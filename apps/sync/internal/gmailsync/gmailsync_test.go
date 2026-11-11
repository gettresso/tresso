package gmailsync

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/fakeapi"
	"tresso/sync/internal/ingestmsg"
	"tresso/sync/internal/isolate"
	"tresso/sync/internal/providerauth"
	"tresso/sync/internal/providersend"
	"tresso/sync/internal/storage/storagetest"
)

func testOptions(baseURL string) Options {
	opts := DefaultOptions()
	opts.Client.BaseURL = baseURL
	opts.Client.HTTP.MinBackoff = time.Millisecond
	opts.Client.HTTP.MaxBackoff = 5 * time.Millisecond
	opts.Client.HTTP.MaxAttempts = 3
	opts.Client.HTTP.UnitsPerSecond = 0 // the limiter has its own tests; here it would only slow the tests down
	opts.ListPageSize = 2
	opts.BackfillPagesPerPass = 10
	opts.MinBackoff = time.Millisecond
	opts.MaxBackoff = 5 * time.Millisecond
	return opts
}

type harness struct {
	gmail   *fakeGmail
	api     *fakeapi.API
	store   *storagetest.Vault
	syncer  *Syncer
	session *session
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{gmail: newFakeGmail(t), api: fakeapi.New(), store: storagetest.New()}
	h.syncer = New(h.api, h.store, "w1", testOptions(h.gmail.server.URL), slog.New(slog.NewTextHandler(io.Discard, nil)))
	return h
}

