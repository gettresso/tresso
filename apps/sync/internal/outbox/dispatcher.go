// Package outbox does the account work users wait for: for each account this worker leases, it sends the mail that is
// due through the account's provider (SMTP for IMAP accounts, the Gmail API, Microsoft Graph), files a copy in Sent
// when the provider does not do so itself, reports the outcome, keeps the Drafts folder in step with the user's
// drafts, makes the user's changes to messages (read, flagged, moved) on the server, and sends the one-click
// unsubscribe requests (RFC 8058) the user asked for.
package outbox

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap/v2"

	"tresso/sync/internal/api"
	"tresso/sync/internal/gmailsync"
	"tresso/sync/internal/graphsync"
	"tresso/sync/internal/imapsync"
	"tresso/sync/internal/providerhttp"
	"tresso/sync/internal/providersend"
	"tresso/sync/internal/providersync"
	"tresso/sync/internal/smtpsend"
	"tresso/sync/internal/storage"
)

// API is the part of the internal API the dispatcher uses.
type API interface {
	Credentials(ctx context.Context, accountID, workerID string) (api.Credentials, error)
	ClaimOutbox(ctx context.Context, accountID, workerID string) ([]api.OutgoingMessage, error)
	ReportOutbox(ctx context.Context, accountID, messageID, workerID, outcome, errorText string, copiedToSent bool) error
	ClaimDrafts(ctx context.Context, accountID, workerID string) (api.DraftWork, error)
	ReportDraftFiled(ctx context.Context, accountID, draftID, workerID string, version int, messageID string) error
	ReportDraftRemoved(ctx context.Context, accountID, removalID, workerID string) error
	ClaimMailbox(ctx context.Context, accountID, workerID string) ([]api.MailboxChange, error)
	ReportMailbox(ctx context.Context, accountID, changeID, workerID, outcome, errorText, remoteUID string) error
	ClaimUnsubscribes(ctx context.Context, accountID, workerID string) ([]api.UnsubscribeRequest, error)
	ReportUnsubscribe(ctx context.Context, accountID, requestID, workerID, outcome, errorText string) error
}

// Unsubscriber sends one one-click unsubscribe request (see package unsubscribe). It is the same HTTP POST for every
// provider, so it needs no Sender. outcome is api.UnsubscribeDone, api.OutcomeRetry or api.OutcomeFailed; text is
// safe to show the user.
type Unsubscriber interface {
	Post(ctx context.Context, url string) (outcome, text string)
}

// SentStore is the account's Sent folder.
type SentStore interface {
	Contains(messageID string) (bool, error)
	Append(raw []byte, at time.Time) error
	Close()
}

// DraftsStore is the account's Drafts folder. Remove finds a copy by its Message-ID; a copy that is not there counts
// as removed.
type DraftsStore interface {
	AppendDraft(raw []byte, at time.Time) error
	Remove(messageID string) error
	Close()
}

// MailboxStore makes changes to the account's messages on the server.
//
// SetFlags on a copy that is gone needs nothing and succeeds. Move returns the copy's remote uid in the target folder
// ("" when unknown); a copy no longer in the source folder is ErrMessageGone (imapsync, gmailsync or graphsync's).
type MailboxStore interface {
	SetFlags(location api.MailboxLocation, seen, flagged *bool) error
	Move(source api.MailboxLocation, target, messageID string) (string, error)
	Close()
}

// OutgoingFinder is a SentStore that can tell whether an earlier attempt sent a message even when the provider gave
// the sent copy another Message-ID (Gmail and Graph may). raw is the message being sent, since the earliest an
// attempt can have been made. An error leaves the question open: the dispatcher then does not send, as sending could
// send twice.
type OutgoingFinder interface {
	SentBefore(message api.OutgoingMessage, raw []byte, since time.Time) (bool, error)
}

// providerAnswered reports whether a failed duplicate check is a definite answer from the provider: a refusal (4xx,
// not 429) that no retry changes. 429 and 5xx, also after providerhttp's retries, are like no answer at all
// (connection, timeout) or providersend.ErrNotDecided: the next attempt looks again.
func providerAnswered(err error) bool {
	var status *providerhttp.StatusError
	return errors.As(err, &status) && status.StatusCode >= 400 && status.StatusCode < 500 &&
		status.StatusCode != http.StatusTooManyRequests && !errors.Is(err, providersend.ErrNotDecided)
}

