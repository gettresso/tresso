package api

import (
	"context"
	"net/url"
)

// RemoteCalendar is one calendar collection at the provider.
type RemoteCalendar struct {
	RemoteID  string  `json:"remoteId"`
	Name      string  `json:"name"`
	Color     *string `json:"color"`
	TimeZone  *string `json:"timeZone"`
	Writable  bool    `json:"writable"`
	IsDefault bool    `json:"isDefault"`
	// ConferenceProviders are the online meetings events of this calendar can get ("meet", "teams").
	ConferenceProviders []string `json:"conferenceProviders,omitempty"`
}

// CalendarList is the complete calendar list of an account.
type CalendarList struct {
	WorkerID          string           `json:"workerId"`
	Source            string           `json:"source"`
	ServerURL         *string          `json:"serverUrl"`
	ProviderSchedules bool             `json:"providerSchedules"`
	Calendars         []RemoteCalendar `json:"calendars"`
}

// CalendarState is what the API keeps for a calendar: its id and the cursor the last batch ended with.
type CalendarState struct {
	RemoteID string  `json:"remoteId"`
	ID       string  `json:"id"`
	Cursor   *string `json:"cursor"`
}

// CalendarListAnswer is the API's answer to a calendar list: its state per calendar, and the account's calendar status
// after the list (the list keeps `error` and makes any other status `active`). Status is empty from an API that does
// not send it.
type CalendarListAnswer struct {
	Calendars []CalendarState `json:"calendars"`
	Status    string          `json:"calendarStatus"`
}

// RemoteObject is one calendar resource; Ical is set when it was fetched.
type RemoteObject struct {
	RemoteID string  `json:"remoteId"`
	ETag     *string `json:"etag"`
	Ical     *string `json:"ical,omitempty"`
}

type InventoryResult struct {
	Fetch   []string `json:"fetch"`
	Removed int      `json:"removed"`
}

type ObjectBatch struct {
	WorkerID string         `json:"workerId"`
	Cursor   *string        `json:"cursor"`
	Changed  []RemoteObject `json:"changed"`
	Removed  []string       `json:"removed"`
}

type ObjectBatchResult struct {
	Stored  int `json:"stored"`
	Removed int `json:"removed"`
	Skipped int `json:"skipped"`
}

// CalendarOperation is a write the worker makes at the provider: put Ical (create when RemoteID is nil) or delete
// RemoteID, conditional on IfMatch.
type CalendarOperation struct {
	ID               string  `json:"id"`
	Kind             string  `json:"kind"`
	CalendarRemoteID string  `json:"calendarRemoteId"`
	UID              string  `json:"uid"`
	RemoteID         *string `json:"remoteId"`
	IfMatch          *string `json:"ifMatch"`
	Ical             *string `json:"ical"`
	Attempt          int     `json:"attempt"`
	// Notify is false when the user asked not to tell attendees (the provider then sends no updates or replies).
	Notify bool `json:"notify"`
	// Comment goes with the user's reply to an invitation.
	Comment *string `json:"comment"`
}

// OperationResult reports a calendar write: done, conflict (with the provider's current version, nil when gone),
// failed or retry. A done write may carry the provider's version too, when the provider changed the event while
// storing it (a Google Meet or Teams meeting it added).
type OperationResult struct {
	WorkerID string        `json:"workerId"`
	Outcome  string        `json:"outcome"`
	RemoteID *string       `json:"remoteId,omitempty"`
	ETag     *string       `json:"etag,omitempty"`
	Error    *string       `json:"error,omitempty"`
	Current  *RemoteObject `json:"current,omitempty"`
}

const (
	OperationDone     = "done"
	OperationConflict = "conflict"
	OperationFailed   = "failed"
	OperationRetry    = "retry"
)

func (c *Client) Calendars(ctx context.Context, accountID string, list CalendarList) (CalendarListAnswer, error) {
	list.Calendars = nonNil(list.Calendars)
	var out CalendarListAnswer
	err := c.post(ctx, accountPath(accountID, "calendars"), list, &out)
	return out, err
}

// CalendarInventory hands a listing of a calendar to the API, which names what to fetch. A complete listing also
// removes what it does not list; a partial one (a page of a listing too large for one request) never removes.
func (c *Client) CalendarInventory(ctx context.Context, accountID, calendarID, workerID string, objects []RemoteObject, partial bool) (InventoryResult, error) {
	var out InventoryResult
	err := c.post(ctx, calendarPath(accountID, calendarID, "inventory"), map[string]any{"workerId": workerID, "objects": nonNil(objects), "partial": partial}, &out)
	return out, err
}

func (c *Client) CalendarObjects(ctx context.Context, accountID, calendarID string, batch ObjectBatch) (ObjectBatchResult, error) {
	batch.Changed, batch.Removed = nonNil(batch.Changed), nonNil(batch.Removed)
	var out ObjectBatchResult
	err := c.post(ctx, calendarPath(accountID, calendarID, "objects"), batch, &out)
	return out, err
}

func (c *Client) ClaimCalendarOperations(ctx context.Context, accountID, workerID string) ([]CalendarOperation, error) {
	var out struct {
		Operations []CalendarOperation `json:"operations"`
	}
	err := c.post(ctx, accountPath(accountID, "calendar-operations/claim"), map[string]any{"workerId": workerID}, &out)
	return out.Operations, err
}

func (c *Client) ReportCalendarOperation(ctx context.Context, accountID, operationID string, result OperationResult) error {
	return c.post(ctx, accountPath(accountID, "calendar-operations/"+url.PathEscape(operationID)+"/result"), result, nil)
}

func calendarPath(accountID, calendarID, action string) string {
	return accountPath(accountID, "calendars/"+url.PathEscape(calendarID)+"/"+action)
}

// Calendar sync statuses the worker reports; a working sync is reported by the calendar list itself.
const (
	CalendarUnsupported = "unsupported"
	CalendarAuthFailed  = "auth_failed"
	CalendarError       = "error"
	// CalendarUnconfirmed: a server was found that the user has to confirm before it gets the password.
	CalendarUnconfirmed = "unconfirmed"
	// CalendarNotGranted: the provider refuses calendar access because the user did not allow it.
	CalendarNotGranted = "not_granted"
	// CalendarActive: the calendars sync again after an error. The API applies it only over error; an API that does
	// not know it answers 422.
	CalendarActive = "active"
)

// CalendarStatus reports why the account's calendars do not sync. foundURL is the address of a calendar server the
// user is to confirm (status unconfirmed): it is sent as "url", and left out when empty, so an API that does not know
// the field yet gets the same request as before.
func (c *Client) CalendarStatus(ctx context.Context, accountID, workerID, status, detail, foundURL string) error {
	body := map[string]any{"workerId": workerID, "status": status, "detail": detail}
	if foundURL != "" {
		body["url"] = foundURL
	}
	return c.post(ctx, accountPath(accountID, "calendar-status"), body, nil)
}
