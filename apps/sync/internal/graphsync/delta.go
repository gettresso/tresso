package graphsync

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"sync"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/providerhttp"
	"tresso/sync/internal/providersync"
)

var errNoDeltaLink = errors.New("delta query ended without a delta link")

// deltaResult is what one folder's delta query returned in a round.
type deltaResult struct {
	run       *folderRun
	changed   map[string]graphMessage // added or changed, by id
	order     []string
	removed   []string
	deltaLink string
	// resync is set when the delta token had expired and the folder was listed from scratch: everything the API has
	// that the listing lacks was removed.
	resync bool
	// rescue marks additions found by looking a removed message up (see rescueMoves); it has no delta link to store.
	rescue bool
}

func newDeltaResult(run *folderRun) *deltaResult {
	return &deltaResult{run: run, changed: map[string]graphMessage{}}
}

// collect adds a page of delta items. A later item for the same id replaces an earlier one.
func (r *deltaResult) collect(items []graphMessage) {
	for _, item := range items {
		if item.ID == "" {
			continue
		}
		if item.Removed != nil {
			if _, ok := r.changed[item.ID]; ok {
				delete(r.changed, item.ID)
				r.order = without(r.order, item.ID)
			}
			r.removed = append(r.removed, item.ID)
			continue
		}
		r.add(item)
		r.removed = without(r.removed, item.ID)
	}
}

func (r *deltaResult) add(item graphMessage) {
	if _, ok := r.changed[item.ID]; !ok {
		r.order = append(r.order, item.ID)
	}
	r.changed[item.ID] = item
}

// round runs the delta query of the given folders.
//
// A removal may be a move, and the folder it moved to must link the message before the old folder drops it. So when
// any folder reports a removal, the folder tree is read again (the message may have moved into a folder created
// since; such a folder is started with a checkpointed backfill like any other), every other folder is queried too,
// and messages a folder may only know through its pending backfill are rescued (rescueMoves). All additions are
// applied first, then the removals, each with the folder's new delta link.
func (s *session) round(ctx context.Context, due []*folderRun) error {
	results := make([]*deltaResult, 0, len(s.runs))
	polled := map[*folderRun]bool{}
	removals := false
	for _, run := range due {
		result, err := s.poll(ctx, run)
		if err != nil {
			if err := s.deny(run, err); err != nil {
				return err
			}
			continue
		}
		polled[run] = true
		results = append(results, result)
		removals = removals || len(result.removed) > 0 || result.resync
	}

	if removals {
		if err := s.refreshFolders(ctx); err != nil {
			return err
		}
		// Folders that disappeared or were reset by the API are dropped; their results no longer apply.
		live := make(map[*folderRun]bool, len(s.runs))
		for _, run := range s.runs {
			live[run] = true
		}
		kept := results[:0]
		for _, result := range results {
			if live[result.run] {
				kept = append(kept, result)
			}
		}
		results = kept

		for _, run := range s.runs {
			if polled[run] || run.denied {
				continue
			}
			if run.cursor == nil {
				// Not started yet: steps start one folder at a time, also now. A message moved into it is rescued
				// below and its existing mail comes through its backfill once it is started.
				continue
			}
			result, err := s.poll(ctx, run)
			if err != nil {
				if err := s.deny(run, err); err != nil {
					return err
				}
				continue
			}
			results = append(results, result)
		}
	}

	// What each folder lost, known before any addition: a resynced folder's removals are what the API has beyond the
	// listing.
	for _, result := range results {
		if result.resync {
			missing, err := s.ingest.Missing(ctx, result.run.folder.RemoteName, presentSet(result))
			if err != nil {
				return err
			}
			result.removed = missing
		}
	}
	if removals {
		rescued, err := s.rescueMoves(ctx, results)
		if err != nil {
			return err
		}
		results = append(rescued, results...)
	}

	built := providersync.NewMessageCache(providersync.DefaultCacheSize)
	for _, result := range results {
		changes := make([]api.FlagChange, 0, len(result.order))
		for _, id := range result.order {
			changes = append(changes, api.FlagChange{RemoteUID: id, Flags: result.changed[id].flags()})
		}
		if err := s.ingest.ApplyFlags(ctx, result.run.folder.RemoteName, changes, s.fetcher(result.changed, built)); err != nil {
			return err
		}
	}

	for _, result := range results {
		if result.rescue {
			continue
		}
		run := result.run
		run.nextPoll = time.Now().Add(s.interval(run))
		quiet := !result.resync && len(result.order) == 0 && len(result.removed) == 0
		// A quiet round keeps the stored delta link, which stays valid; a fresh one is stored now and then, so the
		// stored token never grows old enough for Graph to expire it.
		if quiet && (result.deltaLink == run.cursor.DeltaLink || time.Since(run.storedAt) < s.opts.DeltaLinkMaxAge) {
			continue
		}
		next := *run.cursor
		next.DeltaLink = result.deltaLink
		encoded, err := next.Encode()
		if err != nil {
			return err
		}
		if err := s.ingest.Vanish(ctx, run.folder.RemoteName, result.removed, &encoded); err != nil {
			return err
		}
		run.cursor = &next
		run.storedAt = time.Now()
	}
	return nil
}

