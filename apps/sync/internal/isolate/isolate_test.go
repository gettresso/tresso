package isolate

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/ingestmsg"
)

var discard = slog.New(slog.NewTextHandler(io.Discard, nil))

// recorder is an API that refuses the messages refused names, with that status, and records what it accepted.
type recorder struct {
	refused  map[string]int
	accepted []string
	vanished []string
	cursor   *string
	requests int
}

func (r *recorder) send(_ context.Context, messages []api.Message, cursor *string) error {
	r.requests++
	for _, m := range messages {
		if status, ok := r.refused[m.RemoteUID]; ok && !ingestmsg.IsPlaceholder(m) {
			return &api.HTTPError{Status: status}
		}
	}
	for _, m := range messages {
		uid := m.RemoteUID
		if ingestmsg.IsPlaceholder(m) {
			uid += " (placeholder)"
		}
		r.accepted = append(r.accepted, uid)
	}
	if cursor != nil {
		r.cursor = cursor
	}
	return nil
}

func (r *recorder) vanish(_ context.Context, uid string) error {
	r.vanished = append(r.vanished, uid)
	return nil
}

func batch(uids ...string) []api.Message {
	out := make([]api.Message, 0, len(uids))
	for _, uid := range uids {
		out = append(out, api.Message{RemoteUID: uid, Subject: "Message " + uid})
	}
	return out
}

// clock is a Strikes clock the test moves.
type clock struct{ now time.Time }

func (c *clock) strikes() *Strikes {
	return NewStrikesWithClock(func() time.Time { return c.now })
}

// stand is the placeholder builder of these tests.
func stand(_ context.Context, msg api.Message) (api.Message, error) {
	return ingestmsg.Placeholder(msg), nil
}

func cursorOf(value string) func() *string {
	return func() *string { return &value }
}

func noteTo(placed *[]string) func([]string) error {
	return func(uids []string) error {
		*placed = append(*placed, uids...)
		return nil
	}
}

func TestARefusedMessageIsReplacedAtOnceRecordedAndTheCursorStored(t *testing.T) {
	r := &recorder{refused: map[string]int{"2": http.StatusUnprocessableEntity}}
	var placed []string
	if err := Batch(context.Background(), r.send, NewStrikes(), "INBOX", batch("1", "2", "3"), cursorOf("c1"), noteTo(&placed), stand, discard); err != nil {
		t.Fatal(err)
	}
	slices.Sort(r.accepted)
	if !slices.Equal(r.accepted, []string{"1", "2 (placeholder)", "3"}) || r.cursor == nil || *r.cursor != "c1" {
		t.Errorf("accepted %v, cursor %v", r.accepted, r.cursor)
	}
	if !slices.Equal(placed, []string{"2"}) {
		t.Errorf("placed %v; the placeholder must be recorded for a later try", placed)
	}
}

func TestTheCursorIsReadWhenItIsSent(t *testing.T) {
	r := &recorder{refused: map[string]int{"2": http.StatusUnprocessableEntity}}
	var placed []string
	cursor := func() *string {
		value := "pending=" + strings.Join(placed, ",")
		return &value
	}
	if err := Batch(context.Background(), r.send, NewStrikes(), "INBOX", batch("1", "2"), cursor, noteTo(&placed), stand, discard); err != nil {
		t.Fatal(err)
	}
	if r.cursor == nil || *r.cursor != "pending=2" {
		t.Errorf("cursor %v; it must include the placeholder recorded during the batch", r.cursor)
	}
}

// Fails without the time floor: three failures within a minute replaced the message.
func TestAMessageTheAPIFailsOnIsReplacedOnlyAfterFailingForAnHour(t *testing.T) {
	c := &clock{now: time.Unix(1_000_000, 0)}
	strikes := c.strikes()
	try := func() (*recorder, error) {
		r := &recorder{refused: map[string]int{"2": http.StatusInternalServerError}}
		var placed []string
		return r, Batch(context.Background(), r.send, strikes, "INBOX", batch("1", "2", "3"), cursorOf("c1"), noteTo(&placed), stand, discard)
	}
	for range 10 {
		c.now = c.now.Add(5 * time.Second)
		if r, err := try(); err == nil || r.cursor != nil {
			t.Fatalf("replaced after failing for %v", c.now.Sub(time.Unix(1_000_000, 0)))
		}
	}
	c.now = c.now.Add(MinStrikeSpan)
	r, err := try()
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(r.accepted, "2 (placeholder)") || r.cursor == nil {
		t.Errorf("accepted %v, cursor %v", r.accepted, r.cursor)
	}
}

