// Package isolate keeps one message that cannot be imported from holding up its folder. The API takes a folder's
// messages in batches with the folder's cursor, and the cursor only moves when the whole batch is accepted: without
// isolation, one message the API or the provider refuses would stop the folder (for Gmail the whole account) for good.
//
// A refused batch is sent again one message at a time. A message the API refuses on its own is replaced by a
// placeholder (see ingestmsg.Placeholder) and logged with its folder and uid, so the user sees that a message is
// missing and the operator sees why; the rest of the batch and the cursor go in as usual. Refusals that may pass
// (a 500 from the API, a provider that does not hand a message over) are retried in later sessions first: only a
// message that failed StrikesBeforeSkip times, each time next to messages that went through, is replaced.
package isolate

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"

	"tresso/sync/internal/api"
	"tresso/sync/internal/ingestmsg"
)

// StrikesBeforeSkip is how many sessions in a row a message may fail before a placeholder takes its place.
const StrikesBeforeSkip = 3

// Strikes counts failures per message across the sessions of one account's run. Keys name a message within the
// account (folder and uid). It is safe for concurrent use.
type Strikes struct {
	mu     sync.Mutex
	counts map[string]int
}

func NewStrikes() *Strikes {
	return &Strikes{counts: map[string]int{}}
}

// Add counts one failure of key and reports whether the message has now failed often enough to be skipped.
func (s *Strikes) Add(key string) (skip bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.counts[key]++
	return s.counts[key] >= StrikesBeforeSkip
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

// Batch sends messages with cursor. When the API refuses the batch for its content, the messages are sent one by one
// and each one the API keeps refusing is replaced by a placeholder; then the cursor is stored. It returns an error when
// the batch could not be taken in, also when a doubtful message has not failed often enough yet.
func Batch(ctx context.Context, send Send, strikes *Strikes, folder string, messages []api.Message, cursor *string, logger *slog.Logger) error {
	err := send(ctx, messages, cursor)
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
	for _, suspect := range skipped {
		logSkipped(logger, folder, suspect.message, "the API refused it", suspect.err)
		if err := send(ctx, []api.Message{ingestmsg.Placeholder(suspect.message)}, nil); err != nil {
			return fmt.Errorf("the placeholder of uid %s was refused too: %w", suspect.message.RemoteUID, err)
		}
		strikes.Forget(Key(folder, suspect.message.RemoteUID))
	}
	if cursor == nil {
		return nil
	}
	return send(ctx, []api.Message{}, cursor)
}

// Failed is a message the provider would not hand over.
type Failed struct {
	Folder, UID string
	Err         error
	// Doubtful is set when the failure may say nothing about the message (the provider answered 5xx): it only counts
	// when other messages of the same request went through.
	Doubtful bool
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

// Unreadable decides about messages the provider would not hand over while delivered others did. Each failure counts
// once; a message that has now failed StrikesBeforeSkip times is replaced by its placeholder, which is returned for
// the caller to ingest (should that fail, the count starts again, which only delays the placeholder). While
// any failed message is still to be tried again, a *MessageError for the first one is returned instead, which ends
// the session so they are retried after the backoff.
func Unreadable(ctx context.Context, strikes *Strikes, failed []Failed, delivered int, logger *slog.Logger) ([]api.Message, error) {
	var skipped []Failed
	var retry error
	for _, f := range failed {
		if f.Doubtful && delivered == 0 {
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
	logger.Error("message skipped and replaced by a placeholder: "+reason, "folder", folder, "uid", msg.RemoteUID, "messageId", messageID, "error", err)
}
