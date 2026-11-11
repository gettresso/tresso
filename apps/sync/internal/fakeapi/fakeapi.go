// Package fakeapi is an in-memory stand-in for the internal API's sync endpoints, for the provider syncers' tests. It
// follows the API's ingest rules: messages are stored once per Message-ID and linked into folders, flag changes for
// uids a folder does not have come back as unknown, and removing a message's last location deletes it.
package fakeapi

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"tresso/sync/internal/api"
)

type API struct {
	mu sync.Mutex

	// Credentials: Token is handed out, RefreshCredentials replaces it with RefreshedToken.
	Token          string
	RefreshedToken string
	ExpiresAt      time.Time
	Reauthorize    bool // answer credentials with 409, as when the provider refused to renew
	Refreshes      int

	reported    []api.Folder
	Cursors     map[string]*string
	locations   map[string]map[string]string // folder -> remote uid -> message key
	messages    map[string]api.Message       // key -> message
	Deleted     []string                     // keys of deleted messages, in order
	Statuses    []string                     // "status: detail"
	ingested    map[string][]string          // remote uids of every MessageBatch, per folder, in arrival order
	FolderCalls int
	// RefuseMessages, when set, can refuse a message batch the way the API does (an *api.HTTPError).
	RefuseMessages func(batch api.MessageBatch) error
	// StatusFailures fails that many status reports before taking them.
	StatusFailures int
	vanishRequests int // change requests that removed messages (or tried to)
}

func New() *API {
	return &API{
		Token:          "token-1",
		RefreshedToken: "token-2",
		ExpiresAt:      time.Now().Add(time.Hour),
		Cursors:        map[string]*string{},
		locations:      map[string]map[string]string{},
		messages:       map[string]api.Message{},
		ingested:       map[string][]string{},
	}
}

func (f *API) credentials(token string) (api.Credentials, error) {
	if f.Reauthorize {
		return api.Credentials{}, fmt.Errorf("%w: %w", api.ErrReauthorize, &api.HTTPError{Method: http.MethodGet, Status: http.StatusConflict})
	}
	return api.Credentials{AccountID: "acc", Provider: "test", Secrets: map[string]string{
		"type": "oauth2", "accessToken": token, "expiresAt": f.ExpiresAt.Format(time.RFC3339),
	}}, nil
}

func (f *API) Credentials(context.Context, string, string) (api.Credentials, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.credentials(f.Token)
}

func (f *API) RefreshCredentials(context.Context, string, string) (api.Credentials, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Refreshes++
	if f.RefreshedToken != "" {
		f.Token = f.RefreshedToken
	}
	return f.credentials(f.Token)
}

func (f *API) Folders(_ context.Context, _, _ string, folders []api.Folder) ([]api.FolderState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.FolderCalls++
	f.reported = folders
	states := make([]api.FolderState, 0, len(folders))
	for _, folder := range folders {
		states = append(states, api.FolderState{RemoteName: folder.RemoteName, Cursor: f.Cursors[folder.RemoteName]})
	}
	return states, nil
}

func (f *API) Messages(_ context.Context, _ string, batch api.MessageBatch) (api.MessageBatchResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(batch.Messages) > api.MaxMessagesPerBatch {
		return api.MessageBatchResult{}, fmt.Errorf("batch of %d messages", len(batch.Messages))
	}
	if f.RefuseMessages != nil {
		if err := f.RefuseMessages(batch); err != nil {
			return api.MessageBatchResult{}, err
		}
	}
	if err := f.storeCursor(batch.Folder, batch.Cursor); err != nil {
		return api.MessageBatchResult{}, err
	}
	var result api.MessageBatchResult
	for _, m := range batch.Messages {
		f.ingested[batch.Folder] = append(f.ingested[batch.Folder], m.RemoteUID)
		if key, ok := f.location(batch.Folder, m.RemoteUID); ok {
			stored := f.messages[key]
			stored.Flags = m.Flags
			f.messages[key] = stored
			result.Updated++
			continue
		}
		key := m.RawObjectKey
		if m.MessageID != nil {
			key = *m.MessageID
		}
		if _, ok := f.messages[key]; ok {
			result.Linked++
		} else {
			f.messages[key] = m
			result.Stored++
		}
		if f.locations[batch.Folder] == nil {
			f.locations[batch.Folder] = map[string]string{}
		}
		f.locations[batch.Folder][m.RemoteUID] = key
	}
	return result, nil
}

func (f *API) Changes(_ context.Context, _ string, batch api.ChangeBatch) (api.ChangeBatchResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(batch.Flags) > api.MaxFlagChanges || len(batch.Vanished) > api.MaxVanished {
		return api.ChangeBatchResult{}, fmt.Errorf("change batch too large")
	}
	if len(batch.Presence) > 0 {
		return api.ChangeBatchResult{}, fmt.Errorf("presence ranges are IMAP only")
	}
	if err := f.storeCursor(batch.Folder, batch.Cursor); err != nil {
		return api.ChangeBatchResult{}, err
	}
	result := api.ChangeBatchResult{UnknownUIDs: []string{}}
	for _, change := range batch.Flags {
		key, ok := f.location(batch.Folder, change.RemoteUID)
		if !ok {
			result.Unknown++
			result.UnknownUIDs = append(result.UnknownUIDs, change.RemoteUID)
			continue
		}
		stored := f.messages[key]
		stored.Flags = change.Flags
		f.messages[key] = stored
		result.Updated++
	}
	if len(batch.Vanished) > 0 {
		f.vanishRequests++
	}
	for _, uid := range batch.Vanished {
		key, ok := f.location(batch.Folder, uid)
		if !ok {
			continue
		}
		delete(f.locations[batch.Folder], uid)
		result.Removed++
		if !f.locatedAnywhere(key) {
			delete(f.messages, key)
			f.Deleted = append(f.Deleted, key)
			result.Deleted++
		}
	}
	return result, nil
}

