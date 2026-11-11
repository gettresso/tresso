// Package imapsync keeps one IMAP account in sync: folders, new mail, history (newest first), flag changes and
// removals, with IDLE for instant new mail. All state lives in the API, so any worker can pick up any account.
package imapsync

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"

	"tresso/sync/internal/api"
	"tresso/sync/internal/isolate"
	"tresso/sync/internal/storage"
)

type imapFetchBuffer = imapclient.FetchMessageBuffer

// API is the part of the internal API the syncer uses.
type API interface {
	Credentials(ctx context.Context, accountID, workerID string) (api.Credentials, error)
	Folders(ctx context.Context, accountID, workerID string, folders []api.Folder) ([]api.FolderState, error)
	Messages(ctx context.Context, accountID string, batch api.MessageBatch) (api.MessageBatchResult, error)
	Changes(ctx context.Context, accountID string, batch api.ChangeBatch) (api.ChangeBatchResult, error)
	Status(ctx context.Context, accountID, workerID, status, detail string) error
}

type Options struct {
	FetchBatch             int           // messages per fetch and ingest request
	MaxBatchBytes          int64         // raw bytes per fetch
	BackfillBatchesPerPass int           // history batches per folder per pass, so new mail never waits long
	PresenceChunk          int           // UIDs per presence range
	PollInterval           time.Duration // full pass over all folders
	PresenceInterval       time.Duration // how often a folder's deletions are checked
	// Without CONDSTORE, an IDLE update can only be followed up by a full inbox check; at most this often.
	UpdatePresenceInterval time.Duration
	StatusInterval         time.Duration // how often a healthy account reports itself
	MinBackoff, MaxBackoff time.Duration
	FailuresBeforeError    int // consecutive failed sessions before the user sees an error
	// Consecutive logins refused without a response code before they count as a wrong password (auth_failed). With
	// the backoff this spans about half a minute, so a short outage of the server's login backend does not stop the
	// account.
	RefusalsBeforeAuthFailed int
}

func DefaultOptions() Options {
	return Options{
		FetchBatch:               50,
		MaxBatchBytes:            20 << 20,
		BackfillBatchesPerPass:   10,
		PresenceChunk:            5000,
		PollInterval:             5 * time.Minute,
		PresenceInterval:         30 * time.Minute,
		UpdatePresenceInterval:   time.Minute,
		StatusInterval:           5 * time.Minute,
		MinBackoff:               2 * time.Second,
		MaxBackoff:               5 * time.Minute,
		FailuresBeforeError:      3,
		RefusalsBeforeAuthFailed: 5,
	}
}

type Syncer struct {
	api      API
	store    storage.Blobs
	dialer   Dialer
	workerID string
	opts     Options
	logger   *slog.Logger
	// now is the clock of the strikes and the placeholders' retries (see package isolate).
	now func() time.Time
}

func New(client API, store storage.Blobs, d Dialer, workerID string, opts Options, logger *slog.Logger) *Syncer {
	return &Syncer{api: client, store: store, dialer: d, workerID: workerID, opts: opts, logger: logger, now: time.Now}
}

// Run keeps the account in sync until ctx ends (the lease was lost or the worker stops). A refused login is reported
// and ends the run: the account stops being leased until the user fixes the credentials. A login refused without a
// response code only counts as refused once it repeats RefusalsBeforeAuthFailed times in a row.
func (s *Syncer) Run(ctx context.Context, account api.Account) error {
	logger := s.logger.With("account", account.ID)
	backoff := s.opts.MinBackoff
	failures := 0
	reported := false // whether the API took the error status of the current run of failures
	refusals := 0
	strikes := isolate.NewStrikesWithClock(s.now)

	for {
		healthy, err := s.runSession(ctx, account, strikes, logger)
		if ctx.Err() != nil {
			return nil
		}
		if errors.Is(err, errLoginRefused) {
			refusals++
			if refusals >= max(1, s.opts.RefusalsBeforeAuthFailed) {
				err = fmt.Errorf("%w: %w", ErrAuth, err)
			}
		} else {
			refusals = 0
		}
		if errors.Is(err, ErrAuth) {
			logger.Warn("login refused, account needs new credentials")
			s.report(ctx, account, api.StatusAuthFailed, userFacingDetail(err), logger)
			return nil
		}
		if healthy {
			failures, backoff, reported = 0, s.opts.MinBackoff, false
		}
		failures++
		logger.Warn("sync session ended", "error", err, "retryIn", backoff)
		// Reported until the API took it: a lost report would leave the account looking fine while it fails.
		if failures >= s.opts.FailuresBeforeError && !reported {
			reported = s.report(ctx, account, api.StatusError, userFacingDetail(err), logger) == nil
		}

		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, s.opts.MaxBackoff)
	}
}

