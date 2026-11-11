package calsync

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"testing"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/calsync/calsynctest"
	"tresso/sync/internal/netguard"
	"tresso/sync/internal/providerhttp"
)

// fakeProvider is a provider whose session answers what the test sets.
type fakeProvider struct {
	mu        sync.Mutex
	calendars func() ([]Calendar, error)
	changes   func(calendar Calendar) (Changes, error)
	write     func(operation api.CalendarOperation) (api.OperationResult, error)
	listedAt  []time.Time
	sessions  int
}

func (p *fakeProvider) Name() string   { return "Fake" }
func (p *fakeProvider) Source() string { return "google" }
func (p *fakeProvider) NotGranted(err error) bool {
	return errors.Is(err, errScope)
}

var errScope = errors.New("the token lacks the calendar scopes")

func (p *fakeProvider) Open(providerhttp.Tokens, *http.Client, string, *slog.Logger) Session {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sessions++
	return fakeSession{p}
}

type fakeSession struct{ p *fakeProvider }

func (s fakeSession) Calendars(context.Context) ([]Calendar, error) {
	s.p.mu.Lock()
	s.p.listedAt = append(s.p.listedAt, time.Now())
	list := s.p.calendars
	s.p.mu.Unlock()
	return list()
}

func (s fakeSession) Changes(_ context.Context, calendar Calendar, _ string) (Changes, error) {
	if s.p.changes == nil {
		return Changes{Unchanged: true}, nil
	}
	return s.p.changes(calendar)
}

func (s fakeSession) Fetch(context.Context, Calendar, []string) ([]Object, error) {
	return nil, nil
}

func (s fakeSession) Write(_ context.Context, _ Calendar, operation api.CalendarOperation) (api.OperationResult, error) {
	return s.p.write(operation)
}

func (p *fakeProvider) listings() []time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]time.Time(nil), p.listedAt...)
}

func calendarsOf(ids ...string) func() ([]Calendar, error) {
	return func() ([]Calendar, error) {
		var out []Calendar
		for _, id := range ids {
			out = append(out, Calendar{RemoteCalendar: api.RemoteCalendar{RemoteID: id, Name: id, Writable: true}})
		}
		return out, nil
	}
}

