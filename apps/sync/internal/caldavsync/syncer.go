// Package caldavsync keeps the calendars of an IMAP account in sync over CalDAV: it finds the server, reports the
// calendars and their changed resources to the API, and writes the changes Tresso made back to the server. It runs
// next to the IMAP syncer of the account and fails on its own: a calendar problem never stops mail.
package caldavsync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // calendar time zones are checked against the IANA database, also in minimal images

	"tresso/sync/internal/api"
	"tresso/sync/internal/caldav"
	"tresso/sync/internal/calfailures"
)

// API is the part of the API client the syncer needs.
type API interface {
	Credentials(ctx context.Context, accountID, workerID string) (api.Credentials, error)
	Calendars(ctx context.Context, accountID string, list api.CalendarList) ([]api.CalendarState, error)
	CalendarInventory(ctx context.Context, accountID, calendarID, workerID string, objects []api.RemoteObject, partial bool) (api.InventoryResult, error)
	CalendarObjects(ctx context.Context, accountID, calendarID string, batch api.ObjectBatch) (api.ObjectBatchResult, error)
	ClaimCalendarOperations(ctx context.Context, accountID, workerID string) ([]api.CalendarOperation, error)
	ReportCalendarOperation(ctx context.Context, accountID, operationID string, result api.OperationResult) error
	CalendarStatus(ctx context.Context, accountID, workerID, status, detail string) error
}

type Options struct {
	// Interval between two syncs of all calendars.
	Interval time.Duration
	// NotFoundRetry is how long to wait before looking for CalDAV again on a server that has none.
	NotFoundRetry time.Duration
	MinBackoff    time.Duration
	MaxBackoff    time.Duration
	// AllowHTTP permits plain HTTP servers, for local tests only.
	AllowHTTP bool
	// Resolver looks up SRV and TXT records for discovery; nil skips them.
	Resolver *net.Resolver
}

func DefaultOptions() Options {
	return Options{Interval: 2 * time.Minute, NotFoundRetry: 24 * time.Hour, MinBackoff: 10 * time.Second, MaxBackoff: 30 * time.Minute, Resolver: net.DefaultResolver}
}

const (
	multigetBatch = 50
	objectBatch   = 100
	// The API's limits per request: removals in one object batch, entries in one inventory, calendars in one list,
	// and the length of an href, an ETag and a status detail.
	removedBatch   = 5000
	inventoryBatch = 50000
	maxCalendars   = 500
	maxHref        = 2048
	maxETag        = 512
	maxDetail      = 500
	// maxSyncPages bounds the pages of a cut-short sync-collection before a plain listing is used instead.
	maxSyncPages = 100
)

type Syncer struct {
	api      API
	dialer   caldav.Dialer
	workerID string
	opts     Options
	logger   *slog.Logger

	mu   sync.Mutex
	wake map[string]chan struct{}
}

func New(client API, dialer caldav.Dialer, workerID string, opts Options, logger *slog.Logger) *Syncer {
	return &Syncer{api: client, dialer: dialer, workerID: workerID, opts: opts, logger: logger, wake: map[string]chan struct{}{}}
}

