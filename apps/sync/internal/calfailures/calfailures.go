// Package calfailures keeps track of the calendars of one account that keep failing to sync. One such calendar must
// not hold up the others, so its error is not a session error; but it must not be retried at full pace for ever
// without anyone noticing either. A failing calendar is backed off (its wait doubles up to a maximum) and, once it
// failed Threshold times in a row, named in the account's calendar status.
package calfailures

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"sync"
	"time"

	"tresso/sync/internal/api"
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

// Recovery remembers whether the API was told that the calendars sync again. The API keeps an error status
// until it hears so (a calendar list does not clear it), so after a round in which every calendar synced the worker
// reports active: once after it reported a problem, and once after a start, when it does not know what the API
// shows. An API that does not know the status answers 422; it is asked again a day later at the earliest (a worker
// may outlive an upgrade of the API), and after the next problem.
//
// Problem notes that a problem status was reported; Report sends active (with send) unless the API was told already
// or does not know the status.
type Recovery struct {
	told bool
	// unsupported is when the API last answered 422 to active; zero when it has not.
	unsupported time.Time
	now         func() time.Time
}

// UnsupportedRetry is how long an API that refused active is left alone.
const UnsupportedRetry = 24 * time.Hour

func (c *Recovery) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

func (c *Recovery) Problem() {
	c.told = false
	c.unsupported = time.Time{}
}

func (c *Recovery) Report(send func() error, logger *slog.Logger) {
	if c.told || (!c.unsupported.IsZero() && c.clock().Sub(c.unsupported) < UnsupportedRetry) {
		return
	}
	err := send()
	var httpErr *api.HTTPError
	switch {
	case errors.As(err, &httpErr) && httpErr.Status == http.StatusUnprocessableEntity:
		logger.Info("the API takes no active calendar status; asking again in a day")
		c.unsupported = c.clock()
	case err != nil:
		logger.Warn("reporting that the calendars sync again failed", "error", err)
	default:
		c.told, c.unsupported = true, time.Time{}
	}
}