// report sends an account status; a failure is logged and returned.
func (s *Syncer) report(ctx context.Context, account api.Account, status, detail string, logger *slog.Logger) error {
	err := s.api.Status(ctx, account.ID, s.workerID, status, detail)
	if err != nil && ctx.Err() == nil {
		logger.Warn("reporting account status failed", "status", status, "error", err)
	}
	return err
}

type session struct {
	*Syncer
	account   api.Account
	client    *connection
	condStore bool
	events    *serverEvents
	strikes   *isolate.Strikes // messages that failed in earlier sessions of this run
	runs      []*folderRun
	logger    *slog.Logger
}

// runSession connects, syncs everything once, then follows changes until an error. healthy reports whether the
// initial pass completed, so a later disconnect does not count towards the error threshold.
func (s *Syncer) runSession(ctx context.Context, account api.Account, strikes *isolate.Strikes, logger *slog.Logger) (healthy bool, err error) {
	creds, err := s.api.Credentials(ctx, account.ID, s.workerID)
	if err != nil {
		return false, err
	}
	password, err := creds.Password()
	if err != nil {
		return false, err
	}

	events := newServerEvents()
	client, err := connect(ctx, s.dialer, creds.Connection.IMAP, creds.Connection.Username, password, events)
	if err != nil {
		return false, err
	}
	defer func() {
		_ = client.Logout().Wait()
		_ = client.Close()
	}()

	sess := &session{Syncer: s, account: account, client: client, events: events, strikes: strikes, logger: logger}
	sess.condStore = client.Caps().Has(imap.CapCondStore)

	if err := sess.refreshFolders(ctx); err != nil {
		return false, err
	}
	if err := sess.pass(ctx, true); err != nil {
		return false, err
	}
	s.report(ctx, account, api.StatusActive, "", logger)
	logger.Info("account in sync", "folders", len(sess.runs), "condstore", sess.condStore)

	return true, sess.follow(ctx)
}

// follow waits for changes (IDLE on the inbox, or polling) and syncs what changed.
func (s *session) follow(ctx context.Context) error {
	lastStatus := time.Now()
	nextPoll := time.Now().Add(s.opts.PollInterval)
	// Without CONDSTORE an inbox update needs a full check. When one ran less than UpdatePresenceInterval ago, the
	// check is postponed to this moment instead of being dropped.
	var inboxCheckDue time.Time

	for {
		if s.backfillPending() {
			if err := s.pass(ctx, false); err != nil {
				return err
			}
			continue
		}

		deadline := nextPoll
		if !inboxCheckDue.IsZero() && inboxCheckDue.Before(deadline) {
			deadline = inboxCheckDue
		}
		reason, err := s.wait(ctx, time.Until(deadline))
		if err != nil {
			return err
		}
		now := time.Now()
		inbox := s.inbox()

		switch {
		case reason == wakeUpdate && inbox != nil:
			// With CONDSTORE flag changes need no full check, but an expunge does: only the UID list shows it. Without
			// CONDSTORE every update gets a full check anyway, throttled below.
			expunged := s.events.expunged.Swap(false)
			full := s.condStoreIn(inbox) && expunged
			if !s.condStoreIn(inbox) {
				if due := inbox.lastPresence.Add(s.opts.UpdatePresenceInterval); now.Before(due) {
					inboxCheckDue = due
				} else {
					full, inboxCheckDue = true, time.Time{}
				}
			}
			if err := s.syncFolderOrRefresh(ctx, inbox, full); err != nil {
				return err
			}
		case !inboxCheckDue.IsZero() && !now.Before(inboxCheckDue) && now.Before(nextPoll) && inbox != nil:
			inboxCheckDue = time.Time{}
			if err := s.syncFolderOrRefresh(ctx, inbox, true); err != nil {
				return err
			}
		case !now.Before(nextPoll):
			if err := s.refreshFolders(ctx); err != nil {
				return err
			}
			if err := s.pass(ctx, false); err != nil {
				return err
			}
			if inbox := s.inbox(); inbox != nil && !inboxCheckDue.IsZero() {
				inboxCheckDue = time.Time{}
				if err := s.syncFolderOrRefresh(ctx, inbox, true); err != nil {
					return err
				}
			}
			nextPoll = time.Now().Add(s.opts.PollInterval)
		}

		if time.Since(lastStatus) >= s.opts.StatusInterval {
			s.report(ctx, s.account, api.StatusActive, "", s.logger)
			lastStatus = time.Now()
		}
	}
}

