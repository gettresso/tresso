// Package calsync runs the calendar sync of a Gmail or Microsoft 365 account next to its mail sync: it reports the
// calendars and their changed events to the API as iCalendar, and makes the changes Tresso queued at the provider.
// The provider specific parts (the Google Calendar API, Microsoft Graph) implement Provider; what they report goes
// through the same ingest as CalDAV, so the API has one path for every calendar.
package calsync

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/calfailures"
	"tresso/sync/internal/ical"
	"tresso/sync/internal/netguard"
	"tresso/sync/internal/providerauth"
	"tresso/sync/internal/providerhttp"
)

// API is the part of the API client the syncer needs.
type API interface {
	CalendarCredentials(ctx context.Context, accountID, workerID string) (api.Credentials, error)
	RefreshCalendarCredentials(ctx context.Context, accountID, workerID string) (api.Credentials, error)
	Calendars(ctx context.Context, accountID string, list api.CalendarList) ([]api.CalendarState, error)
	CalendarInventory(ctx context.Context, accountID, calendarID, workerID string, objects []api.RemoteObject, partial bool) (api.InventoryResult, error)
	CalendarObjects(ctx context.Context, accountID, calendarID string, batch api.ObjectBatch) (api.ObjectBatchResult, error)
	ClaimCalendarOperations(ctx context.Context, accountID, workerID string) ([]api.CalendarOperation, error)
	ReportCalendarOperation(ctx context.Context, accountID, operationID string, result api.OperationResult) error
	CalendarStatus(ctx context.Context, accountID, workerID, status, detail string) error
}

// Calendar is one calendar at the provider.
type Calendar struct {
	api.RemoteCalendar
	// Data is the provider's own state of the calendar (default reminders, its time zone) for its adapter.
	Data any
}

// Object is one event resource: a single event, or a series with its changed and cancelled occurrences. Ical is
// empty when the listing named it only; the provider fetches it when the API asks for it.
type Object struct {
	RemoteID string
	ETag     string
	Ical     string
}

// Changes is what a provider reports for one calendar since a cursor.
type Changes struct {
	// Full: Objects is the complete calendar, and whatever the API holds beyond it is gone.
	Full    bool
	Objects []Object
	// Removed lists resources gone since the cursor (incremental changes only).
	Removed []string
	// Cursor is the provider's state after these changes; Unchanged says nothing changed and nothing is sent.
	Cursor    string
	Unchanged bool
}

// Session is one provider's calendar API for one account, built from an access token source.
type Session interface {
	Calendars(ctx context.Context) ([]Calendar, error)
	// Changes reports what changed since cursor ("" when the calendar was never synced).
	Changes(ctx context.Context, calendar Calendar, cursor string) (Changes, error)
	// Fetch returns the named resources as iCalendar; ones that are gone are left out. Events the provider refuses
	// one by one (see EventFailure) are left out too: Fetch then returns what it could fetch together with a
	// *FetchError.
	Fetch(ctx context.Context, calendar Calendar, remoteIDs []string) ([]Object, error)
	// Write makes one queued change at the provider. The error is set, next to the result to report, when the
	// account's access failed: the session then ends.
	Write(ctx context.Context, calendar Calendar, operation api.CalendarOperation) (api.OperationResult, error)
}

// Provider opens sessions.
type Provider interface {
	// Name is how users know the provider ("Google", "Microsoft"), for status messages.
	Name() string
	// Source is the calendar source the API stores ("google", "microsoft").
	Source() string
	// Open starts a session; self is the account's address, which tells the user's own answer among the attendees.
	Open(tokens providerhttp.Tokens, httpClient *http.Client, self string, logger *slog.Logger) Session
	// NotGranted reports whether a provider error means the token lacks the calendar scopes.
	NotGranted(err error) bool
}

type Options struct {
	Interval        time.Duration // between two syncs of all calendars
	NotGrantedRetry time.Duration // how long to wait for the user to allow calendar access
	MinBackoff      time.Duration
	MaxBackoff      time.Duration
}

func DefaultOptions() Options {
	return Options{Interval: time.Minute, NotGrantedRetry: time.Hour, MinBackoff: 10 * time.Second, MaxBackoff: 30 * time.Minute}
}

