// Package gmailsync keeps one Gmail account in sync through the Gmail API: labels as folders, history (newest first),
// then changes from Gmail's account-wide history. All state lives in the API, so any worker can pick up any account.
//
// Labels are folders (remote name = label id), plus the virtual folder "tresso:all" for every message outside Trash
// and Spam. A message's remote uid is its Gmail id in every folder. Flag changes of messages a folder already has
// need no download. The API keeps locations per folder, so a label added to a message is a location that folder does
// not know yet: its MIME is downloaded again and the API links it to the stored message by Message-ID (object storage
// keeps a single copy). Within one round a message is downloaded once, however many folders lack it.
//
// Send delivers outgoing mail through the Gmail API; the outbox dispatcher uses it (through outbox.GmailTransport) for
// accounts of provider "gmail".
package gmailsync

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
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
	GetConcurrency       int           // messages.get calls in flight
	FetchBatch           int           // raw messages per ingest request
	ListPageSize         int           // message ids per backfill page
	BackfillPagesPerPass int           // backfill pages between two history checks, so new mail never waits long
	ChangeChunk          int           // touched messages handled at once in a history round
	PollInterval         time.Duration // history check; cheap, so often
	FolderInterval       time.Duration // label list refresh (renamed or new labels that history does not mention)
	StatusInterval       time.Duration // how often a healthy account reports itself
	providersync.RunOptions
}