// Trigger makes the account's syncer write pending changes and sync now instead of at its next interval.
func (s *Syncer) Trigger(accountID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ch, ok := s.wake[accountID]; ok {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// Run syncs the account's calendars until ctx is cancelled. It only returns ctx's error: failures are retried with
// backoff, a server without CalDAV is asked again a day later.
func (s *Syncer) Run(ctx context.Context, account api.Account) error {
	wake := make(chan struct{}, 1)
	s.mu.Lock()
	s.wake[account.ID] = wake
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.wake, account.ID)
		s.mu.Unlock()
	}()

	logger := s.logger.With("account", account.ID, "part", "calendar")
	backoff := s.opts.MinBackoff
	failures := 0
	status := newStatusReporter(s, account.ID, logger)
	failing := calfailures.New(s.opts.Interval, s.opts.MaxBackoff)
	for {
		healthy, err := s.session(ctx, account, wake, logger, status, failing)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if healthy {
			// A session that synced: the next failure is the first one again.
			failures, backoff = 0, s.opts.MinBackoff
		}
		wait := backoff
		var confirm *caldav.ConfirmError
		var untrusted *caldav.UntrustedError
		switch {
		case errors.As(err, &confirm):
			logger.Info("a calendar server needs the user's confirmation", "url", confirm.URL, "retryIn", s.opts.NotFoundRetry)
			status.report(ctx, api.CalendarUnconfirmed, "A calendar server was found at "+displayURL(confirm.URL)+". To sync your calendars there, confirm this address in the account settings.")
			wait = s.opts.NotFoundRetry
			failures = 0
		case errors.As(err, &untrusted):
			logger.Warn("a calendar server outside the account asked for the login", "url", untrusted.URL, "retryIn", s.opts.MaxBackoff)
			status.report(ctx, api.CalendarError, "The calendar server sent Tresso to "+displayURL(untrusted.URL)+", which does not get your password. Enter the right CalDAV address in the account settings.")
			wait = s.opts.MaxBackoff
			failures = 0
		case errors.Is(err, caldav.ErrNotCalDAV), errors.Is(err, errNoServer):
			logger.Info("no calendar server found for the account", "error", err, "retryIn", s.opts.NotFoundRetry)
			status.report(ctx, api.CalendarUnsupported, "No calendar server was found for this account. If it has one, enter its CalDAV address in the account settings.")
			wait = s.opts.NotFoundRetry
			failures = 0
		case errors.Is(err, caldav.ErrInsecure):
			logger.Warn("the calendar server wanted plain http", "error", err, "retryIn", s.opts.MaxBackoff)
			status.report(ctx, api.CalendarError, "The calendar server sent Tresso to an http:// address, which does not get your password. Enter its https address in the account settings.")
			wait = s.opts.MaxBackoff
			failures = 0
		case errors.Is(err, caldav.ErrUnauthorized):
			logger.Warn("the calendar server refused the login", "retryIn", s.opts.MaxBackoff)
			status.report(ctx, api.CalendarAuthFailed, "The calendar server refused the login. Some providers need an app password for calendars.")
			wait = s.opts.MaxBackoff
			failures = 0
		default:
			failures++
			logger.Warn("calendar sync failed", "error", err, "retryIn", backoff)
			if failures >= maxQuietFailures {
				status.report(ctx, api.CalendarError, "Calendars could not be synced; trying again.")
			}
			backoff = min(backoff*2, s.opts.MaxBackoff)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		case <-wake:
		}
	}
}

var errNoServer = errors.New("the account has no calendar server")

// maxQuietFailures is how many sessions in a row may fail for other reasons before the user is told.
const maxQuietFailures = 3

// statusReporter tells the API about a calendar problem once, not on every retry.
type statusReporter struct {
	syncer    *Syncer
	accountID string
	logger    *slog.Logger
	last      string
}

func newStatusReporter(s *Syncer, accountID string, logger *slog.Logger) *statusReporter {
	return &statusReporter{syncer: s, accountID: accountID, logger: logger}
}

func (r *statusReporter) report(ctx context.Context, status, detail string) {
	detail = truncateText(detail, maxDetail)
	if r.last == status {
		return
	}
	if err := r.syncer.api.CalendarStatus(ctx, r.accountID, r.syncer.workerID, status, detail); err != nil {
		r.logger.Warn("reporting the calendar status failed", "error", err)
		return
	}
	r.last = status
}

func (r *statusReporter) reset() {
	r.last = ""
}

// session opens the server and syncs until something fails. healthy reports whether a sync of every calendar went
// through, so a failure after it does not count towards the error threshold.
func (s *Syncer) session(ctx context.Context, account api.Account, wake <-chan struct{}, logger *slog.Logger, status *statusReporter, failing *calfailures.Tracker) (healthy bool, err error) {
	credentials, err := s.api.Credentials(ctx, account.ID, s.workerID)
	if err != nil {
		return false, err
	}
	password, err := credentials.Password()
	if err != nil {
		return false, fmt.Errorf("%w: %v", errNoServer, err)
	}
	client := caldav.New(s.dialer, credentials.Connection.Username, password, s.opts.AllowHTTP, caldav.NewTrust(credentials.Connection.IMAP.Host, credentials.Connection.CalDAV))

	var server caldav.Account
	if credentials.Connection.CalDAV != "" {
		server, err = client.Open(ctx, credentials.Connection.CalDAV)
	} else {
		server, err = client.Discover(ctx, credentials.EmailAddress, credentials.Connection.IMAP.Host, s.opts.Resolver)
	}
	if err != nil {
		return false, err
	}
	logger.Info("calendar server found", "url", server.ContextURL, "autoSchedule", server.AutoSchedule)

	run := &run{syncer: s, client: client, server: server, account: account, logger: logger, failing: failing}
	for {
		if err := run.writeAll(ctx); err != nil {
			return healthy, err
		}
		if err := run.syncAll(ctx); err != nil {
			return healthy, err
		}
		healthy = true
		// A calendar list the API accepted makes the status active there; calendars that keep failing make it an
		// error again.
		status.reset()
		if detail, failing := failing.Detail(); failing {
			status.report(ctx, api.CalendarError, detail)
		}
		select {
		case <-ctx.Done():
			return healthy, ctx.Err()
		case <-time.After(s.opts.Interval):
		case <-wake:
		}
	}
}

