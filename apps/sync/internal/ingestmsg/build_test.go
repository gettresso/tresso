package ingestmsg

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/blobcrypt"
	"tresso/sync/internal/storage/storagetest"
)

var discard = slog.New(slog.NewTextHandler(io.Discard, nil))

func TestBuildStoresRawAndDescribesTheMessage(t *testing.T) {
	store := storagetest.New()
	raw := []byte("From: Sam <sam@example.test>\r\nTo: kim@example.test\r\nSubject: Hello\r\nMessage-ID: <a@example.test>\r\nDate: Mon, 19 Oct 2026 10:00:00 +0000\r\n\r\nBody\r\n")
	received := time.Date(2026, 10, 19, 12, 0, 0, 0, time.FixedZone("x", 3600))

	msg, err := Build(context.Background(), store, "acc-1", raw, "gmail-id", received, api.Flags{Seen: true}, discard)
	if err != nil {
		t.Fatal(err)
	}
	if msg.RemoteUID != "gmail-id" || !msg.Flags.Seen || msg.Subject != "Hello" || msg.From.Address != "sam@example.test" || msg.Size != int64(len(raw)) || msg.BodyText != "Body" {
		t.Errorf("message = %+v", msg)
	}
	if !msg.ReceivedAt.Equal(received) || msg.ReceivedAt.Location() != time.UTC {
		t.Errorf("receivedAt = %v", msg.ReceivedAt)
	}
	if string(store.Plaintext(msg.RawObjectKey)) != string(raw) || msg.KeyVersion != 1 {
		t.Errorf("raw message not stored under %q with key version 1 (got %d)", msg.RawObjectKey, msg.KeyVersion)
	}
	if parsed, ok := blobcrypt.ParseKey(msg.RawObjectKey); !ok || parsed.Kind != blobcrypt.KindRaw || parsed.OwnerID != storagetest.OwnerID {
		t.Errorf("raw key %q is not the owner's", msg.RawObjectKey)
	}

	// Without a provider date the Date header is used.
	msg, _ = Build(context.Background(), store, "acc-1", raw, "x", time.Time{}, api.Flags{}, discard)
	if !msg.ReceivedAt.Equal(time.Date(2026, 10, 19, 10, 0, 0, 0, time.UTC)) {
		t.Errorf("fallback receivedAt = %v", msg.ReceivedAt)
	}
}

func TestBuildSendsTheSignalHeaders(t *testing.T) {
	raw := []byte("From: news@shop.example\r\nPrecedence: bulk\r\nList-Unsubscribe: <https://shop.example/u>\r\nSubject: Deals\r\n\r\nBody\r\n")

	msg, err := Build(context.Background(), storagetest.New(), "acc-1", raw, "x", time.Time{}, api.Flags{}, discard)
	if err != nil {
		t.Fatal(err)
	}
	if msg.Headers["precedence"] != "bulk" || msg.Headers["list-unsubscribe"] != "<https://shop.example/u>" || len(msg.Headers) != 2 {
		t.Errorf("headers = %v", msg.Headers)
	}
}

func TestBuildReportsTheCalendarParts(t *testing.T) {
	raw := []byte("From: anna@finance.example\r\nTo: kim@company.example\r\nSubject: Invitation\r\nMIME-Version: 1.0\r\n" +
		"Content-Type: text/calendar; charset=utf-8; method=REQUEST\r\n\r\n" +
		"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:a@finance.example\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")

	msg, err := Build(context.Background(), storagetest.New(), "acc-1", raw, "gmail-id", time.Now(), api.Flags{}, discard)
	if err != nil {
		t.Fatal(err)
	}

	if len(msg.CalendarParts) != 1 || msg.CalendarParts[0].Method == nil || *msg.CalendarParts[0].Method != "REQUEST" {
		t.Fatalf("calendar parts = %+v", msg.CalendarParts)
	}
}

func TestBuildEncryptsTheAttachmentsWithTheMessage(t *testing.T) {
	store := storagetest.New()
	raw := []byte("From: anna@finance.example\r\nSubject: Invoice\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n" +
		"--b\r\nContent-Type: text/plain\r\n\r\nAttached.\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=invoice.pdf\r\n\r\n%PDF-1.4 secret\r\n--b--\r\n")

	msg, err := Build(context.Background(), store, "acc-1", raw, "1", time.Now(), api.Flags{}, discard)
	if err != nil {
		t.Fatal(err)
	}
	if len(msg.Attachments) != 1 {
		t.Fatalf("attachments = %+v", msg.Attachments)
	}
	key := blobcrypt.Key(blobcrypt.KindAttachments, storagetest.OwnerID, msg.Attachments[0].Fingerprint)
	if got := store.Plaintext(key); string(got) != "%PDF-1.4 secret" {
		t.Errorf("attachment at %q = %q", key, got)
	}
	for k, object := range store.Objects.Objects {
		if strings.Contains(string(object), "secret") {
			t.Errorf("%s holds plaintext", k)
		}
	}
}