// Texts of an undecided duplicate check. They show in the outbox while the message waits, so only an attempt that
// ends the message says what to do; the others say it is being checked, or a user would send it again meanwhile and
// the next attempt would send the original as well.
const (
	// checkingText is the text of a retry that is not the last.
	checkingText = "Tresso is checking whether an earlier attempt already went out and will try again shortly."
	// undecidedText ends a message whose earlier attempt could not be checked.
	undecidedText = "Tresso could not check whether an earlier attempt already sent this message; it was not sent again. Check Sent and send it again if needed."
	// maySendText ends a message whose earlier attempt may still go out: its copy was still waiting to be sent.
	maySendText = "An earlier attempt may still be waiting in the Outbox and could still be delivered; it was not sent again. Check the Outbox and Sent before you send it again."
)

// finalText is the text that ends a message when its duplicate check stays undecided.
func finalText(err error) string {
	if errors.Is(err, providersend.ErrMaybeSending) {
		return maySendText
	}
	return undecidedText
}

// clockSkew is how much earlier than its id says a message may have been written, as clocks differ.
const clockSkew = 5 * time.Minute

// retrySpan bounds how long ago an earlier attempt can have been made when the message does not say when it was
// written: the API retries after 1, 5 and 15 minutes, 1 and 3 hours (about 4.5 hours with the claims in between).
const retrySpan = 8 * time.Hour

// earliestAttempt is the earliest time an attempt to send message can have been made. Its outbox id is a UUIDv7,
// made when the message was written, and no attempt comes before that.
func earliestAttempt(message api.OutgoingMessage, now time.Time) time.Time {
	if written, ok := providersend.UUIDv7Time(message.ID); ok {
		return written.Add(-clockSkew)
	}
	return now.Add(-retrySpan)
}

// ChangeScoped is a MailboxStore that keeps state while it makes one change (the Gmail store sends one request for a
// message that is in several of the change's folders). StartChange is called before each change, so nothing carries
// over from one change to the next: read, unread, read again are three requests.
type ChangeScoped interface {
	StartChange()
}

// Sender does one account's work during one run of the dispatcher, so what it sets up (a provider client with its
// access token and rate limit) is shared by every message and draft of the run.
type Sender interface {
	// Send delivers one outgoing message, raw being its MIME, to its envelope recipients. Failures are *smtpsend.Error
	// or *providersend.Error, which say whether sending again can help; any other error is retried.
	Send(ctx context.Context, message api.OutgoingMessage, raw []byte) error
	// OpenSent opens the account's Sent folder. For providers that file sent mail themselves it only needs to answer
	// Contains.
	OpenSent(ctx context.Context) (SentStore, error)
	// OpenDrafts opens the account's Drafts folder, creating it when there is none.
	OpenDrafts(ctx context.Context) (DraftsStore, error)
	// OpenMailbox opens what makes the user's changes to messages.
	OpenMailbox(ctx context.Context) (MailboxStore, error)
}

// Transport is how one provider's accounts send. Open prepares a run's Sender and fails when the credentials cannot
// send at all; it runs before anything is claimed, so work is only claimed by a worker that can actually do it.
type Transport interface {
	Open(credentials api.Credentials) (Sender, error)
}

type Dispatcher struct {
	api         API
	store       storage.Blobs
	transports  map[string]Transport // by account provider
	unsubscribe Unsubscriber
	workerID    string
	logger      *slog.Logger
	// now is the clock; tests replace it.
	now func() time.Time

	mu      sync.Mutex
	running map[string]*run
	// unsubscribing holds the runs of the unsubscribe lane, by account.
	unsubscribing map[string]*run
	wg            sync.WaitGroup
}

type run struct{ again bool }

func NewDispatcher(client API, store storage.Blobs, transports map[string]Transport, unsubscriber Unsubscriber, workerID string, logger *slog.Logger) *Dispatcher {
	return &Dispatcher{api: client, store: store, transports: transports, unsubscribe: unsubscriber, workerID: workerID, logger: logger, now: time.Now, running: map[string]*run{}, unsubscribing: map[string]*run{}}
}

