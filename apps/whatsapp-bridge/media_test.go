package main

// Ported from gettresso/whatsapp-mcp (whatsapp-bridge/main_test.go, store_test.go, logger_test.go): the media,
// re-upload and name rules are unchanged.

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

func TestMediaRetryWaiters(t *testing.T) {
	const id = types.MessageID("3EB0TESTWAITER")
	t.Cleanup(func() {
		mediaRetryMu.Lock()
		delete(mediaRetryWaiters, id)
		mediaRetryMu.Unlock()
	})

	first, err := registerMediaRetryWaiter(id)
	if err != nil {
		t.Fatalf("first register: %v", err)
	}

	// A second request for the same message is refused and leaves the first waiter in place.
	if second, err := registerMediaRetryWaiter(id); !errors.Is(err, errMediaRetryPending) || second != nil {
		t.Fatalf("second register = %v, %v; want nil, errMediaRetryPending", second, err)
	}
	if errMediaRetryPending.Error() != "a re-upload of this message is already being requested" {
		t.Fatalf("unexpected message %q", errMediaRetryPending.Error())
	}

	// A release by someone else's (stale) waiter leaves the current one alone.
	stale := make(chan *events.MediaRetry, 1)
	releaseMediaRetryWaiter(id, stale)
	handleMediaRetry(&events.MediaRetry{MessageID: id})
	select {
	case <-first:
	default:
		t.Fatal("the answer did not reach the registered waiter after a stale release")
	}

	// The owner's release removes it, and the id can be requested again.
	releaseMediaRetryWaiter(id, first)
	mediaRetryMu.Lock()
	_, still := mediaRetryWaiters[id]
	mediaRetryMu.Unlock()
	if still {
		t.Fatal("waiter still registered after its own release")
	}
	again, err := registerMediaRetryWaiter(id)
	if err != nil {
		t.Fatalf("register after release: %v", err)
	}
	releaseMediaRetryWaiter(id, again)

	// An answer for a message nobody waits for is dropped without blocking.
	handleMediaRetry(&events.MediaRetry{MessageID: id})
}

type fakeLIDs struct {
	lidToPN map[string]string
	pnToLID map[string]string
	err     error
}

func (f fakeLIDs) GetPNForLID(_ context.Context, lid types.JID) (types.JID, error) {
	if f.err != nil {
		return types.JID{}, f.err
	}
	if pn, ok := f.lidToPN[lid.User]; ok {
		return types.NewJID(pn, types.DefaultUserServer), nil
	}
	return types.JID{}, nil
}

func (f fakeLIDs) GetLIDForPN(_ context.Context, pn types.JID) (types.JID, error) {
	if f.err != nil {
		return types.JID{}, f.err
	}
	if lid, ok := f.pnToLID[pn.User]; ok {
		return types.NewJID(lid, types.HiddenUserServer), nil
	}
	return types.JID{}, nil
}

func TestSenderJID(t *testing.T) {
	store := fakeLIDs{
		// A 15 digit phone number and a short LID: the length rule would get both wrong.
		lidToPN: map[string]string{"12345678": "123456789012345"},
		pnToLID: map[string]string{"123456789012345": "12345678"},
	}
	broken := fakeLIDs{err: errors.New("store closed")}
	cases := []struct {
		name   string
		lids   lidLookup
		sender string
		want   string
	}{
		{"full JID kept", store, "31612345678@s.whatsapp.net", "31612345678@s.whatsapp.net"},
		{"full LID kept", store, "98765432109876543@lid", "98765432109876543@lid"},
		{"store knows it as a LID", store, "12345678", "12345678@lid"},
		{"store knows it as a phone number", store, "123456789012345", "123456789012345@s.whatsapp.net"},
		{"unknown short id falls back to phone", store, "31612345678", "31612345678@s.whatsapp.net"},
		{"unknown long id falls back to LID", store, "98765432109876543", "98765432109876543@lid"},
		{"store error falls back to length", broken, "12345678", "12345678@s.whatsapp.net"},
		{"no store falls back to length", nil, "98765432109876543", "98765432109876543@lid"},
	}
	for _, tc := range cases {
		got, err := senderJID(context.Background(), tc.lids, tc.sender)
		if err != nil || got.String() != tc.want {
			t.Errorf("%s: senderJID(%q) = %q, %v; want %q", tc.name, tc.sender, got.String(), err, tc.want)
		}
	}
	if _, err := senderJID(context.Background(), store, ""); err == nil {
		t.Error("an empty sender must be an error")
	}
}

