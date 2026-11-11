package providersync

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/ingestmsg"
	"tresso/sync/internal/isolate"
	"tresso/sync/internal/providerhttp"
	"tresso/sync/internal/storage"
)

// MaxRemoteUIDLength is the longest remote uid the API stores. Provider ids are far shorter; a longer one is refused
// with an error instead of being cut, which would merge different messages.
const MaxRemoteUIDLength = 255

func checkRemoteUIDs[T any](items []T, uid func(T) string) error {
	for _, item := range items {
		if id := uid(item); len(id) > MaxRemoteUIDLength {
			return fmt.Errorf("remote uid of %d bytes is longer than the API's %d", len(id), MaxRemoteUIDLength)
		}
	}
	return nil
}

// Fetcher downloads and stores the raw messages with the given ids and returns them for the ingest API. Messages that
// no longer exist at the provider are left out.
type Fetcher func(ctx context.Context, ids []string) ([]api.Message, error)

// Ingest sends one account's changes to the API in batches the API accepts.
//
// It also keeps the placeholders whose message is to be tried again (see package isolate) in the cursors it stores:
// under the key "pending" of the cursor's JSON object, which the providers' cursor types leave alone. Every cursor it
// sends carries the folder's current list, and a new placeholder is recorded in the stored cursor before it is sent,
// so a placeholder is never left without a later try.
type Ingest struct {
	API       API
	AccountID string
	WorkerID  string
	// FetchBatch is how many raw messages are downloaded per ingest request (at most api.MaxMessagesPerBatch).
	FetchBatch int
	// Strikes counts the messages that failed in earlier sessions of the account's run (see package isolate). Nil
	// starts a count of its own.
	Strikes *isolate.Strikes
	// PendingFolder names the folder whose cursor keeps the placeholders of folder; nil keeps them in folder's own.
	// Gmail keeps every placeholder on All Mail, as its ids name a message in the whole account.
	PendingFolder func(folder string) string
	Logger        *slog.Logger
	// Store keeps the raw notices of placeholders (see ingestmsg.PlaceholderFor).
	Store storage.Blobs
	// Now is the clock of the placeholders' retries; nil is time.Now.
	Now func() time.Time

	mu      sync.Mutex
	stored  map[string]*string // the cursor the API has for a folder, as last loaded or sent
	pending map[string]isolate.PendingList
}

func (in *Ingest) strikes() *isolate.Strikes {
	if in.Strikes == nil {
		in.Strikes = isolate.NewStrikes()
	}
	return in.Strikes
}

func (in *Ingest) clock() time.Time {
	if in.Now != nil {
		return in.Now()
	}
	return time.Now()
}

func (in *Ingest) pendingFolder(folder string) string {
	if in.PendingFolder == nil {
		return folder
	}
	return in.PendingFolder(folder)
}

// Load takes the cursor the API answered for a folder, with the placeholders it keeps.
func (in *Ingest) Load(folder string, cursor *string) {
	in.mu.Lock()
	defer in.mu.Unlock()
	in.init()
	in.stored[folder] = cursor
	var fields struct {
		Pending isolate.PendingList `json:"pending"`
	}
	if cursor != nil && *cursor != "" && json.Unmarshal([]byte(*cursor), &fields) == nil {
		in.pending[folder] = fields.Pending
	} else {
		delete(in.pending, folder)
	}
}

// Pending returns the placeholders a folder's cursor keeps.
func (in *Ingest) Pending(folder string) isolate.PendingList {
	in.mu.Lock()
	defer in.mu.Unlock()
	return in.pending[folder]
}

func (in *Ingest) init() {
	if in.stored == nil {
		in.stored = map[string]*string{}
		in.pending = map[string]isolate.PendingList{}
	}
}

