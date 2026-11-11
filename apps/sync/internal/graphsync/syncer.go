// Package graphsync keeps one Microsoft 365 or Outlook.com mailbox in sync through Microsoft Graph: the folder tree,
// existing mail (newest first), then changes from each folder's delta query. All state lives in the API, so any worker
// can pick up any account.
//
// Messages are identified by their immutable id, which stays the same when a message moves: a move shows up as a
// removal in one folder's delta and an addition in another's. The addition is always applied first, so the message
// never loses its last location and is not deleted. The API keeps locations per folder, so the folder it moved to
// does not know the id yet: its MIME is downloaded once more and the API links it to the stored message by
// Message-ID (object storage keeps a single copy).
//
// Send delivers outgoing mail through Graph; the outbox dispatcher uses it (through outbox.GraphTransport) for
// accounts of provider "microsoft".
package graphsync

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/ingestmsg"
	"tresso/sync/internal/isolate"
	"tresso/sync/internal/providerauth"
	"tresso/sync/internal/providerhttp"
	"tresso/sync/internal/providersync"
	"tresso/sync/internal/storage"
)

type Options struct {
	Client               ClientOptions
	FetchConcurrency     int           // raw downloads in flight; Outlook allows 4 concurrent requests per mailbox
	FetchBatch           int           // raw messages per ingest request
	BackfillPageSize     int           // messages per backfill page
	BackfillPagesPerPass int           // backfill pages per folder between two delta rounds, so new mail never waits long
	InboxInterval        time.Duration // delta query of the inbox
	PollInterval         time.Duration // delta query of the other folders, and the folder tree
	StatusInterval       time.Duration // how often a healthy account reports itself
	// DeltaLinkMaxAge is how long a quiet folder keeps its stored delta link before a fresh one is stored, so the
	// stored token never ages out at Graph.
	DeltaLinkMaxAge time.Duration
	providersync.RunOptions
}

func DefaultOptions() Options {
	return Options{
		Client:               DefaultClientOptions(),
		FetchConcurrency:     4,
		FetchBatch:           50,
		BackfillPageSize:     50,
		BackfillPagesPerPass: 5,
		InboxInterval:        30 * time.Second,
		PollInterval:         5 * time.Minute,
		StatusInterval:       5 * time.Minute,
		DeltaLinkMaxAge:      24 * time.Hour,
		RunOptions: providersync.RunOptions{
			MinBackoff:          2 * time.Second,
			MaxBackoff:          5 * time.Minute,
			FailuresBeforeError: 3,
		},
	}
}

type Syncer struct {
	api      providersync.API
	store    storage.Blobs
	workerID string
	opts     Options
	logger   *slog.Logger
}

func New(client providersync.API, store storage.Blobs, workerID string, opts Options, logger *slog.Logger) *Syncer {
	return &Syncer{api: client, store: store, workerID: workerID, opts: opts, logger: logger}
}

// Run keeps the account in sync until ctx ends (the lease was lost or the worker stops). Lost access is reported and
// ends the run: the account stops being leased until the user signs in with Microsoft again.
func (s *Syncer) Run(ctx context.Context, account api.Account) error {
	logger := s.logger.With("account", account.ID)
	strikes := isolate.NewStrikes()
	return providersync.Run(ctx, s.api, account, s.workerID, "Microsoft", s.opts.RunOptions, logger, func(ctx context.Context) (bool, error) {
		return s.runSession(ctx, account, strikes, logger)
	})
}

type folderRun struct {
	folder   api.Folder
	cursor   *Cursor
	nextPoll time.Time
	storedAt time.Time // when this session last stored the cursor; zero when it came from the API
	// startLink is where the folder's interrupted first delta walk continues; "" to start it from the beginning.
	startLink string
	// denied is set when Graph refused this folder's messages (403 ErrorAccessDenied: a folder the user lost access
	// to). The folder is left alone until the folder tree is read again.
	denied bool
}

