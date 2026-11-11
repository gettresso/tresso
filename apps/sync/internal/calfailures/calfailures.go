// Package calfailures keeps track of the calendars of one account that keep failing to sync. One such calendar must
// not hold up the others, so its error is not a session error; but it must not be retried at full pace for ever
// without anyone noticing either. A failing calendar is backed off (its wait doubles up to a maximum) and, once it
// failed Threshold times in a row, named in the account's calendar status.
package calfailures

import (
	"fmt"
	"sort"
	"sync"
	"time"
)

// Threshold is how many syncs in a row a calendar may fail before the user is told.
const Threshold = 3

type entry struct {
	name     string
	failures int
	wait     time.Duration
	next     time.Time
}

// Tracker holds the failing calendars of one account, by remote id. It lives as long as the account's calendar
// syncer, across sessions. It is safe for concurrent use.
type Tracker struct {
	mu      sync.Mutex
	first   time.Duration
	max     time.Duration
	now     func() time.Time
	entries map[string]*entry
}

// New returns a tracker whose first wait after a failure is first, doubling up to max.
func New(first, max time.Duration) *Tracker {
	return &Tracker{first: first, max: max, now: time.Now, entries: map[string]*entry{}}
}

// Due reports whether the calendar may be synced now: it is not backing off from a failure.
func (t *Tracker) Due(remoteID string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	e, ok := t.entries[remoteID]
	return !ok || !t.now().Before(e.next)
}

// Failed counts a failed sync of the calendar and schedules its next try.
func (t *Tracker) Failed(remoteID, name string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	e, ok := t.entries[remoteID]
	if !ok {
		e = &entry{}
		t.entries[remoteID] = e
	}
	e.name = name
	e.failures++
	if e.wait == 0 {
		e.wait = t.first
	} else {
		e.wait = min(e.wait*2, t.max)
	}
	e.next = t.now().Add(e.wait)
}

// Succeeded forgets the calendar's failures.
func (t *Tracker) Succeeded(remoteID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.entries, remoteID)
}

// Keep forgets the calendars that are no longer listed.
func (t *Tracker) Keep(listed map[string]bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for id := range t.entries {
		if !listed[id] {
			delete(t.entries, id)
		}
	}
}

// Detail is the status text for the calendars that failed Threshold times or more in a row; ok is false when there
// are none.
func (t *Tracker) Detail() (detail string, ok bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	var names []string
	for _, e := range t.entries {
		if e.failures >= Threshold {
			names = append(names, e.name)
		}
	}
	switch len(names) {
	case 0:
		return "", false
	case 1:
		return fmt.Sprintf("The calendar %q could not be synced; trying again.", names[0]), true
	default:
		sort.Strings(names)
		return fmt.Sprintf("%d calendars could not be synced (%q and others); trying again.", len(names), names[0]), true
	}
}