// pass syncs every folder once; deletions are checked when forced or when a folder's last check is old enough.
func (s *session) pass(ctx context.Context, forcePresence bool) error {
	for _, run := range s.runs {
		if run.unavailable {
			continue
		}
		full := forcePresence || time.Since(run.lastPresence) >= s.opts.PresenceInterval
		if err := s.syncFolderOrRefresh(ctx, run, full); err != nil {
			return err
		}
	}
	return nil
}

func (s *session) syncFolderOrRefresh(ctx context.Context, run *folderRun, full bool) error {
	err := s.syncFolder(ctx, run, full)
	if errors.Is(err, errFoldersChanged) {
		s.logger.Info("folder was reset on the server", "folder", run.folder.RemoteName)
		return s.refreshFolders(ctx)
	}
	if errors.Is(err, errFolderUnavailable) {
		s.logger.Warn("the server refused to open a folder; skipping it until the folder list is read again", "folder", run.folder.RemoteName, "error", err)
		run.unavailable = true
		return nil
	}
	return err
}

// refreshFolders reports the folder list and rebuilds the runs from what the API stored.
func (s *session) refreshFolders(ctx context.Context) error {
	folders, unreadable, err := listFolders(s.client.Client)
	if err != nil {
		return err
	}
	for name, err := range unreadable {
		s.logger.Warn("the server refused the status of a folder; leaving it out", "folder", name, "error", err)
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
	}

	runs := make([]*folderRun, 0, len(folders))
	for _, folder := range folders {
		run := &folderRun{folder: folder}
		state := stateOf[folder.RemoteName]
		if !state.Reset {
			cursor, err := DecodeCursor(state.Cursor)
			if err != nil {
				s.logger.Warn("unreadable cursor, restarting folder", "folder", folder.RemoteName, "error", err)
			}
			run.cursor = cursor
		}
		if old, ok := previous[folder.RemoteName]; ok && !state.Reset {
			run.lastPresence = old.lastPresence
		}
		runs = append(runs, run)
	}
	s.runs = runs
	return nil
}

func (s *session) backfillPending() bool {
	for _, run := range s.runs {
		if run.unavailable {
			continue
		}
		if run.cursor == nil || !run.cursor.BackfillDone() {
			return true
		}
	}
	return false
}

func (s *session) inbox() *folderRun {
	for _, run := range s.runs {
		if run.folder.Role == "inbox" && !run.unavailable {
			return run
		}
	}
	return nil
}

type wakeReason int

const (
	wakePoll wakeReason = iota
	wakeUpdate
)

// noIdlePollInterval is how often a server without IDLE is asked for news (NOOP) between full passes.
const noIdlePollInterval = time.Minute

// wait blocks until the server reports news for the inbox, the poll time arrives, or ctx ends.
func (s *session) wait(ctx context.Context, untilPoll time.Duration) (wakeReason, error) {
	if untilPoll <= 0 {
		return wakePoll, nil
	}
	timer := time.NewTimer(untilPoll)
	defer timer.Stop()

	inbox := s.inbox()
	if inbox == nil {
		select {
		case <-ctx.Done():
			return wakePoll, ctx.Err()
		case <-timer.C:
			return wakePoll, nil
		}
	}
	sel, err := s.client.Select(inbox.folder.RemoteName, &imap.SelectOptions{ReadOnly: true, CondStore: s.condStore}).Wait()
	if err != nil {
		return wakePoll, err
	}
	// Changes between the last sync and this SELECT arrive as part of the SELECT response, not as notifications.
	if stateOf(sel) != inbox.seen {
		return wakeUpdate, nil
	}

	if !s.client.Caps().Has(imap.CapIdle) {
		ticker := time.NewTicker(noIdlePollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return wakePoll, ctx.Err()
			case <-timer.C:
				return wakePoll, nil
			case <-s.events.updates:
				return wakeUpdate, nil
			case <-ticker.C:
				if err := s.client.Noop().Wait(); err != nil {
					return wakePoll, err
				}
			}
		}
	}

	idle, err := s.client.Idle()
	if err != nil {
		return wakePoll, err
	}
	reason := wakePoll
	select {
	case <-ctx.Done():
	case <-timer.C:
	case <-s.events.updates:
		reason = wakeUpdate
	case <-s.client.Closed():
		return wakePoll, errors.New("connection closed by server")
	}
	if err := idle.Close(); err != nil && ctx.Err() == nil {
		return wakePoll, err
	}
	return reason, ctx.Err()
}