type session struct {
	*Syncer
	account api.Account
	graph   *Client
	ingest  *providersync.Ingest
	logger  *slog.Logger
	runs    []*folderRun
}

func (s *Syncer) runSession(ctx context.Context, account api.Account, strikes *isolate.Strikes, logger *slog.Logger) (healthy bool, err error) {
	sess := s.newSession(account, strikes, logger)

	if err := sess.refreshFolders(ctx); err != nil {
		return false, err
	}
	if err := sess.step(ctx, true); err != nil {
		return false, err
	}
	providersync.Report(ctx, s.api, account.ID, s.workerID, api.StatusActive, "", logger)
	logger.Info("account in sync", "folders", len(sess.runs))

	return true, sess.follow(ctx)
}

func (s *Syncer) newSession(account api.Account, strikes *isolate.Strikes, logger *slog.Logger) *session {
	tokens := providerauth.New(s.api, account.ID, s.workerID)
	return &session{
		Syncer:  s,
		account: account,
		graph:   NewClient(tokens, s.opts.Client),
		ingest:  &providersync.Ingest{API: s.api, AccountID: account.ID, WorkerID: s.workerID, FetchBatch: s.opts.FetchBatch, Strikes: strikes, Logger: logger, Store: s.store},
		logger:  logger,
	}
}

// step starts folders without a cursor, runs a delta round (of every folder when all is set, else of the folders that
// are due), then continues the backfill. Every folder's existing mail comes in through its checkpointed newest-first
// backfill, also when the folder appears next to folders already in sync (round rescues mail moved into it).
func (s *session) step(ctx context.Context, all bool) error {
	// One folder's first delta walk per step, in list order (the inbox first): a large folder can take thousands of
	// requests to walk, and the folders already started (the inbox above all) keep being polled and backfilled in
	// between.
	for _, run := range s.runs {
		if run.cursor == nil && !run.denied {
			if err := s.start(ctx, run); s.deny(run, err) != nil {
				return err
			}
			break
		}
	}
	now := time.Now()
	var due []*folderRun
	for _, run := range s.runs {
		if run.cursor != nil && !run.denied && (all || !now.Before(run.nextPoll)) {
			due = append(due, run)
		}
	}
	if err := s.round(ctx, due); err != nil {
		return err
	}
	for _, run := range s.runs {
		if run.cursor != nil && !run.denied && !run.cursor.BackfillDone {
			if err := s.backfill(ctx, run); s.deny(run, err) != nil {
				return err
			}
		}
	}
	for _, run := range s.runs {
		if run.cursor != nil && !run.denied {
			if err := s.retryPlaceholders(ctx, run); s.deny(run, err) != nil {
				return err
			}
		}
	}
	return nil
}

// retryPlaceholders tries the messages of the folder's due placeholders again (see
// providersync.Ingest.RetryPlaceholders), in the folder the message is in now.
func (s *session) retryPlaceholders(ctx context.Context, run *folderRun) error {
	folder := run.folder.RemoteName
	return s.ingest.RetryPlaceholders(ctx, folder, func(ctx context.Context, id string) (*api.Message, []string, error) {
		item, err := s.graph.message(ctx, id)
		if providerhttp.IsStatus(err, http.StatusNotFound) {
			return nil, nil, nil
		}
		if err != nil {
			return nil, nil, err
		}
		target := folder
		if item.ParentFolderID != folder {
			// Moved (in Tresso or at Microsoft): immutable ids keep the uid, so the placeholder, or the message the
			// delta of that folder brings, is there.
			if !s.knownFolder(item.ParentFolderID) {
				return nil, nil, nil
			}
			target = item.ParentFolderID
		}
		raw, err := s.graph.raw(ctx, id)
		if providerhttp.IsStatus(err, http.StatusNotFound) {
			return nil, nil, nil
		}
		if err != nil {
			return nil, nil, err
		}
		msg, err := ingestmsg.BuildFromExchange(ctx, s.store, s.account.ID, raw, id, item.receivedAt(), item.flags(), s.logger)
		if err != nil {
			return nil, nil, err
		}
		return &msg, []string{target}, nil
	})
}

