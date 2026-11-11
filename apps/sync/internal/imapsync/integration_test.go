//go:build integration

// Integration tests against a real IMAP server (GreenMail). Run with:
//
//	GREENMAIL_HOST=localhost go test -tags integration ./internal/imapsync
//
// The mailbox kim@tresso.test is emptied at the start of every test.
package imapsync

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"

	"tresso/sync/internal/api"
	"tresso/sync/internal/blobcrypt"
	"tresso/sync/internal/netguard"
	"tresso/sync/internal/storage/storagetest"
)

const (
	testUser     = "kim@tresso.test"
	testPassword = "dev-password-kim"
)

func greenmail(t *testing.T) (string, int) {
	t.Helper()
	host := os.Getenv("GREENMAIL_HOST")
	if host == "" {
		t.Skip("GREENMAIL_HOST is not set")
	}
	port := 3143
	if p := os.Getenv("GREENMAIL_IMAP_PORT"); p != "" {
		port, _ = strconv.Atoi(p)
	}
	return host, port
}

// fakeAPI follows the API's ingest rules closely enough to test the syncer: cursors per folder, messages per
// (folder, uid), presence ranges remove what is not listed.
type fakeAPI struct {
	mu       sync.Mutex
	server   api.ServerSettings
	password string
	cursors  map[string]*string
	uidValid map[string]uint32
	messages map[string]map[string]api.Message // folder -> uid -> message
	flags    map[string]map[string]api.Flags
	statuses []string
	folders  []api.Folder
}

func newFakeAPI(host string, port int, password string) *fakeAPI {
	return &fakeAPI{
		server:   api.ServerSettings{Host: host, Port: port, Security: "none"},
		password: password,
		cursors:  map[string]*string{},
		uidValid: map[string]uint32{},
		messages: map[string]map[string]api.Message{},
		flags:    map[string]map[string]api.Flags{},
	}
}

func (f *fakeAPI) Credentials(context.Context, string, string) (api.Credentials, error) {
	return api.Credentials{
		AccountID: "acc", Provider: "imap",
		Connection: api.Connection{IMAP: f.server, Username: testUser},
		Secrets:    map[string]string{"type": "password", "password": f.password},
	}, nil
}

func (f *fakeAPI) Folders(_ context.Context, _, _ string, folders []api.Folder) ([]api.FolderState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.folders = folders
	states := make([]api.FolderState, 0, len(folders))
	for _, folder := range folders {
		reset := false
		if old, ok := f.uidValid[folder.RemoteName]; ok && folder.UIDValidity != nil && old != *folder.UIDValidity {
			reset = true
			f.cursors[folder.RemoteName] = nil
			delete(f.messages, folder.RemoteName)
		}
		if folder.UIDValidity != nil {
			f.uidValid[folder.RemoteName] = *folder.UIDValidity
		}
		states = append(states, api.FolderState{RemoteName: folder.RemoteName, UIDValidity: folder.UIDValidity, Cursor: f.cursors[folder.RemoteName], Reset: reset})
	}
	return states, nil
}

func (f *fakeAPI) Messages(_ context.Context, _ string, batch api.MessageBatch) (api.MessageBatchResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.messages[batch.Folder] == nil {
		f.messages[batch.Folder] = map[string]api.Message{}
		f.flags[batch.Folder] = map[string]api.Flags{}
	}
	var result api.MessageBatchResult
	for _, m := range batch.Messages {
		if _, ok := f.messages[batch.Folder][m.RemoteUID]; ok {
			result.Updated++
		} else {
			result.Stored++
		}
		f.messages[batch.Folder][m.RemoteUID] = m
		f.flags[batch.Folder][m.RemoteUID] = m.Flags
	}
	if batch.Cursor != nil {
		f.cursors[batch.Folder] = batch.Cursor
	}
	return result, nil
}