func TestBuildKeepsEveryValueInsideTheAPILimits(t *testing.T) {
	var parts strings.Builder
	for i := range 600 {
		fmt.Fprintf(&parts, "--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=f%d.bin\r\n\r\nx\r\n", i)
	}
	longReference := strings.Repeat("r", 2000) + "@example.test"
	raw := []byte("From: =?utf-8?q?Sam=00?= <sam@example.test>\r\nTo: kim@example.test\r\nSubject: Hello\x00 there\x01\r\n" +
		"References: <" + longReference + "> <ok@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n" +
		"--b\r\nContent-Type: text/plain\r\n\r\nBody\x00 text\r\n" +
		"--b\r\nContent-Type: application/" + strings.Repeat("x", 300) + "\r\nContent-Disposition: attachment; filename=long-type.bin\r\nContent-ID: <" + strings.Repeat("c", 400) + ">\r\n\r\ny\r\n" +
		parts.String() + "--b--\r\n")

	msg, err := Build(context.Background(), storagetest.New(), "acc-1", raw, "1", time.Now(), api.Flags{}, discard)
	if err != nil {
		t.Fatal(err)
	}
	if msg.Subject != "Hello there" || strings.ContainsRune(msg.BodyText, 0) || strings.ContainsRune(msg.Snippet, 0) {
		t.Errorf("subject %q, body %q, snippet %q still hold control characters", msg.Subject, msg.BodyText, msg.Snippet)
	}
	if msg.From.Name == nil || *msg.From.Name != "Sam" {
		t.Errorf("from = %+v", msg.From)
	}
	if len(msg.Attachments) != 500 {
		t.Errorf("%d attachments, the API takes 500", len(msg.Attachments))
	}
	first := msg.Attachments[0]
	if len([]rune(first.ContentType)) != 255 || first.ContentID == nil || len([]rune(*first.ContentID)) != 255 {
		t.Errorf("first attachment = %+v", first)
	}
	for _, a := range msg.Attachments {
		if a.ContentType == "" || len([]rune(a.ContentType)) > 255 || a.Filename == "" {
			t.Fatalf("attachment outside the limits: %+v", a)
		}
	}
	if len(msg.References) != 2 || len([]rune(msg.References[0])) != 998 || msg.References[1] != "ok@example.test" {
		t.Errorf("references = %d %v", len(msg.References), msg.References[1:])
	}
}

func TestCleanDropsControlCharactersAndFallsBack(t *testing.T) {
	if got := clean("a\x00b\tc\nd\x7f\xff", 10); got != "ab\tc\nd\uFFFD" {
		t.Errorf("clean = %q", got)
	}
	if orDefault(clean(" \x00", 255), "application/octet-stream") != "application/octet-stream" {
		t.Error("an empty value after cleaning does not fall back")
	}
}

func TestPlaceholderKeepsTheRawMessageAndDropsWhatWasParsed(t *testing.T) {
	modSeq := uint64(7)
	id := "a@example.test"
	original := api.Message{RemoteUID: "9", ModSeq: &modSeq, RawObjectKey: "raw/key", KeyVersion: 2, Size: 10, ReceivedAt: time.Unix(5, 0).UTC(),
		Flags: api.Flags{Seen: true}, MessageID: &id, Subject: "Broken", From: api.Address{Address: "x@example.test"},
		Attachments: []api.Attachment{{Filename: "a"}}}

	got := Placeholder(original)
	if got.RemoteUID != "9" || got.ModSeq != &modSeq || got.RawObjectKey != "raw/key" || got.KeyVersion != 2 || !got.Flags.Seen || !got.ReceivedAt.Equal(original.ReceivedAt) {
		t.Errorf("placeholder lost what identifies the message: %+v", got)
	}
	if !strings.HasPrefix(got.Subject, PlaceholderSubject) || !IsPlaceholder(got) || got.MessageID != nil || got.From.Address != "unknown@unknown.invalid" || len(got.Attachments) != 0 || got.Snippet == "" {
		t.Errorf("placeholder kept parsed values: %+v", got)
	}
}

func TestUnreadableStoresANoticeThatIsUniquePerMessage(t *testing.T) {
	store := storagetest.New()
	at := time.Date(2026, 10, 19, 10, 0, 0, 0, time.UTC)
	first, err := Unreadable(context.Background(), store, "acc-1", "INBOX\x007", "7", at, api.Flags{Flagged: true})
	if err != nil {
		t.Fatal(err)
	}
	second, err := Unreadable(context.Background(), store, "acc-1", "INBOX\x008", "8", at, api.Flags{})
	if err != nil {
		t.Fatal(err)
	}
	if first.RemoteUID != "7" || !first.Flags.Flagged || !strings.HasPrefix(first.Subject, PlaceholderSubject) || first.MessageID == nil || first.KeyVersion != 1 {
		t.Errorf("unreadable = %+v", first)
	}
	if first.RawObjectKey == second.RawObjectKey || *first.MessageID == *second.MessageID {
		t.Error("two unreadable messages share a raw message or a Message-ID, the API would merge them")
	}
	if !strings.Contains(string(store.Plaintext(first.RawObjectKey)), "could not import") {
		t.Error("the notice was not stored as the raw message")
	}
}

// Anyone can write X-MS-Exchange-Organization-AuthAs; only Exchange Online strips it from mail arriving from outside,
// so it is passed on for messages Exchange took in, and never otherwise.
func TestTheExchangeAuthAsHeaderIsOnlyPassedOnForExchange(t *testing.T) {
	raw := []byte("From: a@example.com\r\nX-MS-Exchange-Organization-AuthAs: Internal\r\nSubject: Hi\r\n\r\nBody\r\n")

	msg, err := Build(context.Background(), storagetest.New(), "acc-1", raw, "1", time.Now(), api.Flags{}, discard)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := msg.Headers["x-ms-exchange-organization-authas"]; ok {
		t.Errorf("headers %v; the header must be left out outside Exchange", msg.Headers)
	}
	msg, err = BuildFromExchange(context.Background(), storagetest.New(), "acc-1", raw, "1", time.Now(), api.Flags{}, discard)
	if err != nil {
		t.Fatal(err)
	}
	if got := msg.Headers["x-ms-exchange-organization-authas"]; got != "Internal" {
		t.Errorf("x-ms-exchange-organization-authas = %q, want Internal", got)
	}
}