type run struct {
	syncer  *Syncer
	client  *caldav.Client
	server  caldav.Account
	account api.Account
	logger  *slog.Logger
	// The calendars as the API knows them, by remote id, from the last sync.
	states map[string]api.CalendarState
	// failing holds the calendars that failed in this or an earlier session.
	failing *calfailures.Tracker
}

// cursor is what the API keeps per calendar for this syncer: the sync token, or the ctag for servers without one.
type cursor struct {
	SyncToken string `json:"syncToken,omitempty"`
	CTag      string `json:"ctag,omitempty"`
}

func (r *run) syncAll(ctx context.Context) error {
	calendars, err := r.client.Calendars(ctx, r.server)
	if err != nil {
		return err
	}
	list := api.CalendarList{WorkerID: r.syncer.workerID, Source: "caldav", ServerURL: &r.server.ContextURL, ProviderSchedules: r.server.AutoSchedule}
	calendars = r.acceptable(calendars)
	for _, calendar := range calendars {
		remote := api.RemoteCalendar{RemoteID: calendar.URL, Name: calendar.Name, Writable: calendar.Writable, IsDefault: calendar.IsDefault}
		if calendar.Color != "" {
			remote.Color = &calendar.Color
		}
		if zone := ianaZone(calendar.TimeZone); zone != "" {
			remote.TimeZone = &zone
		}
		list.Calendars = append(list.Calendars, remote)
	}
	states, err := r.syncer.api.Calendars(ctx, r.account.ID, list)
	if err != nil {
		return err
	}
	r.states = make(map[string]api.CalendarState, len(states))
	for _, state := range states {
		r.states[state.RemoteID] = state
	}
	listed := make(map[string]bool, len(calendars))
	for _, calendar := range calendars {
		listed[calendar.URL] = true
	}
	r.failing.Keep(listed)

	refused, synced := 0, 0
	for _, calendar := range calendars {
		state, ok := r.states[calendar.URL]
		if !ok || !r.failing.Due(calendar.URL) {
			continue
		}
		synced++
		if err := r.syncCalendar(ctx, calendar, state); err != nil {
			if ctx.Err() != nil {
				return err
			}
			if errors.Is(err, caldav.ErrUnauthorized) {
				// A calendar shared with the user and taken back refuses the login; the others may still work.
				refused++
				r.logger.Warn("a calendar refused the login", "calendar", calendar.URL)
				continue
			}
			// One broken calendar (a shared one that went away mid-sync) must not hold up the others; it is backed
			// off and, if it keeps failing, named in the status.
			r.logger.Warn("calendar could not be synced", "calendar", calendar.URL, "error", err)
			r.failing.Failed(calendar.URL, calendarName(calendar))
			continue
		}
		r.failing.Succeeded(calendar.URL)
	}
	if refused > 0 && refused == synced {
		return caldav.ErrUnauthorized
	}
	return nil
}

// calendarName is how the user knows a calendar, for status messages.
func calendarName(calendar caldav.Calendar) string {
	if calendar.Name != "" {
		return calendar.Name
	}
	return displayURL(calendar.URL)
}

// acceptable leaves out the calendars the API cannot take, which would make it refuse the whole list every time: one
// with an overlong address, and any past the most a list may have.
func (r *run) acceptable(calendars []caldav.Calendar) []caldav.Calendar {
	kept := make([]caldav.Calendar, 0, min(len(calendars), maxCalendars))
	for _, calendar := range calendars {
		if len(calendar.URL) > maxHref || len(kept) == maxCalendars {
			r.logger.Warn("leaving out a calendar the API cannot take", "calendar", truncateText(calendar.URL, 200))
			continue
		}
		kept = append(kept, calendar)
	}
	return kept
}