// start opens a session and runs its first step, as Run does.
func (h *harness) start(t *testing.T) {
	t.Helper()
	h.session = h.syncer.newSession(api.Account{ID: "acc"}, isolate.NewStrikes(), h.syncer.logger)
	if err := h.session.refreshFolders(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.step(t)
}

func (h *harness) step(t *testing.T) {
	t.Helper()
	if err := h.session.step(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) cursor(t *testing.T) Cursor {
	t.Helper()
	raw := h.api.Cursor(allMailFolder)
	c, err := DecodeCursor(&raw)
	if err != nil || c == nil {
		t.Fatalf("All Mail cursor %q: %v", raw, err)
	}
	return *c
}

func raw(id string) []byte { return fakeapi.RawMessage(id+"@example.test", "Message "+id) }

// backfilled is a mailbox with mail in every kind of place, synced once.
func backfilled(t *testing.T) *harness {
	h := newHarness(t)
	g := h.gmail
	g.addLabel("Label_1", "Projects/Acme")
	g.add("m1", 1000, raw("m1"), "INBOX", "UNREAD")
	g.add("m2", 2000, raw("m2"), "CATEGORY_PERSONAL") // archived
	g.add("m3", 3000, raw("m3"), "SENT")
	g.add("m4", 4000, raw("m4"), "INBOX", "STARRED", "Label_1", "IMPORTANT")
	g.add("m5", 5000, raw("m5"), "TRASH")
	g.add("m6", 6000, raw("m6"), "SPAM")
	h.start(t)
	return h
}

func expectUIDs(t *testing.T, h *harness, folder string, want ...string) {
	t.Helper()
	if want == nil {
		want = []string{}
	}
	if got := h.api.UIDs(folder); !slices.Equal(got, want) {
		t.Errorf("%s holds %v, want %v", folder, got, want)
	}
}

func TestBackfillIngestsNewestFirstIntoEveryFolder(t *testing.T) {
	h := backfilled(t)

	var names []string
	for _, f := range h.api.ReportedFolders() {
		names = append(names, f.RemoteName+"="+f.DisplayName+"/"+f.Role)
		if f.UIDValidity != nil {
			t.Errorf("folder %s has a uidValidity", f.RemoteName)
		}
	}
	want := []string{"INBOX=Inbox/inbox", "SENT=Sent/sent", "DRAFT=Drafts/drafts", "TRASH=Trash/trash", "SPAM=Spam/spam", "tresso:all=All Mail/all", "Label_1=Projects/Acme/custom"}
	if !slices.Equal(names, want) {
		t.Errorf("folders = %v, want %v", names, want)
	}

	expectUIDs(t, h, "INBOX", "m1", "m4")
	expectUIDs(t, h, allMailFolder, "m1", "m2", "m3", "m4")
	expectUIDs(t, h, "SENT", "m3")
	expectUIDs(t, h, "TRASH", "m5")
	expectUIDs(t, h, "SPAM", "m6")
	expectUIDs(t, h, "Label_1", "m4")
	expectUIDs(t, h, "DRAFT")

	if got := h.api.Ingested(allMailFolder); !slices.Equal(got, []string{"m4", "m3", "m2", "m1"}) {
		t.Errorf("All Mail ingested in order %v, want newest first", got)
	}
	if f, _ := h.api.Flags("INBOX", "m1"); f.Seen || f.Flagged {
		t.Errorf("m1 flags = %+v, want unread", f)
	}
	if f, _ := h.api.Flags("Label_1", "m4"); !f.Seen || !f.Flagged || f.Answered {
		t.Errorf("m4 flags = %+v, want read and flagged", f)
	}

	c := h.cursor(t)
	if !c.BackfillDone || c.HistoryID != "106" || c.BackfillPageToken != "" {
		t.Errorf("cursor = %+v", c)
	}
	for _, f := range []string{"INBOX", "SENT", "Label_1", "TRASH"} {
		if h.api.Cursor(f) != "" {
			t.Errorf("%s has a cursor; only All Mail has one", f)
		}
	}
	for _, id := range []string{"m1", "m2", "m3", "m4", "m5", "m6"} {
		if got, _ := h.gmail.gets(id); got != 1 {
			t.Errorf("%s downloaded %d times", id, got)
		}
	}
	if h.store.Objects.Len() == 0 {
		t.Error("raw messages were not stored")
	}
}

func TestBackfillIsInterleavedAndResumes(t *testing.T) {
	h := newHarness(t)
	for i := 1; i <= 6; i++ {
		id := "m" + strconv.Itoa(i)
		h.gmail.add(id, int64(i)*1000, raw(id), "INBOX")
	}
	h.syncer.opts.BackfillPagesPerPass = 1
	h.start(t)

	c := h.cursor(t)
	if c.BackfillDone || c.BackfillPageToken == "" {
		t.Fatalf("after one page cursor = %+v", c)
	}
	expectUIDs(t, h, "INBOX", "m5", "m6")

	// New mail arrives while the backfill runs: the next step takes it in before the next page.
	h.gmail.add("m7", 7000, raw("m7"), "INBOX")
	h.step(t)
	expectUIDs(t, h, "INBOX", "m3", "m4", "m5", "m6", "m7")

	h.step(t)
	expectUIDs(t, h, "INBOX", "m1", "m2", "m3", "m4", "m5", "m6", "m7")
	if !h.cursor(t).BackfillDone {
		t.Error("backfill not done")
	}
}

func TestHistoryRoundAppliesEveryKindOfChange(t *testing.T) {
	h := backfilled(t)
	g := h.gmail
	g.add("m7", 7000, raw("m7"), "INBOX", "UNREAD") // new mail
	g.removeLabels("m1", "UNREAD")                  // read
	g.removeLabels("m4", "INBOX")                   // archived
	g.addLabels("m2", "Label_1")                    // labelled
	g.remove("m3", false)                           // deleted for good
	g.addLabels("m6", "STARRED")                    // flagged in Spam

	h.step(t)

	expectUIDs(t, h, "INBOX", "m1", "m7")
	expectUIDs(t, h, allMailFolder, "m1", "m2", "m4", "m7")
	expectUIDs(t, h, "Label_1", "m2", "m4")
	expectUIDs(t, h, "SENT")
	if f, _ := h.api.Flags("INBOX", "m1"); !f.Seen {
		t.Error("m1 not marked read")
	}
	if f, _ := h.api.Flags("SPAM", "m6"); !f.Flagged {
		t.Error("m6 not flagged")
	}

	// Flag changes and removals never download the MIME again; the new message is downloaded once although both
	// Inbox and All Mail lacked it. A label added to m2 is a new location, which the ingest API only takes as a
	// complete message, so m2 is downloaded once more (object storage keeps one copy).
	for id, want := range map[string]int{"m1": 1, "m2": 2, "m4": 1, "m6": 1, "m7": 1} {
		if got, _ := g.gets(id); got != want {
			t.Errorf("%s downloaded %d times, want %d", id, got, want)
		}
	}
	deleted := h.api.DeletedKeys()
	if len(deleted) != 1 || !strings.Contains(deleted[0], "m3@") {
		t.Errorf("deleted = %v, want only m3", deleted)
	}
	if c := h.cursor(t); c.HistoryID != strconv.Itoa(g.historyID) {
		t.Errorf("cursor history id %s, want %d", c.HistoryID, g.historyID)
	}
}

func TestExpiredHistoryResyncsEveryFolder(t *testing.T) {
	h := backfilled(t)
	g := h.gmail
	g.remove("m2", true)
	g.add("m8", 8000, raw("m8"), "INBOX")
	g.mu.Lock()
	g.messages["m1"].labels = []string{"INBOX"} // read, without history
	g.mu.Unlock()
	g.expireHistory()

	h.step(t)

	expectUIDs(t, h, allMailFolder, "m1", "m3", "m4", "m8")
	expectUIDs(t, h, "INBOX", "m1", "m4", "m8")
	if f, _ := h.api.Flags("INBOX", "m1"); !f.Seen {
		t.Error("m1 flags not refreshed by the resync")
	}
	if deleted := h.api.DeletedKeys(); len(deleted) != 1 || !strings.Contains(deleted[0], "m2@") {
		t.Errorf("deleted = %v, want m2", deleted)
	}
	if got, _ := g.gets("m4"); got != 1 {
		t.Errorf("m4 downloaded %d times during the resync", got)
	}
	if c := h.cursor(t); c.HistoryID != strconv.Itoa(g.historyID) || !c.BackfillDone {
		t.Errorf("cursor after resync = %+v", c)
	}

	// History works again from the new id.
	g.add("m9", 9000, raw("m9"), "INBOX")
	h.step(t)
	expectUIDs(t, h, "INBOX", "m1", "m4", "m8", "m9")
}

func TestUnknownLabelInHistoryRefreshesFolders(t *testing.T) {
	h := backfilled(t)
	calls := h.api.Calls()
	h.gmail.addLabel("Label_2", "Receipts")
	h.gmail.addLabels("m1", "Label_2")

	h.step(t)

	if h.api.Calls() != calls+1 {
		t.Errorf("folder list reported %d more times, want once", h.api.Calls()-calls)
	}
	if !slices.ContainsFunc(h.api.ReportedFolders(), func(f api.Folder) bool { return f.RemoteName == "Label_2" && f.DisplayName == "Receipts" }) {
		t.Error("Label_2 was not reported")
	}
	expectUIDs(t, h, "Label_2", "m1")
}

func TestRefusedTokenIsRenewedOnce(t *testing.T) {
	h := newHarness(t)
	h.gmail.add("m1", 1000, raw("m1"), "INBOX")
	h.gmail.token = "token-2" // the API's token has been revoked; the renewed one works

	h.start(t)

	if h.api.Refreshes != 1 || h.gmail.authRejected != 1 {
		t.Errorf("refreshes %d, rejected %d; want one renewal", h.api.Refreshes, h.gmail.authRejected)
	}
	expectUIDs(t, h, "INBOX", "m1")
}

func TestRefusedRenewedTokenReportsAuthFailure(t *testing.T) {
	h := newHarness(t)
	h.gmail.token = "nothing-works"

	runUntilReturn(t, h.syncer)

	if log := h.api.StatusLog(); !strings.HasPrefix(log, api.StatusAuthFailed+": Google no longer accepts") {
		t.Errorf("statuses = %q", log)
	}
}

func TestReauthorizeFromTheAPIEndsTheRunQuietly(t *testing.T) {
	h := newHarness(t)
	h.api.Reauthorize = true

	runUntilReturn(t, h.syncer)

	if log := h.api.StatusLog(); log != "" {
		t.Errorf("statuses = %q; the API already marked the account", log)
	}
}

func TestMissingMailScopeReportsAuthFailure(t *testing.T) {
	h := newHarness(t)
	h.gmail.fail(http.StatusForbidden, `{"error":{"code":403,"message":"Request had insufficient authentication scopes.","status":"PERMISSION_DENIED",`+
		`"errors":[{"reason":"insufficientPermissions"}],"details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}`)

	runUntilReturn(t, h.syncer)

	if log := h.api.StatusLog(); !strings.Contains(log, api.StatusAuthFailed+": ") || !strings.Contains(log, "allow access to your mail") {
		t.Errorf("statuses = %q", log)
	}
}

func TestRateLimitedRequestIsRetried(t *testing.T) {
	h := newHarness(t)
	h.gmail.add("m1", 1000, raw("m1"), "INBOX")
	h.gmail.fail(http.StatusForbidden, `{"error":{"code":403,"errors":[{"reason":"userRateLimitExceeded"}]}}`)

	h.start(t)

	expectUIDs(t, h, "INBOX", "m1")
}

// runUntilReturn runs the syncer and fails when Run does not end on its own.
func runUntilReturn(t *testing.T, s *Syncer) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.Run(ctx, api.Account{ID: "acc"}); err != nil {
		t.Fatal(err)
	}
	if ctx.Err() != nil {
		t.Fatal("Run did not end after losing access")
	}
}

func TestFoldersAndFlagsOfLabels(t *testing.T) {
	isFolder := map[string]bool{"INBOX": true, "TRASH": true, "Label_1": true, allMailFolder: true}
	cases := []struct {
		labels []string
		want   []string
	}{
		{[]string{"INBOX", "UNREAD", "CATEGORY_UPDATES"}, []string{"INBOX", allMailFolder}},
		{nil, []string{allMailFolder}},
		{[]string{"TRASH", "Label_1", "INBOX"}, []string{"TRASH"}},
		{[]string{"SPAM", "Label_1"}, nil}, // SPAM is no folder in this map
		{[]string{"CHAT"}, nil},
	}
	for _, c := range cases {
		if got := foldersOf(c.labels, isFolder); !slices.Equal(got, c.want) {
			t.Errorf("foldersOf(%v) = %v, want %v", c.labels, got, c.want)
		}
	}
	if f := flagsOf([]string{"UNREAD", "STARRED", "DRAFT"}); f.Seen || !f.Flagged || !f.Draft || f.Answered {
		t.Errorf("flags = %+v", f)
	}
}

func TestCursorRoundTripAndLimit(t *testing.T) {
	encoded, err := Cursor{HistoryID: "42", BackfillPageToken: "tok"}.Encode()
	if err != nil {
		t.Fatal(err)
	}
	c, err := DecodeCursor(&encoded)
	if err != nil || c == nil || c.HistoryID != "42" || c.BackfillPageToken != "tok" || c.Version != cursorVersion {
		t.Fatalf("decoded %+v, %v", c, err)
	}
	if _, err := (Cursor{HistoryID: "1", BackfillPageToken: strings.Repeat("x", api.MaxCursorLength)}).Encode(); err == nil {
		t.Error("an oversized cursor must fail, not be cut")
	}
	old := `{"v":0,"historyId":"1"}`
	if c, err := DecodeCursor(&old); c != nil || err != nil {
		t.Errorf("old cursor = %+v, %v", c, err)
	}
}

func sendClient(h *harness, opts ClientOptions) *Client {
	return NewClient(providerauth.New(h.api, "acc", "w1"), opts)
}

func TestSendAddsBccForEnvelopeOnlyRecipients(t *testing.T) {
	h := newHarness(t)
	message := []byte("From: kim@example.test\r\nTo: Anna <anna@example.test>\r\nCc: bo@example.test\r\nSubject: Hi\r\n\r\nHello\r\n")

	err := Send(context.Background(), sendClient(h, h.syncer.opts.Client), message, []string{"anna@example.test", "BO@example.test", "secret@example.test"})
	if err != nil {
		t.Fatal(err)
	}

	sent := h.gmail.sent
	if len(sent) != 1 || !strings.HasPrefix(sent[0].path, "/gmail/v1/users/me/messages/send") || sent[0].contentType != "application/json" {
		t.Fatalf("sent = %+v", sent)
	}
	var body struct {
		Raw string `json:"raw"`
	}
	if err := json.Unmarshal(sent[0].raw, &body); err != nil {
		t.Fatal(err)
	}
	delivered, err := base64.URLEncoding.DecodeString(body.Raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(delivered), "Bcc: <secret@example.test>\r\nFrom: kim@example.test\r\n") {
		t.Errorf("delivered message = %q", delivered)
	}
}

func TestSendUploadsLargeMessagesAsMultipart(t *testing.T) {
	h := newHarness(t)
	message := append([]byte("From: kim@example.test\r\nTo: anna@example.test\r\nSubject: Big\r\n\r\n"), make([]byte, uploadThreshold+1)...)

	if err := Send(context.Background(), sendClient(h, h.syncer.opts.Client), message, []string{"anna@example.test"}); err != nil {
		t.Fatal(err)
	}

	sent := h.gmail.sent
	if len(sent) != 1 || sent[0].path != "/upload/gmail/v1/users/me/messages/send?uploadType=multipart" || !strings.HasPrefix(sent[0].contentType, "multipart/related; boundary=") {
		t.Fatalf("sent = path %q type %q", sent[0].path, sent[0].contentType)
	}
	raw, _ := h.gmail.decodeMessage(sent[0].contentType, sent[0].raw, false)
	if len(raw) != len(message) {
		t.Errorf("uploaded %d bytes, want %d", len(raw), len(message))
	}
}

func TestSendErrorsArePermanentOrTemporary(t *testing.T) {
	cases := []struct {
		status    int
		body      string
		permanent bool
		text      string
	}{
		{http.StatusBadRequest, `{"error":{"code":400,"message":"Invalid To header"}}`, true, "Gmail refused the message. Gmail said: Invalid To header"},
		{http.StatusTooManyRequests, `{"error":{"code":429}}`, false, "Gmail is limiting how much mail Tresso sends right now."},
		{http.StatusInternalServerError, `{"error":{"code":500}}`, false, "Gmail could not send the message right now."},
	}
	for _, c := range cases {
		h := newHarness(t)
		opts := h.syncer.opts.Client
		opts.HTTP.MaxAttempts = 1
		h.gmail.fail(c.status, c.body)

		err := Send(context.Background(), sendClient(h, opts), []byte("To: a@example.test\r\n\r\nx"), []string{"a@example.test"})

		var sendErr *providersend.Error
		if !errors.As(err, &sendErr) || sendErr.Permanent != c.permanent || sendErr.Message != c.text {
			t.Errorf("status %d: err = %#v", c.status, err)
		}
	}
}

func TestSentStoreFindsEarlierSends(t *testing.T) {
	h := newHarness(t)
	h.gmail.add("m1", 1000, raw("m1"), "SENT")
	store := OpenSent(context.Background(), sendClient(h, h.syncer.opts.Client))

	found, err := store.Contains("m1@example.test")
	if err != nil || !found {
		t.Errorf("Contains = %v, %v", found, err)
	}
	if err := store.Append(nil, time.Now()); !errors.Is(err, ErrFilesSentItself) {
		t.Errorf("Append = %v", err)
	}
}

func TestChatsAreLeftOutOfBackfillAndResync(t *testing.T) {
	h := newHarness(t)
	h.gmail.add("m1", 1000, raw("m1"), "INBOX")
	h.gmail.add("c1", 2000, raw("c1"), "CHAT")
	h.start(t)

	expectUIDs(t, h, allMailFolder, "m1")
	h.gmail.expireHistory()
	h.step(t)

	expectUIDs(t, h, allMailFolder, "m1")
	if got, _ := h.gmail.gets("c1"); got != 0 {
		t.Errorf("chat message downloaded %d times", got)
	}
}

func TestMovesMadeByTheMailboxDoNotComeBackThroughHistory(t *testing.T) {
	h := backfilled(t)
	mailbox := OpenMailbox(context.Background(), sendClient(h, h.syncer.opts.Client))
	moves := []struct{ source, target, id string }{
		{"INBOX", "Label_1", "m1"},     // between labels
		{"INBOX", allMailFolder, "m4"}, // archive: the message already sits in All Mail
		{"SENT", "TRASH", "m3"},
	}
	for _, move := range moves {
		uid, err := mailbox.Move(api.MailboxLocation{Folder: move.source, RemoteUID: move.id}, move.target, "")
		if err != nil || uid != move.id {
			t.Fatalf("Move(%s) = %q, %v", move.id, uid, err)
		}
		h.api.MoveLocation(move.source, move.target, move.id, uid) // what the API does with the report
	}

	h.step(t)

	expectUIDs(t, h, "INBOX")
	expectUIDs(t, h, "Label_1", "m1", "m4")
	expectUIDs(t, h, "TRASH", "m3", "m5")
	expectUIDs(t, h, allMailFolder, "m1", "m2", "m4")
	if deleted := h.api.DeletedKeys(); len(deleted) != 0 {
		t.Errorf("deleted = %v", deleted)
	}
	for _, id := range []string{"m1", "m3", "m4"} {
		if got, _ := h.gmail.gets(id); got != 1 {
			t.Errorf("%s downloaded %d times; the history round must find it known", id, got)
		}
	}
}

// sentThread returns the thread id the last send or draft request asked for.
func sentThread(t *testing.T, h *harness, draft bool) string {
	t.Helper()
	last := h.gmail.sent[len(h.gmail.sent)-1]
	_, threadID := h.gmail.decodeMessage(last.contentType, last.raw, draft)
	return threadID
}

// Fails without the fix: Send passed no threadId, so Gmail started a new conversation for every reply.
func TestRepliesGoIntoTheConversationTheyAnswer(t *testing.T) {
	h := newHarness(t)
	h.gmail.add("m1", 1000, raw("m1"), "INBOX")
	h.gmail.messages["m1"].thread = "t-1"
	client := sendClient(h, h.syncer.opts.Client)
	reply := func(headers string) []byte {
		return []byte("From: kim@example.test\r\nTo: sam@example.test\r\nSubject: Re: Message m1\r\n" + headers + "\r\nThanks\r\n")
	}

	cases := []struct {
		name, headers, want string
	}{
		{"in-reply-to", "In-Reply-To: <m1@example.test>\r\nReferences: <m1@example.test>\r\n", "t-1"},
		{"references only", "References: <older@example.test> <m1@example.test>\r\n", "t-1"},
		{"unknown original", "In-Reply-To: <elsewhere@example.test>\r\n", ""},
		{"no reply", "", ""},
	}
	for _, c := range cases {
		if err := Send(context.Background(), client, reply(c.headers), []string{"sam@example.test"}); err != nil {
			t.Fatal(err)
		}
		if got := sentThread(t, h, false); got != c.want {
			t.Errorf("%s: threadId %q, want %q", c.name, got, c.want)
		}
	}

	// Large replies are uploaded with the thread in the metadata, and draft replies thread as well.
	big := append(reply("In-Reply-To: <m1@example.test>\r\n"), make([]byte, uploadThreshold)...)
	if err := Send(context.Background(), client, big, []string{"sam@example.test"}); err != nil {
		t.Fatal(err)
	}
	if got := sentThread(t, h, false); got != "t-1" {
		t.Errorf("large reply: threadId %q", got)
	}
	drafts := OpenDrafts(context.Background(), client)
	if err := drafts.AppendDraft(reply("Message-ID: <d1.1@example.test>\r\nIn-Reply-To: <m1@example.test>\r\n"), time.Now()); err != nil {
		t.Fatal(err)
	}
	if got := sentThread(t, h, true); got != "t-1" {
		t.Errorf("draft reply: threadId %q", got)
	}
}

// Fails without the fix: the duplicate check only looked for the Message-ID, which Gmail replaced, so a retry after an
// unreported attempt sent the message again.
func TestEarlierSendIsFoundWhenGmailReplacedTheMessageID(t *testing.T) {
	h := newHarness(t)
	h.gmail.rewriteIDs = true
	client := sendClient(h, h.syncer.opts.Client)
	raw := []byte("From: kim@example.test\r\nTo: sam@example.test\r\nSubject: Hi\r\nMessage-ID: <o1@example.test>\r\n\r\nHello\r\n")
	marked, err := providersend.SetHeader(raw, providersend.OutgoingIDHeader, providersend.OutgoingMarker("outgoing-1", "o1@example.test"))
	if err != nil {
		t.Fatal(err)
	}
	if err := Send(context.Background(), client, marked, []string{"sam@example.test"}); err != nil {
		t.Fatal(err)
	}

	store := OpenSent(context.Background(), client)
	if found, _ := store.Contains("o1@example.test"); found {
		t.Fatal("the fake did not replace the Message-ID")
	}
	since := time.Now().Add(-time.Hour)
	sam := []string{"sam@example.test"}
	if found, err := store.SentBefore(api.OutgoingMessage{ID: "outgoing-1", MessageID: "o1@example.test", Recipients: sam}, marked, since); err != nil || !found {
		t.Errorf("SentBefore = %v, %v; want the earlier send found by its outbox marker", found, err)
	}
	if found, err := store.SentBefore(api.OutgoingMessage{ID: "outgoing-2", MessageID: "o2@example.test", Recipients: sam}, marked, since); err != nil || found {
		t.Errorf("SentBefore(other) = %v, %v", found, err)
	}
}

// Fails without the fix: removal only matched the Message-ID, which Gmail replaced, so the old copy stayed.
func TestReplacedDraftCopyIsRemovedWhenGmailReplacedItsMessageID(t *testing.T) {
	h := newHarness(t)
	h.gmail.rewriteIDs = true
	drafts := OpenDrafts(context.Background(), sendClient(h, h.syncer.opts.Client))
	version := func(n string) []byte {
		return []byte("From: kim@example.test\r\nTo: sam@example.test\r\nSubject: Draft\r\nMessage-ID: <d1." + n + "@example.test>\r\nX-Tresso-Draft: d1\r\n\r\nNot done\r\n")
	}
	if err := drafts.AppendDraft(version("1"), time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := drafts.AppendDraft(version("2"), time.Now()); err != nil {
		t.Fatal(err)
	}

	if err := drafts.Remove("d1.1@example.test"); err != nil {
		t.Fatal(err)
	}

	var left []string
	for _, messageID := range h.gmail.drafts {
		left = append(left, providersend.HeaderValue(h.gmail.messages[messageID].raw, providersend.DraftCopyHeader))
	}
	if !slices.Equal(left, []string{providersend.DraftCopyMarker("d1.2@example.test")}) {
		t.Errorf("drafts left = %v; only the replaced version may go", left)
	}
}

// Fails without the fix: foldersOf kept a trashed message in the Inbox, its labels and All Mail.
func TestTrashedAndSpamMessagesAreOnlyInTrashOrSpam(t *testing.T) {
	h := newHarness(t)
	h.gmail.addLabel("Label_1", "Projects")
	h.gmail.add("t1", 1000, raw("t1"), "INBOX", "Label_1", "TRASH")
	h.gmail.add("s1", 2000, raw("s1"), "INBOX", "SPAM")
	h.gmail.add("m1", 3000, raw("m1"), "INBOX", "Label_1")
	h.start(t)

	expectUIDs(t, h, "INBOX", "m1")
	expectUIDs(t, h, "Label_1", "m1")
	expectUIDs(t, h, allMailFolder, "m1")
	expectUIDs(t, h, "TRASH", "t1")
	expectUIDs(t, h, "SPAM", "s1")
}

// Fails without the fix: history only took the message out of the labels it named, so a trashed message stayed in
// the Inbox and its labels.
func TestTrashAndRestoreThroughHistory(t *testing.T) {
	h := backfilled(t)

	h.gmail.addLabels("m4", "TRASH")
	h.step(t)
	expectUIDs(t, h, "INBOX", "m1")
	expectUIDs(t, h, "Label_1")
	expectUIDs(t, h, allMailFolder, "m1", "m2", "m3")
	expectUIDs(t, h, "TRASH", "m4", "m5")

	h.gmail.removeLabels("m4", "TRASH")
	h.step(t)
	expectUIDs(t, h, "INBOX", "m1", "m4")
	expectUIDs(t, h, "Label_1", "m4")
	expectUIDs(t, h, allMailFolder, "m1", "m2", "m3", "m4")
	expectUIDs(t, h, "TRASH", "m5")
	if deleted := h.api.DeletedKeys(); len(deleted) != 0 {
		t.Errorf("deleted = %v", deleted)
	}
}

// Fails without the fix: trashing one message sent a removal to every label folder of the account.
func TestTrashingAMessageOnlyAsksItsOwnFoldersToRemoveIt(t *testing.T) {
	h := newHarness(t)
	for i := range 50 {
		h.gmail.addLabel(fmt.Sprintf("Label_%d", i+10), fmt.Sprintf("Label %d", i))
	}
	h.gmail.addLabel("Label_1", "Projects/Acme")
	h.gmail.add("m1", 1000, raw("m1"), "INBOX")
	h.gmail.add("m4", 4000, raw("m4"), "INBOX", "Label_1")
	h.start(t)

	before := h.api.VanishRequests()
	h.gmail.addLabels("m4", "TRASH")
	h.step(t)

	expectUIDs(t, h, "INBOX", "m1")
	expectUIDs(t, h, "Label_1")
	expectUIDs(t, h, "TRASH", "m4")
	// Inbox, Label_1 and All Mail had it; Sent, Drafts and Spam are asked too, never the other 50 labels.
	if requests := h.api.VanishRequests() - before; requests > 6 {
		t.Errorf("trashing one message made %d removal requests; want at most the system folders and its label", h.api.VanishRequests()-before)
	}
}

// Fails without the fix: the resync listed label folders with Trash and Spam included, keeping a trashed message in
// its labels.
func TestResyncKeepsTrashedMessagesOutOfTheirLabels(t *testing.T) {
	h := backfilled(t)
	h.gmail.mu.Lock()
	h.gmail.messages["m4"].labels = append(h.gmail.messages["m4"].labels, "TRASH") // without history
	h.gmail.mu.Unlock()
	h.gmail.add("m9", 9000, raw("m9"), "SENT") // history moves on, then expires
	h.gmail.expireHistory()

	h.step(t)

	expectUIDs(t, h, "INBOX", "m1")
	expectUIDs(t, h, "Label_1")
	expectUIDs(t, h, allMailFolder, "m1", "m2", "m3", "m9")
	expectUIDs(t, h, "TRASH", "m4", "m5")
}

func sentTo(to, messageID string) []byte {
	return []byte("From: kim@example.test\r\nTo: " + to + "\r\nSubject: Hi\r\nMessage-ID: <" + messageID + ">\r\n\r\nHello\r\n")
}

// Fails on the earlier code: it looked through all mail sent in the last 48 hours and gave up ("undecided") above
// 2000 messages, so on a busy account a message whose first attempt never went out was never sent, and every check
// cost a metadata request per sent message.
func TestDuplicateCheckOnlyReadsMailToTheRecipient(t *testing.T) {
	h := newHarness(t)
	h.gmail.rewriteIDs = true
	now := time.Now()
	for i := range 2100 {
		h.gmail.addSent(sentTo("other@example.test", fmt.Sprintf("busy-%d@example.test", i)), now.Add(-time.Minute).UnixMilli())
	}
	client := sendClient(h, h.syncer.opts.Client)
	marked, err := providersend.SetHeader(sentTo("sam@example.test", "o1@example.test"), providersend.OutgoingIDHeader, providersend.OutgoingMarker("outgoing-1", "o1@example.test"))
	if err != nil {
		t.Fatal(err)
	}
	if err := Send(context.Background(), client, marked, []string{"sam@example.test"}); err != nil {
		t.Fatal(err)
	}
	store := OpenSent(context.Background(), client)
	since := now.Add(-time.Hour)

	found, err := store.SentBefore(api.OutgoingMessage{ID: "outgoing-1", MessageID: "o1@example.test", Recipients: []string{"sam@example.test"}}, marked, since)
	if err != nil || !found {
		t.Errorf("SentBefore = %v, %v", found, err)
	}
	// A message whose first attempt failed before sending: decided "not sent", so the retry sends it.
	found, err = store.SentBefore(api.OutgoingMessage{ID: "outgoing-2", MessageID: "o2@example.test", Recipients: []string{"anna@example.test"}}, marked, since)
	if err != nil || found {
		t.Errorf("SentBefore(never sent) = %v, %v", found, err)
	}
	if h.gmail.metadataGets > 2 {
		t.Errorf("%d metadata requests; only mail to the recipient may be read", h.gmail.metadataGets)
	}
}

// Fails on the earlier code: when the Message-ID search found nothing it went through every draft and gave up
// ("undecided") above 2000, so the removal came back every run for ever.
func TestDraftRemovalOnlyLooksAtDraftsSinceTheDraftStarted(t *testing.T) {
	h := newHarness(t)
	h.gmail.rewriteIDs = true
	now := time.Now()
	for i := range 2100 {
		h.gmail.addDraft(sentTo("other@example.test", fmt.Sprintf("old-%d@example.test", i)), now.Add(-48*time.Hour).UnixMilli())
	}
	draftID := fakeapi.UUIDv7(now.Add(-time.Hour), 1)
	filed := draftID + ".1@example.test"
	drafts := OpenDrafts(context.Background(), sendClient(h, h.syncer.opts.Client))
	if err := drafts.AppendDraft(sentTo("sam@example.test", filed), now); err != nil {
		t.Fatal(err)
	}

	if err := drafts.Remove(draftID + ".9@example.test"); err != nil {
		t.Errorf("removing a copy that was never filed: %v; it counts as removed", err)
	}
	if err := drafts.Remove(filed); err != nil {
		t.Fatal(err)
	}
	if len(h.gmail.drafts) != 2100 {
		t.Errorf("%d drafts left, want the 2100 old ones", len(h.gmail.drafts))
	}
	if h.gmail.metadataGets > 2 {
		t.Errorf("%d metadata requests; drafts older than the draft may not be read", h.gmail.metadataGets)
	}
}

func sentWithSubject(to, subject, messageID string) []byte {
	return []byte("From: kim@example.test\r\nTo: " + to + "\r\nSubject: " + subject + "\r\nMessage-ID: <" + messageID + ">\r\n\r\nHello\r\n")
}

// Fails on the earlier code: the scan stopped at 2000 messages and called the question undecided, which used up the
// message's attempts. The subject narrows the search, and the whole window is read when it still holds many.
func TestDuplicateCheckReadsTheWholeWindowForABusyRecipient(t *testing.T) {
	h := newHarness(t)
	h.gmail.rewriteIDs = true
	now := time.Now()
	for i := range 2100 {
		h.gmail.addSent(sentWithSubject("sam@example.test", "Status", fmt.Sprintf("busy-%d@example.test", i)), now.Add(-time.Minute).UnixMilli()-int64(i))
	}
	client := sendClient(h, h.syncer.opts.Client)
	store := OpenSent(context.Background(), client)
	since := now.Add(-time.Hour)

	// Another subject: only our copy is read.
	ours := sentWithSubject("sam@example.test", "Quarterly numbers", "o1@example.test")
	marked, _ := providersend.SetHeader(ours, providersend.OutgoingIDHeader, providersend.OutgoingMarker("outgoing-1", "o1@example.test"))
	if err := Send(context.Background(), client, marked, []string{"sam@example.test"}); err != nil {
		t.Fatal(err)
	}
	found, err := store.SentBefore(api.OutgoingMessage{ID: "outgoing-1", MessageID: "o1@example.test", Recipients: []string{"sam@example.test"}}, marked, since)
	if err != nil || !found || h.gmail.metadataGets > 1 {
		t.Errorf("SentBefore = %v, %v after %d reads", found, err, h.gmail.metadataGets)
	}

	// The same subject as 2100 others, never sent: every one is read and the answer is "not sent", not undecided.
	h.gmail.metadataGets = 0
	same := sentWithSubject("sam@example.test", "Status", "o2@example.test")
	found, err = store.SentBefore(api.OutgoingMessage{ID: "outgoing-2", MessageID: "o2@example.test", Recipients: []string{"sam@example.test"}}, same, since)
	if err != nil || found || h.gmail.metadataGets != 2100 {
		t.Errorf("SentBefore(never sent) = %v, %v after %d reads", found, err, h.gmail.metadataGets)
	}
}

// Fails on the earlier code: in:sent does not find a sent copy the user moved to Trash, so a retry sent it again.
func TestDuplicateCheckFindsASentCopyInTrash(t *testing.T) {
	h := newHarness(t)
	h.gmail.rewriteIDs = true
	client := sendClient(h, h.syncer.opts.Client)
	raw := sentWithSubject("sam@example.test", "Hi", "o1@example.test")
	marked, _ := providersend.SetHeader(raw, providersend.OutgoingIDHeader, providersend.OutgoingMarker("outgoing-1", "o1@example.test"))
	if err := Send(context.Background(), client, marked, []string{"sam@example.test"}); err != nil {
		t.Fatal(err)
	}
	h.gmail.mu.Lock()
	for _, m := range h.gmail.messages {
		m.labels = append(m.labels, "TRASH")
	}
	h.gmail.mu.Unlock()

	found, err := OpenSent(context.Background(), client).SentBefore(api.OutgoingMessage{ID: "outgoing-1", MessageID: "o1@example.test", Recipients: []string{"sam@example.test"}}, marked, time.Now().Add(-time.Hour))
	if err != nil || !found {
		t.Errorf("SentBefore = %v, %v; the copy in Trash was sent", found, err)
	}
}

// Fails on the earlier code: removing a copy that is gone read the header of every draft since the draft started
// (a day before it, for clock differences), however long ago that was. Now at most a week back is read.
func TestRemovingAGoneDraftCopyReadsAtMostAWeekOfDrafts(t *testing.T) {
	h := newHarness(t)
	now := time.Now()
	for i := range 300 {
		h.gmail.addDraft(sentWithSubject("other@example.test", "Old", fmt.Sprintf("old-%d@example.test", i)), now.Add(-10*24*time.Hour).UnixMilli())
	}
	draftID := fakeapi.UUIDv7(now.Add(-30*24*time.Hour), 1)
	drafts := OpenDrafts(context.Background(), sendClient(h, h.syncer.opts.Client))

	if err := drafts.Remove(draftID + ".4@example.test"); err != nil {
		t.Fatal(err)
	}
	if h.gmail.metadataGets != 0 {
		t.Errorf("%d drafts read for a copy that is gone", h.gmail.metadataGets)
	}
}

// Fails on the earlier code: Gmail matches a subject by its words, so a subject of only punctuation matched nothing,
// the earlier copy was not found, and the retry sent the message again.
func TestDuplicateCheckIgnoresASubjectWithoutWords(t *testing.T) {
	h := newHarness(t)
	h.gmail.rewriteIDs = true
	client := sendClient(h, h.syncer.opts.Client)
	raw := sentWithSubject("sam@example.test", "???", "o1@example.test")
	marked, _ := providersend.SetHeader(raw, providersend.OutgoingIDHeader, providersend.OutgoingMarker("outgoing-1", "o1@example.test"))
	if err := Send(context.Background(), client, marked, []string{"sam@example.test"}); err != nil {
		t.Fatal(err)
	}

	found, err := OpenSent(context.Background(), client).SentBefore(api.OutgoingMessage{ID: "outgoing-1", MessageID: "o1@example.test", Recipients: []string{"sam@example.test"}}, marked, time.Now().Add(-time.Hour))
	if err != nil || !found {
		t.Errorf("SentBefore = %v, %v", found, err)
	}
}

// sessions starts sessions one after the other on one run's strikes and clock, each starting from what the API
// stored, and returns the error of each.
func (h *harness) sessions(t *testing.T, n int, strikes *isolate.Strikes, now func() time.Time) []error {
	t.Helper()
	var errs []error
	for range n {
		h.session = h.syncer.newSession(api.Account{ID: "acc"}, strikes, h.syncer.logger)
		h.session.ingest.Now = now
		err := h.session.refreshFolders(context.Background())
		if err == nil {
			err = h.session.step(context.Background())
		}
		errs = append(errs, err)
	}
	return errs
}

type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// Fails without the fix: a throttling 403 counted against the message, and three quick sessions replaced it.
func TestGmailThrottlingReplacesNothing(t *testing.T) {
	h := newHarness(t)
	h.gmail.add("m1", 1000, raw("m1"), "INBOX")
	h.gmail.add("m2", 2000, raw("m2"), "INBOX")
	h.gmail.refuseAllRaw = [2]string{"403", `{"error":{"code":403,"errors":[{"reason":"userRateLimitExceeded"}],"status":"PERMISSION_DENIED"}}`}
	c := &clock{now: time.Now()}
	strikes := isolate.NewStrikesWithClock(c.Now)

	for range 5 {
		c.advance(isolate.MinStrikeSpan)
		h.sessions(t, 1, strikes, c.Now)
	}
	expectUIDs(t, h, "INBOX")
	expectUIDs(t, h, allMailFolder)
}

// A message Gmail keeps refusing, next to messages that come through, gets a placeholder only after the time floor,
// filed by its labels; once Gmail hands it over, the real message takes the placeholder's place.
func TestAGmailPlaceholderIsFiledByItsLabelsAndReplacedLater(t *testing.T) {
	h := newHarness(t)
	h.gmail.addLabel("Label_1", "Projects")
	h.gmail.add("m1", 1000, raw("m1"), "INBOX")
	h.gmail.add("m2", 2000, raw("m2"), "INBOX", "Label_1")
	h.gmail.add("m3", 3000, raw("m3"), "INBOX")
	h.gmail.refuseRaw = map[string][2]string{"m2": {"400", `{"error":{"code":400,"status":"FAILED_PRECONDITION"}}`}}
	c := &clock{now: time.Now()}
	strikes := isolate.NewStrikesWithClock(c.Now)

	for i, err := range h.sessions(t, isolate.StrikesBeforeSkip+1, strikes, c.Now) {
		if err == nil {
			t.Fatalf("session %d went through before the time floor", i+1)
		}
	}
	c.advance(isolate.MinStrikeSpan)
	if errs := h.sessions(t, 1, strikes, c.Now); errs[0] != nil {
		t.Fatal(errs[0])
	}
	expectUIDs(t, h, "INBOX", "m1", "m2", "m3")
	expectUIDs(t, h, "Label_1", "m2")
	msg, _ := h.api.Message("INBOX", "m2")
	if !strings.HasPrefix(msg.Subject, ingestmsg.PlaceholderSubject) || !msg.ReceivedAt.Equal(time.UnixMilli(2000).UTC()) {
		t.Fatalf("m2 = %+v; want a placeholder with the message's own date", msg)
	}

	h.gmail.mu.Lock()
	h.gmail.refuseRaw = nil
	h.gmail.mu.Unlock()
	c.advance(isolate.RetryFirst)
	if errs := h.sessions(t, 1, strikes, c.Now); errs[0] != nil {
		t.Fatal(errs[0])
	}
	for _, folder := range []string{"INBOX", "Label_1", allMailFolder} {
		if msg, _ := h.api.Message(folder, "m2"); msg.Subject != "Message m2" {
			t.Errorf("%s holds %q for m2; want the real message", folder, msg.Subject)
		}
	}
	if pending := h.session.ingest.Pending(allMailFolder); len(pending) != 0 {
		t.Errorf("pending %v after the replacement", pending)
	}
}

// A sender can write X-MS-Exchange-Organization-AuthAs into any mail; Gmail does not strip it, so it is left out.
func TestGmailMailDoesNotPassOnExchangesAuthAs(t *testing.T) {
	h := newHarness(t)
	h.gmail.add("m1", 1000, []byte("From: anna@company.example\r\nX-MS-Exchange-Organization-AuthAs: Internal\r\nMessage-ID: <m1@example.test>\r\nSubject: Hi\r\n\r\nBody\r\n"), "INBOX")
	h.start(t)

	msg, ok := h.api.Message("INBOX", "m1")
	if !ok {
		t.Fatal("not ingested")
	}
	if _, sent := msg.Headers["x-ms-exchange-organization-authas"]; sent {
		t.Errorf("headers %v", msg.Headers)
	}
}
