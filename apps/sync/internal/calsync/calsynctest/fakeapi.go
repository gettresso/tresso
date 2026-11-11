// Package calsynctest has the fake internal API the provider calendar tests sync against.
package calsynctest

import (
	"context"
	"sort"
	"sync"
	"testing"
	"time"

	"tresso/sync/internal/api"
)

// Stored is one resource as the fake API keeps it.
type Stored struct {
	ETag string
	Ical string
}

// API is a fake of the calendar part of the internal API, with the API's ingest rules: a full listing removes what
// it does not list, a batch's cursor is stored with it, and a write result's current version replaces the stored one.
type API struct {
	mu          sync.Mutex
	Email       string
	NotGranted  bool
	lists       []api.CalendarList
	ids         map[string]string            // calendar id by remote id
	cursors     map[string]string            // by calendar id
	objects     map[string]map[string]Stored // by calendar id, then remote id
	inventories int
	batches     int
	operations  []api.CalendarOperation
	results     map[string]api.OperationResult
	queued      map[string]api.CalendarOperation // every write ever queued, by id
	statuses    []string
	details     []string
	tokens      int
}

func NewAPI(email string) *API {
	return &API{Email: email, ids: map[string]string{}, cursors: map[string]string{}, objects: map[string]map[string]Stored{}, results: map[string]api.OperationResult{}, queued: map[string]api.CalendarOperation{}}
}

func (a *API) CalendarCredentials(context.Context, string, string) (api.Credentials, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.NotGranted {
		return api.Credentials{}, api.ErrNotGranted
	}
	a.tokens++
	return api.Credentials{AccountID: "a1", EmailAddress: a.Email, Secrets: map[string]string{"type": "oauth2", "accessToken": "token", "expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339)}}, nil
}

func (a *API) RefreshCalendarCredentials(ctx context.Context, accountID, workerID string) (api.Credentials, error) {
	return a.CalendarCredentials(ctx, accountID, workerID)
}

// Grant lets the worker have calendar tokens from now on.
func (a *API) Grant() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.NotGranted = false
}

func (a *API) Calendars(_ context.Context, _ string, list api.CalendarList) ([]api.CalendarState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.lists = append(a.lists, list)
	states := make([]api.CalendarState, 0, len(list.Calendars))
	for _, calendar := range list.Calendars {
		id, ok := a.ids[calendar.RemoteID]
		if !ok {
			id = "cal-" + calendar.RemoteID
			a.ids[calendar.RemoteID] = id
			a.objects[id] = map[string]Stored{}
		}
		state := api.CalendarState{RemoteID: calendar.RemoteID, ID: id}
		if cursor, ok := a.cursors[id]; ok {
			state.Cursor = &cursor
		}
		states = append(states, state)
	}
	return states, nil
}

func (a *API) CalendarInventory(_ context.Context, _, calendarID, _ string, objects []api.RemoteObject, partial bool) (api.InventoryResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.inventories++
	stored := a.objects[calendarID]
	listed := map[string]bool{}
	result := api.InventoryResult{Fetch: []string{}}
	for _, object := range objects {
		listed[object.RemoteID] = true
		if current, ok := stored[object.RemoteID]; !ok || object.ETag == nil || current.ETag != *object.ETag {
			result.Fetch = append(result.Fetch, object.RemoteID)
		}
	}
	if !partial {
		for remoteID := range stored {
			if !listed[remoteID] && !a.pendingLocked(remoteID) {
				delete(stored, remoteID)
				result.Removed++
			}
		}
	}
	return result, nil
}

func (a *API) pendingLocked(remoteID string) bool {
	for _, operation := range a.operations {
		if operation.RemoteID != nil && *operation.RemoteID == remoteID {
			return true
		}
	}
	return false
}

func (a *API) CalendarObjects(_ context.Context, _, calendarID string, batch api.ObjectBatch) (api.ObjectBatchResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.batches++
	stored := a.objects[calendarID]
	for _, object := range batch.Changed {
		stored[object.RemoteID] = Stored{ETag: *object.ETag, Ical: *object.Ical}
	}
	for _, remoteID := range batch.Removed {
		delete(stored, remoteID)
	}
	if batch.Cursor != nil {
		a.cursors[calendarID] = *batch.Cursor
	}
	return api.ObjectBatchResult{Stored: len(batch.Changed), Removed: len(batch.Removed)}, nil
}

func (a *API) ClaimCalendarOperations(context.Context, string, string) ([]api.CalendarOperation, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	operations := a.operations
	a.operations = nil
	return operations, nil
}

func (a *API) ReportCalendarOperation(_ context.Context, _, operationID string, result api.OperationResult) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.results[operationID] = result
	operation := a.queued[operationID]
	stored := a.objects[a.ids[operation.CalendarRemoteID]]
	switch {
	case result.Current != nil && result.Current.Ical != nil:
		stored[result.Current.RemoteID] = Stored{ETag: *result.Current.ETag, Ical: *result.Current.Ical}
	case operation.Kind == "delete" && result.Outcome == api.OperationDone && operation.RemoteID != nil,
		result.Outcome == api.OperationConflict && operation.RemoteID != nil:
		delete(stored, *operation.RemoteID)
	}
	return nil
}

func (a *API) CalendarStatus(_ context.Context, _, _, status, detail string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.statuses = append(a.statuses, status)
	a.details = append(a.details, detail)
	return nil
}

// Details returns the detail of every status report, in order.
func (a *API) Details() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.details...)
}

// Queue adds a write for the worker to claim.
func (a *API) Queue(operation api.CalendarOperation) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.operations = append(a.operations, operation)
	a.queued[operation.ID] = operation
}

// Result is the reported outcome of a write, if any.
func (a *API) Result(operationID string) (api.OperationResult, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	result, ok := a.results[operationID]
	return result, ok
}

// Objects is a copy of what the API holds for a calendar, by remote id.
func (a *API) Objects(remoteCalendar string) map[string]Stored {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := map[string]Stored{}
	for remoteID, object := range a.objects[a.ids[remoteCalendar]] {
		out[remoteID] = object
	}
	return out
}

// Lists returns the calendar lists the worker reported.
func (a *API) Lists() []api.CalendarList {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]api.CalendarList(nil), a.lists...)
}

func (a *API) Statuses() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.statuses...)
}

// Counts are the inventories and object batches the worker sent.
func (a *API) Counts() (inventories, batches int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.inventories, a.batches
}

// Cursor is the stored cursor of a calendar.
func (a *API) Cursor(remoteCalendar string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cursors[a.ids[remoteCalendar]]
}

// Keys returns the sorted keys of a map, for messages.
func Keys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Eventually waits until cond holds, or fails the test after a few seconds.
func Eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}