// withPending returns cursor with folder's placeholders under "pending". A list that would make the cursor longer than
// the API stores loses its oldest entries.
func (in *Ingest) withPending(folder string, cursor *string) (*string, error) {
	if cursor == nil {
		return nil, nil
	}
	in.mu.Lock()
	list := in.pending[folder]
	in.mu.Unlock()
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal([]byte(*cursor), &fields); err != nil {
		if len(list) == 0 {
			return cursor, nil
		}
		return nil, fmt.Errorf("cursor is not a JSON object, it cannot keep placeholders: %w", err)
	}
	if _, has := fields["pending"]; !has && len(list) == 0 {
		return cursor, nil
	}
	encode := func(list isolate.PendingList) (string, bool) {
		delete(fields, "pending")
		if len(list) > 0 {
			data, _ := json.Marshal(list)
			fields["pending"] = data
		}
		out, _ := json.Marshal(fields)
		return string(out), len(out) <= api.MaxCursorLength
	}
	out, fits := encode(list)
	if !fits {
		kept := list.Trim(func(l isolate.PendingList) bool { _, ok := encode(l); return ok })
		in.Logger.Warn("the cursor cannot keep every placeholder; the oldest stay as they are", "folder", folder, "kept", len(kept), "of", len(list))
		in.mu.Lock()
		in.pending[folder] = kept
		in.mu.Unlock()
		out, fits = encode(kept)
		if !fits {
			return nil, fmt.Errorf("encoded cursor is %d bytes, the API stores at most %d", len(out), api.MaxCursorLength)
		}
	}
	return &out, nil
}

// sent notes the cursor the API now has for folder.
func (in *Ingest) sent(folder string, cursor *string) {
	if cursor == nil {
		return
	}
	in.mu.Lock()
	defer in.mu.Unlock()
	in.init()
	in.stored[folder] = cursor
}

// recordPending keeps uids for a later try, stored before their placeholders are sent.
func (in *Ingest) recordPending(ctx context.Context, folder string, uids []string) error {
	pf := in.pendingFolder(folder)
	in.mu.Lock()
	in.init()
	in.pending[pf] = in.pending[pf].Add(in.clock(), uids...)
	stored := in.stored[pf]
	in.mu.Unlock()
	if stored == nil {
		// The folder has no cursor yet: the list goes with the first one.
		return nil
	}
	return in.StoreCursor(ctx, pf, *stored)
}

// RetryPlaceholders tries the due placeholders kept in folder's cursor again. fetch returns the real message and the
// folders it is to go in (nil message: it is gone at the provider). A message that goes in takes its placeholder's
// place; one that does not (the provider or the API still refuses it) waits twice as long. Errors that are not about
// the message (the API is unreachable, lost access) end the round.
func (in *Ingest) RetryPlaceholders(ctx context.Context, folder string, fetch func(ctx context.Context, uid string) (*api.Message, []string, error)) error {
	in.mu.Lock()
	due := in.pending[folder].Due(in.clock())
	in.mu.Unlock()
	if len(due) == 0 {
		return nil
	}
	update := func(change func(isolate.PendingList) isolate.PendingList) {
		in.mu.Lock()
		in.pending[folder] = change(in.pending[folder])
		in.mu.Unlock()
	}
	for _, uid := range due {
		msg, folders, err := fetch(ctx, uid)
		switch {
		case err != nil && (errors.Is(err, providerhttp.ErrUnauthorized) || errors.Is(err, api.ErrReauthorize) || errors.Is(err, ErrAccessDenied) || ctx.Err() != nil):
			return err
		case err != nil:
			in.Logger.Info("a placeholder's message still cannot be downloaded", "folder", folder, "uid", uid, "error", err)
			update(func(l isolate.PendingList) isolate.PendingList { return l.Later(uid, in.clock()) })
			continue
		case msg == nil:
			update(func(l isolate.PendingList) isolate.PendingList { return l.Drop(uid) })
			continue
		}
		replaced := true
		for _, target := range folders {
			err := isolate.Replace(ctx, in.sender(target), func(ctx context.Context, uid string) error {
				_, err := in.API.Changes(ctx, in.AccountID, api.ChangeBatch{WorkerID: in.WorkerID, Folder: target, Vanished: []string{uid}})
				return err
			}, *msg, in.placeholder)
			if err != nil && isolate.Classify(err) == isolate.NotRefused {
				return err
			}
			if err != nil {
				in.Logger.Info("the API still refuses a placeholder's message", "folder", target, "uid", uid, "error", err)
				replaced = false
				break
			}
		}
		if replaced {
			in.Logger.Info("a placeholder was replaced by its message", "folder", folder, "uid", uid)
			update(func(l isolate.PendingList) isolate.PendingList { return l.Drop(uid) })
			// Stored at once: a later failure of this round must not have the replacement done again, on the real
			// message.
			if err := in.storePending(ctx, folder); err != nil {
				return err
			}
		} else {
			update(func(l isolate.PendingList) isolate.PendingList { return l.Later(uid, in.clock()) })
		}
	}
	return in.storePending(ctx, folder)
}