// knownFolder reports whether id is a folder this session syncs.
func (s *session) knownFolder(id string) bool {
	for _, run := range s.runs {
		if run.folder.RemoteName == id && !run.denied {
			return true
		}
	}
	return false
}

// deny marks run as denied when err is Graph refusing access to the folder, and returns err otherwise. A folder the
// user lost access to must not stop the others, nor be taken for a mailbox Tresso may not read.
func (s *session) deny(run *folderRun, err error) error {
	if err == nil || !accessDenied(err) {
		return err
	}
	s.logger.Warn("Graph refused access to a folder; leaving it alone until the folder tree is read again", "folder", run.folder.RemoteName, "error", err)
	run.denied = true
	return nil
}

func (s *session) follow(ctx context.Context) error {
	lastStatus := time.Now()
	lastFolders := time.Now()

	for {
		if !s.backfillPending() {
			next := time.Now().Add(s.opts.PollInterval)
			for _, run := range s.runs {
				if !run.denied && run.nextPoll.Before(next) {
					next = run.nextPoll
				}
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Until(next)):
			}
		}
		if time.Since(lastFolders) >= s.opts.PollInterval {
			if err := s.refreshFolders(ctx); err != nil {
				return err
			}
			lastFolders = time.Now()
		}
		if err := s.step(ctx, false); err != nil {
			return err
		}
		if time.Since(lastStatus) >= s.opts.StatusInterval {
			providersync.Report(ctx, s.api, s.account.ID, s.workerID, api.StatusActive, "", s.logger)
			lastStatus = time.Now()
		}
	}
}

func (s *session) backfillPending() bool {
	for _, run := range s.runs {
		if run.denied {
			continue
		}
		if run.cursor == nil || !run.cursor.BackfillDone {
			return true
		}
	}
	return false
}

// refreshFolders reports the folder tree and rebuilds the runs. A folder the session already runs keeps its run (and
// cursor, which may be ahead of the stored one within a round); a new or reset folder starts from what the API stored.
func (s *session) refreshFolders(ctx context.Context) error {
	folders, denied, err := listFolders(ctx, s.graph)
	if err != nil {
		return err
	}
	for _, path := range denied {
		s.logger.Warn("Graph refused to list the subfolders of a folder; leaving them out", "folder", path)
	}
	states, err := s.api.Folders(ctx, s.account.ID, s.workerID, folders)
	if err != nil {
		return err
	}

	previous := make(map[string]*folderRun, len(s.runs))
	for _, run := range s.runs {
		previous[run.folder.RemoteName] = run
	}
	stateOf := make(map[string]api.FolderState, len(states))
	for _, state := range states {
		stateOf[state.RemoteName] = state
		s.ingest.Load(state.RemoteName, state.Cursor)
	}

	runs := make([]*folderRun, 0, len(folders))
	for _, folder := range folders {
		state := stateOf[folder.RemoteName]
		if old, ok := previous[folder.RemoteName]; ok && !state.Reset && old.cursor != nil {
			old.folder = folder // a rename changes the display name only
			old.denied = false  // tried again with every new folder tree
			runs = append(runs, old)
			continue
		}
		run := &folderRun{folder: folder}
		if !state.Reset {
			cursor, err := DecodeCursor(state.Cursor)
			if err != nil {
				s.logger.Warn("unreadable cursor, restarting folder", "folder", folder.RemoteName, "error", err)
			}
			if cursor != nil && !cursor.Started() {
				run.startLink = cursor.StartLink
				cursor = nil
			}
			run.cursor = cursor
		}
		if old, ok := previous[folder.RemoteName]; ok && !state.Reset && run.cursor == nil && old.startLink != "" {
			run.startLink = old.startLink // stored by this session, maybe after the folder list was read
		}
		runs = append(runs, run)
	}
	s.runs = runs
	return nil
}