// Trigger makes the account's due work go out, in two lanes: the mail users wait for (sending, drafts, changes to
// messages), and the unsubscribe requests, which wait on servers of strangers and so must never hold up the mail. Runs
// of one lane for one account never overlap: a trigger during a run makes that run go round once more, so nothing is
// missed and nothing is done twice by this worker.
func (d *Dispatcher) Trigger(ctx context.Context, accountID string) {
	d.lane(ctx, d.running, accountID, d.process)
	if d.unsubscribe != nil {
		d.lane(ctx, d.unsubscribing, accountID, func(ctx context.Context, accountID string) {
			d.unsubscribes(ctx, d.logger.With("account", accountID), accountID)
		})
	}
}

// lane runs work for the account, once more for every trigger during a run, never twice at once.
func (d *Dispatcher) lane(ctx context.Context, running map[string]*run, accountID string, work func(context.Context, string)) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if r, ok := running[accountID]; ok {
		r.again = true
		return
	}
	r := &run{again: true}
	running[accountID] = r
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		for {
			d.mu.Lock()
			if !r.again || ctx.Err() != nil {
				delete(running, accountID)
				d.mu.Unlock()
				return
			}
			r.again = false
			d.mu.Unlock()
			work(ctx, accountID)
		}
	}()
}

// Wait blocks until every run has finished.
func (d *Dispatcher) Wait() {
	d.wg.Wait()
}

func (d *Dispatcher) process(ctx context.Context, accountID string) {
	logger := d.logger.With("account", accountID)
	// Credentials first: a message is only claimed once this worker can actually send it.
	credentials, err := d.api.Credentials(ctx, accountID, d.workerID)
	if err != nil {
		logger.Warn("fetching credentials for sending failed", "error", err)
		return
	}
	transport, ok := d.transports[credentials.Provider]
	if !ok {
		logger.Error("cannot send for this provider", "provider", credentials.Provider)
		return
	}
	sender, err := transport.Open(credentials)
	if err != nil {
		logger.Error("account has no credentials to send with", "error", err)
		return
	}
	d.sendOutbox(ctx, logger, sender, credentials)
	d.fileDrafts(ctx, logger, sender, credentials)
	d.changeMailbox(ctx, logger, sender, credentials)
}

func (d *Dispatcher) sendOutbox(ctx context.Context, logger *slog.Logger, sender Sender, credentials api.Credentials) {
	messages, err := d.api.ClaimOutbox(ctx, credentials.AccountID, d.workerID)
	if err != nil {
		logger.Warn("claiming outgoing mail failed", "error", err)
		return
	}

	sent := &lazy[SentStore]{open: func() (SentStore, error) { return sender.OpenSent(ctx) }}
	defer sent.close()
	for _, message := range messages {
		d.deliver(ctx, logger.With("outgoing", message.ID), sender, credentials, sent, message)
	}
}

// fileDrafts appends the newest copy of each draft and only then removes the copy it replaces, so a failure halfway
// leaves an extra copy rather than none. A failed step is not reported: the claim expires and the work comes back.
func (d *Dispatcher) fileDrafts(ctx context.Context, logger *slog.Logger, sender Sender, credentials api.Credentials) {
	work, err := d.api.ClaimDrafts(ctx, credentials.AccountID, d.workerID)
	if err != nil {
		logger.Warn("claiming draft work failed", "error", err)
		return
	}
	if len(work.Files) == 0 && len(work.Removals) == 0 {
		return
	}
	folder := &lazy[DraftsStore]{open: func() (DraftsStore, error) { return sender.OpenDrafts(ctx) }}
	defer folder.close()
	drafts, err := folder.get()
	if err != nil {
		logger.Warn("opening the Drafts folder failed", "error", err)
		return
	}

	for _, file := range work.Files {
		fileLogger := logger.With("draft", file.DraftID, "version", file.Version)
		raw, err := d.store.Read(ctx, credentials.AccountID, file.RawObjectKey)
		if err != nil {
			fileLogger.Warn("reading the draft copy failed", "error", err)
			continue
		}
		if err := drafts.AppendDraft(raw, time.Now()); err != nil {
			fileLogger.Warn("filing the draft failed", "error", err)
			if accessLost(err) {
				return // every other step would be refused the same way
			}
			continue
		}
		if file.PreviousMessageID != nil {
			if err := drafts.Remove(*file.PreviousMessageID); err != nil {
				fileLogger.Warn("removing the previous draft copy failed; it is removed with the next version", "error", err)
				if accessLost(err) {
					return
				}
				continue
			}
		}
		if err := d.api.ReportDraftFiled(ctx, credentials.AccountID, file.DraftID, d.workerID, file.Version, file.MessageID); err != nil {
			fileLogger.Warn("reporting the filed draft failed", "error", err)
		}
	}
	for _, removal := range work.Removals {
		if err := drafts.Remove(removal.MessageID); err != nil {
			logger.Warn("removing a draft copy failed", "removal", removal.ID, "error", err)
			if accessLost(err) {
				return
			}
			continue
		}
		if err := d.api.ReportDraftRemoved(ctx, credentials.AccountID, removal.ID, d.workerID); err != nil {
			logger.Warn("reporting the removed draft copy failed", "removal", removal.ID, "error", err)
		}
	}
}

