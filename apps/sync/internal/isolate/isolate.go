// Package isolate keeps one message that cannot be imported from holding up its folder. The API takes a folder's
// messages in batches with the folder's cursor, and the cursor only moves when the whole batch is accepted: without
// isolation, one message the API or the provider refuses would stop the folder (for Gmail the whole account) for good.
//
// A refused batch is sent again one message at a time. A message the API refuses on its own (400, 413, 422) is
// replaced by a placeholder (see ingestmsg.Placeholder) and logged with its folder and uid, so the user sees that a
// message is missing and the operator sees why; the rest of the batch and the cursor go in as usual.
//
// Failures that may pass (a 500 from the API, a message the provider does not hand over) only count next to messages
// of the same request that went through, so an outage of the API or the provider never counts; and a message is only
// replaced once it failed StrikesBeforeSkip times over at least MinStrikeSpan, so a problem that passes within the
// hour replaces nothing.
//
// A placeholder is not final. Its uid is kept in the folder's cursor (see Pending) and the real message is tried
// again, after RetryFirst and then less and less often up to RetryMax; once it goes in, it takes the placeholder's
// place (see Replace).
package isolate

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"sync"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/ingestmsg"
)

const (
	// StrikesBeforeSkip is how many failed tries a message needs, at the least, before a placeholder takes its place.
	StrikesBeforeSkip = 3
	// MinStrikeSpan is how long a message must have kept failing before a placeholder takes its place. Sessions
	// restart within seconds, so a count alone would be reached by a problem of a minute or two.
	MinStrikeSpan = time.Hour
)

type strike struct {
	count int
	first time.Time
}

// Strikes counts failures per message across the sessions of one account's run. Keys name a message within the
// account (folder and uid). It is safe for concurrent use.
type Strikes struct {
	mu     sync.Mutex
	counts map[string]*strike
	now    func() time.Time
}

func NewStrikes() *Strikes {
	return NewStrikesWithClock(time.Now)
}

// NewStrikesWithClock is NewStrikes with a clock of the caller's, for tests.
func NewStrikesWithClock(now func() time.Time) *Strikes {
	return &Strikes{counts: map[string]*strike{}, now: now}
}

// Add counts one failure of key and reports whether the message has now failed often enough, and for long enough, to
// be replaced by a placeholder.
func (s *Strikes) Add(key string) (skip bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	e, ok := s.counts[key]
	if !ok {
		e = &strike{first: now}
		s.counts[key] = e
	}
	e.count++
	return e.count >= StrikesBeforeSkip && now.Sub(e.first) >= MinStrikeSpan
}

// Forget clears key after the message (or its placeholder) went through.
func (s *Strikes) Forget(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.counts, key)
}

// Key names a message within an account.
func Key(folder, uid string) string {
	return folder + "\x00" + uid
}

// Send ingests messages into the API, cursor (when not nil) with them.
type Send func(ctx context.Context, messages []api.Message, cursor *string) error

// Refusal tells what an API error says about the messages of a batch.
type Refusal int

const (
	// NotRefused: the request failed for a reason that is not the batch (connection, authentication, lease, rate
	// limit, the API being unavailable). The session ends and retries as before.
	NotRefused Refusal = iota
	// Refused: the API refused the content (400, 413, 422). It answers the same every time.
	Refused
	// MaybeRefused: the API failed while storing it (500). A value the database refuses does that, but so does a
	// passing fault, so the message is only skipped once it keeps failing.
	MaybeRefused
)

// Classify reads an API error.
func Classify(err error) Refusal {
	var httpErr *api.HTTPError
	if !errors.As(err, &httpErr) {
		return NotRefused
	}
	switch httpErr.Status {
	case http.StatusBadRequest, http.StatusRequestEntityTooLarge, http.StatusUnprocessableEntity:
		return Refused
	case http.StatusInternalServerError:
		return MaybeRefused
	}
	return NotRefused
}