func (s *session) interval(run *folderRun) time.Duration {
	if run.folder.Role == "inbox" {
		return s.opts.InboxInterval
	}
	return s.opts.PollInterval
}

// start walks a new folder's delta query to its end, only to learn where changes start; the items are ingested by
// the checkpointed backfill, newest first. Asking for the synced properties here makes later delta rounds return
// them. Every startCheckpointPages pages the walk's position is stored, so a session that ends inside a large folder
// continues there; the cursor is stored right away at the end, so a session that fails later resumes this folder
// instead of starting it again.
func (s *session) start(ctx context.Context, run *folderRun) error {
	link := deltaStart(run.folder.RemoteName)
	resumed := run.startLink != ""
	if resumed {
		link = run.startLink
	}
	pages := 0
	checkpoint := func(next string) error {
		pages++
		if pages%startCheckpointPages != 0 {
			return nil
		}
		encoded, err := Cursor{StartLink: s.graph.relative(next)}.Encode()
		if err != nil {
			// A link too long to store only costs the checkpoint.
			s.logger.Warn("delta walk position not stored", "folder", run.folder.RemoteName, "error", err)
			return nil
		}
		if err := s.ingest.StoreCursor(ctx, run.folder.RemoteName, encoded); err != nil {
			return err
		}
		run.startLink = s.graph.relative(next)
		return nil
	}
	deltaLink, err := s.walkDeltaPages(ctx, link, func([]graphMessage) {}, checkpoint)
	if resumed && startLinkRefused(err) {
		s.logger.Info("stored delta walk position refused, walking the folder from the start", "folder", run.folder.RemoteName, "error", err)
		run.startLink = ""
		deltaLink, err = s.walkDeltaPages(ctx, deltaStart(run.folder.RemoteName), func([]graphMessage) {}, checkpoint)
	}
	if err != nil {
		return err
	}
	cursor := &Cursor{DeltaLink: deltaLink}
	encoded, err := cursor.Encode()
	if err != nil {
		return err
	}
	if err := s.ingest.StoreCursor(ctx, run.folder.RemoteName, encoded); err != nil {
		return err
	}
	run.cursor, run.storedAt, run.startLink = cursor, time.Now(), ""
	run.nextPoll = time.Now().Add(s.interval(run))
	s.logger.Info("starting folder from scratch", "folder", run.folder.RemoteName, "resumed", resumed)
	return nil
}

// startLinkRefused reports whether Graph refused a stored delta walk position: it expired, or Graph answers any 4xx
// for it other than the token (401), access (403) and throttling, which say nothing about the link.
func startLinkRefused(err error) bool {
	if deltaExpired(err) {
		return true
	}
	var statusErr *providerhttp.StatusError
	if !errors.As(err, &statusErr) || providerhttp.Throttled(err) || errors.Is(err, providerhttp.ErrUnauthorized) {
		return false
	}
	code := statusErr.StatusCode
	return code >= 400 && code < 500 && code != http.StatusUnauthorized && code != http.StatusForbidden
}

// startCheckpointPages is how many pages of a folder's first delta walk go between two stored positions.
const startCheckpointPages = 10

func deltaStart(folderID string) string {
	return "/me/mailFolders/" + url.PathEscape(folderID) + "/messages/delta?$select=" + messageFields
}

// walkDelta follows a delta query's pages to its end and returns the new delta link (relative). each receives the
// items of every page.
func (s *session) walkDelta(ctx context.Context, link string, each func([]graphMessage)) (deltaLink string, err error) {
	return s.walkDeltaPages(ctx, link, each, nil)
}

