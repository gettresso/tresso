package calfailures

import (
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"tresso/sync/internal/api"
)

func TestAFailingCalendarIsBackedOffAndNamedAfterTheThreshold(t *testing.T) {
	now := time.Unix(0, 0)
	tracker := New(time.Minute, 4*time.Minute)
	tracker.now = func() time.Time { return now }

	var gaps []time.Duration
	for range Threshold + 2 {
		if !tracker.Due("cal") {
			t.Fatal("a calendar was not due once its wait passed")
		}
		if _, ok := tracker.Detail(); ok && len(gaps) < Threshold {
			t.Fatalf("reported after %d failures", len(gaps))
		}
		tracker.Failed("cal", "Team")
		start := now
		for !tracker.Due("cal") {
			now = now.Add(time.Second)
		}
		gaps = append(gaps, now.Sub(start))
	}
	want := []time.Duration{time.Minute, 2 * time.Minute, 4 * time.Minute, 4 * time.Minute, 4 * time.Minute}
	for i := range want {
		if gaps[i] != want[i] {
			t.Errorf("gaps = %v, want %v", gaps, want)
			break
		}
	}
	if detail, ok := tracker.Detail(); !ok || detail != `The calendar "Team" could not be synced; trying again.` {
		t.Errorf("detail %q, %v", detail, ok)
	}

	tracker.Succeeded("cal")
	if _, ok := tracker.Detail(); ok || !tracker.Due("cal") {
		t.Error("a calendar that synced again is still counted")
	}
}

func TestCalendarsNoLongerListedAreForgotten(t *testing.T) {
	tracker := New(time.Minute, time.Hour)
	for range Threshold {
		tracker.Failed("a", "A")
		tracker.Failed("b", "B")
	}
	if detail, _ := tracker.Detail(); detail != `2 calendars could not be synced ("A" and others); trying again.` {
		t.Errorf("detail %q", detail)
	}
	tracker.Keep(map[string]bool{"b": true})
	if detail, _ := tracker.Detail(); detail != `The calendar "B" could not be synced; trying again.` {
		t.Errorf("detail %q", detail)
	}
}

func TestAnAPIThatRefusedActiveIsAskedAgainADayLater(t *testing.T) {
	now := time.Unix(0, 0)
	r := &Recovery{now: func() time.Time { return now }}
	asked := 0
	refuse := true
	send := func() error {
		asked++
		if refuse {
			return &api.HTTPError{Status: http.StatusUnprocessableEntity}
		}
		return nil
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	r.Report(send, logger)
	now = now.Add(UnsupportedRetry - time.Minute)
	r.Report(send, logger)
	if asked != 1 {
		t.Fatalf("asked %d times within a day", asked)
	}
	refuse = false
	now = now.Add(2 * time.Minute)
	r.Report(send, logger)
	r.Report(send, logger)
	if asked != 2 {
		t.Errorf("asked %d times; want once more after a day, then not again", asked)
	}
}
