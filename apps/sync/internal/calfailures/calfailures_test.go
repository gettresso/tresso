package calfailures

import (
	"testing"
	"time"
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