// walkDeltaPages is walkDelta that also hands every next link to next (when not nil) before following it.
func (s *session) walkDeltaPages(ctx context.Context, link string, each func([]graphMessage), next func(link string) error) (deltaLink string, err error) {
	for {
		page, err := s.graph.messagesPage(ctx, link, true)
		if err != nil {
			return "", err
		}
		each(page.Value)
		switch {
		case page.NextLink != "":
			link = page.NextLink
			if next != nil {
				if err := next(link); err != nil {
					return "", err
				}
			}
		case page.DeltaLink != "":
			return s.graph.relative(page.DeltaLink), nil
		default:
			return "", errNoDeltaLink
		}
	}
}

// fetcher downloads, stores and describes messages for the ingest helper, FetchConcurrency at a time, using the flags
// and dates Graph listed. Messages deleted meanwhile are left out. A message that several folders of a round lack is
// built once while it stays in the bounded cache. A message Graph keeps refusing is replaced by a placeholder once it
// failed often enough (see package isolate); until then the session ends with its error.
func (s *session) fetcher(listed map[string]graphMessage, built *providersync.MessageCache) providersync.Fetcher {
	return func(ctx context.Context, ids []string) ([]api.Message, error) {
		got := make(map[string]api.Message, len(ids))
		var mu sync.Mutex
		var missing []string
		for _, id := range ids {
			if msg, ok := built.Get(id); ok {
				got[id] = msg
			} else {
				missing = append(missing, id)
			}
		}
		var failed []providersync.UnreadableMessage
		err := s.each(ctx, missing, func(ctx context.Context, id string) error {
			raw, err := s.graph.raw(ctx, id)
			if providerhttp.IsStatus(err, http.StatusNotFound) {
				return nil
			}
			item := listed[id]
			if err != nil && providersync.AboutMessage(err) {
				mu.Lock()
				failed = append(failed, providersync.UnreadableMessage{ID: id, ReceivedAt: item.receivedAt(), Flags: item.flags(), Err: err})
				mu.Unlock()
				return nil
			}
			if err != nil {
				return err
			}
			msg, err := ingestmsg.BuildFromExchange(ctx, s.store, s.account.ID, raw, id, item.receivedAt(), item.flags(), s.logger)
			if err != nil {
				return err
			}
			built.Put(id, msg)
			mu.Lock()
			got[id] = msg
			mu.Unlock()
			return nil
		})
		if err != nil {
			return nil, err
		}
		if len(failed) > 0 {
			// Immutable ids name a message in the whole mailbox, so failures are counted once, not per folder.
			placeholders, err := s.ingest.Unreadable(ctx, s.store, unreadableFolder, failed, len(got))
			if err != nil {
				return nil, err
			}
			for _, msg := range placeholders {
				built.Put(msg.RemoteUID, msg)
				got[msg.RemoteUID] = msg
			}
		}
		messages := make([]api.Message, 0, len(ids))
		for _, id := range ids {
			if msg, ok := got[id]; ok {
				// The flags are this folder's listing, also for a message built for another folder.
				if item, listedHere := listed[id]; listedHere {
					msg.Flags = item.flags()
				}
				messages = append(messages, msg)
			}
		}
		return messages, nil
	}
}

// unreadableFolder is where the failures of messages Graph would not hand over are counted: ids are mailbox-wide.
const unreadableFolder = "graph:messages"

// each runs fn for every id with at most FetchConcurrency in flight, and stops at the first error.
func (s *session) each(ctx context.Context, ids []string, fn func(ctx context.Context, id string) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	work := make(chan string)
	var wg sync.WaitGroup
	var once sync.Once
	var first error
	for range max(1, s.opts.FetchConcurrency) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for id := range work {
				if err := fn(ctx, id); err != nil {
					once.Do(func() { first = err; cancel() })
				}
			}
		}()
	}
	for _, id := range ids {
		select {
		case work <- id:
		case <-ctx.Done():
		}
		if ctx.Err() != nil {
			break
		}
	}
	close(work)
	wg.Wait()
	if first != nil {
		return first
	}
	return ctx.Err()
}
