package graphsync

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"tresso/sync/internal/providerhttp"
	"tresso/sync/internal/providersend"
	"tresso/sync/internal/providersync"
)

// Named extended properties Tresso puts on the messages it creates, in a property set of its own. Exchange keeps
// custom extended properties on an item, also when a draft is sent and lands in Sent Items, and Graph filters on
// them, so a copy is found with one request, whatever Exchange did to its Message-ID or headers.
//
// Extended properties overview: https://learn.microsoft.com/en-us/graph/api/resources/extended-properties-overview
// Create (PATCH): https://learn.microsoft.com/en-us/graph/api/singlevaluelegacyextendedproperty-post-singlevalueextendedproperties
// Filter (Any): https://learn.microsoft.com/en-us/graph/api/singlevaluelegacyextendedproperty-get
const (
	tressoPropertySet = "{8c5c2f8e-4f0e-4a43-9a51-6b3e2d7c1f90}"
	outgoingProperty  = "String " + tressoPropertySet + " Name TressoOutgoing"
	draftCopyProperty = "String " + tressoPropertySet + " Name TressoDraftCopy"
	tooLarge          = "The message is too large for Outlook, which takes at most 3 MB including attachments."
)

// createDraft creates a draft from raw MIME (POST /me/messages with the base64 MIME; Graph files it in Drafts) and
// marks it with a property. Graph takes at most 4 MB per request, base64 included; a larger message fails
// permanently.
//
// Microsoft documents that MIME properties cannot be edited one by one, not whether extended properties of a draft
// made from MIME can. Should Exchange refuse the marker (a 4xx), the draft is used unmarked: lookups fall back to the
// Message-ID and the X- header, and that is logged once per account. Should marking fail otherwise (5xx, connection),
// the draft is deleted again; a draft that cannot be deleted either is left to the duplicate check of the next
// attempt, which deletes it once it is old enough.
//
// MIME messages: https://learn.microsoft.com/en-us/graph/outlook-send-mime-message
func (c *Client) createDraft(ctx context.Context, raw []byte, property, value string) (string, error) {
	body := []byte(base64.StdEncoding.EncodeToString(raw))
	if len(body) > maxSendBody {
		return "", &providersend.Error{Permanent: true, Message: tooLarge, Err: errors.New("message exceeds the request size limit")}
	}
	var created struct {
		ID string `json:"id"`
	}
	err := c.http.JSON(ctx, providerhttp.Request{Method: http.MethodPost, URL: c.base + "/me/messages", ContentType: "text/plain", Body: body}, &created)
	if err != nil {
		return "", mapAccessError(err)
	}
	if created.ID == "" {
		return "", errors.New("graph created a draft without an id")
	}
	err = c.setProperty(ctx, created.ID, property, value)
	var statusErr *providerhttp.StatusError
	switch {
	case err == nil:
	case errors.As(err, &statusErr) && statusErr.StatusCode >= 400 && statusErr.StatusCode < 500 && statusErr.StatusCode != http.StatusTooManyRequests && !accessRefused(err):
		if _, logged := unmarkedAccounts.LoadOrStore(c.account, true); !logged {
			c.logger.Warn("Exchange refused the Tresso marker on a draft; copies are found by Message-ID and header only", "account", c.account, "error", err)
		}
	default:
		_ = c.deleteMessage(ctx, created.ID)
		return "", err
	}
	return created.ID, nil
}

// unmarkedAccounts are the accounts whose Exchange refused a marker, logged once each.
var unmarkedAccounts sync.Map

// accessRefused reports refused access, which is no answer about the marker.
func accessRefused(err error) bool {
	return errors.Is(err, providerhttp.ErrUnauthorized) || errors.Is(err, providersync.ErrAccessDenied)
}

func (c *Client) setProperty(ctx context.Context, id, property, value string) error {
	patch, err := json.Marshal(map[string]any{"singleValueExtendedProperties": []map[string]string{{"id": property, "value": value}}})
	if err != nil {
		return err
	}
	_, err = c.http.Do(ctx, providerhttp.Request{
		Method: http.MethodPatch, URL: c.base + "/me/messages/" + url.PathEscape(id), ContentType: "application/json", Body: patch,
	})
	return mapAccessError(err)
}

// deleteMessage removes a message for good (not into Deleted Items). A message that is gone counts as deleted.
func (c *Client) deleteMessage(ctx context.Context, id string) error {
	_, err := c.http.Do(ctx, providerhttp.Request{Method: http.MethodPost, URL: c.base + "/me/messages/" + url.PathEscape(id) + "/permanentDelete"})
	if providerhttp.IsStatus(err, http.StatusNotFound) {
		return nil
	}
	return mapAccessError(err)
}

type markedMessage struct {
	ID             string    `json:"id"`
	IsDraft        bool      `json:"isDraft"`
	ParentFolderID string    `json:"parentFolderId"`
	LastModified   time.Time `json:"lastModifiedDateTime"`
}

// markedFields are what lookups of earlier attempts read of a message.
const markedFields = "id,isDraft,parentFolderId,lastModifiedDateTime"

// findByProperty returns the messages in scope ("/me/messages" for the whole mailbox, or a folder's messages) whose
// property has value.
func (c *Client) findByProperty(ctx context.Context, scope, property, value string) ([]markedMessage, error) {
	filter := "singleValueExtendedProperties/Any(ep: ep/id eq '" + property + "' and ep/value eq '" + strings.ReplaceAll(value, "'", "''") + "')"
	return c.listMarked(ctx, scope, filter)
}

// listMarked returns every message in scope that filter selects.
func (c *Client) listMarked(ctx context.Context, scope, filter string) ([]markedMessage, error) {
	link := scope + "?$select=" + markedFields + "&$top=100&$filter=" + queryEscape(filter)
	var found []markedMessage
	for link != "" {
		var page struct {
			Value    []markedMessage `json:"value"`
			NextLink string          `json:"@odata.nextLink"`
		}
		if err := c.get(ctx, link, "", &page); err != nil {
			return nil, mapAccessError(err)
		}
		found = append(found, page.Value...)
		link = page.NextLink
	}
	return found, nil
}