// Batch sends messages with the cursor. When the API refuses the batch for its content, the messages are sent one by
// one and each one the API keeps refusing is replaced by a placeholder; then the cursor is stored. It returns an error
// when the batch could not be taken in, also when a doubtful message has not failed often and long enough yet.
//
// cursor is read when it is sent (nil, or one returning nil, sends none), so it includes what placed recorded.
// placed is called with the uids of every placeholder of the batch (those among messages and those made here) before
// they are sent, so the caller can keep them for a later try (see Pending).
func Batch(ctx context.Context, send Send, strikes *Strikes, folder string, messages []api.Message, cursor func() *string, placed func(uids []string) error, logger *slog.Logger) error {
	currentCursor := func() *string {
		if cursor == nil {
			return nil
		}
		return cursor()
	}
	var already []string
	for _, m := range messages {
		if ingestmsg.IsPlaceholder(m) {
			already = append(already, m.RemoteUID)
		}
	}
	if len(already) > 0 {
		if err := placed(already); err != nil {
			return err
		}
	}

	err := send(ctx, messages, currentCursor())
	if err == nil {
		for _, m := range messages {
			strikes.Forget(Key(folder, m.RemoteUID))
		}
		return nil
	}
	if len(messages) == 0 || Classify(err) == NotRefused {
		return err
	}
	logger.Warn("the API refused a batch of messages; sending them one by one", "folder", folder, "messages", len(messages), "error", err)

	type refused struct {
		message api.Message
		err     error
	}
	var suspects []refused
	accepted := 0
	if len(messages) == 1 {
		suspects = append(suspects, refused{messages[0], err})
	} else {
		for _, m := range messages {
			err := send(ctx, []api.Message{m}, nil)
			switch {
			case err == nil:
				accepted++
				strikes.Forget(Key(folder, m.RemoteUID))
			case Classify(err) == NotRefused:
				return err
			default:
				suspects = append(suspects, refused{m, err})
			}
		}
	}

	var skipped []refused
	var retry error
	for _, suspect := range suspects {
		if Classify(suspect.err) == MaybeRefused {
			// Only a failure next to messages that went through says something about this message; when none did,
			// the API itself is in trouble.
			if accepted == 0 || !strikes.Add(Key(folder, suspect.message.RemoteUID)) {
				retry = cmp.Or(retry, suspect.err)
				continue
			}
		}
		skipped = append(skipped, suspect)
	}
	if retry != nil {
		return retry
	}
	if len(skipped) > 0 {
		uids := make([]string, 0, len(skipped))
		for _, suspect := range skipped {
			uids = append(uids, suspect.message.RemoteUID)
		}
		if err := placed(uids); err != nil {
			return err
		}
	}
	for _, suspect := range skipped {
		logSkipped(logger, folder, suspect.message, "the API refused it", suspect.err)
		if err := send(ctx, []api.Message{ingestmsg.Placeholder(suspect.message)}, nil); err != nil {
			return fmt.Errorf("the placeholder of uid %s was refused too: %w", suspect.message.RemoteUID, err)
		}
		strikes.Forget(Key(folder, suspect.message.RemoteUID))
	}
	if c := currentCursor(); c != nil {
		return send(ctx, []api.Message{}, c)
	}
	return nil
}

// Replace puts msg, the real message, in the place of the placeholder its uid holds in a folder. The API only
// refreshes the flags of a uid the folder already has, so the message is sent once to see whether the API takes it
// now (when it refuses, the placeholder stays and the error is returned), then the placeholder's uid is removed and
// the message sent again. A placeholder that is gone already costs nothing more: the first send stores the message.
func Replace(ctx context.Context, send Send, vanish func(ctx context.Context, uid string) error, msg api.Message) error {
	if err := send(ctx, []api.Message{msg}, nil); err != nil {
		return err
	}
	if err := vanish(ctx, msg.RemoteUID); err != nil {
		return err
	}
	return send(ctx, []api.Message{msg}, nil)
}

// Failed is a message the provider would not hand over.
type Failed struct {
	Folder, UID string
	Err         error
	// Placeholder builds what stands in for the message, usually with ingestmsg.Unreadable.
	Placeholder func(ctx context.Context) (api.Message, error)
}

// MessageError is the error of a message the provider would not hand over, returned while it is still to be tried
// again. It does not unwrap to the provider's error on purpose: a refusal of one message (a 403 for its content, say)
// must not be taken for a refusal of its folder or the account.
type MessageError struct {
	Folder, UID string
	Err         error
}

func (e *MessageError) Error() string {
	return fmt.Sprintf("message %s in %s could not be downloaded: %v", e.UID, e.Folder, e.Err)
}