func (r *run) syncCalendar(ctx context.Context, calendar caldav.Calendar, state api.CalendarState) error {
	var stored cursor
	if state.Cursor != nil {
		_ = json.Unmarshal([]byte(*state.Cursor), &stored)
	}

	if calendar.SyncToken != "" {
		if stored.SyncToken == calendar.SyncToken {
			return nil
		}
		if stored.SyncToken != "" {
			err := r.syncChanges(ctx, calendar, state, stored.SyncToken)
			if err == nil || !errors.Is(err, caldav.ErrInvalidSyncToken) && !errors.Is(err, errTooManyPages) {
				return err
			}
		}
		members, token, err := r.syncListing(ctx, calendar.URL)
		if err == nil {
			return r.applyListing(ctx, calendar, state, members, cursor{SyncToken: token})
		}
		if errors.Is(err, caldav.ErrUnauthorized) || ctx.Err() != nil {
			return err
		}
		// A server whose sync-collection fails may still list the calendar; the token is then not kept, so the next
		// sync lists it again.
		r.logger.Info("sync-collection failed; listing the calendar instead", "calendar", calendar.URL, "error", err)
	} else if calendar.CTag != "" && stored.CTag == calendar.CTag {
		return nil
	}

	members, err := r.client.List(ctx, calendar.URL)
	if err != nil {
		return err
	}
	return r.applyListing(ctx, calendar, state, members, cursor{CTag: calendar.CTag})
}

var errTooManyPages = errors.New("the calendar server kept cutting its changes short")

// syncChanges applies what changed since the token, page by page when the server cuts its answer short (RFC 6578
// 3.6); each page carries its own token, so a sync that breaks off resumes after the last page applied.
func (r *run) syncChanges(ctx context.Context, calendar caldav.Calendar, state api.CalendarState, token string) error {
	for range maxSyncPages {
		members, next, truncated, err := r.client.SyncCollection(ctx, calendar.URL, token)
		if err != nil {
			return err
		}
		if err := r.applyChanges(ctx, calendar, state, members, cursor{SyncToken: next}); err != nil {
			return err
		}
		if !truncated || next == "" || next == token {
			return nil
		}
		token = next
	}
	return errTooManyPages
}

// syncListing collects a complete listing through sync-collection, following the pages of a cut-short answer. Only
// the last page's token stands for the whole listing; a page alone would make the API remove what later pages list.
// The pages are folded in order: a later page's entry for a resource replaces an earlier one, and a removal there
// drops it.
func (r *run) syncListing(ctx context.Context, calendarURL string) ([]caldav.Member, string, error) {
	var order []string
	byHref := map[string]caldav.Member{}
	token := ""
	for range maxSyncPages {
		members, next, truncated, err := r.client.SyncCollection(ctx, calendarURL, token)
		if err != nil {
			return nil, "", err
		}
		for _, member := range members {
			if member.Removed {
				delete(byHref, member.Href)
				continue
			}
			if _, ok := byHref[member.Href]; !ok {
				order = append(order, member.Href)
			}
			byHref[member.Href] = member
		}
		if !truncated || next == "" || next == token {
			all := make([]caldav.Member, 0, len(byHref))
			for _, href := range order {
				if member, ok := byHref[href]; ok {
					all = append(all, member)
					delete(byHref, href)
				}
			}
			return all, next, nil
		}
		token = next
	}
	return nil, "", errTooManyPages
}

// applyListing hands the complete listing to the API, which removes what is gone and names what to fetch. A listing
// larger than the API takes in one request goes in pages that remove nothing.
func (r *run) applyListing(ctx context.Context, calendar caldav.Calendar, state api.CalendarState, members []caldav.Member, next cursor) error {
	objects := make([]api.RemoteObject, 0, len(members))
	seen := make(map[string]bool, len(members))
	for _, member := range members {
		if member.Removed || seen[member.Href] {
			continue
		}
		seen[member.Href] = true
		if !r.fits(member.Href, member.ETag) {
			continue
		}
		etag := member.ETag
		objects = append(objects, api.RemoteObject{RemoteID: member.Href, ETag: &etag})
	}
	partial := len(objects) > inventoryBatch
	if partial {
		r.logger.Warn("the calendar is too large to find removed events in", "calendar", calendar.URL, "resources", len(objects))
	}
	var fetch []string
	for start := 0; start < len(objects) || start == 0; start += inventoryBatch {
		end := min(start+inventoryBatch, len(objects))
		result, err := r.syncer.api.CalendarInventory(ctx, r.account.ID, state.ID, r.syncer.workerID, objects[start:end], partial)
		if err != nil {
			return err
		}
		fetch = append(fetch, result.Fetch...)
	}
	return r.upload(ctx, calendar, state, fetch, nil, next)
}