func start(t *testing.T, provider *fakeProvider, fake *calsynctest.API, opts Options) *Syncer {
	t.Helper()
	syncer := New(fake, provider, netguard.New(true), "w1", opts, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = syncer.Run(ctx, api.Account{ID: "a1", EmailAddress: "kim@example.com"})
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return syncer
}

var quick = Options{Interval: 10 * time.Millisecond, NotGrantedRetry: time.Hour, MinBackoff: 10 * time.Millisecond, MaxBackoff: 40 * time.Millisecond}

func TestFailuresBackOffAndReachTheUserOnlyAfterSeveral(t *testing.T) {
	provider := &fakeProvider{calendars: func() ([]Calendar, error) { return nil, errors.New("connection reset") }}
	fake := calsynctest.NewAPI("kim@example.com")
	start(t, provider, fake, quick)

	calsynctest.Eventually(t, "six attempts", func() bool { return len(provider.listings()) >= 6 })
	listed := provider.listings()
	first, later := listed[1].Sub(listed[0]), listed[5].Sub(listed[4])
	if first >= 30*time.Millisecond || later < 35*time.Millisecond {
		t.Errorf("waits double up to the maximum: first %v, later %v", first, later)
	}
	if statuses := fake.Statuses(); len(statuses) != 1 || statuses[0] != api.CalendarError {
		t.Errorf("one error status, after the quiet failures: %v", statuses)
	}
}

func TestARefusedCalendarListAsksTheUserToAllowCalendars(t *testing.T) {
	refused := &providerhttp.StatusError{Method: "GET", URL: "/calendars", StatusCode: http.StatusForbidden, Reasons: []string{"ErrorAccessDenied"}}
	provider := &fakeProvider{calendars: func() ([]Calendar, error) { return nil, fmt.Errorf("list: %w", refused) }}
	fake := calsynctest.NewAPI("kim@example.com")
	syncer := start(t, provider, fake, quick)

	calsynctest.Eventually(t, "the status", func() bool { return len(fake.Statuses()) == 1 })
	syncer.Trigger("a1")
	calsynctest.Eventually(t, "the retry the trigger starts", func() bool { return len(provider.listings()) >= 2 })
	if statuses := fake.Statuses(); len(statuses) != 1 || statuses[0] != api.CalendarNotGranted {
		t.Fatalf("statuses = %v", statuses)
	}
}

func TestOneForbiddenCalendarIsSkippedAndTheOthersSync(t *testing.T) {
	forbidden := &providerhttp.StatusError{Method: "GET", URL: "/events", StatusCode: http.StatusForbidden, Reasons: []string{"ErrorAccessDenied"}}
	provider := &fakeProvider{
		calendars: calendarsOf("shared", "own"),
		changes: func(calendar Calendar) (Changes, error) {
			if calendar.RemoteID == "shared" {
				return Changes{}, forbidden
			}
			return Changes{Full: true, Objects: []Object{{RemoteID: "lunch", ETag: "1", Ical: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"}}, Cursor: "c1"}, nil
		},
	}
	fake := calsynctest.NewAPI("kim@example.com")
	start(t, provider, fake, quick)

	calsynctest.Eventually(t, "the other calendar", func() bool { _, ok := fake.Objects("own")["lunch"]; return ok })
	calsynctest.Eventually(t, "more rounds in the same session", func() bool { return len(provider.listings()) >= 3 })
	if provider.sessions != 1 {
		t.Fatalf("one calendar is no account problem: sessions %d", provider.sessions)
	}
	for _, status := range fake.Statuses() {
		if status != api.CalendarError {
			t.Fatalf("statuses = %v; one calendar that keeps failing is at most an error naming it", fake.Statuses())
		}
	}
}

// Fails without the fix: a calendar that failed every time was retried every interval and never reported.
func TestACalendarThatKeepsFailingIsBackedOffAndReported(t *testing.T) {
	var mu sync.Mutex
	var asked []time.Time
	provider := &fakeProvider{
		calendars: calendarsOf("broken", "own"),
		changes: func(calendar Calendar) (Changes, error) {
			if calendar.RemoteID == "broken" {
				mu.Lock()
				asked = append(asked, time.Now())
				mu.Unlock()
				return Changes{}, &providerhttp.StatusError{Method: "GET", URL: "/events", StatusCode: http.StatusInternalServerError}
			}
			return Changes{Full: true, Objects: []Object{{RemoteID: "lunch", ETag: "1", Ical: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"}}, Cursor: "c1"}, nil
		},
	}
	fake := calsynctest.NewAPI("kim@example.com")
	opts := quick
	opts.Interval, opts.MaxBackoff = 5*time.Millisecond, 40*time.Millisecond
	start(t, provider, fake, opts)

	calsynctest.Eventually(t, "the error status", func() bool { return len(fake.Statuses()) > 0 })
	if statuses, details := fake.Statuses(), fake.Details(); statuses[0] != api.CalendarError || details[0] != `The calendar "broken" could not be synced; trying again.` {
		t.Errorf("statuses %v, details %v", statuses, details)
	}
	calsynctest.Eventually(t, "five tries", func() bool { mu.Lock(); defer mu.Unlock(); return len(asked) >= 5 })
	mu.Lock()
	first, later := asked[1].Sub(asked[0]), asked[4].Sub(asked[3])
	mu.Unlock()
	if later < 30*time.Millisecond || later <= first {
		t.Errorf("the gaps between tries of the failing calendar do not grow: first %v, later %v", first, later)
	}
	if listed := len(provider.listings()); listed < 8 {
		t.Errorf("the other calendars were synced %d times only", listed)
	}
	if _, ok := fake.Objects("own")["lunch"]; !ok {
		t.Error("the other calendar did not sync")
	}
}

type fetchSession struct {
	fakeSession
	fetch func(ids []string) ([]Object, error)
}

func (s fetchSession) Fetch(_ context.Context, _ Calendar, ids []string) ([]Object, error) {
	return s.fetch(ids)
}

func TestEventsTheProviderRefusesAreLeftOutAndOnlyAPassingFailureKeepsTheCursor(t *testing.T) {
	text := "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"
	for _, c := range []struct {
		name       string
		transient  bool
		wantCursor string
	}{{"refused", false, "c1"}, {"may pass", true, ""}} {
		t.Run(c.name, func(t *testing.T) {
			provider := &fakeProvider{calendars: calendarsOf("own")}
			r := &run{
				syncer:  New(calsynctest.NewAPI("kim@example.com"), provider, netguard.New(true), "w1", quick, slog.New(slog.NewTextHandler(io.Discard, nil))),
				account: api.Account{ID: "a1"},
				logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
			}
			fake := r.syncer.api.(*calsynctest.API)
			r.session = fetchSession{fakeSession{provider}, func(ids []string) ([]Object, error) {
				var out []Object
				var skipped *FetchError
				for _, id := range ids {
					if id == "two" {
						skipped = skipped.Add(errors.New("refused"), c.transient)
						continue
					}
					out = append(out, Object{RemoteID: id, ETag: "1", Ical: text})
				}
				return out, skipped
			}}
			states, err := fake.Calendars(context.Background(), "a1", api.CalendarList{Calendars: []api.RemoteCalendar{{RemoteID: "own", Name: "own"}}})
			if err != nil {
				t.Fatal(err)
			}
			err = r.upload(context.Background(), Calendar{RemoteCalendar: api.RemoteCalendar{RemoteID: "own"}}, states[0], nil, []string{"one", "two", "three"}, nil, "c1")
			if (err != nil) != c.transient {
				t.Errorf("upload = %v", err)
			}
			if got := calsynctest.Keys(fake.Objects("own")); len(got) != 2 || fake.Cursor("own") != c.wantCursor {
				t.Errorf("stored %v, cursor %q", got, fake.Cursor("own"))
			}
		})
	}
}

func TestEventFailure(t *testing.T) {
	status := func(code int, reasons ...string) error {
		return &providerhttp.StatusError{StatusCode: code, Reasons: reasons}
	}
	never := func(error) bool { return false }
	cases := []struct {
		err             error
		skip, transient bool
	}{
		{status(http.StatusBadRequest), true, false},
		{status(http.StatusForbidden, "ErrorAccessDenied"), true, false},
		{status(http.StatusServiceUnavailable), true, true},
		{status(http.StatusForbidden, "rateLimitExceeded"), false, false},
		{status(http.StatusTooManyRequests), false, false},
		{fmt.Errorf("%w: %w", providerhttp.ErrUnauthorized, status(http.StatusUnauthorized)), false, false},
		{errors.New("connection reset"), false, false},
	}
	for _, c := range cases {
		if skip, transient := EventFailure(c.err, never); skip != c.skip || transient != c.transient {
			t.Errorf("EventFailure(%v) = %v, %v; want %v, %v", c.err, skip, transient, c.skip, c.transient)
		}
	}
	if skip, _ := EventFailure(status(http.StatusForbidden), func(error) bool { return true }); skip {
		t.Error("a token without the calendar scopes was taken for one event")
	}
}

func TestAScopeTheTokenLacksStopsTheSession(t *testing.T) {
	provider := &fakeProvider{
		calendars: calendarsOf("own"),
		changes:   func(Calendar) (Changes, error) { return Changes{}, errScope },
	}
	fake := calsynctest.NewAPI("kim@example.com")
	start(t, provider, fake, quick)

	calsynctest.Eventually(t, "the status", func() bool { return len(fake.Statuses()) == 1 })
	if statuses := fake.Statuses(); statuses[0] != api.CalendarNotGranted {
		t.Fatalf("statuses = %v", statuses)
	}
}

func TestAWriteThatLostTheAccountsAccessIsReportedAndEndsTheSession(t *testing.T) {
	provider := &fakeProvider{
		calendars: calendarsOf("own"),
		write: func(api.CalendarOperation) (api.OperationResult, error) {
			message := "refused"
			return api.OperationResult{Outcome: api.OperationRetry, Error: &message}, fmt.Errorf("write: %w", providerhttp.ErrUnauthorized)
		},
	}
	fake := calsynctest.NewAPI("kim@example.com")
	text := "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"
	fake.Queue(api.CalendarOperation{ID: "op1", Kind: "put", CalendarRemoteID: "own", UID: "lunch", Ical: &text})
	start(t, provider, fake, quick)

	calsynctest.Eventually(t, "the report and the status", func() bool { _, ok := fake.Result("op1"); return ok && len(fake.Statuses()) == 1 })
	if result, _ := fake.Result("op1"); result.Outcome != api.OperationRetry {
		t.Errorf("result = %+v", result)
	}
	if statuses := fake.Statuses(); statuses[0] != api.CalendarAuthFailed {
		t.Errorf("statuses = %v", statuses)
	}
}

func TestARateLimitOnTheCalendarListIsNoMissingPermission(t *testing.T) {
	limited := &providerhttp.StatusError{Method: "GET", URL: "/users/me/calendarList", StatusCode: http.StatusForbidden, Reasons: []string{"403", "rateLimitExceeded", "PERMISSION_DENIED"}}
	provider := &fakeProvider{calendars: func() ([]Calendar, error) { return nil, fmt.Errorf("list: %w", limited) }}
	fake := calsynctest.NewAPI("kim@example.com")
	start(t, provider, fake, quick)

	calsynctest.Eventually(t, "the quiet failures", func() bool { return len(provider.listings()) >= 4 })
	for _, status := range fake.Statuses() {
		if status == api.CalendarNotGranted {
			t.Fatalf("statuses = %v", fake.Statuses())
		}
	}
	if statuses := fake.Statuses(); len(statuses) != 1 || statuses[0] != api.CalendarError {
		t.Fatalf("an exhausted rate limit is an ordinary failure, retried with backoff: %v", statuses)
	}
}
