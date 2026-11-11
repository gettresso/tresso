package providersync

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
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
type Ingest struct {
	API       API
	AccountID string
	WorkerID  string
	// FetchBatch is how many raw messages are downloaded per ingest request (at most api.MaxMessagesPerBatch).
	FetchBatch int
	// Strikes counts the messages that failed in earlier sessions of the account's run (see package isolate). Nil
	// starts a count of its own.
	Strikes *isolate.Strikes
	Logger  *slog.Logger
}

func (in *Ingest) strikes() *isolate.Strikes {
	if in.Strikes == nil {
		in.Strikes = isolate.NewStrikes()
	}
	return in.Strikes
}

// Unreadable describes a message the provider would not hand over (err) for Messages: once it failed often enough,
// a placeholder with the given received time and flags stands in for it. Doubtful failures (5xx) only count when
// delivered other messages of the same request came through.
func (in *Ingest) Unreadable(ctx context.Context, store storage.Blobs, folder string, failed []UnreadableMessage, delivered int) ([]api.Message, error) {
	list := make([]isolate.Failed, 0, len(failed))
	for _, f := range failed {
		list = append(list, isolate.Failed{
			Folder:   folder,
			UID:      f.ID,
			Err:      f.Err,
			Doubtful: Doubtful(f.Err),
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

// AboutMessage reports whether a provider error concerns the one message asked for rather than the account or the
// connection: an answer other than 401 (the token), 404 (the message is gone, handled by the callers), 429
// (throttling) and lost access. Those end the session as before.
func AboutMessage(err error) bool {
	if errors.Is(err, providerhttp.ErrUnauthorized) || errors.Is(err, api.ErrReauthorize) || errors.Is(err, ErrAccessDenied) {
		return false
	}
	var status *providerhttp.StatusError
	if !errors.As(err, &status) {
		return false
	}
	switch status.StatusCode {
	case http.StatusUnauthorized, http.StatusNotFound, http.StatusTooManyRequests:
		return false
	}
	return status.StatusCode >= 400
}

// Doubtful reports whether a failure may say nothing about the message itself: the provider failed (5xx) also after
// providerhttp's retries.
func Doubtful(err error) bool {
	var status *providerhttp.StatusError
	return errors.As(err, &status) && status.StatusCode >= 500
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

// Messages ingests messages into a folder; cursor (when not nil) is stored with the last batch.
func (in *Ingest) Messages(ctx context.Context, folder string, messages []api.Message, cursor *string) error {
	if err := checkRemoteUIDs(messages, func(m api.Message) string { return m.RemoteUID }); err != nil {
		return err
	}
	for start := 0; start < len(messages) || (start == 0 && cursor != nil); start += api.MaxMessagesPerBatch {
		end := min(start+api.MaxMessagesPerBatch, len(messages))
		batch := api.MessageBatch{WorkerID: in.WorkerID, Folder: folder, Messages: messages[start:end]}
		if end == len(messages) {
			batch.Cursor = cursor
		}
		send := func(ctx context.Context, messages []api.Message, cursor *string) error {
			result, err := in.API.Messages(ctx, in.AccountID, api.MessageBatch{WorkerID: in.WorkerID, Folder: folder, Messages: messages, Cursor: cursor})
			if err == nil {
				in.Logger.Debug("ingested", "folder", folder, "stored", result.Stored, "linked", result.Linked, "updated", result.Updated)
			}
			return err
		}
		if err := isolate.Batch(ctx, send, in.strikes(), folder, batch.Messages, batch.Cursor, in.Logger); err != nil {
			return err
		}
		if end == len(messages) {
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
			batch.Cursor = cursor
		}
		if _, err := in.API.Changes(ctx, in.AccountID, batch); err != nil {
			return err
		}
		if end == len(ids) {
			break
		}
	}
	return nil
}

// StoreCursor stores a folder's cursor on its own.
func (in *Ingest) StoreCursor(ctx context.Context, folder, cursor string) error {
	_, err := in.API.Changes(ctx, in.AccountID, api.ChangeBatch{WorkerID: in.WorkerID, Folder: folder, Cursor: &cursor})
	return err
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