func DefaultOptions() Options {
	return Options{
		Client:               DefaultClientOptions(),
		GetConcurrency:       8,
		FetchBatch:           50,
		ListPageSize:         100,
		BackfillPagesPerPass: 5,
		ChangeChunk:          1000,
		PollInterval:         30 * time.Second,
		FolderInterval:       5 * time.Minute,
		StatusInterval:       5 * time.Minute,
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
// ends the run: the account stops being leased until the user signs in with Google again.
func (s *Syncer) Run(ctx context.Context, account api.Account) error {
	logger := s.logger.With("account", account.ID)
	strikes := isolate.NewStrikes()
	return providersync.Run(ctx, s.api, account, s.workerID, "Google", s.opts.RunOptions, logger, func(ctx context.Context) (bool, error) {
		return s.runSession(ctx, account, strikes, logger)
	})
}

type session struct {
	*Syncer
	account api.Account
	gmail   *Client
	ingest  *providersync.Ingest
	logger  *slog.Logger

	labels   map[string]bool // every label id of the account, folder or not
	isFolder map[string]bool // remote names of the folders, including All Mail
	folders  []api.Folder
	cursor   *Cursor
}

func (s *Syncer) runSession(ctx context.Context, account api.Account, strikes *isolate.Strikes, logger *slog.Logger) (healthy bool, err error) {
	sess := s.newSession(account, strikes, logger)

	if err := sess.refreshFolders(ctx); err != nil {
		return false, err
	}
	if err := sess.step(ctx); err != nil {
		return false, err
	}
	providersync.Report(ctx, s.api, account.ID, s.workerID, api.StatusActive, "", logger)
	logger.Info("account in sync", "folders", len(sess.folders), "backfillDone", sess.cursor != nil && sess.cursor.BackfillDone)

	return true, sess.follow(ctx)
}

func (s *Syncer) newSession(account api.Account, strikes *isolate.Strikes, logger *slog.Logger) *session {
	tokens := providerauth.New(s.api, account.ID, s.workerID)
	return &session{
		Syncer:  s,
		account: account,
		gmail:   NewClient(tokens, s.opts.Client),
		ingest: &providersync.Ingest{
			API: s.api, AccountID: account.ID, WorkerID: s.workerID, FetchBatch: s.opts.FetchBatch, Strikes: strikes, Logger: logger, Store: s.store,
			PendingFolder: func(string) string { return allMailFolder },
		},
		logger: logger,
	}
}

// step does one unit of work: start the account when it has no cursor, check history, and continue the backfill.
func (s *session) step(ctx context.Context) error {
	if s.cursor == nil {
		if err := s.start(ctx); err != nil {
			return err
		}
	}
	if err := s.historyRound(ctx); err != nil {
		return err
	}
	if s.cursor != nil {
		if err := s.retryPlaceholders(ctx); err != nil {
			return err
		}
	}
	if s.cursor != nil && !s.cursor.BackfillDone {
		return s.backfill(ctx)
	}
	return nil
}

// start captures the current history id before anything is fetched, so mail arriving during the backfill is picked
// up by the next history check.
func (s *session) start(ctx context.Context) error {
	historyID, err := s.gmail.profile(ctx)
	if err != nil {
		return err
	}
	cursor := &Cursor{HistoryID: historyID}
	if err := s.storeCursor(ctx, cursor); err != nil {
		return err
	}
	s.cursor = cursor
	s.logger.Info("starting account from scratch", "historyId", historyID)
	return nil
}

// follow checks history every PollInterval; while the backfill runs it alternates backfill pages and history checks.
func (s *session) follow(ctx context.Context) error {
	lastStatus := time.Now()
	lastFolders := time.Now()

	for {
		if s.cursor != nil && s.cursor.BackfillDone {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(s.opts.PollInterval):
			}
		}
		if time.Since(lastFolders) >= s.opts.FolderInterval {
			if err := s.refreshFolders(ctx); err != nil {
				return err
			}
			lastFolders = time.Now()
		}
		if err := s.step(ctx); err != nil {
			return err
		}
		if time.Since(lastStatus) >= s.opts.StatusInterval {
			providersync.Report(ctx, s.api, s.account.ID, s.workerID, api.StatusActive, "", s.logger)
			lastStatus = time.Now()
		}
	}
}

// refreshFolders reports the label folders and reads the account cursor from All Mail.
func (s *session) refreshFolders(ctx context.Context) error {
	labels, err := s.gmail.labels(ctx)
	if err != nil {
		return err
	}
	folders := foldersFromLabels(labels)
	states, err := s.api.Folders(ctx, s.account.ID, s.workerID, folders)
	if err != nil {
		return err
	}

	s.labels = make(map[string]bool, len(labels))
	for _, l := range labels {
		s.labels[l.ID] = true
	}
	s.isFolder = make(map[string]bool, len(folders))
	for _, f := range folders {
		s.isFolder[f.RemoteName] = true
	}
	s.folders = folders

	for _, state := range states {
		if state.RemoteName != allMailFolder {
			continue
		}
		s.ingest.Load(allMailFolder, state.Cursor)
		switch {
		case state.Reset:
			s.cursor = nil
		case s.cursor == nil:
			cursor, err := DecodeCursor(state.Cursor)
			if err != nil {
				s.logger.Warn("unreadable cursor, starting the account from scratch", "error", err)
			}
			s.cursor = cursor
		}
	}
	return nil
}

func (s *session) storeCursor(ctx context.Context, cursor *Cursor) error {
	encoded, err := cursor.Encode()
	if err != nil {
		return err
	}
	return s.ingest.StoreCursor(ctx, allMailFolder, encoded)
}

// fetched is a message downloaded with format=raw and stored.
type fetched struct {
	labels  []string
	message api.Message
}

// fetchRaw downloads, stores and describes messages, GetConcurrency at a time. Messages deleted meanwhile are left
// out. Each raw message is dropped as soon as it is stored. A message Gmail keeps refusing (or hands over unreadable)
// is replaced by a placeholder, with its labels, date and flags when Gmail still answers those, once it failed often
// and long enough next to messages that came through (see package isolate); until then the session ends with its
// error. Throttling never counts.
func (s *session) fetchRaw(ctx context.Context, ids []string) (map[string]fetched, error) {
	out := make(map[string]fetched, len(ids))
	var failed []providersync.UnreadableMessage
	labelsOf := map[string][]string{}
	var mu sync.Mutex
	fail := func(ctx context.Context, id string, m message, err error) {
		if m.ID == "" {
			// What Gmail still says about the message dates and files its placeholder.
			if minimal, err := s.gmail.getMessage(ctx, id, "minimal"); err == nil {
				m = minimal
			}
		}
		mu.Lock()
		defer mu.Unlock()
		failed = append(failed, providersync.UnreadableMessage{ID: id, ReceivedAt: m.receivedAt(), Flags: flagsOf(m.LabelIDs), Err: err})
		labelsOf[id] = m.LabelIDs
	}
	err := s.each(ctx, ids, func(ctx context.Context, id string) error {
		m, err := s.gmail.getMessage(ctx, id, "raw")
		if providerhttp.IsStatus(err, http.StatusNotFound) {
			return nil
		}
		if err != nil && providersync.AboutMessage(err) {
			fail(ctx, id, message{}, err)
			return nil
		}
		if err != nil {
			return err
		}
		raw, err := decodeRaw(m.Raw)
		if err != nil {
			fail(ctx, id, m, fmt.Errorf("message %s: decode raw: %w", id, err))
			return nil
		}
		msg, err := ingestmsg.Build(ctx, s.store, s.account.ID, raw, id, m.receivedAt(), flagsOf(m.LabelIDs), s.logger)
		if err != nil {
			return err
		}
		mu.Lock()
		out[id] = fetched{labels: m.LabelIDs, message: msg}
		mu.Unlock()
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(failed) > 0 {
		// Gmail ids name a message in the whole account, so failures are counted on All Mail.
		placeholders, err := s.ingest.Unreadable(ctx, s.store, allMailFolder, failed, len(out))
		if err != nil {
			return nil, err
		}
		for _, msg := range placeholders {
			out[msg.RemoteUID] = fetched{labels: labelsOf[msg.RemoteUID], message: msg}
		}
	}
	return out, nil
}

// retryPlaceholders tries the messages of due placeholders again (see providersync.Ingest.RetryPlaceholders); they
// are all kept on All Mail.
func (s *session) retryPlaceholders(ctx context.Context) error {
	return s.ingest.RetryPlaceholders(ctx, allMailFolder, func(ctx context.Context, id string) (*api.Message, []string, error) {
		m, err := s.gmail.getMessage(ctx, id, "raw")
		if providerhttp.IsStatus(err, http.StatusNotFound) {
			return nil, nil, nil
		}
		if err != nil {
			return nil, nil, err
		}
		raw, err := decodeRaw(m.Raw)
		if err != nil {
			return nil, nil, fmt.Errorf("message %s: decode raw: %w", id, err)
		}
		msg, err := ingestmsg.Build(ctx, s.store, s.account.ID, raw, id, m.receivedAt(), flagsOf(m.LabelIDs), s.logger)
		if err != nil {
			return nil, nil, err
		}
		return &msg, foldersOf(m.LabelIDs, s.isFolder), nil
	})
}

// labelsOf fetches the current labels of messages (format=minimal); a deleted message maps to gone = true.
func (s *session) labelsOf(ctx context.Context, ids []string) (labels map[string][]string, gone map[string]bool, err error) {
	labels, gone = make(map[string][]string, len(ids)), map[string]bool{}
	var mu sync.Mutex
	err = s.each(ctx, ids, func(ctx context.Context, id string) error {
		m, err := s.gmail.getMessage(ctx, id, "minimal")
		mu.Lock()
		defer mu.Unlock()
		switch {
		case providerhttp.IsStatus(err, http.StatusNotFound):
			gone[id] = true
		case err != nil:
			return err
		default:
			labels[id] = m.LabelIDs
		}
		return nil
	})
	return labels, gone, err
}

// each runs fn for every id with at most GetConcurrency in flight, and stops at the first error.
func (s *session) each(ctx context.Context, ids []string, fn func(ctx context.Context, id string) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	work := make(chan string)
	var wg sync.WaitGroup
	var once sync.Once
	var first error
	for range max(1, s.opts.GetConcurrency) {
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

// fetcher downloads messages for the ingest helper, remembering what it built in this round (within the bounded
// cache): a new message is unknown in several folders (Inbox and All Mail) but downloaded once.
func (s *session) fetcher(built *providersync.MessageCache) providersync.Fetcher {
	return func(ctx context.Context, ids []string) ([]api.Message, error) {
		known := make(map[string]api.Message, len(ids))
		var missing []string
		for _, id := range ids {
			if msg, ok := built.Get(id); ok {
				known[id] = msg
			} else {
				missing = append(missing, id)
			}
		}
		got, err := s.fetchRaw(ctx, missing)
		if err != nil {
			return nil, err
		}
		for id, f := range got {
			built.Put(id, f.message)
			known[id] = f.message
		}
		messages := make([]api.Message, 0, len(ids))
		for _, id := range ids {
			if msg, ok := known[id]; ok {
				messages = append(messages, msg)
			}
		}
		return messages, nil
	}
}