// storePending stores folder's cursor as the API has it, with the folder's current placeholders.
func (in *Ingest) storePending(ctx context.Context, folder string) error {
	in.mu.Lock()
	stored := in.stored[folder]
	in.mu.Unlock()
	if stored == nil {
		return nil
	}
	return in.StoreCursor(ctx, folder, *stored)
}

// placeholder builds the placeholder of a message; provider ids name a message in the whole account.
func (in *Ingest) placeholder(ctx context.Context, msg api.Message) (api.Message, error) {
	return ingestmsg.PlaceholderFor(ctx, in.Store, in.AccountID, msg.RemoteUID, msg)
}

// Unreadable describes messages the provider would not hand over for Messages: once one failed often and long enough
// next to messages that came through (delivered), a placeholder with the given received time and flags stands in for
// it (see isolate.Unreadable).
func (in *Ingest) Unreadable(ctx context.Context, store storage.Blobs, folder string, failed []UnreadableMessage, delivered int) ([]api.Message, error) {
	list := make([]isolate.Failed, 0, len(failed))
	for _, f := range failed {
		list = append(list, isolate.Failed{
			Folder: folder,
			UID:    f.ID,
			Err:    f.Err,
			Placeholder: func(ctx context.Context) (api.Message, error) {
				return ingestmsg.Unreadable(ctx, store, in.AccountID, f.ID, f.ID, f.ReceivedAt, f.Flags)
			},
		})
	}
	return isolate.Unreadable(ctx, in.strikes(), list, delivered, in.Logger)
}

// UnreadableMessage is a message the provider would not hand over.
type UnreadableMessage struct {
	ID         string
	ReceivedAt time.Time
	Flags      api.Flags
	Err        error
}

// AboutMessage reports whether a provider error concerns the one message asked for rather than the account, the
// connection or the provider's limits: an answer other than 401 (the token), 404 (the message is gone, handled by
// the callers), throttling and quotas (429, and the 403s Gmail and Graph answer them with) and lost access. Those end
// the session as before.
func AboutMessage(err error) bool {
	if errors.Is(err, providerhttp.ErrUnauthorized) || errors.Is(err, api.ErrReauthorize) || errors.Is(err, ErrAccessDenied) || providerhttp.Throttled(err) {
		return false
	}
	var status *providerhttp.StatusError
	if !errors.As(err, &status) {
		return false
	}
	switch status.StatusCode {
	case http.StatusUnauthorized, http.StatusNotFound:
		return false
	}
	return status.StatusCode >= 400
}

// ApplyFlags reports flags for messages in a folder. The messages the API has no location for in that folder are
// downloaded with fetch and ingested; a message the API already has in another folder is linked, not duplicated.
// Cursors are not touched: store them with StoreCursor or Vanish once all of a round's work is in.
func (in *Ingest) ApplyFlags(ctx context.Context, folder string, changes []api.FlagChange, fetch Fetcher) error {
	if err := checkRemoteUIDs(changes, func(c api.FlagChange) string { return c.RemoteUID }); err != nil {
		return err
	}
	for start := 0; start < len(changes); start += api.MaxFlagChanges {
		chunk := changes[start:min(start+api.MaxFlagChanges, len(changes))]
		result, err := in.API.Changes(ctx, in.AccountID, api.ChangeBatch{WorkerID: in.WorkerID, Folder: folder, Flags: chunk})
		if err != nil {
			return err
		}
		if err := in.fetchAndIngest(ctx, folder, result.UnknownUIDs, fetch); err != nil {
			return err
		}
	}
	return nil
}

func (in *Ingest) fetchAndIngest(ctx context.Context, folder string, ids []string, fetch Fetcher) error {
	size := max(1, min(in.FetchBatch, api.MaxMessagesPerBatch))
	for start := 0; start < len(ids); start += size {
		messages, err := fetch(ctx, ids[start:min(start+size, len(ids))])
		if err != nil {
			return err
		}
		if err := in.Messages(ctx, folder, messages, nil); err != nil {
			return err
		}
	}
	return nil
}

func (in *Ingest) sender(folder string) isolate.Send {
	return func(ctx context.Context, messages []api.Message, cursor *string) error {
		result, err := in.API.Messages(ctx, in.AccountID, api.MessageBatch{WorkerID: in.WorkerID, Folder: folder, Messages: messages, Cursor: cursor})
		if err == nil {
			in.sent(folder, cursor)
			in.Logger.Debug("ingested", "folder", folder, "stored", result.Stored, "linked", result.Linked, "updated", result.Updated)
		}
		return err
	}
}

