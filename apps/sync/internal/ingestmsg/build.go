// Package ingestmsg turns a raw message into what the ingest API takes. It is shared by every provider: the raw MIME
// and its attachments go to object storage, the API gets the metadata.
package ingestmsg

import (
	"context"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"tresso/sync/internal/api"
	"tresso/sync/internal/blobcrypt"
	"tresso/sync/internal/mimeparse"
	"tresso/sync/internal/storage"
)

// Build stores raw and its attachments, encrypted with the account owner's key, then describes the message for the
// ingest API. remoteUID is the provider's id of the message in the folder; receivedAt is when the provider received it
// (zero falls back to the Date header, then to now). What the parser could not read as it should (see
// mimeparse.Message.Problems) is logged.
func Build(ctx context.Context, blobs storage.Blobs, accountID string, raw []byte, remoteUID string, receivedAt time.Time, flags api.Flags, logger *slog.Logger) (api.Message, error) {
	return build(ctx, blobs, accountID, raw, remoteUID, receivedAt, flags, logger, false)
}

// BuildFromExchange is Build for a message Exchange Online took in (a Microsoft account through Graph): it also
// passes on X-MS-Exchange-Organization-AuthAs, which Exchange writes and strips from mail arriving from outside.
// Anywhere else a sender could have written it, so Build leaves it out.
func BuildFromExchange(ctx context.Context, blobs storage.Blobs, accountID string, raw []byte, remoteUID string, receivedAt time.Time, flags api.Flags, logger *slog.Logger) (api.Message, error) {
	return build(ctx, blobs, accountID, raw, remoteUID, receivedAt, flags, logger, true)
}

func build(ctx context.Context, blobs storage.Blobs, accountID string, raw []byte, remoteUID string, receivedAt time.Time, flags api.Flags, logger *slog.Logger, exchange bool) (api.Message, error) {
	writer, err := blobs.Writer(ctx, accountID)
	if err != nil {
		return api.Message{}, err
	}
	rawKey, _, err := writer.Put(ctx, blobcrypt.KindRaw, raw)
	if err != nil {
		return api.Message{}, err
	}

	parsed, err := mimeparse.Parse(raw)
	if err != nil {
		// Not parseable as mail at all: keep it with what the server knows.
		parsed = &mimeparse.Message{From: mimeparse.Address{Address: mimeparse.UnknownSender}, Problems: []string{err.Error()}}
	}
	if len(parsed.Problems) > 0 {
		logger.Warn("parts of a message could not be read as they should", "uid", remoteUID, "messageId", parsed.MessageID, "problems", parsed.Problems)
	}

	attachments := make([]api.Attachment, 0, min(len(parsed.Attachments), maxAttachments))
	for _, a := range limit(parsed.Attachments, maxAttachments) {
		_, fingerprint, err := writer.Put(ctx, blobcrypt.KindAttachments, a.Data)
		if err != nil {
			return api.Message{}, err
		}
		attachment := api.Attachment{
			Filename:    orDefault(clean(a.Filename, maxFieldLength), "attachment"),
			ContentType: orDefault(clean(a.ContentType, maxFieldLength), "application/octet-stream"),
			Size:        a.Size,
			Fingerprint: fingerprint,
			Inline:      a.Inline,
		}
		if contentID := clean(a.ContentID, maxFieldLength); contentID != "" {
			attachment.ContentID = &contentID
		}
		attachments = append(attachments, attachment)
	}

	calendarParts := make([]api.CalendarPart, 0, len(parsed.CalendarParts))
	for _, part := range parsed.CalendarParts {
		ical := clean(part.Data, maxCalendarLength)
		if ical == "" {
			continue
		}
		calendarPart := api.CalendarPart{Ical: ical}
		if method := clean(part.Method, maxMethodLength); method != "" {
			calendarPart.Method = &method
		}
		calendarParts = append(calendarParts, calendarPart)
		if len(calendarParts) == maxCalendarParts {
			break
		}
	}

	if receivedAt.IsZero() {
		if parsed.Date != nil {
			receivedAt = *parsed.Date
		} else {
			receivedAt = time.Now()
		}
	}

	from := address(parsed.From)
	if from.Address == "" {
		from = api.Address{Address: mimeparse.UnknownSender}
	}
	msg := api.Message{
		RemoteUID:     remoteUID,
		RawObjectKey:  rawKey,
		KeyVersion:    writer.KeyVersion(),
		Size:          int64(len(raw)),
		ReceivedAt:    receivedAt.UTC(),
		SentAt:        parsed.Date,
		Flags:         flags,
		References:    references(parsed.References),
		Subject:       clean(parsed.Subject, maxHeaderLength),
		From:          from,
		To:            addresses(parsed.To, 1000),
		Cc:            addresses(parsed.Cc, 1000),
		Bcc:           addresses(parsed.Bcc, 1000),
		ReplyTo:       addresses(parsed.ReplyTo, 100),
		Snippet:       clean(parsed.Snippet, maxSnippetLength),
		BodyText:      clean(parsed.BodyText, maxBodyTextLength),
		Attachments:   attachments,
		Headers:       signals(parsed.Signals, exchange),
		CalendarParts: calendarParts,
	}
	if id := clean(parsed.MessageID, maxHeaderLength); id != "" {
		msg.MessageID = &id
	}
	if id := clean(parsed.InReplyTo, maxHeaderLength); id != "" {
		msg.InReplyTo = &id
	}
	return msg, nil
}

