package api

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Folder is one mailbox as the worker found it on the server.
type Folder struct {
	RemoteName  string  `json:"remoteName"`
	DisplayName string  `json:"displayName"`
	Role        string  `json:"role"` // inbox, sent, drafts, trash, spam, archive, all, custom
	UIDValidity *uint32 `json:"uidValidity"`
}

// FolderState is what the API stored for a folder; Reset means start the folder from scratch.
type FolderState struct {
	RemoteName  string  `json:"remoteName"`
	UIDValidity *uint32 `json:"uidValidity"`
	Cursor      *string `json:"cursor"`
	Reset       bool    `json:"reset"`
}

type Flags struct {
	Seen     bool `json:"seen"`
	Flagged  bool `json:"flagged"`
	Answered bool `json:"answered"`
	Draft    bool `json:"draft"`
}

type Address struct {
	Address string  `json:"address"`
	Name    *string `json:"name,omitempty"`
}

type Attachment struct {
	Filename    string  `json:"filename"`
	ContentType string  `json:"contentType"`
	Size        int64   `json:"size"`
	Fingerprint string  `json:"fingerprint"`
	ContentID   *string `json:"contentId,omitempty"`
	Inline      bool    `json:"inline"`
}

type Message struct {
	RemoteUID    string       `json:"remoteUid"`
	ModSeq       *uint64      `json:"modSeq,omitempty"`
	RawObjectKey string       `json:"rawObjectKey"`
	KeyVersion   uint32       `json:"keyVersion"`
	Size         int64        `json:"size"`
	ReceivedAt   time.Time    `json:"receivedAt"`
	SentAt       *time.Time   `json:"sentAt,omitempty"`
	Flags        Flags        `json:"flags"`
	MessageID    *string      `json:"messageId,omitempty"`
	InReplyTo    *string      `json:"inReplyTo,omitempty"`
	References   []string     `json:"references"`
	Subject      string       `json:"subject"`
	From         Address      `json:"from"`
	To           []Address    `json:"to"`
	Cc           []Address    `json:"cc"`
	Bcc          []Address    `json:"bcc"`
	ReplyTo      []Address    `json:"replyTo"`
	Snippet      string       `json:"snippet"`
	BodyText     string       `json:"bodyText"` // plain text for search, at most 32768 characters
	Attachments  []Attachment `json:"attachments"`
	// Headers that tell automated, bulk and junk mail apart, by lower-cased name; see mimeparse.Message.Signals.
	Headers map[string]string `json:"headers,omitempty"`
	// Junk is set when the server flagged the message as junk ($Junk without $NotJunk).
	Junk bool `json:"junk"`
	// Placeholder marks a message Tresso keeps in place of one it could not import (see ingestmsg.Placeholder). It is
	// the worker's own note and is not sent.
	Placeholder   bool           `json:"-"`
	CalendarParts []CalendarPart `json:"calendarParts"`
}

// CalendarPart is a text/calendar part of a message; the API applies it to the user's calendars.
type CalendarPart struct {
	Method *string `json:"method"`
	Ical   string  `json:"ical"`
}

type MessageBatch struct {
	WorkerID string    `json:"workerId"`
	Folder   string    `json:"folder"`
	Cursor   *string   `json:"cursor"`
	Messages []Message `json:"messages"`
}

type MessageBatchResult struct {
	Stored  int `json:"stored"`
	Linked  int `json:"linked"`
	Updated int `json:"updated"`
}

type FlagChange struct {
	RemoteUID string  `json:"remoteUid"`
	ModSeq    *uint64 `json:"modSeq,omitempty"`
	Flags     Flags   `json:"flags"`
}

// PresenceRange says: between FromUID and ToUID only UIDs exist; everything else there was removed.
type PresenceRange struct {
	FromUID uint32   `json:"fromUid"`
	ToUID   uint32   `json:"toUid"`
	UIDs    []uint32 `json:"uids"`
}

type ChangeBatch struct {
	WorkerID string          `json:"workerId"`
	Folder   string          `json:"folder"`
	Cursor   *string         `json:"cursor"`
	Flags    []FlagChange    `json:"flags"`
	Presence []PresenceRange `json:"presence"`
	Vanished []string        `json:"vanished"`
}