const (
	objectBatch    = 100
	fetchBatch     = 50
	removedBatch   = 5000
	inventoryBatch = 50000
	maxCalendars   = 500
	maxRemoteID    = 2048
	maxETag        = 512
	maxDetail      = 500
	maxCursor      = 4096
	// maxQuietFailures is how many sessions in a row may fail before the user is told.
	maxQuietFailures = 3
)

type Syncer struct {
	api      API
	provider Provider
	workerID string
	opts     Options
	logger   *slog.Logger
	http     *http.Client

	mu   sync.Mutex
	wake map[string]chan struct{}
}

// New returns the calendar syncer for one provider. Its requests go through the netguard dialer, like every other
// connection the worker opens.
func New(client API, provider Provider, dialer *netguard.Dialer, workerID string, opts Options, logger *slog.Logger) *Syncer {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, _, address string) (net.Conn, error) {
		return dialer.DialContext(ctx, address)
	}
	return &Syncer{
		api: client, provider: provider, workerID: workerID, opts: opts,
		logger: logger.With("part", "calendar", "calendarProvider", provider.Source()),
		http:   &http.Client{Transport: transport},
		wake:   map[string]chan struct{}{},
	}
}

// Trigger makes the account's syncer write pending changes and sync now.
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

// Run syncs the account's calendars until ctx ends. Failures are retried with backoff and never end the mail sync.
func (s *Syncer) Run(ctx context.Context, account api.Account) error {
	wake := make(chan struct{}, 1)
	s.mu.Lock()
	s.wake[account.ID] = wake
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.wake[account.ID] == wake {
			delete(s.wake, account.ID)
		}
		s.mu.Unlock()
	}()

	logger := s.logger.With("account", account.ID)
	status := &statusReporter{syncer: s, accountID: account.ID, logger: logger}
	failing := calfailures.New(s.opts.Interval, s.opts.MaxBackoff)
	backoff := s.opts.MinBackoff
	failures := 0
	for {
		healthy, err := s.session(ctx, account, wake, logger, status, failing)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if healthy {
			failures, backoff = 0, s.opts.MinBackoff
		}
		wait := backoff
		switch {
		case errors.Is(err, api.ErrNotGranted):
			// The API set the status that asks the user to allow calendars; a new sign-in wakes the syncer.
			logger.Info("calendar access not allowed yet", "retryIn", s.opts.NotGrantedRetry)
			status.forget()
			wait = s.opts.NotGrantedRetry
		case s.provider.NotGranted(err), errors.Is(err, errListRefused):
			logger.Info("the provider refuses calendar access", "error", err, "retryIn", s.opts.NotGrantedRetry)
			status.report(ctx, api.CalendarNotGranted, fmt.Sprintf("Tresso is not allowed to use the calendars of this account. Allow calendar access by signing in with %s again.", s.provider.Name()))
			wait = s.opts.NotGrantedRetry
		case errors.Is(err, api.ErrReauthorize), errors.Is(err, providerhttp.ErrUnauthorized):
			// The mail side reports a lost sign-in; the calendar waits for the new one.
			logger.Warn("the provider refused the account's access", "error", err, "retryIn", s.opts.MaxBackoff)
			status.report(ctx, api.CalendarAuthFailed, fmt.Sprintf("%s no longer accepts Tresso's access to this account. Sign in with %s again.", s.provider.Name(), s.provider.Name()))
			wait = s.opts.MaxBackoff
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

type statusReporter struct {
	syncer    *Syncer
	accountID string
	logger    *slog.Logger
	last      string
}

// report tells the API about a calendar problem once, not on every retry.
func (r *statusReporter) report(ctx context.Context, status, detail string) {
	if r.last == status {
		return
	}
	if err := r.syncer.api.CalendarStatus(ctx, r.accountID, r.syncer.workerID, status, truncate(detail, maxDetail)); err != nil {
		r.logger.Warn("reporting the calendar status failed", "error", err)
		return
	}
	r.last = status
}

// forget is for a status someone else reported (or that the calendar list cleared).
func (r *statusReporter) forget() {
	r.last = ""
}

// calendarTokens hands out access tokens that carry the calendar scopes.
type calendarTokens struct {
	client API
}

func (c calendarTokens) Credentials(ctx context.Context, accountID, workerID string) (api.Credentials, error) {
	return c.client.CalendarCredentials(ctx, accountID, workerID)
}

func (c calendarTokens) RefreshCredentials(ctx context.Context, accountID, workerID string) (api.Credentials, error) {
	return c.client.RefreshCalendarCredentials(ctx, accountID, workerID)
}

func (s *Syncer) session(ctx context.Context, account api.Account, wake <-chan struct{}, logger *slog.Logger, status *statusReporter, failing *calfailures.Tracker) (bool, error) {
	credentials, err := s.api.CalendarCredentials(ctx, account.ID, s.workerID)
	if err != nil {
		return false, err
	}
	tokens, err := providerauth.FromCredentials(calendarTokens{client: s.api}, credentials, s.workerID)
	if err != nil {
		return false, err
	}
	self := credentials.EmailAddress
	if self == "" {
		self = account.EmailAddress
	}
	r := &run{syncer: s, session: s.provider.Open(tokens, s.http, ical.Address(self), logger), account: account, logger: logger, failing: failing}
	healthy := false
	for {
		if err := r.syncAll(ctx); err != nil {
			return healthy, err
		}
		if err := r.writeAll(ctx); err != nil {
			return healthy, err
		}
		// A calendar list the API accepted made the status active there; calendars that keep failing make it an
		// error again.
		healthy = true
		status.forget()
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
	session Session
	account api.Account
	logger  *slog.Logger
	// calendars by remote id, with the API's state, from the last list.
	calendars map[string]Calendar
	states    map[string]api.CalendarState
	// failing holds the calendars that failed in this or an earlier session.
	failing *calfailures.Tracker
}

func (r *run) syncAll(ctx context.Context) error {
	calendars, err := r.session.Calendars(ctx)
	if providerhttp.IsStatus(err, http.StatusForbidden) && !throttled(err) {
		// The calendar list is the account's own: refusing it means the account may not use calendars.
		return fmt.Errorf("%w: %w", errListRefused, err)
	}
	if err != nil {
		return err
	}
	calendars = r.acceptable(calendars)
	list := api.CalendarList{WorkerID: r.syncer.workerID, Source: r.syncer.provider.Source(), ProviderSchedules: true}
	for _, calendar := range calendars {
		list.Calendars = append(list.Calendars, calendar.RemoteCalendar)
	}
	states, err := r.syncer.api.Calendars(ctx, r.account.ID, list)
	if err != nil {
		return err
	}
	r.calendars = make(map[string]Calendar, len(calendars))
	listed := make(map[string]bool, len(calendars))
	for _, calendar := range calendars {
		r.calendars[calendar.RemoteID] = calendar
		listed[calendar.RemoteID] = true
	}
	r.failing.Keep(listed)
	r.states = make(map[string]api.CalendarState, len(states))
	for _, state := range states {
		r.states[state.RemoteID] = state
	}

	for _, calendar := range calendars {
		state, ok := r.states[calendar.RemoteID]
		if !ok || !r.failing.Due(calendar.RemoteID) {
			continue
		}
		if err := r.syncCalendar(ctx, calendar, state); err != nil {
			if ctx.Err() != nil || r.fatal(err) {
				return err
			}
			// One calendar that fails (a shared one taken back mid-sync) must not hold up the others; it is backed
			// off and, if it keeps failing, named in the status.
			r.logger.Warn("calendar could not be synced", "calendar", truncate(calendar.RemoteID, 200), "error", err)
			r.failing.Failed(calendar.RemoteID, calendar.Name)
			continue
		}
		r.failing.Succeeded(calendar.RemoteID)
	}
	return nil
}

// fatal errors end the session instead of skipping one calendar: the account's access as a whole is the problem.
// A 403 on one calendar (shared and taken back, or read-only) is not fatal: that calendar is skipped.
func (r *run) fatal(err error) bool {
	return errors.Is(err, api.ErrReauthorize) || errors.Is(err, api.ErrNotGranted) || errors.Is(err, providerhttp.ErrUnauthorized) || r.syncer.provider.NotGranted(err)
}

// throttled: a 403 that is a quota or rate limit (Google answers those with 403 too), which says nothing about
// what the account may do; once its retries are spent it is an ordinary failure, retried with backoff.
func throttled(err error) bool {
	var statusErr *providerhttp.StatusError
	if !errors.As(err, &statusErr) {
		return false
	}
	for _, reason := range []string{"rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded", "ApplicationThrottled", "TooManyRequests"} {
		if statusErr.HasReason(reason) {
			return true
		}
	}
	return false
}

// errListRefused: the provider refused the account's calendar list.
var errListRefused = errors.New("the provider refused the calendar list")

// acceptable leaves out calendars the API would refuse the whole list for.
func (r *run) acceptable(calendars []Calendar) []Calendar {
	kept := make([]Calendar, 0, min(len(calendars), maxCalendars))
	for _, calendar := range calendars {
		if len(calendar.RemoteID) > maxRemoteID || len(kept) == maxCalendars {
			r.logger.Warn("leaving out a calendar the API cannot take", "calendar", truncate(calendar.RemoteID, 200))
			continue
		}
		if calendar.Name == "" {
			calendar.Name = "Calendar"
		}
		calendar.Name = truncate(calendar.Name, 255)
		kept = append(kept, calendar)
	}
	return kept
}

func (r *run) syncCalendar(ctx context.Context, calendar Calendar, state api.CalendarState) error {
	cursor := ""
	if state.Cursor != nil {
		cursor = *state.Cursor
	}
	changes, err := r.session.Changes(ctx, calendar, cursor)
	if err != nil {
		return err
	}
	if changes.Unchanged {
		return nil
	}
	if len(changes.Cursor) > maxCursor {
		return fmt.Errorf("the provider's cursor is %d bytes, the API stores at most %d", len(changes.Cursor), maxCursor)
	}
	if changes.Full {
		return r.applyListing(ctx, calendar, state, changes)
	}
	return r.upload(ctx, calendar, state, changes.Objects, nil, changes.Removed, changes.Cursor)
}

// applyListing hands the complete listing to the API, which removes what is gone and names what to send.
func (r *run) applyListing(ctx context.Context, calendar Calendar, state api.CalendarState, changes Changes) error {
	byID := make(map[string]Object, len(changes.Objects))
	objects := make([]api.RemoteObject, 0, len(changes.Objects))
	for _, object := range changes.Objects {
		if _, seen := byID[object.RemoteID]; seen || !r.fits(object) {
			continue
		}
		byID[object.RemoteID] = object
		etag := object.ETag
		objects = append(objects, api.RemoteObject{RemoteID: object.RemoteID, ETag: &etag})
	}
	partial := len(objects) > inventoryBatch
	if partial {
		r.logger.Warn("the calendar is too large to find removed events in", "calendar", truncate(calendar.RemoteID, 200), "events", len(objects))
	}
	var send []Object
	var fetch []string
	for start := 0; start < len(objects) || start == 0; start += inventoryBatch {
		end := min(start+inventoryBatch, len(objects))
		result, err := r.syncer.api.CalendarInventory(ctx, r.account.ID, state.ID, r.syncer.workerID, objects[start:end], partial)
		if err != nil {
			return err
		}
		for _, remoteID := range result.Fetch {
			object, ok := byID[remoteID]
			switch {
			case !ok:
			case object.Ical != "":
				send = append(send, object)
			default:
				fetch = append(fetch, remoteID)
			}
		}
	}
	return r.upload(ctx, calendar, state, send, fetch, nil, changes.Cursor)
}

// fits reports whether the API takes the resource's id and ETag.
func (r *run) fits(object Object) bool {
	if len(object.RemoteID) <= maxRemoteID && len(object.ETag) <= maxETag {
		return true
	}
	r.logger.Info("skipping an event the API cannot take", "event", truncate(object.RemoteID, 200))
	return false
}

// upload reports the changed events (fetching those the provider only named) in batches; only the last batch carries
// the cursor, so a sync that breaks off is repeated from the old one.
func (r *run) upload(ctx context.Context, calendar Calendar, state api.CalendarState, ready []Object, fetch []string, removed []string, cursor string) error {
	var pending []api.RemoteObject
	send := func(batch api.ObjectBatch) error {
		_, err := r.syncer.api.CalendarObjects(ctx, r.account.ID, state.ID, batch)
		return err
	}
	add := func(object Object) error {
		if !r.fits(object) {
			return nil
		}
		if len(object.Ical) > ical.MaxSize {
			r.logger.Info("skipping an event that is too large", "event", truncate(object.RemoteID, 200), "bytes", len(object.Ical))
			return nil
		}
		etag, data := object.ETag, object.Ical
		pending = append(pending, api.RemoteObject{RemoteID: object.RemoteID, ETag: &etag, Ical: &data})
		if len(pending) < objectBatch {
			return nil
		}
		err := send(api.ObjectBatch{WorkerID: r.syncer.workerID, Changed: pending})
		pending = nil
		return err
	}

	for _, object := range ready {
		if err := add(object); err != nil {
			return err
		}
	}
	// Events the provider refused one by one are left out. A refusal that will not change (4xx) lets the cursor
	// move on: a later change of the event names it again. One that may pass (5xx) keeps the cursor, so the next
	// sync of this calendar asks for the event again.
	var transient *FetchError
	for start := 0; start < len(fetch); start += fetchBatch {
		objects, err := r.session.Fetch(ctx, calendar, fetch[start:min(start+fetchBatch, len(fetch))])
		var skipped *FetchError
		if errors.As(err, &skipped) {
			r.logger.Warn("events could not be fetched and were left out", "calendar", truncate(calendar.RemoteID, 200), "transient", skipped.Transient, "permanent", skipped.Permanent, "error", skipped.Err)
			if skipped.Transient > 0 {
				transient = skipped
			}
		} else if err != nil {
			return err
		}
		for _, object := range objects {
			if err := add(object); err != nil {
				return err
			}
		}
	}

	var kept []string
	for _, remoteID := range removed {
		if len(remoteID) <= maxRemoteID {
			kept = append(kept, remoteID)
		}
	}
	for len(kept) > removedBatch {
		if err := send(api.ObjectBatch{WorkerID: r.syncer.workerID, Changed: pending, Removed: kept[:removedBatch]}); err != nil {
			return err
		}
		pending = nil
		kept = kept[removedBatch:]
	}
	if transient != nil {
		if err := send(api.ObjectBatch{WorkerID: r.syncer.workerID, Changed: pending, Removed: kept}); err != nil {
			return err
		}
		return transient
	}
	return send(api.ObjectBatch{WorkerID: r.syncer.workerID, Changed: pending, Removed: kept, Cursor: &cursor})
}

// FetchError is what Fetch returns next to the objects it could fetch when the provider refused some events one by
// one (see EventFailure).
type FetchError struct {
	// Transient counts events that may come through next time (the provider failed, 5xx); Permanent those it
	// refused (4xx).
	Transient, Permanent int
	// Err is the last refusal.
	Err error
}

func (e *FetchError) Error() string {
	return fmt.Sprintf("%d events could not be fetched (%d may pass): %v", e.Transient+e.Permanent, e.Transient, e.Err)
}

func (e *FetchError) Unwrap() error { return e.Err }

// Add counts one event that was left out; a nil receiver starts the count.
func (e *FetchError) Add(err error, transient bool) *FetchError {
	if e == nil {
		e = &FetchError{}
	}
	if transient {
		e.Transient++
	} else {
		e.Permanent++
	}
	e.Err = err
	return e
}

// EventFailure tells whether an error fetching one event concerns that event only, so it is left out and the others
// go on (skip), and whether a later try may get it (transient). The account's access, throttling, a broken connection
// and the end of the context concern every event and end the sync. notGranted is the provider's own test for a token
// without the calendar scopes.
func EventFailure(err error, notGranted func(error) bool) (skip, transient bool) {
	var statusErr *providerhttp.StatusError
	if !errors.As(err, &statusErr) || errors.Is(err, providerhttp.ErrUnauthorized) || errors.Is(err, api.ErrReauthorize) || throttled(err) || notGranted(err) {
		return false, false
	}
	switch {
	case statusErr.StatusCode == http.StatusUnauthorized, statusErr.StatusCode == http.StatusTooManyRequests:
		return false, false
	case statusErr.StatusCode >= 500:
		return true, true
	case statusErr.StatusCode >= 400:
		return true, false
	}
	return false, false
}

// writeAll makes the changes Tresso queued for this account's calendars.
func (r *run) writeAll(ctx context.Context) error {
	for {
		operations, err := r.syncer.api.ClaimCalendarOperations(ctx, r.account.ID, r.syncer.workerID)
		if err != nil {
			return err
		}
		if len(operations) == 0 {
			return nil
		}
		operations, err = r.moves(ctx, operations)
		if err != nil {
			return err
		}
		for _, operation := range operations {
			result, writeErr := r.write(ctx, operation)
			result.WorkerID = r.syncer.workerID
			if result.Current != nil && (len(result.Current.RemoteID) > maxRemoteID || result.Current.Ical != nil && len(*result.Current.Ical) > ical.MaxSize) {
				result.Current = nil
			}
			if err := r.syncer.api.ReportCalendarOperation(ctx, r.account.ID, operation.ID, result); err != nil {
				return err
			}
			if writeErr != nil && r.fatal(writeErr) {
				return writeErr
			}
		}
	}
}

// Mover is a session that can move an event to another calendar of the account, so attendees see no cancellation
// and new invitation (Google's events.move; Graph has no move for events).
type Mover interface {
	// Move moves the resource, unless the provider's version differs from ifMatch (ErrMoveConflict), and returns its
	// id and ETag in the target calendar.
	Move(ctx context.Context, from, to Calendar, remoteID string, ifMatch *string) (id, etag string, err error)
}

// ErrMoveConflict: the event changed at the provider since Tresso's version, so it is not moved; the delete then
// reports the conflict as any other write does.
var ErrMoveConflict = errors.New("the event changed at the provider since it was moved in Tresso")

// moves turns a delete in one calendar and the create of the same event in another, which is how the API queues a
// move, into a move at the provider. The delete is reported done and the create becomes an update of the moved
// event. A move the provider refuses leaves both as they were.
func (r *run) moves(ctx context.Context, operations []api.CalendarOperation) ([]api.CalendarOperation, error) {
	mover, ok := r.session.(Mover)
	if !ok {
		return operations, nil
	}
	creates := map[string]int{}
	for i, operation := range operations {
		if operation.Kind != "delete" && operation.RemoteID == nil {
			creates[operation.UID] = i
		}
	}
	// held are operations the move answers itself: the moved delete, or the create of a move that conflicted.
	held := map[string]bool{}
	for _, operation := range operations {
		i, paired := creates[operation.UID]
		if operation.Kind != "delete" || operation.RemoteID == nil || !paired || operations[i].CalendarRemoteID == operation.CalendarRemoteID {
			continue
		}
		from, fromOK := r.calendars[operation.CalendarRemoteID]
		to, toOK := r.calendars[operations[i].CalendarRemoteID]
		if !fromOK || !toOK {
			continue
		}
		moved, etag, err := mover.Move(ctx, from, to, *operation.RemoteID, operation.IfMatch)
		if errors.Is(err, ErrMoveConflict) {
			// The event changed at the provider: it stays where it is, so the create in the other calendar must not
			// make a second copy. The create is a conflict (Tresso drops its copy there), and the delete reports the
			// provider's version below, which Tresso keeps in the old calendar.
			if err := r.syncer.api.ReportCalendarOperation(ctx, r.account.ID, operations[i].ID, api.OperationResult{WorkerID: r.syncer.workerID, Outcome: api.OperationConflict}); err != nil {
				return nil, err
			}
			held[operations[i].ID] = true
			continue
		}
		if err != nil {
			if r.fatal(err) {
				return nil, err
			}
			r.logger.Info("the provider did not move the event; it is deleted and created instead", "error", err)
			continue
		}
		if err := r.syncer.api.ReportCalendarOperation(ctx, r.account.ID, operation.ID, api.OperationResult{WorkerID: r.syncer.workerID, Outcome: api.OperationDone}); err != nil {
			return nil, err
		}
		held[operation.ID] = true
		// The update is conditional on the moved event's version, so a change made at the provider meanwhile is a
		// conflict, not overwritten.
		operations[i].RemoteID, operations[i].IfMatch = &moved, &etag
	}
	kept := make([]api.CalendarOperation, 0, len(operations))
	for _, operation := range operations {
		if !held[operation.ID] {
			kept = append(kept, operation)
		}
	}
	return kept, nil
}

func (r *run) write(ctx context.Context, operation api.CalendarOperation) (api.OperationResult, error) {
	calendar, ok := r.calendars[operation.CalendarRemoteID]
	if !ok {
		return api.OperationResult{Outcome: api.OperationRetry, Error: text("The calendar was not found at the provider.")}, nil
	}
	return r.session.Write(ctx, calendar, operation)
}

func text(s string) *string {
	return &s
}

func truncate(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max])
}
