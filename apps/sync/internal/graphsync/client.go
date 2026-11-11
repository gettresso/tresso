package graphsync

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/providerhttp"
	"tresso/sync/internal/providersync"
)

// preferImmutableID makes message ids survive moves between folders, so a moved message keeps its remote uid.
const preferImmutableID = `IdType="ImmutableId"`

// messageFields are the properties synced from Graph; the rest comes from the raw MIME.
const messageFields = "id,isRead,isDraft,flag,receivedDateTime,createdDateTime,lastModifiedDateTime"

type ClientOptions struct {
	BaseURL string // https://graph.microsoft.com/v1.0; tests point it at a fake
	HTTP    providerhttp.Options
	// HTTPClient carries the requests; nil uses a default client.
	HTTPClient *http.Client
	// Logger and Account say what the client works for, in the few things it logs itself; nil logs to slog.Default.
	Logger  *slog.Logger
	Account string
}

func DefaultClientOptions() ClientOptions {
	httpOpts := providerhttp.DefaultOptions()
	// Outlook allows 10,000 requests per 10 minutes per mailbox; stay below that.
	httpOpts.UnitsPerSecond = 15
	httpOpts.Burst = 20
	return ClientOptions{BaseURL: "https://graph.microsoft.com/v1.0", HTTP: httpOpts}
}

// Client calls Microsoft Graph for one mailbox. Every request asks for immutable ids.
type Client struct {
	http    *providerhttp.Client
	base    string
	logger  *slog.Logger
	account string
}

func NewClient(tokens providerhttp.Tokens, opts ClientOptions) *Client {
	httpOpts := opts.HTTP
	header := http.Header{}
	for name, values := range httpOpts.Header {
		header[name] = values
	}
	header.Set("Prefer", preferImmutableID)
	httpOpts.Header = header
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Client{http: providerhttp.New(opts.HTTPClient, tokens, httpOpts), base: strings.TrimRight(opts.BaseURL, "/"), logger: logger, account: opts.Account}
}

type mailFolder struct {
	ID               string `json:"id"`
	DisplayName      string `json:"displayName"`
	ChildFolderCount int    `json:"childFolderCount"`
}

type graphMessage struct {
	ID      string `json:"id"`
	IsRead  bool   `json:"isRead"`
	IsDraft bool   `json:"isDraft"`
	Flag    struct {
		FlagStatus string `json:"flagStatus"`
	} `json:"flag"`
	ReceivedDateTime     time.Time `json:"receivedDateTime"`
	CreatedDateTime      time.Time `json:"createdDateTime"`
	LastModifiedDateTime time.Time `json:"lastModifiedDateTime"`
	ParentFolderID       string    `json:"parentFolderId"` // only asked for when looking a message up
	Removed              *struct {
		Reason string `json:"reason"`
	} `json:"@removed"`
}

// flags maps Graph's properties. Answered needs an extended property (PR_LAST_VERB_EXECUTED) that delta queries do not
// return, so it stays false.
func (m graphMessage) flags() api.Flags {
	return api.Flags{Seen: m.IsRead, Flagged: m.Flag.FlagStatus == "flagged", Draft: m.IsDraft}
}

// receivedAt is when the message arrived; for the rare message without a receive time, when it was created or last
// changed. Zero when Graph has none of them.
func (m graphMessage) receivedAt() time.Time {
	for _, t := range []time.Time{m.ReceivedDateTime, m.CreatedDateTime, m.LastModifiedDateTime} {
		if !t.IsZero() {
			return t
		}
	}
	return time.Time{}
}

type messagePage struct {
	Value     []graphMessage `json:"value"`
	NextLink  string         `json:"@odata.nextLink"`
	DeltaLink string         `json:"@odata.deltaLink"`
}

// folders lists a folder level: the top level for parentID "", else the children of parentID. Only a refused top
// level means the token cannot read the mailbox (providersync.ErrAccessDenied); a refused child level is a folder the
// user lost access to (see folderDenied).
func (c *Client) folders(ctx context.Context, parentID string) ([]mailFolder, error) {
	link := "/me/mailFolders?$top=100"
	if parentID != "" {
		link = "/me/mailFolders/" + url.PathEscape(parentID) + "/childFolders?$top=100"
	}
	var all []mailFolder
	for link != "" {
		var page struct {
			Value    []mailFolder `json:"value"`
			NextLink string       `json:"@odata.nextLink"`
		}
		if err := c.get(ctx, link, "", &page); err != nil {
			if parentID == "" {
				return nil, mapAccessError(err)
			}
			return nil, err
		}
		all = append(all, page.Value...)
		link = page.NextLink
	}
	return all, nil
}