// rescueMoves finds removed messages that a folder still has to backfill. A folder's delta only reports changes
// after the folder was started; a message that moved into it before that (while the folder it left was already
// synced) is only in its backfill, and removing it from the old folder first would delete it. While no folder has a
// backfill pending, every move shows up as an addition in some folder's delta and nothing needs looking up.
//
// Each removed id that no folder added in this round is looked up; when it now lives in a folder with a pending
// backfill, it is added there before the removals.
func (s *session) rescueMoves(ctx context.Context, results []*deltaResult) ([]*deltaResult, error) {
	pending := map[string]*folderRun{}
	for _, run := range s.runs {
		if !run.denied && (run.cursor == nil || !run.cursor.BackfillDone) {
			pending[run.folder.RemoteName] = run
		}
	}
	if len(pending) == 0 {
		return nil, nil
	}
	added := map[string]bool{}
	for _, result := range results {
		for id := range result.changed {
			added[id] = true
		}
	}
	var lookup []string
	seen := map[string]bool{}
	for _, result := range results {
		for _, id := range result.removed {
			if !added[id] && !seen[id] {
				seen[id] = true
				lookup = append(lookup, id)
			}
		}
	}

	var mu sync.Mutex
	byFolder := map[*folderRun]*deltaResult{}
	err := s.each(ctx, lookup, func(ctx context.Context, id string) error {
		item, err := s.graph.message(ctx, id)
		if providerhttp.IsStatus(err, http.StatusNotFound) {
			return nil // deleted for good
		}
		if accessDenied(err) {
			return nil // moved where the user may not look
		}
		if err != nil {
			return err
		}
		run, ok := pending[item.ParentFolderID]
		if !ok {
			return nil
		}
		mu.Lock()
		defer mu.Unlock()
		result, ok := byFolder[run]
		if !ok {
			result = newDeltaResult(run)
			result.rescue = true
			byFolder[run] = result
		}
		result.add(item)
		return nil
	})
	if err != nil {
		return nil, err
	}
	rescued := make([]*deltaResult, 0, len(byFolder))
	for _, run := range s.runs {
		if result, ok := byFolder[run]; ok {
			slices.Sort(result.order)
			rescued = append(rescued, result)
		}
	}
	return rescued, nil
}

// poll runs a folder's delta query from its cursor. An expired delta token restarts the query from scratch, which
// lists every message in the folder.
func (s *session) poll(ctx context.Context, run *folderRun) (*deltaResult, error) {
	result := newDeltaResult(run)
	deltaLink, err := s.walkDelta(ctx, run.cursor.DeltaLink, result.collect)
	if deltaExpired(err) {
		s.logger.Info("delta token expired, resyncing folder", "folder", run.folder.RemoteName)
		result = newDeltaResult(run)
		result.resync = true
		deltaLink, err = s.walkDelta(ctx, deltaStart(run.folder.RemoteName), result.collect)
	}
	if err != nil {
		return nil, err
	}
	result.deltaLink = deltaLink
	return result, nil
}

func presentSet(result *deltaResult) map[string]bool {
	present := make(map[string]bool, len(result.changed))
	for id := range result.changed {
		present[id] = true
	}
	return present
}

func without(ids []string, id string) []string {
	for i, existing := range ids {
		if existing == id {
			return append(ids[:i:i], ids[i+1:]...)
		}
	}
	return ids
}

// maxPageSize is the most messages Graph returns per page.
const maxPageSize = 1000

// backfill ingests up to BackfillPagesPerPass pages of a folder's existing mail, newest first: flags first, raw MIME
// only for what the API does not have, then the cursor moves on.
//
// Pages are cut by receive time, not by position: Graph's own next links skip a number of messages, so a message
// deleted or moved away on an earlier page would make one on a later page be skipped for good. Each page asks for the
// messages received before the oldest one of the previous page. As several messages can share a receive time, a page
// followed by more is completed with every message of its oldest receive time, and the next page starts below that
// time. When Graph has no next page, completeFolder picks up what no time filter matched before the folder is done.
func (s *session) backfill(ctx context.Context, run *folderRun) error {
	for page := 0; page < s.opts.BackfillPagesPerPass && !run.cursor.BackfillDone; page++ {
		batch, before, err := s.datedPage(ctx, run)
		if err != nil {
			return err
		}
		if err := s.applyListed(ctx, run, batch); err != nil {
			return err
		}
		next := *run.cursor
		next.BackfillBefore = before
		if before == "" {
			if err := s.completeFolder(ctx, run); err != nil {
				return err
			}
			next.BackfillDone = true
		}

		encoded, err := next.Encode()
		if err != nil {
			return err
		}
		if err := s.ingest.StoreCursor(ctx, run.folder.RemoteName, encoded); err != nil {
			return err
		}
		run.cursor = &next
		run.storedAt = time.Now()
	}
	if run.cursor.BackfillDone {
		s.logger.Info("folder backfill complete", "folder", run.folder.RemoteName)
	}
	return nil
}