// changeMailbox makes the user's changes to messages on the server, in the order they were made. A refusal is
// reported, so Tresso undoes the change; once a message's change is not done, its later changes wait for the next
// run. When the connection fails, the rest is left unreported and comes back once the claim expires, without
// counting as a failed attempt.
func (d *Dispatcher) changeMailbox(ctx context.Context, logger *slog.Logger, sender Sender, credentials api.Credentials) {
	changes, err := d.api.ClaimMailbox(ctx, credentials.AccountID, d.workerID)
	if err != nil {
		logger.Warn("claiming changes to messages failed", "error", err)
		return
	}
	if len(changes) == 0 {
		return
	}
	connection := &lazy[MailboxStore]{open: func() (MailboxStore, error) { return sender.OpenMailbox(ctx) }}
	defer connection.close()
	mailbox, err := connection.get()
	if err != nil {
		logger.Warn("connecting to make changes to messages failed", "error", err)
		return
	}

	waiting := map[string]bool{}
	for _, change := range changes {
		if waiting[change.MessageID] {
			continue
		}
		changeLogger := logger.With("change", change.ID, "kind", change.Kind)
		if scoped, ok := mailbox.(ChangeScoped); ok {
			scoped.StartChange()
		}
		result, err := applyChange(mailbox, change)
		if err != nil {
			changeLogger.Warn("making a change to a message failed; it comes back later", "error", err)
			return
		}
		if result.outcome != api.MailboxDone {
			waiting[change.MessageID] = true
			changeLogger.Warn("the server did not make a change to a message", "outcome", result.outcome, "reason", result.text)
		}
		if err := d.api.ReportMailbox(ctx, credentials.AccountID, change.ID, d.workerID, result.outcome, result.text, result.remoteUID); err != nil {
			changeLogger.Warn("reporting a change to a message failed", "error", err)
			waiting[change.MessageID] = true
		}
	}
}

// UnsubscribeClaimBudget is how long after claiming the worker still starts an unsubscribe request: the API's claim
// lasts five minutes, and each request takes at most unsubscribe's timeout.
const UnsubscribeClaimBudget = 4 * time.Minute

// unsubscribes sends the user's one-click unsubscribe requests and reports each outcome. A report that fails (the claim
// was lost, or the API is unreachable) is only logged: the request comes back once the claim expires. Without an
// Unsubscriber nothing is claimed.
func (d *Dispatcher) unsubscribes(ctx context.Context, logger *slog.Logger, accountID string) {
	if d.unsubscribe == nil {
		return
	}
	requests, err := d.api.ClaimUnsubscribes(ctx, accountID, d.workerID)
	if err != nil {
		logger.Warn("claiming unsubscribe requests failed", "error", err)
		return
	}
	deadline := d.now().Add(UnsubscribeClaimBudget)
	for _, request := range requests {
		if ctx.Err() != nil {
			return // the worker stops; the rest comes back once the claim expires
		}
		if !d.now().Before(deadline) {
			// Close to the end of the claim: a report after it would be refused, and another worker may take the
			// request meanwhile. The rest comes back once the claim expires.
			logger.Warn("leaving unsubscribe requests for later; their claim is about to expire")
			return
		}
		requestLogger := logger.With("unsubscribe", request.ID)
		outcome, text := d.unsubscribe.Post(ctx, request.URL)
		if outcome != api.UnsubscribeDone {
			requestLogger.Warn("unsubscribing did not succeed", "outcome", outcome, "reason", text)
		}
		if err := d.api.ReportUnsubscribe(ctx, accountID, request.ID, d.workerID, outcome, text); err != nil {
			requestLogger.Warn("reporting an unsubscribe request failed", "error", err)
		}
	}
}