func TestNothingIsReplacedWhenEveryMessageFails(t *testing.T) {
	c := &clock{now: time.Unix(1_000_000, 0)}
	strikes := c.strikes()
	for range StrikesBeforeSkip + 2 {
		c.now = c.now.Add(MinStrikeSpan)
		r := &recorder{refused: map[string]int{"1": http.StatusInternalServerError, "2": http.StatusInternalServerError}}
		if err := Batch(context.Background(), r.send, strikes, "INBOX", batch("1", "2"), nil, noteTo(new([]string)), stand, discard); err == nil || len(r.accepted) != 0 {
			t.Fatalf("err %v, accepted %v", err, r.accepted)
		}
	}
}

func TestOtherFailuresAreNotIsolated(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusNotFound, http.StatusConflict, http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		r := &recorder{refused: map[string]int{"1": status}}
		err := Batch(context.Background(), r.send, NewStrikes(), "INBOX", batch("1", "2"), nil, noteTo(new([]string)), stand, discard)
		if err == nil || r.requests != 1 {
			t.Errorf("status %d: err %v after %d requests; want the error after one", status, err, r.requests)
		}
	}
	r := &recorder{}
	broken := errors.New("connection reset")
	failing := func(context.Context, []api.Message, *string) error { r.requests++; return broken }
	if err := Batch(context.Background(), failing, NewStrikes(), "INBOX", batch("1", "2"), nil, noteTo(new([]string)), stand, discard); !errors.Is(err, broken) || r.requests != 1 {
		t.Errorf("err %v after %d requests", err, r.requests)
	}
}

func unreadable(uid string, err error) Failed {
	return Failed{Folder: "INBOX", UID: uid, Err: err, Placeholder: func(context.Context) (api.Message, error) {
		return ingestmsg.Placeholder(api.Message{RemoteUID: uid}), nil
	}}
}

func TestUnreadableMessagesAreReplacedOnceTheyKeptFailingNextToOthers(t *testing.T) {
	c := &clock{now: time.Unix(1_000_000, 0)}
	strikes := c.strikes()
	refused := errors.New("refused")
	failed := []Failed{unreadable("7", refused)}

	for range StrikesBeforeSkip + 1 {
		c.now = c.now.Add(time.Minute)
		var messageErr *MessageError
		if _, err := Unreadable(context.Background(), strikes, failed, 3, discard); !errors.As(err, &messageErr) || messageErr.Err != refused || errors.Is(err, refused) {
			t.Fatalf("%v; want a MessageError that does not unwrap to the provider's error, before an hour passed", err)
		}
	}
	c.now = c.now.Add(MinStrikeSpan)
	placeholders, err := Unreadable(context.Background(), strikes, failed, 3, discard)
	if err != nil || len(placeholders) != 1 || placeholders[0].RemoteUID != "7" || !ingestmsg.IsPlaceholder(placeholders[0]) {
		t.Fatalf("placeholders %v, %v", placeholders, err)
	}
}

// Fails without the fix: a failure that was not a 5xx counted also when no message of the request came through.
func TestAFailureWithNothingDeliveredNeverCounts(t *testing.T) {
	c := &clock{now: time.Unix(1_000_000, 0)}
	strikes := c.strikes()
	for range StrikesBeforeSkip + 3 {
		c.now = c.now.Add(MinStrikeSpan)
		if placeholders, err := Unreadable(context.Background(), strikes, []Failed{unreadable("8", errors.New("403"))}, 0, discard); err == nil || len(placeholders) != 0 {
			t.Fatalf("a failure with nothing delivered was counted: %v, %v", placeholders, err)
		}
	}
}

func TestReplaceTakesThePlaceholdersPlaceOnlyWhenTheAPITakesTheMessage(t *testing.T) {
	r := &recorder{refused: map[string]int{"5": http.StatusUnprocessableEntity}}
	if err := Replace(context.Background(), r.send, r.vanish, api.Message{RemoteUID: "5"}, stand); err == nil || len(r.vanished) != 0 {
		t.Fatalf("err %v, vanished %v; a message the API still refuses must leave the placeholder alone", err, r.vanished)
	}

	r = &recorder{}
	if err := Replace(context.Background(), r.send, r.vanish, api.Message{RemoteUID: "5"}, stand); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(r.vanished, []string{"5"}) || !slices.Equal(r.accepted, []string{"5", "5"}) {
		t.Errorf("vanished %v, accepted %v; want the placeholder removed and the message sent again", r.vanished, r.accepted)
	}
}

