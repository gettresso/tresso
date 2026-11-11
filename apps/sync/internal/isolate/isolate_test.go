package isolate

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"testing"

	"tresso/sync/internal/api"
	"tresso/sync/internal/ingestmsg"
)

var discard = slog.New(slog.NewTextHandler(io.Discard, nil))

// recorder is an API that refuses the messages refused names, with that status, and records what it accepted.
type recorder struct {
	refused  map[string]int
	accepted []string
	cursor   *string
	requests int
}

func (r *recorder) send(_ context.Context, messages []api.Message, cursor *string) error {
	r.requests++
	for _, m := range messages {
		if status, ok := r.refused[m.RemoteUID]; ok && m.Subject != ingestmsg.PlaceholderSubject {
			return &api.HTTPError{Status: status}
		}
	}
	for _, m := range messages {
		uid := m.RemoteUID
		if m.Subject == ingestmsg.PlaceholderSubject {
			uid += " (placeholder)"
		}
		r.accepted = append(r.accepted, uid)
	}
	if cursor != nil {
		r.cursor = cursor
	}
	return nil
}

func batch(uids ...string) []api.Message {
	out := make([]api.Message, 0, len(uids))
	for _, uid := range uids {
		out = append(out, api.Message{RemoteUID: uid, Subject: "Message " + uid})
	}
	return out
}

func TestARefusedMessageIsReplacedAtOnceAndTheCursorStored(t *testing.T) {
	r := &recorder{refused: map[string]int{"2": http.StatusUnprocessableEntity}}
	cursor := "c1"
	if err := Batch(context.Background(), r.send, NewStrikes(), "INBOX", batch("1", "2", "3"), &cursor, discard); err != nil {
		t.Fatal(err)
	}
	slices.Sort(r.accepted)
	if !slices.Equal(r.accepted, []string{"1", "2 (placeholder)", "3"}) || r.cursor == nil || *r.cursor != "c1" {
		t.Errorf("accepted %v, cursor %v", r.accepted, r.cursor)
	}
}

func TestAMessageTheAPIFailsOnIsReplacedOnlyAfterRepeatedFailures(t *testing.T) {
	strikes := NewStrikes()
	cursor := "c1"
	for attempt := 1; attempt < StrikesBeforeSkip; attempt++ {
		r := &recorder{refused: map[string]int{"2": http.StatusInternalServerError}}
		if err := Batch(context.Background(), r.send, strikes, "INBOX", batch("1", "2", "3"), &cursor, discard); err == nil || r.cursor != nil {
			t.Fatalf("attempt %d: err %v, cursor %v; the message must be tried again first", attempt, err, r.cursor)
		}
	}
	r := &recorder{refused: map[string]int{"2": http.StatusInternalServerError}}
	if err := Batch(context.Background(), r.send, strikes, "INBOX", batch("1", "2", "3"), &cursor, discard); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(r.accepted, "2 (placeholder)") || r.cursor == nil {
		t.Errorf("accepted %v, cursor %v", r.accepted, r.cursor)
	}
}

func TestNothingIsReplacedWhenEveryMessageFails(t *testing.T) {
	strikes := NewStrikes()
	for range StrikesBeforeSkip + 2 {
		r := &recorder{refused: map[string]int{"1": http.StatusInternalServerError, "2": http.StatusInternalServerError}}
		if err := Batch(context.Background(), r.send, strikes, "INBOX", batch("1", "2"), nil, discard); err == nil || len(r.accepted) != 0 {
			t.Fatalf("err %v, accepted %v", err, r.accepted)
		}
	}
}

func TestOtherFailuresAreNotIsolated(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusNotFound, http.StatusConflict, http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		r := &recorder{refused: map[string]int{"1": status}}
		err := Batch(context.Background(), r.send, NewStrikes(), "INBOX", batch("1", "2"), nil, discard)
		if err == nil || r.requests != 1 {
			t.Errorf("status %d: err %v after %d requests; want the error after one", status, err, r.requests)
		}
	}
	r := &recorder{}
	broken := errors.New("connection reset")
	failing := func(context.Context, []api.Message, *string) error { r.requests++; return broken }
	if err := Batch(context.Background(), failing, NewStrikes(), "INBOX", batch("1", "2"), nil, discard); !errors.Is(err, broken) || r.requests != 1 {
		t.Errorf("err %v after %d requests", err, r.requests)
	}
}

func TestUnreadableMessagesAreReplacedOnceTheyKeepFailing(t *testing.T) {
	strikes := NewStrikes()
	refused := errors.New("refused")
	failed := []Failed{{Folder: "INBOX", UID: "7", Err: refused, Placeholder: func(context.Context) (api.Message, error) {
		return api.Message{RemoteUID: "7", Subject: ingestmsg.PlaceholderSubject}, nil
	}}}
	for attempt := 1; attempt < StrikesBeforeSkip; attempt++ {
		var messageErr *MessageError
		if _, err := Unreadable(context.Background(), strikes, failed, 0, discard); !errors.As(err, &messageErr) || messageErr.Err != refused || errors.Is(err, refused) {
			t.Fatalf("attempt %d: %v; want a MessageError that does not unwrap to the provider's error", attempt, err)
		}
	}
	placeholders, err := Unreadable(context.Background(), strikes, failed, 0, discard)
	if err != nil || len(placeholders) != 1 || placeholders[0].RemoteUID != "7" {
		t.Fatalf("placeholders %v, %v", placeholders, err)
	}

	doubtful := []Failed{{Folder: "INBOX", UID: "8", Err: refused, Doubtful: true, Placeholder: failed[0].Placeholder}}
	for range StrikesBeforeSkip + 1 {
		var messageErr *MessageError
		if _, err := Unreadable(context.Background(), strikes, doubtful, 0, discard); !errors.As(err, &messageErr) {
			t.Fatalf("a doubtful failure with nothing delivered was skipped: %v", err)
		}
	}
}