func (f *fakeAPI) Changes(_ context.Context, _ string, batch api.ChangeBatch) (api.ChangeBatchResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var result api.ChangeBatchResult
	for _, change := range batch.Flags {
		if _, ok := f.messages[batch.Folder][change.RemoteUID]; !ok {
			result.Unknown++
			continue
		}
		f.flags[batch.Folder][change.RemoteUID] = change.Flags
		result.Updated++
	}
	for _, r := range batch.Presence {
		present := map[uint32]bool{}
		for _, uid := range r.UIDs {
			present[uid] = true
		}
		for key := range f.messages[batch.Folder] {
			uid, _ := strconv.ParseUint(key, 10, 32)
			if uint32(uid) >= r.FromUID && uint32(uid) <= r.ToUID && !present[uint32(uid)] {
				delete(f.messages[batch.Folder], key)
				result.Removed++
			}
		}
	}
	if batch.Cursor != nil {
		f.cursors[batch.Folder] = batch.Cursor
	}
	return result, nil
}

func (f *fakeAPI) Status(_ context.Context, _, _, status, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.statuses = append(f.statuses, status)
	return nil
}

func (f *fakeAPI) count(folder string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.messages[folder])
}

func (f *fakeAPI) bySubject(folder, subject string) (api.Message, api.Flags, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for uid, m := range f.messages[folder] {
		if m.Subject == subject {
			return m, f.flags[folder][uid], true
		}
	}
	return api.Message{}, api.Flags{}, false
}

func (f *fakeAPI) cursor(folder string) *Cursor {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, _ := DecodeCursor(f.cursors[folder])
	return c
}

func (f *fakeAPI) hasStatus(status string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, s := range f.statuses {
		if s == status {
			return true
		}
	}
	return false
}

// admin is a second IMAP connection that plays the outside world: delivering, flagging and deleting mail.
type admin struct {
	t *testing.T
	c *imapclient.Client
}