// The API's limits (apps/api/src/ApiResource/Input/Sync/MessageInput.php and its parts). A message that breaks one is
// refused with the whole batch, so every value is kept inside them here.
const (
	maxHeaderLength   = 998
	maxReferences     = 200
	maxAddressLength  = 320
	maxNameLength     = 255
	maxFieldLength    = 255 // attachment filename, content type and Content-ID
	maxSnippetLength  = 2000
	maxBodyTextLength = 32768
	maxSignalLength   = 1000
	maxAuthResults    = 8000 // authentication-results, cut by mimeparse at a ";"
	maxSignals        = 20
	maxAttachments    = 500
	maxCalendarParts  = 5
	maxCalendarLength = 262144
	maxMethodLength   = 32
)

// clean makes text acceptable to the API: valid UTF-8, without NUL (PostgreSQL refuses it in text) and the other
// control characters except tab, line feed and carriage return, cut to max characters.
func clean(s string, max int) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "\uFFFD")
	}
	if strings.IndexFunc(s, isControl) >= 0 {
		s = strings.Map(func(r rune) rune {
			if isControl(r) {
				return -1
			}
			return r
		}, s)
	}
	return truncate(s, max)
}

func isControl(r rune) bool {
	return (r < 0x20 && r != '\t' && r != '\n' && r != '\r') || r == 0x7f
}

func orDefault(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}

func references(ids []string) []string {
	out := make([]string, 0, min(len(ids), maxReferences))
	for _, id := range ids {
		if id = clean(id, maxHeaderLength); id != "" {
			out = append(out, id)
		}
		if len(out) == maxReferences {
			break
		}
	}
	return out
}

func signals(headers map[string]string, exchange bool) map[string]string {
	if len(headers) == 0 {
		return nil
	}
	out := make(map[string]string, len(headers))
	for name, value := range headers {
		if name == strings.ToLower(mimeparse.ExchangeAuthAs) && !exchange {
			continue
		}
		limit := maxSignalLength
		if name == "authentication-results" {
			limit = maxAuthResults
		}
		if value = clean(value, limit); value != "" && len(out) < maxSignals {
			out[name] = value
		}
	}
	return out
}

func address(a mimeparse.Address) api.Address {
	out := api.Address{Address: strings.TrimSpace(clean(a.Address, maxAddressLength))}
	if name := clean(a.Name, maxNameLength); name != "" {
		out.Name = &name
	}
	return out
}

// addresses applies the API's per-header limit and leaves out addresses that are empty once cleaned.
func addresses(list []mimeparse.Address, max int) []api.Address {
	out := make([]api.Address, 0, min(len(list), max))
	for _, a := range list {
		if len(out) == max {
			break
		}
		if cleaned := address(a); cleaned.Address != "" {
			out = append(out, cleaned)
		}
	}
	return out
}

// Truncate shortens s to at most max characters (runes), for the API's length limits.
func Truncate(s string, max int) string {
	return truncate(s, max)
}

func truncate(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max])
}

func limit[T any](s []T, max int) []T {
	if len(s) > max {
		return s[:max]
	}
	return s
}