// applyListed reports listed messages to a folder: flags first, raw MIME for the ones the API does not have.
func (s *session) applyListed(ctx context.Context, run *folderRun, items []graphMessage) error {
	listed := make(map[string]graphMessage, len(items))
	changes := make([]api.FlagChange, 0, len(items))
	for _, item := range items {
		if _, dup := listed[item.ID]; dup {
			continue
		}
		listed[item.ID] = item
		changes = append(changes, api.FlagChange{RemoteUID: item.ID, Flags: item.flags()})
	}
	return s.ingest.ApplyFlags(ctx, run.folder.RemoteName, changes, s.fetcher(listed, providersync.NewMessageCache(providersync.DefaultCacheSize)))
}

// datedPage lists the next page below the cursor's BackfillBefore. before is where the page after it starts, "" when
// this was the last one. Messages without a receive time on the page come with it (their date falls back to when
// they were created); they cannot mark where a page ends.
func (s *session) datedPage(ctx context.Context, run *folderRun) (batch []graphMessage, before string, err error) {
	filter := ""
	if run.cursor.BackfillBefore != "" {
		filter = "receivedDateTime lt " + run.cursor.BackfillBefore
	}
	size := max(1, min(s.opts.BackfillPageSize, maxPageSize))
	listing, err := s.graph.messagesPage(ctx, listLink(run.folder.RemoteName, filter, size, true), false)
	if err != nil {
		return nil, "", err
	}
	// Graph may return fewer messages than asked for, even none or only undated ones, while more follow: only a
	// missing next link ends the folder. Without a dated message to continue below, its own next link is followed.
	var dated []graphMessage
	link := listing.NextLink
	for {
		for _, item := range listing.Value {
			if item.ReceivedDateTime.IsZero() {
				batch = append(batch, item)
			} else {
				dated = append(dated, item)
			}
		}
		if len(dated) > 0 || link == "" {
			break
		}
		if listing, err = s.graph.messagesPage(ctx, link, false); err != nil {
			return nil, "", err
		}
		link = listing.NextLink
	}
	if link == "" {
		return append(batch, dated...), "", nil
	}

	oldest := dated[0].ReceivedDateTime
	for _, item := range dated {
		if item.ReceivedDateTime.Before(oldest) {
			oldest = item.ReceivedDateTime
		}
	}
	at := graphTime(oldest)
	for _, item := range dated {
		if item.ReceivedDateTime.After(oldest) {
			batch = append(batch, item)
		}
	}
	same, err := s.allMessages(ctx, listLink(run.folder.RemoteName, "receivedDateTime eq "+at, maxPageSize, true))
	if err != nil {
		return nil, "", err
	}
	return append(batch, same...), at, nil
}

// completeFolder ingests what the backfill's time-cut pages could not reach: messages without a receive time, which
// no time filter matches, or any other gap. It lists the folder once by position and ingests the messages the API
// does not have in it. Positional pages can skip a message deleted meanwhile, but a skipped one was ingested by the
// pages before, and anything that changes from here on comes through the delta query.
func (s *session) completeFolder(ctx context.Context, run *folderRun) error {
	stored, err := s.ingest.Stored(ctx, run.folder.RemoteName)
	if err != nil {
		return err
	}
	var missing []graphMessage
	link := listLink(run.folder.RemoteName, "", maxPageSize, false)
	for link != "" {
		page, err := s.graph.messagesPage(ctx, link, false)
		if err != nil {
			return err
		}
		for _, item := range page.Value {
			if !stored[item.ID] {
				missing = append(missing, item)
			}
		}
		link = page.NextLink
	}
	if len(missing) > 0 {
		s.logger.Info("backfill completed with messages the time-cut pages missed", "folder", run.folder.RemoteName, "messages", len(missing))
	}
	return s.applyListed(ctx, run, missing)
}

// allMessages follows a listing's pages to the end. It is only used for the messages of one receive time, a set that
// fits a page or two.
func (s *session) allMessages(ctx context.Context, link string) ([]graphMessage, error) {
	var all []graphMessage
	for link != "" {
		page, err := s.graph.messagesPage(ctx, link, false)
		if err != nil {
			return nil, err
		}
		all = append(all, page.Value...)
		link = page.NextLink
	}
	return all, nil
}

// listLink lists a folder, newest first when ordered. Graph requires a filtered property to lead the ordering, which
// it does.
func listLink(folderID, filter string, top int, ordered bool) string {
	link := "/me/mailFolders/" + url.PathEscape(folderID) + "/messages?$select=" + messageFields + "&$top=" + strconv.Itoa(top)
	if filter != "" {
		link += "&$filter=" + queryEscape(filter)
	}
	if ordered {
		link += "&$orderby=receivedDateTime%20desc"
	}
	return link
}

// graphTime formats a receive time as an OData date-time literal, keeping any fraction Graph reported.
func graphTime(t time.Time) string {
	return t.UTC().Format(time.RFC3339Nano)
}