type changeResult struct {
	outcome, text, remoteUID string
}

// applyChange makes one change. An error means the connection failed and nothing is worth reporting; every answer
// from the server becomes an outcome.
func applyChange(mailbox MailboxStore, change api.MailboxChange) (changeResult, error) {
	switch change.Kind {
	case api.MailboxFlags:
		return applyFlags(mailbox, change)
	case api.MailboxMove:
		if change.Source == nil || change.Target == nil {
			return changeResult{api.OutcomeFailed, "a move without source or target", ""}, nil
		}
		messageID := ""
		if change.MessageIDHeader != nil {
			messageID = *change.MessageIDHeader
		}
		uid, err := mailbox.Move(*change.Source, change.Target.Folder, messageID)
		switch {
		case err == nil:
			return changeResult{api.MailboxDone, "", uid}, nil
		case messageGone(err):
			return changeResult{api.MailboxGone, err.Error(), ""}, nil
		case errors.Is(err, imapsync.ErrFolderReset):
			// The uid may name another message now; the folder sync finds the copy again.
			return changeResult{api.OutcomeFailed, err.Error(), ""}, nil
		case refused(err):
			return changeResult{refusalOutcome(err), err.Error(), ""}, nil
		}
		return changeResult{}, err
	}
	return changeResult{api.OutcomeFailed, fmt.Sprintf("unknown kind %q", change.Kind), ""}, nil
}

// applyFlags sets the flags on every copy. It is done when any copy took them: a copy in a folder that is gone or was
// reset meanwhile is the folder sync's to sort out, and undoing the whole change would take the flags off the rest.
func applyFlags(mailbox MailboxStore, change api.MailboxChange) (changeResult, error) {
	if len(change.Locations) == 0 {
		return changeResult{api.MailboxDone, "", ""}, nil
	}
	set, reset, retry := 0, 0, 0
	var last error
	for _, location := range change.Locations {
		err := mailbox.SetFlags(location, change.Seen, change.Flagged)
		switch {
		case err == nil:
			set++
		case errors.Is(err, imapsync.ErrFolderReset):
			reset++
			last = err
		case refused(err):
			if refusalOutcome(err) == api.OutcomeRetry {
				retry++
			}
			last = err
		default:
			return changeResult{}, err
		}
	}
	switch {
	case set > 0:
		return changeResult{api.MailboxDone, "", ""}, nil
	case reset+retry == len(change.Locations):
		// Busy, or every copy's folder was reset: once the sync relearnt the uids, the change applies to them.
		return changeResult{api.OutcomeRetry, last.Error(), ""}, nil
	}
	return changeResult{api.OutcomeFailed, last.Error(), ""}, nil
}

// messageGone reports whether the copy a move was to take is no longer in its folder, whatever the provider.
func messageGone(err error) bool {
	return errors.Is(err, imapsync.ErrMessageGone) || errors.Is(err, gmailsync.ErrMessageGone) || errors.Is(err, graphsync.ErrMessageGone)
}

// refused reports whether the server answered rather than the connection failing: only an answer is worth reporting.
// For Gmail and Graph an answer is an HTTP status about the change. Lost access is never one (see accessLost).
func refused(err error) bool {
	if accessLost(err) {
		return false
	}
	var response *imap.Error
	var status *providerhttp.StatusError
	return errors.As(err, &response) || errors.As(err, &status)
}

// accessLost reports whether a Gmail or Microsoft account can no longer be used at all: the provider refused even a
// renewed access token, the API could not renew it, or the token lacks the mail scope (403). None of these says
// anything about the change itself, so nothing is reported: reporting a failure would make the API undo what the user
// did. The syncer of the account reports it as auth_failed, and the work comes back once the user signed in again.
func accessLost(err error) bool {
	return errors.Is(err, providerhttp.ErrUnauthorized) || errors.Is(err, api.ErrReauthorize) || errors.Is(err, providersync.ErrAccessDenied)
}