// fits reports whether the API takes a resource's href and ETag; one it does not would make it refuse the request.
func (r *run) fits(href, etag string) bool {
	if len(href) <= maxHref && len(etag) <= maxETag {
		return true
	}
	r.logger.Info("skipping a calendar resource the API cannot take", "href", truncateText(href, 200))
	return false
}

// applyChanges uploads what sync-collection reported changed and removed.
func (r *run) applyChanges(ctx context.Context, calendar caldav.Calendar, state api.CalendarState, members []caldav.Member, next cursor) error {
	var changed, removed []string
	for _, member := range members {
		if len(member.Href) > maxHref {
			r.logger.Info("skipping a calendar resource the API cannot take", "href", truncateText(member.Href, 200))
			continue
		}
		if member.Removed {
			removed = append(removed, member.Href)
		} else {
			changed = append(changed, member.Href)
		}
	}
	return r.upload(ctx, calendar, state, changed, removed, next)
}

// upload fetches the changed resources and reports them in batches; only the last batch carries the new cursor, so
// a sync that breaks off is repeated from the old one.
func (r *run) upload(ctx context.Context, calendar caldav.Calendar, state api.CalendarState, changed, removed []string, next cursor) error {
	encoded, err := json.Marshal(next)
	if err != nil {
		return err
	}
	cursorText := string(encoded)

	var pending []api.RemoteObject
	flush := func(last bool) error {
		batch := api.ObjectBatch{WorkerID: r.syncer.workerID, Changed: pending}
		if last {
			// Removals go after every change, in batches the API takes; the cursor only with the very last one.
			for len(removed) > removedBatch {
				if _, err := r.syncer.api.CalendarObjects(ctx, r.account.ID, state.ID, api.ObjectBatch{WorkerID: r.syncer.workerID, Changed: pending, Removed: removed[:removedBatch]}); err != nil {
					return err
				}
				pending = nil
				removed = removed[removedBatch:]
			}
			batch.Changed = pending
			batch.Cursor = &cursorText
			batch.Removed = removed
		}
		if _, err := r.syncer.api.CalendarObjects(ctx, r.account.ID, state.ID, batch); err != nil {
			return err
		}
		pending = nil
		return nil
	}

	for start := 0; start < len(changed); start += multigetBatch {
		end := min(start+multigetBatch, len(changed))
		objects, err := r.client.MultiGet(ctx, calendar.URL, changed[start:end])
		if err != nil {
			return err
		}
		for _, object := range objects {
			if len(object.Data) > caldav.MaxObject {
				r.logger.Info("skipping a calendar resource that is too large", "href", object.Href, "bytes", len(object.Data))
				continue
			}
			if !r.fits(object.Href, object.ETag) {
				continue
			}
			etag, data := object.ETag, object.Data
			pending = append(pending, api.RemoteObject{RemoteID: object.Href, ETag: &etag, Ical: &data})
			if len(pending) == objectBatch {
				if err := flush(false); err != nil {
					return err
				}
			}
		}
	}
	return flush(true)
}

// writeAll makes the changes Tresso has for this account's calendars.
func (r *run) writeAll(ctx context.Context) error {
	for {
		operations, err := r.syncer.api.ClaimCalendarOperations(ctx, r.account.ID, r.syncer.workerID)
		if err != nil {
			return err
		}
		if len(operations) == 0 {
			return nil
		}
		for _, operation := range operations {
			result := r.write(ctx, operation)
			result.WorkerID = r.syncer.workerID
			if err := r.syncer.api.ReportCalendarOperation(ctx, r.account.ID, operation.ID, result); err != nil {
				return err
			}
		}
	}
}