func TestAwaitMediaRetry(t *testing.T) {
	waiter := make(chan *events.MediaRetry, 1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := awaitMediaRetry(ctx, waiter, time.Hour); err == nil || !strings.Contains(err.Error(), "context canceled") {
		t.Errorf("cancelled context: got %v, want a cancellation error", err)
	}

	if _, err := awaitMediaRetry(context.Background(), waiter, time.Millisecond); err == nil || !strings.Contains(err.Error(), "no answer") {
		t.Errorf("timeout: got %v, want a timeout error", err)
	}

	answer := &events.MediaRetry{MessageID: "X"}
	waiter <- answer
	if got, err := awaitMediaRetry(context.Background(), waiter, time.Hour); err != nil || got != answer {
		t.Errorf("answer: got %v, %v", got, err)
	}
}

func TestValidChatJID(t *testing.T) {
	for _, jid := range []string{
		"31612345678@s.whatsapp.net",
		"120363012345678901@g.us",
		"123456789012345@lid",
		"120363012345678901@newsletter",
	} {
		if err := validChatJID(jid); err != nil {
			t.Errorf("validChatJID(%q) = %v, want nil", jid, err)
		}
	}
	for _, jid := range []string{
		"",
		".",
		"..",
		"@s.whatsapp.net",
		"31612345678",
		"31612345678@example.com",
		"31612345678@broadcast",
		"../x@s.whatsapp.net",
		"a/b@s.whatsapp.net",
		"a\\b@s.whatsapp.net",
		"..@s.whatsapp.net",
		"x@g.us@/../../etc",
		"x@g.us/..",
		"x\x00@g.us",
	} {
		if err := validChatJID(jid); err == nil {
			t.Errorf("validChatJID(%q) accepted", jid)
		}
	}
}

func TestValidMessageID(t *testing.T) {
	for _, id := range []string{"3EB0C431C26A1916E07A", "ABCDEF0123456789", "a-b_c"} {
		if !validMessageID(id) {
			t.Errorf("validMessageID(%q) = false", id)
		}
	}
	for _, id := range []string{"", ".", "..", "a/b", "a\\b", "a.b", "a b", "a\nb", strings.Repeat("A", 129)} {
		if validMessageID(id) {
			t.Errorf("validMessageID(%q) = true", id)
		}
	}
}

func TestMediaFileNamesDoNotCollide(t *testing.T) {
	first := mediaFileName("3EB0AAAA", "report.pdf")
	second := mediaFileName("3EB0BBBB", "report.pdf")
	if first == second {
		t.Fatalf("two messages with one file name share %q", first)
	}
	if first != "3EB0AAAA_report.pdf" {
		t.Errorf("unexpected name %q", first)
	}
}

func TestStoredFileMatchesAndWritePrivateFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, mediaFileName("3EB0AAAA", "report.pdf"))
	data := []byte("the first report")
	sum := sha256.Sum256(data)

	if storedFileMatches(path, sum[:]) {
		t.Fatal("a missing file matched")
	}
	if err := writePrivateFile(path, data); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0600 {
		t.Errorf("file mode %o, want 600", mode)
	}
	if !storedFileMatches(path, sum[:]) {
		t.Error("the file that was written does not match its hash")
	}
	other := sha256.Sum256([]byte("the second report"))
	if storedFileMatches(path, other[:]) {
		t.Error("a file matched another message's hash")
	}
	if storedFileMatches(path, nil) {
		t.Error("a file matched without a stored hash")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("temporary files left behind: %v", entries)
	}
}

func TestMediaFileNameLength(t *testing.T) {
	id := "3EB0C431C26A1916E07A"
	long := strings.Repeat("é", 150) + strings.Repeat("😀", 20) + ".pdf" // 300 + 80 + 4 bytes
	name := mediaFileName(id, long)
	if len(name) > maxFileNameBytes {
		t.Fatalf("name of %d bytes", len(name))
	}
	document := strings.TrimPrefix(name, id+"_")
	if len(document) > maxDocumentNameBytes {
		t.Errorf("document part of %d bytes, want at most %d", len(document), maxDocumentNameBytes)
	}
	if !utf8.ValidString(name) {
		t.Errorf("name cut inside a rune: %q", name)
	}
	if !strings.HasSuffix(name, ".pdf") {
		t.Errorf("extension lost: %q", name)
	}
	if !strings.HasPrefix(document, strings.Repeat("é", 98)) {
		t.Errorf("unexpected start %q", document)
	}

	// The longest message ID still leaves the whole within the limit.
	longID := strings.Repeat("A", 128)
	if got := mediaFileName(longID, long); len(got) > maxFileNameBytes || !utf8.ValidString(got) || !strings.HasSuffix(got, ".pdf") {
		t.Errorf("long ID: %d bytes, %q", len(got), got)
	}

	// A short name stays as it is, and an extension that is most of the name is not kept apart.
	if got := mediaFileName(id, "report.pdf"); got != id+"_report.pdf" {
		t.Errorf("short name changed: %q", got)
	}
	weird := "a." + strings.Repeat("ü", 150)
	if got := mediaFileName(id, weird); len(got) > maxFileNameBytes || !utf8.ValidString(got) {
		t.Errorf("long extension: %d bytes, %q", len(got), got)
	}
}