// Messages ingests messages into a folder; cursor (when not nil) is stored with the last batch.
func (in *Ingest) Messages(ctx context.Context, folder string, messages []api.Message, cursor *string) error {
	if err := checkRemoteUIDs(messages, func(m api.Message) string { return m.RemoteUID }); err != nil {
		return err
	}
	for start := 0; start < len(messages) || (start == 0 && cursor != nil); start += api.MaxMessagesPerBatch {
		end := min(start+api.MaxMessagesPerBatch, len(messages))
		last := end == len(messages)
		var cursorErr error
		batchCursor := func() *string {
			if !last {
				return nil
			}
			merged, err := in.withPending(folder, cursor)
			cursorErr = cmp.Or(cursorErr, err)
			return merged
		}
		placed := func(uids []string) error { return in.recordPending(ctx, folder, uids) }
		if err := isolate.Batch(ctx, in.sender(folder), in.strikes(), folder, messages[start:end], batchCursor, placed, in.placeholder, in.Logger); err != nil {
			return err
		}
		if cursorErr != nil {
			return cursorErr
		}
		if last {
			break
		}
	}
	return nil
}

// Vanish removes messages from a folder; cursor (when not nil) is stored with the last request, also when there is
// nothing to remove.
func (in *Ingest) Vanish(ctx context.Context, folder string, ids []string, cursor *string) error {
	if err := checkRemoteUIDs(ids, func(id string) string { return id }); err != nil {
		return err
	}
	for start := 0; start < len(ids) || (start == 0 && cursor != nil); start += api.MaxVanished {
		end := min(start+api.MaxVanished, len(ids))
		batch := api.ChangeBatch{WorkerID: in.WorkerID, Folder: folder, Vanished: ids[start:end]}
		if end == len(ids) {
			merged, err := in.withPending(folder, cursor)
			if err != nil {
				return err
			}
			batch.Cursor = merged
		}
		if _, err := in.API.Changes(ctx, in.AccountID, batch); err != nil {
			return err
		}
		in.sent(folder, batch.Cursor)
		if end == len(ids) {
			break
		}
	}
	return nil
}

// StoreCursor stores a folder's cursor on its own.
func (in *Ingest) StoreCursor(ctx context.Context, folder, cursor string) error {
	merged, err := in.withPending(folder, &cursor)
	if err != nil {
		return err
	}
	if _, err := in.API.Changes(ctx, in.AccountID, api.ChangeBatch{WorkerID: in.WorkerID, Folder: folder, Cursor: merged}); err != nil {
		return err
	}
	in.sent(folder, merged)
	return nil
}

// Stored returns every remote uid the API has in a folder.
func (in *Ingest) Stored(ctx context.Context, folder string) (map[string]bool, error) {
	stored := map[string]bool{}
	after := ""
	for {
		page, err := in.API.RemoteUIDs(ctx, in.AccountID, in.WorkerID, folder, after, api.MaxRemoteUIDPage)
		if err != nil {
			return nil, err
		}
		for _, id := range page.RemoteUIDs {
			stored[id] = true
		}
		if page.Next == nil || *page.Next == "" || len(page.RemoteUIDs) == 0 {
			return stored, nil
		}
		after = *page.Next
	}
}

// pendingPrefix marks a placeholder location the API keeps for a move the worker has not made yet. It is no message
// at the provider, so it is never missing there.
const pendingPrefix = "pending:"

// Missing returns the ids the API has in a folder that are not in present, sorted as the API listed them. Placeholders
// of pending moves are never missing.
func (in *Ingest) Missing(ctx context.Context, folder string, present map[string]bool) ([]string, error) {
	var missing []string
	after := ""
	for {
		page, err := in.API.RemoteUIDs(ctx, in.AccountID, in.WorkerID, folder, after, api.MaxRemoteUIDPage)
		if err != nil {
			return nil, err
		}
		for _, id := range page.RemoteUIDs {
			if !present[id] && !strings.HasPrefix(id, pendingPrefix) {
				missing = append(missing, id)
			}
		}
		if page.Next == nil || *page.Next == "" || len(page.RemoteUIDs) == 0 {
			return missing, nil
		}
		after = *page.Next
	}
}