func (r *run) write(ctx context.Context, operation api.CalendarOperation) api.OperationResult {
	ifMatch := ""
	if operation.IfMatch != nil {
		ifMatch = *operation.IfMatch
	}

	if operation.Kind == "delete" {
		if operation.RemoteID == nil {
			return api.OperationResult{Outcome: api.OperationDone}
		}
		err := r.client.Delete(ctx, *operation.RemoteID, ifMatch)
		if err == nil {
			return api.OperationResult{Outcome: api.OperationDone}
		}
		return r.failure(ctx, *operation.RemoteID, err)
	}

	if operation.Ical == nil {
		return api.OperationResult{Outcome: api.OperationFailed, Error: text("The event was removed before it could be saved.")}
	}
	href := ""
	create := operation.RemoteID == nil
	if create {
		href = resourceURL(operation.CalendarRemoteID, operation.UID)
		ifMatch = ""
	} else {
		href = *operation.RemoteID
	}
	if !create && ifMatch == "" {
		// The last write got no ETag back; the server's current one still guards against overwriting a change made
		// elsewhere since.
		current, err := r.client.ETag(ctx, href)
		if err != nil {
			// Without it the PUT would overwrite whatever the server has now.
			return r.failure(ctx, href, err)
		}
		if current == "" {
			// The server names no ETag, so nothing guards the write: treated as a conflict, the server's version
			// wins and the user sees their change was not saved.
			return r.failure(ctx, href, &caldav.StatusError{Method: "PROPFIND", URL: href, Status: 412})
		}
		ifMatch = current
	}
	etag, err := r.client.Put(ctx, href, *operation.Ical, ifMatch, create)
	if err != nil {
		return r.failure(ctx, href, err)
	}
	if etag == "" {
		// Some servers change the object on PUT and leave the ETag out; the next sync fetches their version.
		etag, _ = r.client.ETag(ctx, href)
	}
	result := api.OperationResult{Outcome: api.OperationDone, RemoteID: &href}
	if etag != "" {
		result.ETag = &etag
	}
	return result
}

// failure turns a failed write into the outcome the API needs.
func (r *run) failure(ctx context.Context, href string, err error) api.OperationResult {
	var status *caldav.StatusError
	if !errors.As(err, &status) {
		if errors.Is(err, caldav.ErrUnauthorized) {
			return api.OperationResult{Outcome: api.OperationRetry, Error: text("The calendar server refused the login.")}
		}
		return api.OperationResult{Outcome: api.OperationRetry, Error: text("The calendar server could not be reached.")}
	}
	switch {
	case status.Status == 412 || (status.Status == 404 && status.Method != "PUT"):
		current, getErr := r.client.Get(ctx, href)
		if getErr != nil {
			var missing *caldav.StatusError
			if errors.As(getErr, &missing) && missing.Status == 404 {
				return api.OperationResult{Outcome: api.OperationConflict}
			}
			return api.OperationResult{Outcome: api.OperationRetry, Error: text("The calendar server could not be reached.")}
		}
		etag, data := current.ETag, current.Data
		return api.OperationResult{Outcome: api.OperationConflict, Current: &api.RemoteObject{RemoteID: href, ETag: &etag, Ical: &data}}
	case status.Status == 404:
		// An update of a resource that is gone.
		return api.OperationResult{Outcome: api.OperationConflict}
	case status.Status == 403:
		return api.OperationResult{Outcome: api.OperationFailed, Error: text("The calendar is read-only at the provider.")}
	case status.Status == 413 || status.Status == 507:
		return api.OperationResult{Outcome: api.OperationFailed, Error: text("The calendar server has no room for this event.")}
	case status.Status >= 400 && status.Status < 500:
		return api.OperationResult{Outcome: api.OperationFailed, Error: text(fmt.Sprintf("The calendar server refused the event (HTTP %d).", status.Status))}
	default:
		return api.OperationResult{Outcome: api.OperationRetry, Error: text(fmt.Sprintf("The calendar server had a problem (HTTP %d).", status.Status))}
	}
}

// resourceURL is where a new event goes: the calendar collection plus a file name from the UID.
func resourceURL(calendarURL, uid string) string {
	name := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.' {
			return r
		}
		return '-'
	}, uid)
	if !strings.HasSuffix(calendarURL, "/") {
		calendarURL += "/"
	}
	return calendarURL + url.PathEscape(name) + ".ics"
}

func ianaZone(name string) string {
	if name == "" {
		return ""
	}
	if _, err := time.LoadLocation(name); err != nil || name == "Local" {
		return ""
	}
	return name
}

func text(s string) *string {
	return &s
}

// truncateText cuts s to at most max runes.
func truncateText(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max])
}

// displayURL is a server address as the user may see it in a status: without a login or query, which can carry
// secrets.
func displayURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "the address the server named"
	}
	u.User = nil
	u.RawQuery = ""
	u.Fragment = ""
	return truncateText(u.String(), 200)
}