// refusalOutcome tells a refusal that may pass (the server is busy) from one that will not.
func refusalOutcome(err error) string {
	var status *providerhttp.StatusError
	if errors.As(err, &status) {
		if status.StatusCode == http.StatusTooManyRequests || status.StatusCode >= 500 {
			return api.OutcomeRetry
		}
		return api.OutcomeFailed
	}
	var response *imap.Error
	if errors.As(err, &response) {
		switch response.Code {
		case imap.ResponseCodeUnavailable, imap.ResponseCodeInUse, imap.ResponseCodeLimit, imap.ResponseCodeServerBug, imap.ResponseCodeContactAdmin:
			return api.OutcomeRetry
		}
	}
	return api.OutcomeFailed
}

func (d *Dispatcher) deliver(ctx context.Context, logger *slog.Logger, sender Sender, credentials api.Credentials, sent *lazy[SentStore], message api.OutgoingMessage) {
	raw, err := d.store.Read(ctx, credentials.AccountID, message.RawObjectKey)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			d.report(ctx, logger, credentials.AccountID, message.ID, api.OutcomeFailed, "The message could not be found any more.", false)
			return
		}
		d.report(ctx, logger, credentials.AccountID, message.ID, api.OutcomeRetry, "The message could not be read; trying again later.", false)
		return
	}

	// An earlier attempt may have reached the server before the worker could report it; never send twice. A check
	// that cannot be made (no connection, a refused login, a failed search) leaves the question open and nothing is
	// sent; only an account without a Sent folder has nothing to check.
	if message.Attempt > 1 {
		store, err := sent.get()
		switch {
		case errors.Is(err, imapsync.ErrNoSentFolder):
		case err != nil:
			d.undecided(ctx, logger, credentials, message, err)
			return
		default:
			if finder, ok := store.(OutgoingFinder); ok {
				found, err := finder.SentBefore(message, raw, earliestAttempt(message, time.Now()))
				switch {
				case err != nil && accessLost(err):
					// Nothing is known yet; once the user signed in again the check runs again.
					logger.Warn("checking for an earlier attempt failed: access lost", "error", err)
					d.report(ctx, logger, credentials.AccountID, message.ID, api.OutcomeRetry, "Tresso lost access to this account. Sign in again to send.", false)
					return
				case err != nil && providerAnswered(err):
					// The provider refused the lookup, also after providerhttp's retries: retrying the check would only
					// use up the attempts of a message nobody can tell is sent. The user decides.
					logger.Warn("checking for an earlier attempt failed; not sending", "error", err)
					d.report(ctx, logger, credentials.AccountID, message.ID, api.OutcomeFailed, undecidedText, false)
					return
				case err != nil:
					// No answer (connection, timeout, 429, 5xx) or not decided yet (a copy the provider may still be
					// sending): look again next attempt.
					d.undecided(ctx, logger, credentials, message, err)
					return
				}
				if found {
					logger.Info("outgoing message was sent by an earlier attempt")
					d.report(ctx, logger, credentials.AccountID, message.ID, api.OutcomeSent, "", true)
					return
				}
			} else {
				found, err := store.Contains(message.MessageID)
				if err != nil {
					d.undecided(ctx, logger, credentials, message, err)
					return
				}
				if found {
					logger.Info("outgoing message was sent by an earlier attempt")
					d.report(ctx, logger, credentials.AccountID, message.ID, api.OutcomeSent, "", true)
					return
				}
			}
		}
	}

	if err := sender.Send(ctx, message, raw); err != nil {
		outcome, text := outcomeOf(err)
		logger.Warn("sending failed", "outcome", outcome, "error", err)
		d.report(ctx, logger, credentials.AccountID, message.ID, outcome, text, false)
		return
	}

	copied := true
	if !AutoSavesSent(credentials) {
		copied = false
		if store, err := sent.get(); err != nil {
			logger.Warn("opening the Sent folder failed", "error", err)
		} else if err := store.Append(raw, time.Now()); err != nil {
			logger.Warn("filing the sent copy failed", "error", err)
		} else {
			copied = true
		}
	}
	logger.Info("outgoing message sent", "copiedToSent", copied)
	d.report(ctx, logger, credentials.AccountID, message.ID, api.OutcomeSent, "", copied)
}

