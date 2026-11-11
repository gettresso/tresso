package graphsync

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
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
	opts.BackfillPageSize = 2
	opts.BackfillPagesPerPass = 10
	opts.MinBackoff = time.Millisecond
	opts.MaxBackoff = 5 * time.Millisecond
	return opts
}

type harness struct {
	graph   *fakeGraph
	api     *fakeapi.API
	syncer  *Syncer
	session *session
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{graph: newFakeGraph(t), api: fakeapi.New()}
	h.graph.standardTree()
	h.syncer = New(h.api, storagetest.New(), "w1", testOptions(h.graph.base), slog.New(slog.NewTextHandler(io.Discard, nil)))
	return h
}

// start opens a session, starts every folder (Run's steps do that one folder per step) and runs a step over every
// folder.
func (h *harness) start(t *testing.T) {
	t.Helper()
	h.session = h.syncer.newSession(api.Account{ID: "acc"}, isolate.NewStrikes(), h.syncer.logger)
	if err := h.session.refreshFolders(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, run := range h.session.runs {
		if run.cursor == nil {
			if err := h.session.start(context.Background(), run); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := h.session.step(context.Background(), true); err != nil {
		t.Fatal(err)
	}
}

func (s *session) unstarted() bool {
	for _, run := range s.runs {
		if run.cursor == nil && !run.denied {
			return true
		}
	}
	return false
}

// pollInbox runs a step in which only the inbox is due.
func (h *harness) pollInbox(t *testing.T) {
	t.Helper()
	for _, run := range h.session.runs {
		run.nextPoll = time.Now().Add(time.Hour)
		if run.folder.Role == "inbox" {
			run.nextPoll = time.Now().Add(-time.Second)
		}
	}
	if err := h.session.step(context.Background(), false); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) cursor(t *testing.T, folder string) Cursor {
	t.Helper()
	raw := h.api.Cursor(folder)
	c, err := DecodeCursor(&raw)
	if err != nil || c == nil {
		t.Fatalf("%s cursor %q: %v", folder, raw, err)
	}
	return *c
}

func raw(id string) []byte { return fakeapi.RawMessage(id+"@example.test", "Message "+id) }

func expectUIDs(t *testing.T, h *harness, folder string, want ...string) {
	t.Helper()
	if want == nil {
		want = []string{}
	}
	if got := h.api.UIDs(folder); !slices.Equal(got, want) {
		t.Errorf("%s holds %v, want %v", folder, got, want)
	}
}

// synced is a mailbox with mail in the inbox and a nested folder, synced once.
func synced(t *testing.T) *harness {
	h := newHarness(t)
	h.graph.add("m1", "f-inbox", 100, raw("m1"))
	h.graph.add("m2", "f-inbox", 200, raw("m2"))
	h.graph.add("m3", "f-inbox", 300, raw("m3"))
	h.graph.add("p1", "f-proj", 50, raw("p1"))
	h.graph.markRead("m2")
	h.start(t)
	return h
}

func TestFolderTreeWithPathsAndRoles(t *testing.T) {
	h := newHarness(t)
	h.start(t)

	var got []string
	for _, f := range h.api.ReportedFolders() {
		got = append(got, f.RemoteName+"="+f.DisplayName+"/"+f.Role)
		if f.UIDValidity != nil {
			t.Errorf("folder %s has a uidValidity", f.RemoteName)
		}
	}
	want := []string{
		"f-inbox=Inbox/inbox", "f-sent=Sent Items/sent", "f-proj=Inbox/Projects/custom", "f-acme=Inbox/Projects/Acme/custom",
		"f-drafts=Drafts/drafts", "f-trash=Deleted Items/trash", "f-junk=Junk Email/spam", "f-notes=Notes/custom",
	}
	if !slices.Equal(got, want) {
		t.Errorf("folders = %v\nwant      %v", got, want)
	}
}

func TestInitialDeltaThenNewestFirstBackfill(t *testing.T) {
	h := synced(t)

	expectUIDs(t, h, "f-inbox", "m1", "m2", "m3")
	expectUIDs(t, h, "f-proj", "p1")
	if got := h.api.Ingested("f-inbox"); !slices.Equal(got, []string{"m3", "m2", "m1"}) {
		t.Errorf("inbox ingested in order %v, want newest first", got)
	}
	if f, _ := h.api.Flags("f-inbox", "m2"); !f.Seen || f.Flagged || f.Answered {
		t.Errorf("m2 flags = %+v", f)
	}
	if f, _ := h.api.Flags("f-inbox", "m1"); f.Seen {
		t.Errorf("m1 flags = %+v", f)
	}
	for _, id := range []string{"m1", "m2", "m3", "p1"} {
		if got := h.graph.gets(id); got != 1 {
			t.Errorf("%s downloaded %d times", id, got)
		}
	}
	c := h.cursor(t, "f-inbox")
	if !c.BackfillDone || c.BackfillBefore != "" || !strings.HasPrefix(c.DeltaLink, "/me/mailFolders/f-inbox/messages/delta?$deltatoken=") {
		t.Errorf("inbox cursor = %+v; the delta link is stored relative to the base URL", c)
	}
}

func TestBackfillResumesFromTheStoredPage(t *testing.T) {
	h := newHarness(t)
	for i, id := range []string{"m1", "m2", "m3", "m4", "m5"} {
		h.graph.add(id, "f-inbox", 100*(i+1), raw(id))
	}
	h.syncer.opts.BackfillPagesPerPass = 1
	h.start(t)

	c := h.cursor(t, "f-inbox")
	if c.BackfillDone || c.BackfillBefore != "1970-01-01T00:06:40Z" {
		t.Fatalf("cursor after one page = %+v", c)
	}
	expectUIDs(t, h, "f-inbox", "m4", "m5")

	// A new session (another worker) continues where the stored cursor points.
	h.start(t)
	expectUIDs(t, h, "f-inbox", "m2", "m3", "m4", "m5")
}

func TestDeltaRoundAppliesNewChangedMovedAndDeleted(t *testing.T) {
	h := synced(t)
	g := h.graph
	g.add("m4", "f-inbox", 400, raw("m4")) // new
	g.markRead("m1")                       // changed
	g.move("m2", "f-proj")                 // moved, same immutable id
	g.remove("m3", false)                  // deleted

	h.pollInbox(t)

	expectUIDs(t, h, "f-inbox", "m1", "m4")
	expectUIDs(t, h, "f-proj", "m2", "p1")
	if f, _ := h.api.Flags("f-inbox", "m1"); !f.Seen {
		t.Error("m1 not marked read")
	}
	if f, _ := h.api.Flags("f-proj", "m2"); !f.Seen {
		t.Error("m2 lost its flags on the move")
	}
	// The move was linked to the new folder before it left the inbox: only m3 was deleted.
	deleted := h.api.DeletedKeys()
	if len(deleted) != 1 || !strings.Contains(deleted[0], "m3@") {
		t.Errorf("deleted = %v, want only m3", deleted)
	}
	if got := g.gets("m1"); got != 1 {
		t.Errorf("m1 downloaded %d times; a flag change needs no MIME", got)
	}
	if !strings.HasSuffix(h.cursor(t, "f-inbox").DeltaLink, "$deltatoken="+strconv.Itoa(g.seq)) {
		t.Errorf("inbox delta link not advanced: %s", h.cursor(t, "f-inbox").DeltaLink)
	}
}

func TestQuietRoundStoresNothing(t *testing.T) {
	h := synced(t)
	before := h.api.Cursor("f-inbox")

	h.pollInbox(t)

	if h.api.Cursor("f-inbox") != before {
		t.Error("a round without changes rewrote the cursor")
	}
}

func TestExpiredDeltaTokenResyncsTheFolder(t *testing.T) {
	h := synced(t)
	g := h.graph
	g.remove("m1", true)
	g.mu.Lock()
	g.messages["m3"].flagged = true
	g.mu.Unlock()
	g.expireDeltaTokens()

	h.pollInbox(t)

	expectUIDs(t, h, "f-inbox", "m2", "m3")
	if f, _ := h.api.Flags("f-inbox", "m3"); !f.Flagged {
		t.Error("m3 flags not refreshed by the resync")
	}
	if deleted := h.api.DeletedKeys(); len(deleted) != 1 || !strings.Contains(deleted[0], "m1@") {
		t.Errorf("deleted = %v, want m1", deleted)
	}
	if got := g.gets("m2"); got != 1 {
		t.Errorf("m2 downloaded %d times during the resync", got)
	}

	// The new delta link works.
	g.add("m5", "f-inbox", 500, raw("m5"))
	h.pollInbox(t)
	expectUIDs(t, h, "f-inbox", "m2", "m3", "m5")
}

func TestThrottlingHonoursRetryAfter(t *testing.T) {
	h := newHarness(t)
	h.graph.throttle, h.graph.retryAfter = 1, "1"
	started := time.Now()

	h.start(t)

	if len(h.graph.throttledAt) != 1 {
		t.Fatalf("throttled %d times", len(h.graph.throttledAt))
	}
	if elapsed := time.Since(started); elapsed < time.Second {
		t.Errorf("retried after %v, want at least the 1 s Retry-After", elapsed)
	}
	if len(h.api.ReportedFolders()) == 0 {
		t.Error("folders not synced after the throttled request")
	}
}

func TestRefusedTokenIsRenewedOnce(t *testing.T) {
	h := newHarness(t)
	h.graph.token = "token-2"

	h.start(t)

	if h.api.Refreshes != 1 || h.graph.authRejected != 1 {
		t.Errorf("refreshes %d, rejected %d", h.api.Refreshes, h.graph.authRejected)
	}
}

func TestAccessDeniedReportsAuthFailure(t *testing.T) {
	h := newHarness(t)
	h.graph.fail(http.StatusForbidden, `{"error":{"code":"ErrorAccessDenied","message":"Access is denied."}}`)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.syncer.Run(ctx, api.Account{ID: "acc"}); err != nil || ctx.Err() != nil {
		t.Fatalf("Run = %v, ctx %v; want it to end on its own", err, ctx.Err())
	}
	if log := h.api.StatusLog(); !strings.HasPrefix(log, api.StatusAuthFailed+": Tresso is not allowed to read this mailbox. Sign in with Microsoft again") {
		t.Errorf("statuses = %q", log)
	}
}

func TestCursorLimit(t *testing.T) {
	if _, err := (Cursor{DeltaLink: "/" + strings.Repeat("x", api.MaxCursorLength)}).Encode(); err == nil {
		t.Error("an oversized cursor must fail, not be cut")
	}
	encoded, err := Cursor{DeltaLink: "/me/x", BackfillBefore: "2026-10-19T10:00:00Z"}.Encode()
	if err != nil {
		t.Fatal(err)
	}
	if c, err := DecodeCursor(&encoded); err != nil || c == nil || c.DeltaLink != "/me/x" || c.BackfillBefore != "2026-10-19T10:00:00Z" {
		t.Errorf("decoded %+v, %v", c, err)
	}
}

func TestLinksOutsideTheBaseURLAreRefused(t *testing.T) {
	c := NewClient(nil, ClientOptions{BaseURL: "https://graph.example/v1.0"})
	if _, err := c.resolve("https://elsewhere.example/v1.0/me"); err == nil {
		t.Error("a link to another host must be refused")
	}
	if got, _ := c.resolve(c.relative("https://graph.example/v1.0/me/x?a=1")); got != "https://graph.example/v1.0/me/x?a=1" {
		t.Errorf("round trip = %q", got)
	}
}

func sendClient(h *harness, opts ClientOptions) *Client {
	return NewClient(providerauth.New(h.api, "acc", "w1"), opts)
}

func TestSendPostsBase64MIMEWithBcc(t *testing.T) {
	h := newHarness(t)
	message := []byte("From: kim@example.test\r\nTo: anna@example.test\r\nSubject: Hi\r\n\r\nHello\r\n")

	if err := Send(context.Background(), sendClient(h, h.syncer.opts.Client), message, []string{"anna@example.test", "hidden@example.test"}, "marker-1"); err != nil {
		t.Fatal(err)
	}

	sent := h.graph.sent
	if len(sent) != 1 || sent[0].contentType != "text/plain" {
		t.Fatalf("sent = %+v", sent)
	}
	delivered, err := base64.StdEncoding.DecodeString(string(sent[0].body))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(delivered), "Bcc: <hidden@example.test>\r\nFrom: kim@example.test\r\n") {
		t.Errorf("delivered = %q", delivered)
	}
}

func TestSendErrors(t *testing.T) {
	h := newHarness(t)
	h.graph.fail(http.StatusBadRequest, `{"error":{"code":"ErrorInvalidRecipients","message":"At least one recipient is not valid."}}`)
	err := Send(context.Background(), sendClient(h, h.syncer.opts.Client), []byte("To: a@example.test\r\n\r\nx"), nil, "marker-1")
	var sendErr *providersend.Error
	if !errors.As(err, &sendErr) || !sendErr.Permanent || sendErr.Message != "Outlook refused the message. Outlook said: ErrorInvalidRecipients: At least one recipient is not valid." {
		t.Errorf("400: %#v", err)
	}

	opts := h.syncer.opts.Client
	opts.HTTP.MaxAttempts = 1
	h.graph.fail(http.StatusServiceUnavailable, `{"error":{"code":"ServiceUnavailable"}}`)
	err = Send(context.Background(), sendClient(h, opts), []byte("To: a@example.test\r\n\r\nx"), nil, "marker-1")
	if !errors.As(err, &sendErr) || sendErr.Permanent {
		t.Errorf("503: %#v", err)
	}

	big := append([]byte("To: a@example.test\r\n\r\n"), make([]byte, maxSendBody)...)
	err = Send(context.Background(), sendClient(h, opts), big, nil, "marker-1")
	if !errors.As(err, &sendErr) || !sendErr.Permanent || len(h.graph.sent) != 0 {
		t.Errorf("too large: %#v, sent %d", err, len(h.graph.sent))
	}
}

func TestSentStoreFindsEarlierSends(t *testing.T) {
	h := newHarness(t)
	h.graph.add("s1", "f-sent", 100, raw("s1"))
	store := OpenSent(context.Background(), sendClient(h, h.syncer.opts.Client))

	if found, err := store.Contains("s1@example.test"); err != nil || !found {
		t.Errorf("Contains = %v, %v", found, err)
	}
	if found, err := store.Contains("other@example.test"); err != nil || found {
		t.Errorf("Contains(other) = %v, %v", found, err)
	}
	// Graph reads "+" literally in $filter: spaces must be %20.
	last := h.graph.rawQueries[len(h.graph.rawQueries)-1]
	if !strings.Contains(last, "$filter=internetMessageId%20eq%20%27%3Cother%40example.test%3E%27") || strings.Contains(last, "+") {
		t.Errorf("filter encoded as %q", last)
	}
}

func TestDeletionDuringBackfillSkipsNothing(t *testing.T) {
	h := newHarness(t)
	for i, id := range []string{"m1", "m2", "m3", "m4", "m5"} {
		h.graph.add(id, "f-inbox", 100*(i+1), raw(id))
	}
	h.syncer.opts.BackfillPagesPerPass = 1
	h.start(t)
	expectUIDs(t, h, "f-inbox", "m4", "m5")

	// A message on the page already done goes away; with position-based pages the next page would start one too far
	// and m3 would never be ingested.
	h.graph.remove("m5", false)
	h.pollInbox(t)
	h.pollInbox(t)

	expectUIDs(t, h, "f-inbox", "m1", "m2", "m3", "m4")
	if !h.cursor(t, "f-inbox").BackfillDone {
		t.Error("backfill not done")
	}
}

func TestEqualReceiveTimesAcrossAPageBoundary(t *testing.T) {
	h := newHarness(t)
	for _, id := range []string{"m1", "m2", "m3", "m4"} {
		h.graph.add(id, "f-inbox", 100, raw(id))
	}
	h.graph.add("m5", "f-inbox", 200, raw("m5"))
	h.syncer.opts.BackfillPagesPerPass = 1

	h.start(t)
	expectUIDs(t, h, "f-inbox", "m1", "m2", "m3", "m4", "m5")
	h.start(t)
	if !h.cursor(t, "f-inbox").BackfillDone {
		t.Error("backfill not done")
	}
	for _, id := range []string{"m1", "m2", "m3", "m4", "m5"} {
		if got := h.graph.gets(id); got != 1 {
			t.Errorf("%s downloaded %d times", id, got)
		}
	}
}

func TestMoveIntoAFolderCreatedSinceLinksInsteadOfDeleting(t *testing.T) {
	h := synced(t)
	g := h.graph
	g.mu.Lock()
	g.folders = append(g.folders, fakeFolder{"f-new", "Receipts", ""})
	g.mu.Unlock()
	g.move("m1", "f-new")
	g.move("m2", "f-new")

	// Only the inbox is due and the session has not read the folder tree since the folder was created.
	h.pollInbox(t)

	expectUIDs(t, h, "f-inbox", "m3")
	expectUIDs(t, h, "f-new", "m1", "m2")
	if deleted := h.api.DeletedKeys(); len(deleted) != 0 {
		t.Errorf("moved messages were deleted: %v", deleted)
	}
	if f, _ := h.api.Flags("f-new", "m2"); !f.Seen {
		t.Error("m2 lost its flags on the move")
	}
	if h.api.Cursor("f-new") != "" {
		t.Error("the new folder was walked in the round; folders are started one per step")
	}
	// The next step starts it.
	if err := h.session.step(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	expectUIDs(t, h, "f-new", "m1", "m2")
	if c := h.cursor(t, "f-new"); !c.BackfillDone {
		t.Errorf("new folder cursor = %+v; its mail is in, nothing to backfill", c)
	}
}

func TestFolderFoundByAFolderRefreshAppliesItsMailBeforeRemovals(t *testing.T) {
	h := synced(t)
	g := h.graph
	g.mu.Lock()
	g.folders = append(g.folders, fakeFolder{"f-new", "Receipts", ""})
	g.mu.Unlock()
	g.move("m1", "f-new")
	if err := h.session.refreshFolders(context.Background()); err != nil {
		t.Fatal(err)
	}

	h.pollInbox(t)

	expectUIDs(t, h, "f-inbox", "m2", "m3")
	expectUIDs(t, h, "f-new", "m1")
	if deleted := h.api.DeletedKeys(); len(deleted) != 0 {
		t.Errorf("moved message was deleted: %v", deleted)
	}
}

func TestQuietFolderStoresAFreshDeltaLinkOnceTheOldOneAges(t *testing.T) {
	h := synced(t)
	inbox := h.session.runs[0]
	before := h.api.Cursor("f-inbox")
	// A change elsewhere moves Graph's token on; the inbox itself stays quiet.
	h.graph.add("n1", "f-notes", 100, raw("n1"))

	h.pollInbox(t)
	if h.api.Cursor("f-inbox") != before {
		t.Fatal("a recent delta link was replaced in a quiet round")
	}

	inbox.storedAt = time.Now().Add(-25 * time.Hour)
	h.pollInbox(t)
	if after := h.api.Cursor("f-inbox"); after == before {
		t.Error("an old delta link was not refreshed")
	}
	if inbox.storedAt.Before(time.Now().Add(-time.Minute)) {
		t.Error("storedAt not updated")
	}
}

func TestPartialFirstStartResumesWithCheckpointedBackfill(t *testing.T) {
	h := newHarness(t)
	g := h.graph
	g.add("m1", "f-inbox", 100, raw("m1"))
	g.add("p1", "f-proj", 100, raw("p1"))
	g.add("p2", "f-proj", 200, raw("p2"))
	g.add("p3", "f-proj", 300, raw("p3"))
	g.add("a1", "f-acme", 100, raw("a1"))
	g.failDelta = "f-proj"

	// The first session stops while starting the folders.
	h.session = h.syncer.newSession(api.Account{ID: "acc"}, isolate.NewStrikes(), h.syncer.logger)
	if err := h.session.refreshFolders(context.Background()); err != nil {
		t.Fatal(err)
	}
	err := h.session.step(context.Background(), true)
	for err == nil && h.session.unstarted() {
		err = h.session.step(context.Background(), false)
	}
	if err == nil {
		t.Fatal("the failing delta walk did not end the session")
	}
	if h.api.Cursor("f-inbox") == "" || h.api.Cursor("f-proj") != "" {
		t.Fatalf("cursors after the failed start: inbox %q, proj %q", h.api.Cursor("f-inbox"), h.api.Cursor("f-proj"))
	}

	// The next session starts the rest the same way: newest first, checkpointed.
	h.start(t)
	if got := h.api.Ingested("f-proj"); !slices.Equal(got, []string{"p3", "p2", "p1"}) {
		t.Errorf("proj ingested in order %v, want newest first", got)
	}
	expectUIDs(t, h, "f-inbox", "m1")
	expectUIDs(t, h, "f-acme", "a1")
	for _, folder := range []string{"f-inbox", "f-proj", "f-acme"} {
		if !h.cursor(t, folder).BackfillDone {
			t.Errorf("%s backfill not done", folder)
		}
	}
}

func TestMoveIntoAFolderStillBackfillingIsRescued(t *testing.T) {
	h := newHarness(t)
	g := h.graph
	g.add("m1", "f-inbox", 100, raw("m1"))
	for i, id := range []string{"n1", "n2", "n3", "n4", "n5"} {
		g.add(id, "f-notes", 100*(i+1), raw(id))
	}
	h.syncer.opts.BackfillPagesPerPass = 1
	h.start(t)
	if h.cursor(t, "f-notes").BackfillDone {
		t.Fatal("notes should still be backfilling")
	}

	// m1 sits in Notes without Notes' delta reporting it (it got there before the delta started, as seen by a new
	// session); the inbox reports it removed.
	g.moveQuietly("m1", "f-notes")
	h.start(t) // a new session: nothing of the earlier one is remembered
	h.pollInbox(t)

	if deleted := h.api.DeletedKeys(); len(deleted) != 0 {
		t.Errorf("moved message was deleted: %v", deleted)
	}
	if _, ok := h.api.Flags("f-notes", "m1"); !ok {
		t.Error("m1 not linked to Notes")
	}
	expectUIDs(t, h, "f-inbox")
}

func TestNoLookupsOnceEveryFolderIsBackfilled(t *testing.T) {
	h := synced(t)
	h.graph.remove("m3", false)

	h.pollInbox(t)

	for _, op := range h.graph.log() {
		if strings.HasPrefix(op, "lookup ") {
			t.Errorf("looked %s up although no folder is backfilling", op)
		}
	}
	if deleted := h.api.DeletedKeys(); len(deleted) != 1 {
		t.Errorf("deleted = %v", deleted)
	}
}

func TestBackfillEndsOnlyWithoutANextLink(t *testing.T) {
	h := newHarness(t)
	for i, id := range []string{"m1", "m2", "m3", "m4"} {
		h.graph.add(id, "f-inbox", 100*(i+1), raw(id))
	}
	h.graph.shortPages = true

	h.start(t)

	expectUIDs(t, h, "f-inbox", "m1", "m2", "m3", "m4")
	if !h.cursor(t, "f-inbox").BackfillDone {
		t.Error("backfill not done")
	}
}

func TestCompletionSweepIngestsMessagesWithoutAReceiveTime(t *testing.T) {
	h := newHarness(t)
	h.graph.add("m1", "f-inbox", 100, raw("m1"))
	h.graph.add("m2", "f-inbox", 200, raw("m2"))
	h.graph.addUndated("u1", "f-inbox", 50, raw("u1"))
	h.syncer.opts.BackfillPageSize = 1

	h.start(t)

	if got := h.api.Ingested("f-inbox"); !slices.Equal(got, []string{"m2", "m1", "u1"}) {
		t.Errorf("ingested %v; the undated message comes with the completion sweep", got)
	}
	if msg, _ := h.api.Message("f-inbox", "u1"); !msg.ReceivedAt.Equal(time.Unix(50, 0)) {
		t.Errorf("u1 received at %v, want its creation time", msg.ReceivedAt)
	}
	for _, id := range []string{"m1", "m2", "u1"} {
		if got := h.graph.gets(id); got != 1 {
			t.Errorf("%s downloaded %d times; the sweep only downloads what the API lacks", id, got)
		}
	}
	if c := h.cursor(t, "f-inbox"); !c.BackfillDone || c.BackfillBefore != "" {
		t.Errorf("cursor = %+v", c)
	}
	for _, query := range h.graph.rawQueries {
		if strings.Contains(query, "null") {
			t.Errorf("query relies on null comparisons: %s", query)
		}
	}
}

func TestUndatedMessageOnAPageComesWithIt(t *testing.T) {
	h := newHarness(t)
	h.graph.addUndated("u1", "f-inbox", 50, raw("u1"))
	h.graph.add("m1", "f-inbox", 100, raw("m1"))

	h.start(t)

	if got := h.api.Ingested("f-inbox"); !slices.Equal(got, []string{"u1", "m1"}) && !slices.Equal(got, []string{"m1", "u1"}) {
		t.Errorf("ingested %v", got)
	}
	if got := h.graph.gets("u1"); got != 1 {
		t.Errorf("u1 downloaded %d times", got)
	}
}

func TestMessageWithoutAnyTimeFallsBackToItsDateHeader(t *testing.T) {
	h := newHarness(t)
	h.graph.addUndated("u1", "f-inbox", 0, raw("u1"))
	h.graph.mu.Lock()
	h.graph.messages["u1"].created = time.Time{}
	h.graph.mu.Unlock()

	h.start(t)

	if msg, ok := h.api.Message("f-inbox", "u1"); !ok || !msg.ReceivedAt.Equal(time.Date(2026, 10, 19, 10, 0, 0, 0, time.UTC)) {
		t.Errorf("u1 = %v, %v; want the Date header's time", msg.ReceivedAt, ok)
	}
}

func TestDraftsStoreCreatesAndRemovesDrafts(t *testing.T) {
	h := newHarness(t)
	drafts := OpenDrafts(context.Background(), sendClient(h, h.syncer.opts.Client))

	if err := drafts.AppendDraft(raw("d1.1"), time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := drafts.AppendDraft(raw("d1.2"), time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := drafts.Remove("d1.1@example.test"); err != nil {
		t.Fatal(err)
	}
	if err := drafts.Remove("gone@example.test"); err != nil {
		t.Errorf("removing a missing draft: %v", err)
	}
	if got := h.graph.log(); !slices.Equal(got, []string{"create draft-1", "create draft-2", "delete draft-1"}) {
		t.Errorf("ops = %v", got)
	}
	for _, query := range h.graph.rawQueries {
		if strings.Contains(query, "internetMessageId") && (!strings.Contains(query, "$filter=internetMessageId%20eq%20") || strings.Contains(query, "+")) {
			t.Errorf("drafts filter encoded as %q", query)
		}
	}

	big := append([]byte("To: a@example.test\r\n\r\n"), make([]byte, maxSendBody)...)
	var sendErr *providersend.Error
	if err := drafts.AppendDraft(big, time.Now()); !errors.As(err, &sendErr) || !sendErr.Permanent {
		t.Errorf("too large: %v", err)
	}
}

func TestMovesMadeByTheMailboxDoNotComeBackThroughDelta(t *testing.T) {
	h := synced(t)
	mailbox := OpenMailbox(context.Background(), sendClient(h, h.syncer.opts.Client))
	uid, err := mailbox.Move(api.MailboxLocation{Folder: "f-inbox", RemoteUID: "m1"}, "f-proj", "")
	if err != nil || uid != "m1" {
		t.Fatalf("Move = %q, %v", uid, err)
	}
	h.api.MoveLocation("f-inbox", "f-proj", "m1", uid) // what the API does with the report

	h.pollInbox(t)

	expectUIDs(t, h, "f-inbox", "m2", "m3")
	expectUIDs(t, h, "f-proj", "m1", "p1")
	if deleted := h.api.DeletedKeys(); len(deleted) != 0 {
		t.Errorf("deleted = %v", deleted)
	}
	if got := h.graph.gets("m1"); got != 1 {
		t.Errorf("m1 downloaded %d times; the delta round must find it known", got)
	}
}

// Fails without the fix: the duplicate check only looked for the Message-ID, which Exchange replaced, so a retry after
// an unreported attempt sent the message again. Both ways Graph exposes the header are covered.
func TestEarlierSendIsFoundWhenExchangeReplacedTheMessageID(t *testing.T) {
	for _, asProperty := range []bool{false, true} {
		h := newHarness(t)
		h.graph.rewriteIDs, h.graph.headersAsProperties = true, asProperty
		client := sendClient(h, h.syncer.opts.Client)
		raw := []byte("From: kim@example.test\r\nTo: sam@example.test\r\nSubject: Hi\r\nMessage-ID: <o1@example.test>\r\n\r\nHello\r\n")
		marked, err := providersend.SetHeader(raw, providersend.OutgoingIDHeader, providersend.OutgoingMarker("outgoing-1", "o1@example.test"))
		if err != nil {
			t.Fatal(err)
		}
		if err := Send(context.Background(), client, marked, []string{"sam@example.test"}, "marker-1"); err != nil {
			t.Fatal(err)
		}

		store := OpenSent(context.Background(), client)
		if found, _ := store.Contains("o1@example.test"); found {
			t.Fatal("the fake did not replace the Message-ID")
		}
		since := time.Now().Add(-time.Hour)
		sam := []string{"sam@example.test"}
		if found, err := store.SentBefore(api.OutgoingMessage{ID: "outgoing-1", MessageID: "o1@example.test", Recipients: sam}, nil, since); err != nil || !found {
			t.Errorf("properties %v: SentBefore = %v, %v; want the earlier send found by its outbox id", asProperty, found, err)
		}
		if found, err := store.SentBefore(api.OutgoingMessage{ID: "outgoing-2", MessageID: "o2@example.test", Recipients: sam}, nil, since); err != nil || found {
			t.Errorf("properties %v: SentBefore(other) = %v, %v", asProperty, found, err)
		}
	}
}

// Fails without the fix: removal only matched internetMessageId, which Exchange replaced, so the old copy stayed.
func TestReplacedDraftCopyIsRemovedWhenExchangeReplacedItsMessageID(t *testing.T) {
	h := newHarness(t)
	h.graph.rewriteIDs = true
	drafts := OpenDrafts(context.Background(), sendClient(h, h.syncer.opts.Client))
	version := func(n string) []byte {
		return []byte("From: kim@example.test\r\nTo: sam@example.test\r\nSubject: Draft\r\nMessage-ID: <d1." + n + "@example.test>\r\nX-Tresso-Draft: d1\r\n\r\nNot done\r\n")
	}
	for _, n := range []string{"1", "2"} {
		if err := drafts.AppendDraft(version(n), time.Now()); err != nil {
			t.Fatal(err)
		}
	}

	if err := drafts.Remove("d1.1@example.test"); err != nil {
		t.Fatal(err)
	}

	if got := h.graph.log(); !slices.Equal(got, []string{"create draft-1", "create draft-2", "delete draft-1"}) {
		t.Errorf("ops = %v; only the replaced version may go", got)
	}
}

func mailTo(to, messageID string) []byte {
	return []byte("From: kim@example.test\r\nTo: " + to + "\r\nSubject: Hi\r\nMessage-ID: <" + messageID + ">\r\n\r\nHello\r\n")
}

// Fails on the earlier code: it read all Sent Items of the last 48 hours and gave up ("undecided") above 2000, so on a
// busy mailbox a message whose first attempt never went out was never sent.
func TestDuplicateCheckOnlyReadsSentItemsToTheRecipient(t *testing.T) {
	for _, refused := range []bool{false, true} {
		h := newHarness(t)
		h.graph.rewriteIDs, h.graph.refuseRecipientFilter = true, refused
		now := time.Now()
		busy := 2100
		if refused {
			busy = 10 // without the recipient filter every Sent Item since the attempt is read
		}
		for i := range busy {
			h.graph.addAt(fmt.Sprintf("busy-%d", i), "f-sent", now.Add(-time.Minute), mailTo("other@example.test", fmt.Sprintf("busy-%d@example.test", i)))
		}
		client := sendClient(h, h.syncer.opts.Client)
		marked, err := providersend.SetHeader(mailTo("sam@example.test", "o1@example.test"), providersend.OutgoingIDHeader, providersend.OutgoingMarker("outgoing-1", "o1@example.test"))
		if err != nil {
			t.Fatal(err)
		}
		if err := Send(context.Background(), client, marked, []string{"sam@example.test"}, "marker-1"); err != nil {
			t.Fatal(err)
		}
		store := OpenSent(context.Background(), client)
		since := now.Add(-time.Hour)

		found, err := store.SentBefore(api.OutgoingMessage{ID: "outgoing-1", MessageID: "o1@example.test", Recipients: []string{"sam@example.test"}}, nil, since)
		if err != nil || !found {
			t.Errorf("refused %v: SentBefore = %v, %v", refused, found, err)
		}
		found, err = store.SentBefore(api.OutgoingMessage{ID: "outgoing-2", MessageID: "o2@example.test", Recipients: []string{"anna@example.test"}}, nil, since)
		if err != nil || found {
			t.Errorf("refused %v: SentBefore(never sent) = %v, %v", refused, found, err)
		}
		if !refused && h.graph.headerReads > 2 {
			t.Errorf("%d Sent Items read; only those to the recipient may be", h.graph.headerReads)
		}
	}
}

// Fails on the earlier code: when the Message-ID search found nothing it read every draft and gave up ("undecided")
// above 2000, so the removal came back every run for ever.
func TestDraftRemovalOnlyLooksAtDraftsSinceTheDraftStarted(t *testing.T) {
	h := newHarness(t)
	h.graph.rewriteIDs = true
	now := time.Now()
	for i := range 2100 {
		h.graph.addAt(fmt.Sprintf("old-%d", i), "f-drafts", now.Add(-48*time.Hour), mailTo("other@example.test", fmt.Sprintf("old-%d@example.test", i)))
	}
	draftID := fakeapi.UUIDv7(now.Add(-time.Hour), 1)
	filed := draftID + ".1@example.test"
	drafts := OpenDrafts(context.Background(), sendClient(h, h.syncer.opts.Client))
	if err := drafts.AppendDraft(mailTo("sam@example.test", filed), now); err != nil {
		t.Fatal(err)
	}

	if err := drafts.Remove(draftID + ".9@example.test"); err != nil {
		t.Errorf("removing a copy that was never filed: %v; it counts as removed", err)
	}
	if err := drafts.Remove(filed); err != nil {
		t.Fatal(err)
	}
	if got := h.graph.log(); !slices.Equal(got, []string{"create draft-1", "delete draft-1"}) {
		t.Errorf("ops = %v", got)
	}
	if h.graph.headerReads > 2 {
		t.Errorf("%d drafts read; drafts older than the draft may not be", h.graph.headerReads)
	}
}

// Fails on the earlier code, which sent with sendMail and looked for the X- header: when Exchange keeps neither the
// Message-ID nor the header, the earlier attempt's copy was not found and the retry sent the message twice. Sending
// through a draft marked with an extended property finds it with one request.
func TestEarlierSendIsFoundByItsExtendedProperty(t *testing.T) {
	h := newHarness(t)
	h.graph.rewriteIDs, h.graph.stripCustomHeaders = true, true
	client := sendClient(h, h.syncer.opts.Client)
	marker := providersend.OutgoingMarker("outgoing-1", "o1@example.test")
	if err := Send(context.Background(), client, mailTo("sam@example.test", "o1@example.test"), []string{"sam@example.test"}, marker); err != nil {
		t.Fatal(err)
	}
	if got := h.graph.log(); !slices.Equal(got, []string{"create draft-1", "send draft-1"}) {
		t.Errorf("ops = %v; the message goes out through a draft", got)
	}

	store := OpenSent(context.Background(), client)
	h.graph.headerReads = 0
	found, err := store.SentBefore(api.OutgoingMessage{ID: "outgoing-1", MessageID: "o1@example.test", Recipients: []string{"sam@example.test"}}, nil, time.Now().Add(-time.Hour))
	if err != nil || !found {
		t.Errorf("SentBefore = %v, %v", found, err)
	}
	if h.graph.headerReads != 0 {
		t.Errorf("%d messages read; the property filter needs none", h.graph.headerReads)
	}
}

// Fails on the earlier code, which deleted any marked draft it found: a draft left by a failed send may still be
// sent by Exchange (it accepts the send and sends a little later), so a young one is "not decided yet", and only one
// that stayed in Drafts for 15 minutes counts as stopped: it is deleted, and the message is sent anew.
func TestADraftLeftByAFailedSendCountsAsStoppedOnlyWhenOldEnough(t *testing.T) {
	h := newHarness(t)
	client := sendClient(h, h.syncer.opts.Client)
	marker := providersend.OutgoingMarker("outgoing-1", "o1@example.test")
	h.graph.failSend = http.StatusBadGateway // may have sent: the draft stays
	if err := Send(context.Background(), client, mailTo("sam@example.test", "o1@example.test"), []string{"sam@example.test"}, marker); err == nil {
		t.Fatal("the failed send reported success")
	}
	message := api.OutgoingMessage{ID: "outgoing-1", MessageID: "o1@example.test", Recipients: []string{"sam@example.test"}}
	store := OpenSent(context.Background(), client)

	found, err := store.SentBefore(message, nil, time.Now().Add(-time.Hour))
	if found || !errors.Is(err, providersend.ErrMaybeSending) {
		t.Errorf("young draft: SentBefore = %v, %v; want may still be sending", found, err)
	}

	h.graph.age("draft-1", 20*time.Minute)
	found, err = store.SentBefore(message, nil, time.Now().Add(-time.Hour))
	if err != nil || found {
		t.Errorf("old draft: SentBefore = %v, %v; the message was never sent", found, err)
	}
	if got := h.graph.log(); !slices.Equal(got, []string{"create draft-1", "delete draft-1"}) {
		t.Errorf("ops = %v", got)
	}

	// A refused send (4xx) cannot have gone out: its draft is deleted at once.
	h.graph.failSend = http.StatusBadRequest
	if err := Send(context.Background(), client, mailTo("sam@example.test", "o2@example.test"), []string{"sam@example.test"}, "marker-2"); err == nil {
		t.Fatal("the refused send reported success")
	}
	if got := h.graph.log(); !slices.Equal(got[2:], []string{"create draft-2", "delete draft-2"}) {
		t.Errorf("ops = %v", got)
	}
}

// Fails on the earlier code: a draft in the Outbox is on its way however old it looks.
func TestADraftInTheOutboxIsNotDecidedYet(t *testing.T) {
	h := newHarness(t)
	client := sendClient(h, h.syncer.opts.Client)
	h.graph.failSend = http.StatusGatewayTimeout
	_ = Send(context.Background(), client, mailTo("sam@example.test", "o1@example.test"), []string{"sam@example.test"}, providersend.OutgoingMarker("outgoing-1", "o1@example.test"))
	h.graph.mu.Lock()
	h.graph.messages["draft-1"].folder = "f-outbox"
	h.graph.mu.Unlock()
	h.graph.age("draft-1", time.Hour)

	found, err := OpenSent(context.Background(), client).SentBefore(api.OutgoingMessage{ID: "outgoing-1", MessageID: "o1@example.test", Recipients: []string{"sam@example.test"}}, nil, time.Now().Add(-2*time.Hour))
	if found || !errors.Is(err, providersend.ErrMaybeSending) {
		t.Errorf("SentBefore = %v, %v; want may still be sending", found, err)
	}
	if got := h.graph.log(); slices.Contains(got, "delete draft-1") {
		t.Errorf("a draft on its way was deleted: %v", got)
	}
}

// Fails on the earlier code: when marking failed and so did deleting the unmarked draft, the retry's Message-ID
// lookup (over the whole mailbox) took that draft for a sent copy, and the message was never sent.
func TestAnUnmarkedLeftoverDraftIsNotTakenForASentCopy(t *testing.T) {
	h := newHarness(t)
	client := sendClient(h, h.syncer.opts.Client)
	h.graph.failPatch, h.graph.failDelete = http.StatusBadGateway, http.StatusServiceUnavailable
	if err := Send(context.Background(), client, mailTo("sam@example.test", "o1@example.test"), []string{"sam@example.test"}, providersend.OutgoingMarker("outgoing-1", "o1@example.test")); err == nil {
		t.Fatal("a send whose draft could not be marked reported success")
	}
	message := api.OutgoingMessage{ID: "outgoing-1", MessageID: "o1@example.test", Recipients: []string{"sam@example.test"}}
	store := OpenSent(context.Background(), client)

	if found, err := store.SentBefore(message, nil, time.Now().Add(-time.Hour)); found || !errors.Is(err, providersend.ErrNotDecided) {
		t.Errorf("young leftover: SentBefore = %v, %v", found, err)
	}
	h.graph.age("draft-1", 20*time.Minute)
	if found, err := store.SentBefore(message, nil, time.Now().Add(-time.Hour)); found || err != nil {
		t.Errorf("old leftover: SentBefore = %v, %v; want not sent", found, err)
	}
	if got := h.graph.log(); !slices.Contains(got, "delete draft-1") {
		t.Errorf("the leftover draft stayed: %v", got)
	}
}

// Fails on the earlier code, which deleted the draft and failed the send when the marker was refused: a 4xx on the
// PATCH means Exchange does not take markers on MIME drafts, so the draft goes out unmarked, logged once per account.
func TestARefusedMarkerSendsUnmarked(t *testing.T) {
	h := newHarness(t)
	var logs bytes.Buffer
	opts := h.syncer.opts.Client
	opts.Logger = slog.New(slog.NewTextHandler(&logs, nil))
	opts.Account = "acc-refused-marker"
	client := sendClient(h, opts)
	for i, id := range []string{"o1", "o2"} {
		h.graph.failPatch = http.StatusBadRequest
		if err := Send(context.Background(), client, mailTo("sam@example.test", id+"@example.test"), []string{"sam@example.test"}, fmt.Sprintf("marker-%d", i)); err != nil {
			t.Fatal(err)
		}
	}

	want := []string{"create draft-1", "patch refused draft-1", "send draft-1", "create draft-2", "patch refused draft-2", "send draft-2"}
	if got := h.graph.log(); !slices.Equal(got, want) {
		t.Errorf("ops = %v\nwant %v", got, want)
	}
	if n := strings.Count(logs.String(), "refused the Tresso marker"); n != 1 {
		t.Errorf("logged %d times, want once: %s", n, logs.String())
	}
	// The unmarked copy is still found, by its Message-ID.
	found, err := OpenSent(context.Background(), client).SentBefore(api.OutgoingMessage{ID: "outgoing-1", MessageID: "o1@example.test", Recipients: []string{"sam@example.test"}}, nil, time.Now().Add(-time.Hour))
	if err != nil || !found {
		t.Errorf("SentBefore = %v, %v", found, err)
	}
}

// Fails on the earlier code: the header fallback stopped at 2000 Sent Items and called the question undecided.
func TestDuplicateFallbackReadsTheWholeWindow(t *testing.T) {
	h := newHarness(t)
	now := time.Now()
	for i := range 2100 {
		h.graph.addAt(fmt.Sprintf("busy-%d", i), "f-sent", now.Add(-time.Minute), mailTo("sam@example.test", fmt.Sprintf("busy-%d@example.test", i)))
	}
	store := OpenSent(context.Background(), sendClient(h, h.syncer.opts.Client))

	found, err := store.SentBefore(api.OutgoingMessage{ID: "outgoing-2", MessageID: "o2@example.test", Recipients: []string{"sam@example.test"}}, nil, now.Add(-time.Hour))
	if err != nil || found || h.graph.headerReads != 2100 {
		t.Errorf("SentBefore(never sent) = %v, %v after %d reads", found, err, h.graph.headerReads)
	}
}

// Fails on the earlier code: draft copies were found by Message-ID or by reading headers; the property filter needs
// no reads, also when Exchange replaced the Message-ID.
func TestDraftCopiesAreRemovedByTheirExtendedProperty(t *testing.T) {
	h := newHarness(t)
	h.graph.rewriteIDs = true
	drafts := OpenDrafts(context.Background(), sendClient(h, h.syncer.opts.Client))
	for _, n := range []string{"1", "2"} {
		if err := drafts.AppendDraft(mailTo("sam@example.test", "d1."+n+"@example.test"), time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	h.graph.headerReads = 0

	if err := drafts.Remove("d1.1@example.test"); err != nil {
		t.Fatal(err)
	}

	if got := h.graph.log(); !slices.Equal(got, []string{"create draft-1", "create draft-2", "delete draft-1"}) {
		t.Errorf("ops = %v", got)
	}
	if h.graph.headerReads != 0 {
		t.Errorf("%d drafts read; the property filter needs none", h.graph.headerReads)
	}
}

// runSessions starts n sessions in a row on one run's strikes, as Run does after each failed session, and returns the
// error of each. now is the clock of the strikes and the placeholders' retries (nil: the real one).
func (h *harness) runSessions(n int, strikes *isolate.Strikes, now func() time.Time) []error {
	if strikes == nil {
		strikes = isolate.NewStrikes()
	}
	var errs []error
	for range n {
		h.session = h.syncer.newSession(api.Account{ID: "acc"}, strikes, h.syncer.logger)
		h.session.ingest.Now = now
		err := h.session.refreshFolders(context.Background())
		if err == nil {
			err = h.session.step(context.Background(), true)
		}
		for err == nil && h.session.unstarted() {
			err = h.session.step(context.Background(), false)
		}
		errs = append(errs, err)
	}
	return errs
}

func TestAMessageGraphKeepsRefusingIsReplacedAndTheFolderMovesOn(t *testing.T) {
	h := newHarness(t)
	h.graph.add("m1", "f-inbox", 100, raw("m1"))
	h.graph.add("m2", "f-inbox", 200, raw("m2"))
	h.graph.add("m3", "f-inbox", 300, raw("m3"))
	// A 403 for one message's content is about that message, not the mailbox.
	h.graph.refuseRaw = map[string]fakeRefusal{"m2": {http.StatusForbidden, `{"error":{"code":"ErrorAccessDenied"}}`}}
	now := time.Now()
	clock := func() time.Time { return now }
	strikes := isolate.NewStrikesWithClock(clock)

	for i, err := range h.runSessions(isolate.StrikesBeforeSkip+1, strikes, clock) {
		if err == nil {
			t.Fatalf("session %d went through before m2 failed for an hour", i+1)
		}
	}
	now = now.Add(isolate.MinStrikeSpan)
	if errs := h.runSessions(1, strikes, clock); errs[0] != nil {
		t.Fatal(errs[0])
	}
	expectUIDs(t, h, "f-inbox", "m1", "m2", "m3")
	if msg, _ := h.api.Message("f-inbox", "m2"); !strings.HasPrefix(msg.Subject, ingestmsg.PlaceholderSubject) || !msg.ReceivedAt.Equal(time.Unix(200, 0).UTC()) {
		t.Errorf("m2 = %+v, want a placeholder with the message's own date", msg)
	}
	if !h.cursor(t, "f-inbox").BackfillDone {
		t.Error("the inbox backfill did not finish after the refused message")
	}
	if strings.Contains(h.api.StatusLog(), api.StatusAuthFailed) {
		t.Errorf("statuses %q", h.api.StatusLog())
	}

	// Once Graph hands it over, the real message takes the placeholder's place.
	h.graph.mu.Lock()
	h.graph.refuseRaw = nil
	h.graph.mu.Unlock()
	now = now.Add(isolate.RetryFirst)
	if errs := h.runSessions(1, strikes, clock); errs[0] != nil {
		t.Fatal(errs[0])
	}
	if msg, _ := h.api.Message("f-inbox", "m2"); msg.Subject != "Message m2" {
		t.Errorf("m2 = %q; want the real message", msg.Subject)
	}
}

func TestAGraphOutageReplacesNoMessage(t *testing.T) {
	h := newHarness(t)
	h.graph.add("m1", "f-inbox", 100, raw("m1"))
	h.graph.add("m2", "f-inbox", 200, raw("m2"))
	failing := `{"error":{"code":"ErrorInternalServerError"}}`
	h.graph.refuseRaw = map[string]fakeRefusal{"m1": {http.StatusInternalServerError, failing}, "m2": {http.StatusInternalServerError, failing}}

	now := time.Now()
	clock := func() time.Time { return now }
	strikes := isolate.NewStrikesWithClock(clock)
	for i := range isolate.StrikesBeforeSkip + 2 {
		now = now.Add(isolate.MinStrikeSpan)
		if errs := h.runSessions(1, strikes, clock); errs[0] == nil {
			t.Errorf("session %d went through while Graph failed every download", i+1)
		}
	}
	for _, id := range []string{"m1", "m2"} {
		if msg, ok := h.api.Message("f-inbox", id); ok {
			t.Errorf("%s was stored as %+v while Graph failed every download", id, msg)
		}
	}
}

func TestAFolderOrMessageGraphDeniesIsSkippedNotTakenForTheMailbox(t *testing.T) {
	h := newHarness(t)
	h.graph.add("m1", "f-inbox", 100, raw("m1"))
	h.graph.add("m2", "f-inbox", 200, raw("m2"))
	h.graph.add("m3", "f-inbox", 300, raw("m3"))
	h.graph.add("n1", "f-notes", 100, raw("n1"))
	h.graph.add("a1", "f-acme", 100, raw("a1"))
	h.graph.deniedFolders = map[string]bool{"f-proj": true, "f-notes": true}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.syncer.Run(ctx, api.Account{ID: "acc"}) }()
	defer func() {
		cancel()
		<-done
	}()

	deadline := time.Now().Add(10 * time.Second)
	for !slices.Equal(h.api.UIDs("f-inbox"), []string{"m1", "m2", "m3"}) {
		if time.Now().After(deadline) {
			t.Fatalf("inbox holds %v, statuses %q", h.api.UIDs("f-inbox"), h.api.StatusLog())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if strings.Contains(h.api.StatusLog(), api.StatusAuthFailed) {
		t.Errorf("statuses = %q; a denied folder or message is not a mailbox Tresso may not read", h.api.StatusLog())
	}
	for _, f := range h.api.ReportedFolders() {
		if f.RemoteName == "f-acme" {
			t.Error("a folder below a folder whose children Graph refused was listed")
		}
	}
	if got := h.api.UIDs("f-notes"); len(got) != 0 {
		t.Errorf("notes holds %v", got)
	}
}

func TestTheInboxIsIngestedBeforeTheOtherFoldersAreWalked(t *testing.T) {
	h := newHarness(t)
	h.graph.add("m1", "f-inbox", 100, raw("m1"))
	h.graph.add("p1", "f-proj", 100, raw("p1"))
	h.session = h.syncer.newSession(api.Account{ID: "acc"}, isolate.NewStrikes(), h.syncer.logger)
	if err := h.session.refreshFolders(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := h.session.step(context.Background(), true); err != nil {
		t.Fatal(err)
	}

	expectUIDs(t, h, "f-inbox", "m1")
	for _, query := range h.graph.paths() {
		if strings.Contains(query, "f-proj/messages/delta") {
			t.Fatalf("the Projects folder was walked in the first step: %v", h.graph.paths())
		}
	}
	for h.session.unstarted() {
		if err := h.session.step(context.Background(), false); err != nil {
			t.Fatal(err)
		}
	}
	expectUIDs(t, h, "f-proj", "p1")
}

func TestAnInterruptedFirstDeltaWalkResumesWhereItStopped(t *testing.T) {
	h := newHarness(t)
	// Two messages per delta page: the walk has 2*startCheckpointPages+3 pages and breaks after the second checkpoint.
	for i := range 4*startCheckpointPages + 5 {
		h.graph.add(fmt.Sprintf("m%02d", i), "f-inbox", 100+i, raw(fmt.Sprintf("m%02d", i)))
	}
	h.graph.failDeltaFolder, h.graph.failDeltaRequest = "f-inbox", 2*startCheckpointPages+2
	h.session = h.syncer.newSession(api.Account{ID: "acc"}, isolate.NewStrikes(), h.syncer.logger)
	if err := h.session.refreshFolders(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := h.session.step(context.Background(), true); err == nil {
		t.Fatal("the walk did not break")
	}
	stored := h.api.Cursor("f-inbox")
	cursor, err := DecodeCursor(&stored)
	if err != nil || cursor == nil || cursor.Started() || cursor.StartLink == "" {
		t.Fatalf("stored cursor %q: %v", stored, err)
	}

	before := h.graph.deltaPages("f-inbox")
	h.start(t)
	// The rest of the walk (3 pages) and the first round's poll (1 page), not the 23 pages from the start.
	if walked := h.graph.deltaPages("f-inbox") - before; walked > 5 {
		t.Errorf("the resumed session read %d delta pages of the inbox", walked)
	}
	for range 10 {
		if h.cursor(t, "f-inbox").BackfillDone {
			break
		}
		if err := h.session.step(context.Background(), false); err != nil {
			t.Fatal(err)
		}
	}
	if !h.cursor(t, "f-inbox").Started() || len(h.api.UIDs("f-inbox")) != 4*startCheckpointPages+5 {
		t.Errorf("inbox holds %d messages, cursor %+v", len(h.api.UIDs("f-inbox")), h.cursor(t, "f-inbox"))
	}
}