// wellKnownID returns the id of a well-known folder ("inbox", "archive", ...), or "" when the mailbox has none.
func (c *Client) wellKnownID(ctx context.Context, name string) (string, error) {
	var out struct {
		ID string `json:"id"`
	}
	err := c.get(ctx, "/me/mailFolders/"+name+"?$select=id", "", &out)
	if providerhttp.IsStatus(err, http.StatusNotFound) {
		return "", nil
	}
	return out.ID, mapAccessError(err)
}

// messagesPage fetches one page of a listing or delta query; link is a path below the base URL or a full link
// Graph returned.
func (c *Client) messagesPage(ctx context.Context, link string, delta bool) (messagePage, error) {
	prefer := ""
	if delta {
		prefer = preferImmutableID + ", odata.maxpagesize=200"
	}
	var out messagePage
	err := c.get(ctx, link, prefer, &out)
	return out, err
}

// message looks one message up, with the folder it is in now. A message deleted for good is a 404 StatusError.
func (c *Client) message(ctx context.Context, id string) (graphMessage, error) {
	var out graphMessage
	err := c.get(ctx, "/me/messages/"+url.PathEscape(id)+"?$select=parentFolderId,"+messageFields, "", &out)
	return out, err
}

// raw downloads a message's MIME. A message deleted meanwhile is a 404 StatusError; a 403 is about this message
// (see package isolate), not the mailbox.
func (c *Client) raw(ctx context.Context, id string) ([]byte, error) {
	return c.http.Do(ctx, providerhttp.Request{Method: http.MethodGet, URL: c.base + "/me/messages/" + url.PathEscape(id) + "/$value"})
}

func (c *Client) get(ctx context.Context, link, prefer string, out any) error {
	target, err := c.resolve(link)
	if err != nil {
		return err
	}
	req := providerhttp.Request{Method: http.MethodGet, URL: target}
	if prefer != "" {
		req.Header = http.Header{"Prefer": {prefer}}
	}
	return c.http.JSON(ctx, req, out)
}

// resolve turns a stored link into a URL. Links are kept relative to the base URL to keep cursors short; a full link
// must point at the base URL, so a cursor can never send the token elsewhere.
func (c *Client) resolve(link string) (string, error) {
	if strings.HasPrefix(link, "/") {
		return c.base + link, nil
	}
	if strings.HasPrefix(link, c.base+"/") {
		return link, nil
	}
	return "", fmt.Errorf("link outside %s", c.base)
}

// relative is the inverse of resolve, for storing links Graph returned.
func (c *Client) relative(link string) string {
	if rest, ok := strings.CutPrefix(link, c.base); ok && strings.HasPrefix(rest, "/") {
		return rest
	}
	return link
}

// queryEscape escapes an OData expression for a query string. Spaces become %20: Graph does not read "+" as a space
// in $filter.
func queryEscape(s string) string {
	return strings.ReplaceAll(url.QueryEscape(s), "+", "%20")
}

// mapAccessError marks refused mailbox access as providersync.ErrAccessDenied. Graph answers ErrorAccessDenied alike
// for a token without Mail.ReadWrite and for one folder or message the user lost access to, so it is only used for
// the requests about the mailbox itself: the top of the folder tree and the well-known folders. (The API refuses to
// hand out a token without the mail scopes in the first place.)
func mapAccessError(err error) error {
	if accessDenied(err) {
		return fmt.Errorf("%w: %w", providersync.ErrAccessDenied, err)
	}
	return err
}

// accessDenied reports whether Graph refused access to what was asked (403 ErrorAccessDenied).
func accessDenied(err error) bool {
	var statusErr *providerhttp.StatusError
	return errors.As(err, &statusErr) && statusErr.StatusCode == http.StatusForbidden && statusErr.HasReason("ErrorAccessDenied")
}

// deltaExpired reports whether Graph no longer knows a delta token: the folder has to be walked from scratch.
func deltaExpired(err error) bool {
	var statusErr *providerhttp.StatusError
	if !errors.As(err, &statusErr) {
		return false
	}
	return statusErr.StatusCode == http.StatusGone || statusErr.HasReason("syncStateNotFound") || statusErr.HasReason("resyncRequired") ||
		statusErr.HasReason("SyncStateNotFound") || statusErr.HasReason("SyncStateInvalid")
}
