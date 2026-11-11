package ingestmsg

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/blobcrypt"
	"tresso/sync/internal/mimeparse"
	"tresso/sync/internal/storage"
)

const (
	// PlaceholderSubject starts the subject of a message Tresso keeps in place of one it could not import, so the
	// user sees that a message is missing instead of nothing. A short reference follows, so the API does not thread
	// the placeholders of different messages into one conversation.
	PlaceholderSubject = "Message could not be imported"
	placeholderText    = "Tresso could not import this message yet and tries again later. It is still in your mailbox at your mail provider."
)

// IsPlaceholder reports whether msg is a placeholder.
func IsPlaceholder(msg api.Message) bool {
	return msg.Placeholder
}

// Placeholder stands in for a message the API refused: it keeps the raw message already stored, the uid, the dates
// and the flags, and leaves out everything parsed from it, which is where the refused value was. The folder's cursor
// can then move on, and the user sees which message is missing. The syncers try the message again later and put it
// in the placeholder's place once it goes in (see isolate.Replace).
func Placeholder(msg api.Message) api.Message {
	ref := sha256.Sum256([]byte(msg.RemoteUID + "\x00" + msg.RawObjectKey))
	return api.Message{
		Placeholder:   true,
		RemoteUID:     msg.RemoteUID,
		ModSeq:        msg.ModSeq,
		RawObjectKey:  msg.RawObjectKey,
		KeyVersion:    msg.KeyVersion,
		Size:          msg.Size,
		ReceivedAt:    msg.ReceivedAt,
		SentAt:        msg.SentAt,
		Flags:         msg.Flags,
		References:    []string{},
		Subject:       PlaceholderSubject + " (ref " + hex.EncodeToString(ref[:4]) + ")",
		From:          api.Address{Address: mimeparse.UnknownSender},
		To:            []api.Address{},
		Cc:            []api.Address{},
		Bcc:           []api.Address{},
		ReplyTo:       []api.Address{},
		Snippet:       placeholderText,
		BodyText:      placeholderText,
		Attachments:   []api.Attachment{},
		Junk:          msg.Junk,
		CalendarParts: []api.CalendarPart{},
	}
}

// Unreadable stands in for a message the provider would not hand over. There is no raw message to keep, so it stores
// a short notice as the raw message. identity names the message uniquely within the account (folder and uid for
// IMAP, the provider id for Gmail and Microsoft): it goes into the notice's Message-ID, so two unreadable messages are
// never taken for one.
func Unreadable(ctx context.Context, blobs storage.Blobs, accountID, identity, remoteUID string, receivedAt time.Time, flags api.Flags) (api.Message, error) {
	if receivedAt.IsZero() {
		receivedAt = time.Now()
	}
	receivedAt = receivedAt.UTC()
	digest := sha256.Sum256([]byte(accountID + "\x00" + identity))
	messageID := "unreadable." + hex.EncodeToString(digest[:16]) + "@tresso.invalid"
	raw := fmt.Appendf(nil, "From: <%s>\r\nSubject: %s\r\nDate: %s\r\nMessage-ID: <%s>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n",
		mimeparse.UnknownSender, PlaceholderSubject, receivedAt.Format(time.RFC1123Z), messageID, placeholderText)

	writer, err := blobs.Writer(ctx, accountID)
	if err != nil {
		return api.Message{}, err
	}
	rawKey, _, err := writer.Put(ctx, blobcrypt.KindRaw, raw)
	if err != nil {
		return api.Message{}, err
	}
	msg := Placeholder(api.Message{
		RemoteUID:    remoteUID,
		RawObjectKey: rawKey,
		KeyVersion:   writer.KeyVersion(),
		Size:         int64(len(raw)),
		ReceivedAt:   receivedAt,
		Flags:        flags,
	})
	msg.MessageID = &messageID
	return msg, nil
}