func TestPendingPlaceholdersAreTriedLessAndLessOften(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	list := PendingList{}.Add(now, "1", "2")
	if due := list.Due(now.Add(RetryFirst - time.Second)); len(due) != 0 {
		t.Fatalf("due %v before RetryFirst", due)
	}
	if due := list.Due(now.Add(RetryFirst)); !slices.Equal(due, []string{"1", "2"}) {
		t.Fatalf("due %v", due)
	}
	at := now.Add(RetryFirst)
	var waits []time.Duration
	for range 7 {
		list = list.Later("1", at)
		next := time.Unix(list[0].Next, 0)
		waits = append(waits, next.Sub(at))
		at = next
	}
	if waits[0] != 2*RetryFirst || waits[len(waits)-1] != RetryMax {
		t.Errorf("waits %v; want doubling up to %v", waits, RetryMax)
	}
	list = list.Drop("1")
	if len(list) != 1 || list[0].UID != "2" {
		t.Errorf("list after drop %+v", list)
	}

	many := PendingList{}
	for i := range MaxPending + 10 {
		many = many.Add(now, string(rune('a'+i%26))+string(rune('a'+i/26)))
	}
	if len(many) != MaxPending {
		t.Errorf("kept %d, want at most %d", len(many), MaxPending)
	}
}

// folderAPI behaves like the ingest API for one folder: a uid the folder has only gets its flags refreshed (200),
// whatever the content; storing the content of failing uids answers 500.
type folderAPI struct {
	stored  map[string]api.Message
	failing map[string]bool
}

func (f *folderAPI) send(_ context.Context, messages []api.Message, _ *string) error {
	for _, m := range messages {
		if _, known := f.stored[m.RemoteUID]; known {
			continue
		}
		if f.failing[m.RemoteUID] && !ingestmsg.IsPlaceholder(m) {
			return &api.HTTPError{Status: http.StatusInternalServerError}
		}
		f.stored[m.RemoteUID] = m
	}
	return nil
}

func (f *folderAPI) vanish(_ context.Context, uid string) error {
	delete(f.stored, uid)
	return nil
}

// Fails without the fix: the first send only refreshed the placeholder's flags, the uid was removed, the real store
// failed with 500, and the folder kept neither the message nor the placeholder.
func TestAReplacementTheAPIFailsOnPutsThePlaceholderBack(t *testing.T) {
	f := &folderAPI{stored: map[string]api.Message{"5": ingestmsg.Placeholder(api.Message{RemoteUID: "5"})}, failing: map[string]bool{"5": true}}

	err := Replace(context.Background(), f.send, f.vanish, api.Message{RemoteUID: "5", Subject: "Real"}, stand)
	if Classify(err) != MaybeRefused {
		t.Fatalf("err = %v; want the API's 500 back", err)
	}
	if msg, ok := f.stored["5"]; !ok || !ingestmsg.IsPlaceholder(msg) {
		t.Fatalf("uid 5 = %+v, %v; want the placeholder back", msg, ok)
	}

	f.failing = nil
	if err := Replace(context.Background(), f.send, f.vanish, api.Message{RemoteUID: "5", Subject: "Real"}, stand); err != nil {
		t.Fatal(err)
	}
	if msg := f.stored["5"]; ingestmsg.IsPlaceholder(msg) || msg.Subject != "Real" {
		t.Errorf("uid 5 = %+v; want the real message", msg)
	}
}

// A try after one that left the uid empty (the put-back failed) brings the placeholder back.
func TestARefusedTryOverAnEmptyUIDPutsThePlaceholderBack(t *testing.T) {
	f := &folderAPI{stored: map[string]api.Message{}, failing: map[string]bool{"5": true}}
	if err := Replace(context.Background(), f.send, f.vanish, api.Message{RemoteUID: "5"}, stand); err == nil {
		t.Fatal("no error")
	}
	if msg, ok := f.stored["5"]; !ok || !ingestmsg.IsPlaceholder(msg) {
		t.Errorf("uid 5 = %+v, %v; want the placeholder", msg, ok)
	}
}