// Unreadable decides about messages the provider would not hand over while delivered others of the same request did.
// A failure only counts when delivered is above zero: when nothing came through, the provider itself is in trouble
// (or throttles, which the callers do not even pass here). A message that has now failed often and long enough (see
// Strikes) is replaced by its placeholder, which is returned for the caller to ingest. While any failed message is
// still to be tried again, a *MessageError for the first one is returned instead, which ends the session so they are
// retried after the backoff.
func Unreadable(ctx context.Context, strikes *Strikes, failed []Failed, delivered int, logger *slog.Logger) ([]api.Message, error) {
	var skipped []Failed
	var retry error
	for _, f := range failed {
		if delivered == 0 {
			retry = cmp.Or(retry, error(&MessageError{f.Folder, f.UID, f.Err}))
			continue
		}
		if strikes.Add(Key(f.Folder, f.UID)) {
			skipped = append(skipped, f)
			continue
		}
		logger.Warn("a message could not be downloaded; it is tried again", "folder", f.Folder, "uid", f.UID, "error", f.Err)
		retry = cmp.Or(retry, error(&MessageError{f.Folder, f.UID, f.Err}))
	}
	if retry != nil {
		return nil, retry
	}

	placeholders := make([]api.Message, 0, len(skipped))
	for _, f := range skipped {
		msg, err := f.Placeholder(ctx)
		if err != nil {
			return nil, err
		}
		logSkipped(logger, f.Folder, api.Message{RemoteUID: f.UID}, "the provider would not hand it over", f.Err)
		strikes.Forget(Key(f.Folder, f.UID))
		placeholders = append(placeholders, msg)
	}
	return placeholders, nil
}

func logSkipped(logger *slog.Logger, folder string, msg api.Message, reason string, err error) {
	messageID := ""
	if msg.MessageID != nil {
		messageID = *msg.MessageID
	}
	logger.Error("message replaced by a placeholder for now: "+reason, "folder", folder, "uid", msg.RemoteUID, "messageId", messageID, "error", err)
}

const (
	// RetryFirst is how long a placeholder waits before its message is tried again; the wait doubles after every
	// failed try, up to RetryMax.
	RetryFirst = time.Hour
	RetryMax   = 24 * time.Hour
	// MaxPending bounds the placeholders a folder's cursor keeps for a later try; the API stores cursors of at most
	// 8 KB. When more are kept, the ones that waited longest are given up (and stay placeholders).
	MaxPending = 50
)

// Pending is a placeholder whose message is to be tried again, as kept in a folder's cursor.
type Pending struct {
	UID string `json:"uid"`
	// Next is when to try again and Wait the last wait, in Unix seconds.
	Next int64 `json:"next"`
	Wait int64 `json:"wait"`
}

// PendingList is a folder's placeholders waiting for another try. Its methods return the changed list.
type PendingList []Pending

// Add keeps uids for a try after RetryFirst. A uid already kept starts over.
func (l PendingList) Add(now time.Time, uids ...string) PendingList {
	out := slices.Clone(l)
	for _, uid := range uids {
		out = out.Drop(uid)
		out = append(out, Pending{UID: uid, Next: now.Add(RetryFirst).Unix(), Wait: int64(RetryFirst / time.Second)})
	}
	if len(out) > MaxPending {
		// The ones that waited longest go first: they failed most often.
		slices.SortStableFunc(out, func(a, b Pending) int { return cmp.Compare(a.Wait, b.Wait) })
		out = out[:MaxPending]
	}
	return out
}

// Due returns the uids whose try is due.
func (l PendingList) Due(now time.Time) []string {
	var due []string
	for _, p := range l {
		if p.Next <= now.Unix() {
			due = append(due, p.UID)
		}
	}
	return due
}

// Later schedules uid's next try after twice its last wait, at most RetryMax.
func (l PendingList) Later(uid string, now time.Time) PendingList {
	out := slices.Clone(l)
	for i := range out {
		if out[i].UID == uid {
			wait := min(time.Duration(out[i].Wait)*time.Second*2, RetryMax)
			wait = max(wait, RetryFirst)
			out[i].Wait, out[i].Next = int64(wait/time.Second), now.Add(wait).Unix()
		}
	}
	return out
}

// Drop forgets uid: its message went in, or is gone.
func (l PendingList) Drop(uid string) PendingList {
	return slices.DeleteFunc(slices.Clone(l), func(p Pending) bool { return p.UID == uid })
}

// Trim drops the entries that waited longest until fits reports that the list fits.
func (l PendingList) Trim(fits func(PendingList) bool) PendingList {
	out := slices.Clone(l)
	slices.SortStableFunc(out, func(a, b Pending) int { return cmp.Compare(a.Wait, b.Wait) })
	for len(out) > 0 && !fits(out) {
		out = out[:len(out)-1]
	}
	return out
}