func newAdmin(t *testing.T, host string, port int) *admin {
	t.Helper()
	c, err := imapclient.DialInsecure(net.JoinHostPort(host, strconv.Itoa(port)), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Login(testUser, testPassword).Wait(); err != nil {
		t.Fatal(err)
	}
	a := &admin{t: t, c: c}
	a.reset()
	t.Cleanup(func() { _ = c.Logout().Wait(); _ = c.Close() })
	return a
}

// reset empties INBOX and removes every other folder.
func (a *admin) reset() {
	mailboxes, err := a.c.List("", "*", nil).Collect()
	if err != nil {
		a.t.Fatal(err)
	}
	for _, m := range mailboxes {
		if strings.EqualFold(m.Mailbox, "INBOX") {
			continue
		}
		_ = a.c.Delete(m.Mailbox).Wait()
	}
	a.deleteWhere("INBOX", &imap.SearchCriteria{})
}

func (a *admin) createFolder(name string) {
	if err := a.c.Create(name, nil).Wait(); err != nil {
		a.t.Fatal(err)
	}
}

func (a *admin) deliver(folder, raw string, flags ...imap.Flag) {
	data := []byte(strings.ReplaceAll(strings.TrimLeft(raw, "\n"), "\n", "\r\n"))
	cmd := a.c.Append(folder, int64(len(data)), &imap.AppendOptions{Flags: flags, Time: time.Now()})
	if _, err := io.Copy(cmd, bytes.NewReader(data)); err != nil {
		a.t.Fatal(err)
	}
	if err := cmd.Close(); err != nil {
		a.t.Fatal(err)
	}
	if _, err := cmd.Wait(); err != nil {
		a.t.Fatal(err)
	}
}

func (a *admin) searchSubject(folder, subject string) imap.UIDSet {
	if _, err := a.c.Select(folder, nil).Wait(); err != nil {
		a.t.Fatal(err)
	}
	data, err := a.c.UIDSearch(&imap.SearchCriteria{Header: []imap.SearchCriteriaHeaderField{{Key: "Subject", Value: subject}}}, nil).Wait()
	if err != nil {
		a.t.Fatal(err)
	}
	return imap.UIDSetNum(data.AllUIDs()...)
}

func (a *admin) markSeen(folder, subject string) {
	uids := a.searchSubject(folder, subject)
	if err := a.c.Store(uids, &imap.StoreFlags{Op: imap.StoreFlagsAdd, Flags: []imap.Flag{imap.FlagSeen}, Silent: true}, nil).Close(); err != nil {
		a.t.Fatal(err)
	}
}

func (a *admin) deleteSubject(folder, subject string) {
	a.deleteWhere(folder, &imap.SearchCriteria{Header: []imap.SearchCriteriaHeaderField{{Key: "Subject", Value: subject}}})
}

func (a *admin) deleteWhere(folder string, criteria *imap.SearchCriteria) {
	if _, err := a.c.Select(folder, nil).Wait(); err != nil {
		a.t.Fatal(err)
	}
	data, err := a.c.UIDSearch(criteria, nil).Wait()
	if err != nil {
		a.t.Fatal(err)
	}
	if len(data.AllUIDs()) == 0 {
		return
	}
	if err := a.c.Store(imap.UIDSetNum(data.AllUIDs()...), &imap.StoreFlags{Op: imap.StoreFlagsAdd, Flags: []imap.Flag{imap.FlagDeleted}, Silent: true}, nil).Close(); err != nil {
		a.t.Fatal(err)
	}
	if err := a.c.Expunge().Close(); err != nil {
		a.t.Fatal(err)
	}
}

func mail(id, subject, extraHeaders, body string) string {
	headers := fmt.Sprintf("From: Anna de Vries <anna@finance.example>\nTo: kim@tresso.test\nSubject: %s\nMessage-ID: <%s>\nDate: Mon, 19 Oct 2026 09:00:00 +0000", subject, id)
	if extraHeaders != "" {
		headers += "\n" + extraHeaders
	}
	return headers + "\n\n" + body + "\n"
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", what)
}

func testOptions() Options {
	o := DefaultOptions()
	o.FetchBatch = 2 // several batches even for a handful of messages
	o.BackfillBatchesPerPass = 1
	o.PollInterval = time.Second
	o.PresenceInterval = time.Second
	o.UpdatePresenceInterval = 0
	o.StatusInterval = time.Second
	o.MinBackoff = 100 * time.Millisecond
	// A wrong password must end the run within the test, not after the ten minutes a live account waits.
	o.RefusalSpan, o.RefusalWait = 0, 0
	return o
}

func TestSyncsMailboxFollowsNewMailFlagsAndDeletions(t *testing.T) {
	host, port := greenmail(t)
	admin := newAdmin(t, host, port)

	admin.createFolder("Projects")
	admin.deliver("INBOX", mail("root@x", "Offsite", "", "Shall we plan the offsite?"))
	admin.deliver("INBOX", mail("reply@x", "Re: Offsite", "In-Reply-To: <root@x>\nReferences: <root@x>", "Yes, in March."), imap.FlagSeen)
	admin.deliver("INBOX", mail("invoice@x", "Invoice", "MIME-Version: 1.0\nContent-Type: multipart/mixed; boundary=\"b\"",
		"--b\nContent-Type: text/plain\n\nInvoice attached.\n--b\nContent-Type: application/pdf\nContent-Disposition: attachment; filename=\"invoice.pdf\"\nContent-Transfer-Encoding: base64\n\nJVBERi0xLjQK\n--b--"))
	for i := range 3 {
		admin.deliver("INBOX", mail(fmt.Sprintf("old-%d@x", i), fmt.Sprintf("Old %d", i), "", "history"))
	}
	admin.deliver("Projects", mail("project@x", "Project kickoff", "", "Kickoff on Monday."))

	fake := newFakeAPI(host, port, testPassword)
	store := storagetest.New()
	syncer := New(fake, store, netguard.New(true), "test-worker", testOptions(), slog.New(slog.NewTextHandler(io.Discard, nil)))

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- syncer.Run(ctx, api.Account{ID: "acc", Provider: "imap"}) }()
	t.Cleanup(func() {
		cancel()
		<-done
	})

	eventually(t, "initial sync of 6 inbox messages and 1 project message", func() bool {
		return fake.count("INBOX") == 6 && fake.count("Projects") == 1
	})
	eventually(t, "backfill complete", func() bool {
		c := fake.cursor("INBOX")
		return c != nil && c.BackfillDone()
	})
	if !fake.hasStatus(api.StatusActive) {
		t.Error("the account was not reported active")
	}

	reply, replyFlags, _ := fake.bySubject("INBOX", "Re: Offsite")
	if reply.InReplyTo == nil || *reply.InReplyTo != "root@x" || len(reply.References) != 1 || !replyFlags.Seen {
		t.Errorf("reply = %+v flags %+v", reply, replyFlags)
	}
	invoice, _, _ := fake.bySubject("INBOX", "Invoice")
	if len(invoice.Attachments) != 1 || invoice.Attachments[0].Filename != "invoice.pdf" || invoice.Snippet != "Invoice attached." || invoice.BodyText != "Invoice attached." {
		t.Errorf("invoice = %+v", invoice)
	}
	if raw := store.Plaintext(invoice.RawObjectKey); !strings.Contains(string(raw), "Invoice attached.") {
		t.Error("raw message not stored")
	}
	if len(invoice.Attachments) == 1 {
		if pdf := store.Plaintext(blobcrypt.Key(blobcrypt.KindAttachments, storagetest.OwnerID, invoice.Attachments[0].Fingerprint)); !strings.HasPrefix(string(pdf), "%PDF") {
			t.Error("attachment not stored")
		}
	}
	for _, f := range fake.folders {
		if f.RemoteName == "INBOX" && f.Role != "inbox" {
			t.Errorf("INBOX role = %q", f.Role)
		}
	}

	admin.deliver("INBOX", mail("new@x", "Fresh news", "", "Just arrived."))
	eventually(t, "new mail picked up", func() bool { return fake.count("INBOX") == 7 })

	admin.markSeen("INBOX", "Offsite")
	eventually(t, "flag change", func() bool {
		_, flags, ok := fake.bySubject("INBOX", "Offsite")
		return ok && flags.Seen
	})

	admin.deleteSubject("INBOX", "Old 1")
	eventually(t, "deletion detected", func() bool {
		_, _, exists := fake.bySubject("INBOX", "Old 1")
		return !exists && fake.count("INBOX") == 6
	})
}