func (f *API) RemoteUIDs(_ context.Context, _, _, folder, after string, limit int) (api.RemoteUIDPage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if limit < 1 || limit > api.MaxRemoteUIDPage {
		return api.RemoteUIDPage{}, fmt.Errorf("limit %d", limit)
	}
	uids := make([]string, 0, len(f.locations[folder]))
	for uid := range f.locations[folder] {
		if uid > after {
			uids = append(uids, uid)
		}
	}
	slices.Sort(uids)
	page := api.RemoteUIDPage{RemoteUIDs: uids}
	if len(uids) > limit {
		page.RemoteUIDs = uids[:limit]
		next := uids[limit-1]
		page.Next = &next
	}
	return page, nil
}

func (f *API) Status(_ context.Context, _, _, status, detail string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.StatusFailures > 0 {
		f.StatusFailures--
		return &api.HTTPError{Method: http.MethodPost, Path: "/status", Status: http.StatusServiceUnavailable}
	}
	f.Statuses = append(f.Statuses, status+": "+detail)
	return nil
}

func (f *API) storeCursor(folder string, cursor *string) error {
	if cursor == nil {
		return nil
	}
	if len(*cursor) > api.MaxCursorLength {
		return fmt.Errorf("cursor of %d bytes", len(*cursor))
	}
	value := *cursor
	f.Cursors[folder] = &value
	return nil
}

func (f *API) location(folder, uid string) (string, bool) {
	key, ok := f.locations[folder][uid]
	return key, ok
}

func (f *API) locatedAnywhere(key string) bool {
	for _, uids := range f.locations {
		for _, k := range uids {
			if k == key {
				return true
			}
		}
	}
	return false
}

// UIDs returns the remote uids a folder holds, sorted.
func (f *API) UIDs(folder string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	uids := make([]string, 0, len(f.locations[folder]))
	for uid := range f.locations[folder] {
		uids = append(uids, uid)
	}
	slices.Sort(uids)
	return uids
}

// Flags returns the stored flags of the message at uid in folder.
func (f *API) Flags(folder, uid string) (api.Flags, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key, ok := f.location(folder, uid)
	if !ok {
		return api.Flags{}, false
	}
	return f.messages[key].Flags, true
}

// Cursor returns a folder's stored cursor, "" when it has none.
func (f *API) Cursor(folder string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c := f.Cursors[folder]; c != nil {
		return *c
	}
	return ""
}

// StatusLog returns the reported statuses joined by "; ".
func (f *API) StatusLog() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return strings.Join(f.Statuses, "; ")
}

// ReportedFolders returns the folder list of the last Folders call.
func (f *API) ReportedFolders() []api.Folder {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.reported)
}

// DeletedKeys returns the keys (Message-IDs) of deleted messages.
func (f *API) DeletedKeys() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.Deleted)
}

// Ingested returns the remote uids of every message batch sent for a folder, in the order they arrived.
func (f *API) Ingested(folder string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.ingested[folder])
}

// VanishRequests returns how many change requests removed messages (or tried to).
func (f *API) VanishRequests() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.vanishRequests
}

// Calls returns how often Folders was called.
func (f *API) Calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.FolderCalls
}

// RawMessage is a minimal RFC 5322 message with a Message-ID, so the fake links it across folders.
func RawMessage(messageID, subject string) []byte {
	return []byte("From: Sam <sam@example.test>\r\nTo: kim@example.test\r\nSubject: " + subject +
		"\r\nMessage-ID: <" + messageID + ">\r\nDate: Mon, 19 Oct 2026 10:00:00 +0000\r\n\r\nHello " + subject + "\r\n")
}

// Message returns the stored message at uid in folder.
func (f *API) Message(folder, uid string) (api.Message, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key, ok := f.location(folder, uid)
	if !ok {
		return api.Message{}, false
	}
	return f.messages[key], true
}

// MoveLocation does what the API does when the worker reports a move as done: the copy's location leaves the source
// folder and lands in the target under remoteUID. When the target already holds remoteUID (a Gmail archive into All
// Mail, where the message already is) only the source location goes.
func (f *API) MoveLocation(source, target, uid, remoteUID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key, ok := f.location(source, uid)
	if !ok {
		return
	}
	delete(f.locations[source], uid)
	if _, exists := f.locations[target][remoteUID]; exists {
		return
	}
	if f.locations[target] == nil {
		f.locations[target] = map[string]string{}
	}
	f.locations[target][remoteUID] = key
}

// UUIDv7 returns a UUIDv7 made at t, as the API's ids are.
func UUIDv7(t time.Time, n int) string {
	hex := fmt.Sprintf("%012x", t.UnixMilli())
	return fmt.Sprintf("%s-%s-7000-8000-%012x", hex[:8], hex[8:12], n)
}