// undecided reports that the duplicate check of a retried message could not be made: the message is tried again
// later, and on its last attempt the API ends it with a text that tells the user to check Sent.
func (d *Dispatcher) undecided(ctx context.Context, logger *slog.Logger, credentials api.Credentials, message api.OutgoingMessage, err error) {
	text := checkingText
	if message.LastAttempt {
		text = finalText(err)
	}
	logger.Warn("checking for an earlier attempt did not decide; not sending", "lastAttempt", message.LastAttempt, "error", err)
	d.report(ctx, logger, credentials.AccountID, message.ID, api.OutcomeRetry, text, false)
}

// reportAttempts is how often an outcome report is sent when the API cannot be reached or fails. A lost report of a
// sent message makes the next attempt check Sent, which may not be able to decide.
const reportAttempts = 3

// reportBackoff is the wait before the second report attempt; it doubles after that.
var reportBackoff = time.Second

func (d *Dispatcher) report(ctx context.Context, logger *slog.Logger, accountID, messageID, outcome, text string, copied bool) {
	wait := reportBackoff
	for attempt := 1; ; attempt++ {
		err := d.api.ReportOutbox(ctx, accountID, messageID, d.workerID, outcome, text, copied)
		switch {
		case err == nil:
			return
		case errors.Is(err, api.ErrClaimLost):
			logger.Warn("claim on the outgoing message was lost before reporting", "outcome", outcome)
			return
		case attempt < reportAttempts && ctx.Err() == nil && reportMayPass(err):
			logger.Warn("reporting the outgoing message failed; trying again", "outcome", outcome, "error", err)
			select {
			case <-ctx.Done():
			case <-time.After(wait):
			}
			wait *= 2
			continue
		}
		logger.Error("reporting the outgoing message failed", "outcome", outcome, "error", err)
		return
	}
}

// reportMayPass reports whether a failed report may go through when sent again: no answer, or a 5xx. A 4xx answers
// the report itself.
func reportMayPass(err error) bool {
	var httpErr *api.HTTPError
	if errors.As(err, &httpErr) {
		return httpErr.Status >= 500
	}
	return true
}

// outcomeOf maps a send failure to the outcome reported to the API and the text shown to the user.
func outcomeOf(err error) (outcome, text string) {
	var smtpErr *smtpsend.Error
	var providerErr *providersend.Error
	switch {
	case errors.As(err, &smtpErr):
		return outcomeFor(smtpErr.Permanent), smtpErr.Message
	case errors.As(err, &providerErr):
		return outcomeFor(providerErr.Permanent), providerErr.Message
	default:
		return api.OutcomeRetry, "Sending failed; trying again later."
	}
}

func outcomeFor(permanent bool) string {
	if permanent {
		return api.OutcomeFailed
	}
	return api.OutcomeRetry
}

// AutoSavesSent reports whether the provider files sent mail in Sent by itself, so a copy from Tresso would show up
// twice: always for Gmail and Microsoft accounts (their APIs file it), and for IMAP accounts whose SMTP server is
// Gmail's or Microsoft's.
func AutoSavesSent(credentials api.Credentials) bool {
	switch credentials.Provider {
	case "gmail", "microsoft":
		return true
	}
	host := strings.ToLower(strings.TrimSuffix(credentials.Connection.SMTP.Host, "."))
	switch host {
	case "smtp.gmail.com", "smtp.googlemail.com", "smtp.office365.com", "smtp-mail.outlook.com":
		return true
	}
	return false
}

// lazy opens a folder only when something needs it, once per run.
type lazy[T interface{ Close() }] struct {
	open   func() (T, error)
	store  T
	err    error
	opened bool
}

func (l *lazy[T]) get() (T, error) {
	if !l.opened {
		l.store, l.err = l.open()
		l.opened = true
	}
	return l.store, l.err
}

func (l *lazy[T]) close() {
	if l.opened && l.err == nil {
		l.store.Close()
	}
}