// With long poll and presence intervals, only IDLE notifications can explain fast updates: this proves the worker
// reacts to the server instead of polling, and that a notification inside the throttle window is not lost.
func TestIdleNotificationsDriveUpdatesWithoutPolling(t *testing.T) {
	host, port := greenmail(t)
	admin := newAdmin(t, host, port)
	admin.deliver("INBOX", mail("a@x", "First", "", "one"))

	opts := testOptions()
	opts.PollInterval = time.Hour
	opts.PresenceInterval = time.Hour
	opts.UpdatePresenceInterval = 2 * time.Second
	fake := newFakeAPI(host, port, testPassword)
	syncer := New(fake, storagetest.New(), netguard.New(true), "test-worker", opts, slog.New(slog.NewTextHandler(io.Discard, nil)))

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- syncer.Run(ctx, api.Account{ID: "acc", Provider: "imap"}) }()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	eventually(t, "initial sync", func() bool { return fake.count("INBOX") == 1 })

	admin.deliver("INBOX", mail("b@x", "Second", "", "two"))
	eventually(t, "new mail via IDLE", func() bool { return fake.count("INBOX") == 2 })

	// Right after the previous check: this deletion falls inside the throttle window and must still arrive.
	admin.deleteSubject("INBOX", "First")
	eventually(t, "deletion via IDLE after the throttle window", func() bool {
		_, _, exists := fake.bySubject("INBOX", "First")
		return !exists
	})
}

func TestRefusedLoginIsReportedAndStops(t *testing.T) {
	host, port := greenmail(t)
	fake := newFakeAPI(host, port, "wrong-password")
	syncer := New(fake, storagetest.New(), netguard.New(true), "test-worker", testOptions(), slog.New(slog.NewTextHandler(io.Discard, nil)))

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := syncer.Run(ctx, api.Account{ID: "acc", Provider: "imap"}); err != nil {
		t.Fatal(err)
	}
	if ctx.Err() != nil {
		t.Fatal("Run kept retrying after a refused login")
	}
	if !fake.hasStatus(api.StatusAuthFailed) {
		t.Errorf("statuses = %v, want auth_failed", fake.statuses)
	}
}

func TestPrivateServerIsBlockedWithoutAllowUnsafe(t *testing.T) {
	host, port := greenmail(t)
	fake := newFakeAPI(host, port, testPassword)
	opts := testOptions()
	opts.FailuresBeforeError = 1
	syncer := New(fake, storagetest.New(), netguard.New(false), "test-worker", opts, slog.New(slog.NewTextHandler(io.Discard, nil)))

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = syncer.Run(ctx, api.Account{ID: "acc", Provider: "imap"})

	if !fake.hasStatus(api.StatusError) || fake.count("INBOX") != 0 {
		t.Errorf("statuses = %v, messages = %d; the private server must be refused", fake.statuses, fake.count("INBOX"))
	}
}