type ChangeBatchResult struct {
	Updated int `json:"updated"`
	Removed int `json:"removed"`
	Unknown int `json:"unknown"`
	Deleted int `json:"deleted"`
	// UnknownUIDs are the remote uids of flag changes that have no location in the folder: the worker has to ingest
	// those messages.
	UnknownUIDs []string `json:"unknownUids"`
}

// RemoteUIDPage is one page of the remote uids the API stores for a folder, sorted ascending by byte order.
type RemoteUIDPage struct {
	RemoteUIDs []string `json:"remoteUids"`
	Next       *string  `json:"next"` // pass as after for the next page; nil on the last page
}

// Limits of the ingest API per request.
const (
	MaxMessagesPerBatch = 200
	MaxFlagChanges      = 5000
	MaxVanished         = 5000
	MaxCursorLength     = 8192
	MaxRemoteUIDPage    = 5000
)

const (
	StatusActive     = "active"
	StatusAuthFailed = "auth_failed"
	StatusError      = "error"
)

// Folders reports the complete folder list and returns each folder's stored state.
func (c *Client) Folders(ctx context.Context, accountID, workerID string, folders []Folder) ([]FolderState, error) {
	var out struct {
		Folders []FolderState `json:"folders"`
	}
	err := c.post(ctx, accountPath(accountID, "folders"), map[string]any{"workerId": workerID, "folders": folders}, &out)
	return out.Folders, err
}

func (c *Client) Messages(ctx context.Context, accountID string, batch MessageBatch) (MessageBatchResult, error) {
	batch.Messages = nonNil(batch.Messages)
	for i := range batch.Messages {
		m := &batch.Messages[i]
		m.References, m.To, m.Cc, m.Bcc, m.ReplyTo, m.Attachments, m.CalendarParts = nonNil(m.References), nonNil(m.To), nonNil(m.Cc), nonNil(m.Bcc), nonNil(m.ReplyTo), nonNil(m.Attachments), nonNil(m.CalendarParts)
	}
	var out MessageBatchResult
	err := c.post(ctx, accountPath(accountID, "messages"), batch, &out)
	return out, err
}

func (c *Client) Changes(ctx context.Context, accountID string, batch ChangeBatch) (ChangeBatchResult, error) {
	batch.Flags, batch.Presence, batch.Vanished = nonNil(batch.Flags), nonNil(batch.Presence), nonNil(batch.Vanished)
	for i := range batch.Presence {
		batch.Presence[i].UIDs = nonNil(batch.Presence[i].UIDs)
	}
	var out ChangeBatchResult
	err := c.post(ctx, accountPath(accountID, "changes"), batch, &out)
	return out, err
}

// RemoteUIDs lists what the API stores for a folder, a page at a time: after is "" for the first page, then the
// previous page's Next. limit is 1 to MaxRemoteUIDPage.
func (c *Client) RemoteUIDs(ctx context.Context, accountID, workerID, folder, after string, limit int) (RemoteUIDPage, error) {
	query := url.Values{"workerId": {workerID}, "folder": {folder}, "limit": {strconv.Itoa(limit)}}
	if after != "" {
		query.Set("after", after)
	}
	var out RemoteUIDPage
	err := c.do(ctx, http.MethodGet, accountPath(accountID, "folders/remote-uids")+"?"+query.Encode(), nil, &out)
	return out, err
}

// Status reports that the account works, that its login was refused, or that syncing failed.
func (c *Client) Status(ctx context.Context, accountID, workerID, status, detail string) error {
	body := map[string]any{"workerId": workerID, "status": status}
	if detail != "" {
		body["detail"] = detail
	}
	return c.post(ctx, accountPath(accountID, "status"), body, nil)
}

func accountPath(accountID, action string) string {
	return "/internal/sync/accounts/" + url.PathEscape(accountID) + "/" + action
}

// nonNil turns nil slices into empty ones: the API expects JSON arrays, never null.
func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
