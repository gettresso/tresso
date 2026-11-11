package imapsync

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
	"github.com/emersion/go-imap/v2/imapserver/imapmemserver"

	"tresso/sync/internal/api"
	"tresso/sync/internal/ingestmsg"
	"tresso/sync/internal/isolate"
	"tresso/sync/internal/storage/storagetest"
)

// script makes the in-memory server misbehave the way real servers do: refuse logins, folders or fetches.
type script struct {
	mu         sync.Mutex
	loginTimes []time.Time
	logins     int
	login      func(attempt int) error
	selectErr  map[string]error
	statusErr  map[string]error
	// noUIDNext leaves UIDNEXT out of SELECT answers (it is sent as 0), as RFC 3501 allows.
	noUIDNext bool
	// fetch, when set, can refuse a FETCH (an *imap.Error) or have it answered without the body (noBody).
	fetch func(uids []imap.UID) (err error, noBody bool)
}

func (s *script) loginErr() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.logins++
	s.loginTimes = append(s.loginTimes, time.Now())
	if s.login == nil {
		return nil
	}
	return s.login(s.logins)
}

func (s *script) loginCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.logins
}

type scriptedSession struct {
	imapserver.Session
	script *script
}

func (s *scriptedSession) Login(username, password string) error {
	if err := s.script.loginErr(); err != nil {
		return err
	}
	return s.Session.Login(username, password)
}

func (s *scriptedSession) Select(name string, options *imap.SelectOptions) (*imap.SelectData, error) {
	s.script.mu.Lock()
	err := s.script.selectErr[name]
	noUIDNext := s.script.noUIDNext
	s.script.mu.Unlock()
	if err != nil {
		return nil, err
	}
	data, err := s.Session.Select(name, options)
	if err == nil && noUIDNext {
		data.UIDNext = 0
	}
	return data, err
}

func (s *scriptedSession) Fetch(w *imapserver.FetchWriter, numSet imap.NumSet, options *imap.FetchOptions) error {
	s.script.mu.Lock()
	hook := s.script.fetch
	s.script.mu.Unlock()
	if set, ok := numSet.(imap.UIDSet); ok && hook != nil && len(options.BodySection) > 0 {
		uids, _ := set.Nums()
		err, noBody := hook(uids)
		if err != nil {
			return err
		}
		if noBody {
			stripped := *options
			stripped.BodySection = nil
			options = &stripped
		}
	}
	return s.Session.Fetch(w, numSet, options)
}

func (s *scriptedSession) Status(name string, options *imap.StatusOptions) (*imap.StatusData, error) {
	s.script.mu.Lock()
	err := s.script.statusErr[name]
	s.script.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return s.Session.Status(name, options)
}

// scriptedServer runs an in-memory IMAP server for kim with the given folders, misbehaving as sc says.
func scriptedServer(t *testing.T, sc *script, folders ...string) (api.Credentials, *imapmemserver.User) {
	t.Helper()
	memory := imapmemserver.New()
	user := imapmemserver.NewUser("kim", "secret")
	for _, name := range folders {
		if err := user.Create(name, nil); err != nil {
			t.Fatal(err)
		}
	}
	memory.AddUser(user)
	server := imapserver.New(&imapserver.Options{
		NewSession: func(*imapserver.Conn) (imapserver.Session, *imapserver.GreetingData, error) {
			return &scriptedSession{Session: memory.NewSession(), script: sc}, nil, nil
		},
		Caps:         imap.CapSet{imap.CapIMAP4rev1: {}},
		InsecureAuth: true,
	})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	return api.Credentials{
		AccountID:  "acc",
		Provider:   "imap",
		Connection: api.Connection{IMAP: api.ServerSettings{Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, Security: "none"}, Username: "kim"},
		Secrets:    map[string]string{"type": "password", "password": "secret"},
	}, user
}

func deliver(t *testing.T, user *imapmemserver.User, folder, messageID, subject string) {
	t.Helper()
	deliverAt(t, user, folder, messageID, subject, time.Now())
}

func deliverAt(t *testing.T, user *imapmemserver.User, folder, messageID, subject string, at time.Time) {
	t.Helper()
	raw := "From: anna@finance.example\r\nTo: kim@company.example\r\nSubject: " + subject + "\r\nMessage-ID: <" + messageID + ">\r\n\r\nHello.\r\n"
	if _, err := user.Append(folder, literal(raw), &imap.AppendOptions{Time: at}); err != nil {
		t.Fatal(err)
	}
}

type literalReader struct {
	io.Reader
	size int64
}

func (l literalReader) Size() int64 { return l.size }

func literal(s string) imap.LiteralReader {
	return literalReader{Reader: strings.NewReader(s), size: int64(len(s))}
}

// memAPI is the ingest API for these tests: messages per folder and uid, cursors, statuses. refuse can fail a batch.
type memAPI struct {
	mu          sync.Mutex
	credentials api.Credentials
	folders     []api.Folder
	cursors     map[string]*string
	messages    map[string]map[string]api.Message
	statuses    []string
	details     []string
	refuse      func(batch api.MessageBatch) error
	// credentialsErr can fail the credentials call of a session; statusFailures fails that many status reports.
	credentialsErr func() error
	statusFailures int
	calls          int
}

func newMemAPI(credentials api.Credentials) *memAPI {
	return &memAPI{credentials: credentials, cursors: map[string]*string{}, messages: map[string]map[string]api.Message{}}
}

func (m *memAPI) Credentials(context.Context, string, string) (api.Credentials, error) {
	m.mu.Lock()
	hook := m.credentialsErr
	m.mu.Unlock()
	if hook != nil {
		if err := hook(); err != nil {
			return api.Credentials{}, err
		}
	}
	return m.credentials, nil
}

func (m *memAPI) Folders(_ context.Context, _, _ string, folders []api.Folder) ([]api.FolderState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.folders = folders
	states := make([]api.FolderState, 0, len(folders))
	for _, f := range folders {
		states = append(states, api.FolderState{RemoteName: f.RemoteName, UIDValidity: f.UIDValidity, Cursor: m.cursors[f.RemoteName]})
	}
	return states, nil
}

func (m *memAPI) Messages(_ context.Context, _ string, batch api.MessageBatch) (api.MessageBatchResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls++
	if m.refuse != nil {
		if err := m.refuse(batch); err != nil {
			return api.MessageBatchResult{}, err
		}
	}
	if m.messages[batch.Folder] == nil {
		m.messages[batch.Folder] = map[string]api.Message{}
	}
	for _, msg := range batch.Messages {
		m.messages[batch.Folder][msg.RemoteUID] = msg
	}
	if batch.Cursor != nil {
		m.cursors[batch.Folder] = batch.Cursor
	}
	return api.MessageBatchResult{Stored: len(batch.Messages)}, nil
}

func (m *memAPI) Changes(_ context.Context, _ string, batch api.ChangeBatch) (api.ChangeBatchResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, uid := range batch.Vanished {
		delete(m.messages[batch.Folder], uid)
	}
	if batch.Cursor != nil {
		m.cursors[batch.Folder] = batch.Cursor
	}
	return api.ChangeBatchResult{}, nil
}

func (m *memAPI) Status(_ context.Context, _, _, status, detail string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.statusFailures > 0 {
		m.statusFailures--
		return &api.HTTPError{Method: http.MethodPost, Path: "/status", Status: http.StatusServiceUnavailable}
	}
	m.statuses = append(m.statuses, status)
	m.details = append(m.details, detail)
	return nil
}

func (m *memAPI) message(folder, uid string) (api.Message, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	msg, ok := m.messages[folder][uid]
	return msg, ok
}

func (m *memAPI) statusLog() ([]string, []string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return slices.Clone(m.statuses), slices.Clone(m.details)
}

func (m *memAPI) count(folder string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.messages[folder])
}

func (m *memAPI) hasStatus(status string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return slices.Contains(m.statuses, status)
}

func (m *memAPI) cursor(folder string) *Cursor {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, _ := DecodeCursor(m.cursors[folder])
	return c
}

func (m *memAPI) folderNames() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var names []string
	for _, f := range m.folders {
		names = append(names, f.RemoteName)
	}
	return names
}

func fastOptions() Options {
	o := DefaultOptions()
	o.PollInterval = 200 * time.Millisecond
	o.PresenceInterval = time.Hour
	o.StatusInterval = time.Hour
	o.MinBackoff = 10 * time.Millisecond
	o.MaxBackoff = 20 * time.Millisecond
	o.RefusalSpan, o.RefusalWait = 0, 0
	return o
}

// runSyncer runs the syncer until the test ends and returns a channel that is closed when Run returned.
func runSyncer(t *testing.T, fake *memAPI, opts Options) <-chan struct{} {
	t.Helper()
	return runSyncerAt(t, fake, opts, nil)
}

// testClock is a clock the test moves forward, for the strikes and the placeholders' retries.
type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func newTestClock() *testClock { return &testClock{now: time.Now()} }

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *testClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// runSyncerAt is runSyncer with the clock clk (nil: the real one).
func runSyncerAt(t *testing.T, fake *memAPI, opts Options, clk *testClock) <-chan struct{} {
	t.Helper()
	syncer := New(fake, storagetest.New(), plainDialer{}, "test-worker", opts, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if clk != nil {
		syncer.now = clk.Now
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = syncer.Run(ctx, api.Account{ID: "acc", Provider: "imap"})
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return done
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", what)
}

func TestATemporaryLoginRefusalIsRetriedNotReportedAsAWrongPassword(t *testing.T) {
	for _, code := range []imap.ResponseCode{imap.ResponseCodeUnavailable, imap.ResponseCodeInUse, imap.ResponseCodeLimit, imap.ResponseCodeServerBug, imap.ResponseCodeContactAdmin} {
		t.Run(string(code), func(t *testing.T) {
			sc := &script{login: func(attempt int) error {
				if attempt <= 6 {
					return &imap.Error{Type: imap.StatusResponseTypeNo, Code: code, Text: "Temporary authentication failure"}
				}
				return nil
			}}
			credentials, user := scriptedServer(t, sc, "INBOX")
			deliver(t, user, "INBOX", "a@x", "First")
			fake := newMemAPI(credentials)

			runSyncer(t, fake, fastOptions())
			waitFor(t, "the inbox synced after the server let the login in", func() bool { return fake.count("INBOX") == 1 })
			if fake.hasStatus(api.StatusAuthFailed) {
				t.Errorf("a NO [%s] to LOGIN was reported as auth_failed", code)
			}
		})
	}
}

func TestARefusedPasswordStopsTheAccountAtOnce(t *testing.T) {
	for _, code := range []imap.ResponseCode{imap.ResponseCodeAuthenticationFailed, imap.ResponseCodeAuthorizationFailed, imap.ResponseCodeExpired} {
		t.Run(string(code), func(t *testing.T) {
			sc := &script{login: func(int) error {
				return &imap.Error{Type: imap.StatusResponseTypeNo, Code: code, Text: "Invalid credentials"}
			}}
			credentials, _ := scriptedServer(t, sc, "INBOX")
			fake := newMemAPI(credentials)

			done := runSyncer(t, fake, fastOptions())
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("Run kept retrying after a refused password")
			}
			if !fake.hasStatus(api.StatusAuthFailed) || sc.loginCount() != 1 {
				t.Errorf("statuses %v after %d logins, want auth_failed after 1", fake.statuses, sc.loginCount())
			}
		})
	}
}

func TestALoginRefusedWithoutACodeIsAWrongPasswordOnceItRepeats(t *testing.T) {
	sc := &script{login: func(int) error {
		return &imap.Error{Type: imap.StatusResponseTypeNo, Text: "LOGIN failed."}
	}}
	credentials, _ := scriptedServer(t, sc, "INBOX")
	fake := newMemAPI(credentials)
	opts := fastOptions()
	opts.RefusalsBeforeAuthFailed = 4

	done := runSyncer(t, fake, opts)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run kept retrying a login the server keeps refusing")
	}
	if !fake.hasStatus(api.StatusAuthFailed) || sc.loginCount() != 4 {
		t.Errorf("statuses %v after %d logins, want auth_failed after 4", fake.statuses, sc.loginCount())
	}
}

func TestLoginErrorClassification(t *testing.T) {
	no := func(code imap.ResponseCode) error {
		return &imap.Error{Type: imap.StatusResponseTypeNo, Code: code, Text: "text"}
	}
	cases := []struct {
		err  error
		want error
	}{
		{no(imap.ResponseCodeAuthenticationFailed), ErrAuth},
		{no(""), errLoginRefused},
		{no(imap.ResponseCodePrivacyRequired), errLoginDisabled},
		{no(imap.ResponseCodeUnavailable), nil},
		{&imap.Error{Type: imap.StatusResponseTypeBad, Text: "syntax"}, nil},
	}
	for _, c := range cases {
		got := loginError(c.err)
		for _, sentinel := range []error{ErrAuth, errLoginRefused, errLoginDisabled} {
			if errors.Is(got, sentinel) != (sentinel == c.want) {
				t.Errorf("loginError(%v) = %v, want %v", c.err, got, c.want)
			}
		}
	}
}

func refuseUID(uid string, status int) func(api.MessageBatch) error {
	return func(batch api.MessageBatch) error {
		for _, msg := range batch.Messages {
			if msg.RemoteUID == uid && !ingestmsg.IsPlaceholder(msg) {
				return &api.HTTPError{Method: http.MethodPost, Path: "/messages", Status: status, Body: "refused"}
			}
		}
		return nil
	}
}

func TestAMessageTheAPIRefusesIsReplacedAndTheFolderMovesOn(t *testing.T) {
	credentials, user := scriptedServer(t, &script{}, "INBOX")
	for _, id := range []string{"a@x", "b@x", "c@x"} {
		deliver(t, user, "INBOX", id, "Message "+id)
	}
	fake := newMemAPI(credentials)
	fake.refuse = refuseUID("2", http.StatusUnprocessableEntity)

	runSyncer(t, fake, fastOptions())
	waitFor(t, "the folder's backfill finished", func() bool {
		c := fake.cursor("INBOX")
		return c != nil && c.BackfillDone() && fake.count("INBOX") == 3
	})
	if msg, _ := fake.message("INBOX", "2"); !ingestmsg.IsPlaceholder(msg) || msg.RawObjectKey == "" {
		t.Errorf("uid 2 = %+v, want a placeholder that keeps the raw message", msg)
	}
	for _, uid := range []string{"1", "3"} {
		if msg, _ := fake.message("INBOX", uid); ingestmsg.IsPlaceholder(msg) || msg.Subject == "" {
			t.Errorf("uid %s = %+v, want the message itself", uid, msg)
		}
	}

	deliver(t, user, "INBOX", "d@x", "Later")
	waitFor(t, "new mail after the refused message", func() bool { return fake.count("INBOX") == 4 })
}

// Fails without the time floor: three sessions within seconds replaced the message.
func TestAMessageTheAPIFailsOnIsOnlyReplacedOnceItKeptFailingForAnHour(t *testing.T) {
	credentials, user := scriptedServer(t, &script{}, "INBOX")
	for _, id := range []string{"a@x", "b@x", "c@x"} {
		deliver(t, user, "INBOX", id, "Message "+id)
	}
	fake := newMemAPI(credentials)
	fake.refuse = refuseUID("2", http.StatusInternalServerError)
	clk := newTestClock()

	runSyncerAt(t, fake, fastOptions(), clk)
	waitFor(t, "many failed sessions", func() bool { fake.mu.Lock(); defer fake.mu.Unlock(); return fake.calls > 40 })
	if msg, ok := fake.message("INBOX", "2"); ok {
		t.Fatalf("uid 2 was replaced within seconds: %+v", msg)
	}
	clk.advance(isolate.MinStrikeSpan)
	waitFor(t, "the folder's backfill finished", func() bool {
		c := fake.cursor("INBOX")
		return c != nil && c.BackfillDone() && fake.count("INBOX") == 3
	})
	if msg, _ := fake.message("INBOX", "2"); !ingestmsg.IsPlaceholder(msg) {
		t.Errorf("uid 2 = %+v, want a placeholder", msg)
	}
}

// Fails without the fix: a placeholder was final, as the API only refreshes the flags of a uid it has.
func TestAPlaceholderIsReplacedByItsMessageOnceTheAPITakesIt(t *testing.T) {
	credentials, user := scriptedServer(t, &script{}, "INBOX")
	for _, id := range []string{"a@x", "b@x"} {
		deliver(t, user, "INBOX", id, "Message "+id)
	}
	fake := newMemAPI(credentials)
	fake.refuse = refuseUID("2", http.StatusUnprocessableEntity)
	clk := newTestClock()

	runSyncerAt(t, fake, fastOptions(), clk)
	waitFor(t, "the placeholder", func() bool { msg, _ := fake.message("INBOX", "2"); return ingestmsg.IsPlaceholder(msg) })
	if c := fake.cursor("INBOX"); c == nil || len(c.Pending) != 1 || c.Pending[0].UID != "2" {
		t.Fatalf("cursor %+v; the placeholder must be kept for a later try", c)
	}

	// Still refused at the first try: the placeholder stays and waits longer.
	clk.advance(isolate.RetryFirst)
	waitFor(t, "the first try", func() bool {
		c := fake.cursor("INBOX")
		return c != nil && len(c.Pending) == 1 && c.Pending[0].Wait > int64(isolate.RetryFirst/time.Second)
	})
	if msg, _ := fake.message("INBOX", "2"); !ingestmsg.IsPlaceholder(msg) {
		t.Fatalf("uid 2 = %+v; a message the API still refuses must leave the placeholder", msg)
	}

	fake.mu.Lock()
	fake.refuse = nil
	fake.mu.Unlock()
	clk.advance(isolate.RetryMax)
	waitFor(t, "the real message", func() bool { msg, ok := fake.message("INBOX", "2"); return ok && !ingestmsg.IsPlaceholder(msg) })
	if c := fake.cursor("INBOX"); c == nil || len(c.Pending) != 0 {
		t.Errorf("cursor %+v; the replaced placeholder must be forgotten", c)
	}
}

// Fails without the fix: a FETCH answered without bodies struck every message of the group.
func TestAServerThatSendsNoBodiesReplacesNothing(t *testing.T) {
	sc := &script{fetch: func([]imap.UID) (error, bool) { return nil, true }}
	credentials, user := scriptedServer(t, sc, "INBOX")
	for _, id := range []string{"a@x", "b@x"} {
		deliver(t, user, "INBOX", id, "Message "+id)
	}
	fake := newMemAPI(credentials)
	clk := newTestClock()

	runSyncerAt(t, fake, fastOptions(), clk)
	for range 5 {
		clk.advance(isolate.MinStrikeSpan)
		time.Sleep(200 * time.Millisecond)
	}
	if n := fake.count("INBOX"); n != 0 {
		t.Errorf("%d messages stored while the server sent no body for any", n)
	}
}

// A message whose FETCH the server keeps refusing, next to messages that come through, gets a placeholder with its
// own date (not "now"), after the time floor.
func TestAMessageTheServerKeepsRefusingGetsADatedPlaceholder(t *testing.T) {
	refused := &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeServerBug, Text: "Internal error"}
	sc := &script{fetch: func(uids []imap.UID) (error, bool) {
		if slices.Contains(uids, 2) {
			return refused, false
		}
		return nil, false
	}}
	credentials, user := scriptedServer(t, sc, "INBOX")
	old := time.Date(2025, 3, 4, 5, 6, 7, 0, time.UTC)
	deliver(t, user, "INBOX", "a@x", "First")
	deliverAt(t, user, "INBOX", "b@x", "Old", old)
	deliver(t, user, "INBOX", "c@x", "Third")
	fake := newMemAPI(credentials)
	clk := newTestClock()

	runSyncerAt(t, fake, fastOptions(), clk)
	waitFor(t, "several failed sessions", func() bool { return sc.loginCount() > 10 })
	if _, ok := fake.message("INBOX", "2"); ok {
		t.Fatal("replaced before the time floor")
	}
	clk.advance(isolate.MinStrikeSpan)
	waitFor(t, "the placeholder", func() bool { msg, _ := fake.message("INBOX", "2"); return ingestmsg.IsPlaceholder(msg) })
	if msg, _ := fake.message("INBOX", "2"); !msg.ReceivedAt.Equal(old) {
		t.Errorf("placeholder received at %v, want the message's own %v", msg.ReceivedAt, old)
	}
	if fake.count("INBOX") != 3 {
		t.Errorf("inbox holds %d", fake.count("INBOX"))
	}
}
func TestAnAPIThatFailsEveryMessageSkipsNothing(t *testing.T) {
	credentials, user := scriptedServer(t, &script{}, "INBOX")
	for _, id := range []string{"a@x", "b@x"} {
		deliver(t, user, "INBOX", id, "Message "+id)
	}
	fake := newMemAPI(credentials)
	fake.refuse = func(api.MessageBatch) error {
		return &api.HTTPError{Method: http.MethodPost, Path: "/messages", Status: http.StatusInternalServerError}
	}

	runSyncer(t, fake, fastOptions())
	waitFor(t, "several sessions", func() bool {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		return fake.calls > 20
	})
	fake.mu.Lock()
	fake.refuse = nil
	fake.mu.Unlock()
	waitFor(t, "the messages once the API works", func() bool { return fake.count("INBOX") == 2 })
	for _, uid := range []string{"1", "2"} {
		if msg, _ := fake.message("INBOX", uid); ingestmsg.IsPlaceholder(msg) {
			t.Errorf("uid %s was replaced although the API failed for every message", uid)
		}
	}
}

func TestFoldersTheServerWillNotOpenAreSkippedAndTheOthersSync(t *testing.T) {
	sc := &script{
		statusErr: map[string]error{"Shared": &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeNoPerm, Text: "Permission denied"}},
		selectErr: map[string]error{"Broken": &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeCorruption, Text: "Mailbox is damaged"}},
	}
	credentials, user := scriptedServer(t, sc, "INBOX", "Broken", "Shared", "Projects")
	deliver(t, user, "INBOX", "a@x", "Inbox mail")
	deliver(t, user, "Broken", "b@x", "Broken mail")
	deliver(t, user, "Projects", "c@x", "Project mail")
	fake := newMemAPI(credentials)

	runSyncer(t, fake, fastOptions())
	waitFor(t, "the inbox and Projects synced", func() bool { return fake.count("INBOX") == 1 && fake.count("Projects") == 1 })
	waitFor(t, "the account reported active", func() bool { return fake.hasStatus(api.StatusActive) })
	if names := fake.folderNames(); slices.Contains(names, "Shared") || !slices.Contains(names, "Broken") {
		t.Errorf("folders %v: Shared (STATUS refused) must be left out, Broken (SELECT refused) listed", names)
	}

	deliver(t, user, "INBOX", "d@x", "Later")
	waitFor(t, "new mail while a folder stays broken", func() bool { return fake.count("INBOX") == 2 })
	if fake.hasStatus(api.StatusError) {
		t.Error("a folder the server will not open made the account report an error")
	}

	sc.mu.Lock()
	delete(sc.selectErr, "Broken")
	sc.mu.Unlock()
	waitFor(t, "the folder once the server opens it again", func() bool { return fake.count("Broken") == 1 })
}

// Fails without the fix: without UIDNEXT the cursor started at 0 and no message ever looked new.
func TestAServerWithoutUIDNextStillSyncs(t *testing.T) {
	credentials, user := scriptedServer(t, &script{noUIDNext: true}, "INBOX")
	deliver(t, user, "INBOX", "a@x", "First")
	deliver(t, user, "INBOX", "b@x", "Second")
	fake := newMemAPI(credentials)

	runSyncer(t, fake, fastOptions())
	waitFor(t, "the existing mail", func() bool { return fake.count("INBOX") == 2 })
	deliver(t, user, "INBOX", "c@x", "Third")
	waitFor(t, "new mail", func() bool { return fake.count("INBOX") == 3 })
}

func no(code imap.ResponseCode, text string) error {
	return &imap.Error{Type: imap.StatusResponseTypeNo, Code: code, Text: text}
}

// Fails without the fix: any error between two refused logins started the count over, so a server that drops the
// connection after a bad login never reached auth_failed.
func TestRefusedLoginsCountAcrossOtherFailures(t *testing.T) {
	sc := &script{login: func(int) error { return no("", "LOGIN failed.") }}
	credentials, _ := scriptedServer(t, sc, "INBOX")
	fake := newMemAPI(credentials)
	sessions := 0
	fake.credentialsErr = func() error {
		sessions++
		if sessions%2 == 0 {
			return errors.New("connection reset")
		}
		return nil
	}
	opts := fastOptions()
	opts.RefusalsBeforeAuthFailed = 3

	done := runSyncer(t, fake, opts)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run kept retrying a refused login")
	}
	if !fake.hasStatus(api.StatusAuthFailed) || sc.loginCount() != 3 {
		t.Errorf("statuses %v after %d logins", fake.statuses, sc.loginCount())
	}
}

// Fails without the fix: NO [ALERT] was an ordinary session error for ever, and its text never reached the user.
func TestAnAlertRefusalEndsInAuthFailedWithTheServersText(t *testing.T) {
	sc := &script{login: func(int) error {
		return no(imap.ResponseCodeAlert, "Application-specific password required: https://support.example/apppasswords")
	}}
	credentials, _ := scriptedServer(t, sc, "INBOX")
	fake := newMemAPI(credentials)
	opts := fastOptions()
	opts.RefusalsBeforeAuthFailed = 5

	done := runSyncer(t, fake, opts)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run kept retrying a login the server refuses with ALERT")
	}
	statuses, details := fake.statusLog()
	if len(statuses) == 0 || statuses[len(statuses)-1] != api.StatusAuthFailed || sc.loginCount() != 5 {
		t.Fatalf("statuses %v after %d logins", statuses, sc.loginCount())
	}
	if want := "The mail server refused the sign-in: Application-specific password required: https://support.example/apppasswords"; details[len(details)-1] != want {
		t.Errorf("detail %q, want %q", details[len(details)-1], want)
	}
}

func TestAnUnknownCodeCountsAsARefusalButATemporaryOneNever(t *testing.T) {
	if !errors.Is(loginError(no("WEBALERT", "Sign in through your browser")), errLoginRefused) {
		t.Error("an unknown code was not counted as a refusal")
	}
	for _, code := range []imap.ResponseCode{imap.ResponseCodeUnavailable, imap.ResponseCodeInUse, imap.ResponseCodeLimit, imap.ResponseCodeServerBug, imap.ResponseCodeContactAdmin} {
		if errors.Is(loginError(no(code, "x")), errLoginRefused) {
			t.Errorf("NO [%s] was counted as a refusal", code)
		}
	}
}

func TestATemporaryRefusalNeverEndsInAuthFailed(t *testing.T) {
	sc := &script{login: func(int) error { return no(imap.ResponseCodeUnavailable, "Try later") }}
	credentials, _ := scriptedServer(t, sc, "INBOX")
	fake := newMemAPI(credentials)
	opts := fastOptions()
	opts.RefusalsBeforeAuthFailed = 2

	runSyncer(t, fake, opts)
	waitFor(t, "many refused logins", func() bool { return sc.loginCount() > 10 })
	if fake.hasStatus(api.StatusAuthFailed) || !fake.hasStatus(api.StatusError) {
		t.Errorf("statuses %v", fake.statuses)
	}
}

// Fails without the fix: a STATUS refused for a passing reason left the folder out, and the API deleted it with its
// messages.
func TestAFolderWhoseStatusIsRefusedForAWhileStaysListed(t *testing.T) {
	sc := &script{statusErr: map[string]error{"Projects": no(imap.ResponseCodeUnavailable, "Mailbox is being repaired")}}
	credentials, user := scriptedServer(t, sc, "INBOX", "Projects")
	deliver(t, user, "INBOX", "a@x", "Inbox mail")
	deliver(t, user, "Projects", "b@x", "Project mail")
	fake := newMemAPI(credentials)

	runSyncer(t, fake, fastOptions())
	waitFor(t, "the inbox", func() bool { return fake.count("INBOX") == 1 })
	fake.mu.Lock()
	var projects *api.Folder
	for i := range fake.folders {
		if fake.folders[i].RemoteName == "Projects" {
			projects = &fake.folders[i]
		}
	}
	fake.mu.Unlock()
	if projects == nil || projects.UIDValidity != nil {
		t.Fatalf("Projects = %+v; want it listed without a UIDVALIDITY, so the API keeps what it has", projects)
	}

	sc.mu.Lock()
	delete(sc.statusErr, "Projects")
	sc.mu.Unlock()
	waitFor(t, "the folder once the server answers again", func() bool { return fake.count("Projects") == 1 })
}

// Fails without the fix: an inbox the server refused to open was skipped and the account reported active.
func TestAnInboxTheServerWillNotOpenIsAnErrorNotActive(t *testing.T) {
	for name, sc := range map[string]*script{
		"select": {selectErr: map[string]error{"INBOX": no(imap.ResponseCodeUnavailable, "Try later")}},
		"status": {statusErr: map[string]error{"INBOX": no(imap.ResponseCodeUnavailable, "Try later")}},
	} {
		t.Run(name, func(t *testing.T) {
			credentials, _ := scriptedServer(t, sc, "INBOX", "Projects")
			fake := newMemAPI(credentials)

			runSyncer(t, fake, fastOptions())
			waitFor(t, "the error status", func() bool { return fake.hasStatus(api.StatusError) })
			if fake.hasStatus(api.StatusActive) {
				t.Errorf("statuses %v; an inbox nobody can open is not in sync", fake.statuses)
			}
		})
	}
}

// The IMAP side of SYNC-15: a lost error report is sent again after the next failure.
func TestALostErrorReportIsSentAgain(t *testing.T) {
	sc := &script{login: func(int) error { return no(imap.ResponseCodeUnavailable, "Try later") }}
	credentials, _ := scriptedServer(t, sc, "INBOX")
	fake := newMemAPI(credentials)
	fake.statusFailures = 1

	runSyncer(t, fake, fastOptions())
	waitFor(t, "the error status", func() bool { return fake.hasStatus(api.StatusError) })
	if statuses, _ := fake.statusLog(); len(statuses) != 1 {
		t.Errorf("statuses %v; want the error once, after the lost report", statuses)
	}
}

// A lost lease cancels Run's context: Run must end at once, in its backoff wait as well as while it follows the
// mailbox.
func TestALostLeaseEndsTheRunAtOnce(t *testing.T) {
	for name, sc := range map[string]*script{
		"in the backoff": {login: func(int) error { return no(imap.ResponseCodeUnavailable, "Try later") }},
		"following":      {},
	} {
		t.Run(name, func(t *testing.T) {
			credentials, user := scriptedServer(t, sc, "INBOX")
			deliver(t, user, "INBOX", "a@x", "Mail")
			fake := newMemAPI(credentials)
			opts := fastOptions()
			opts.MinBackoff, opts.MaxBackoff, opts.PollInterval = time.Hour, time.Hour, time.Hour
			syncer := New(fake, storagetest.New(), plainDialer{}, "test-worker", opts, slog.New(slog.NewTextHandler(io.Discard, nil)))
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() {
				defer close(done)
				_ = syncer.Run(ctx, api.Account{ID: "acc", Provider: "imap"})
			}()
			waitFor(t, "the first session", func() bool { return sc.loginCount() >= 1 && (name != "following" || fake.count("INBOX") == 1) })
			time.Sleep(50 * time.Millisecond)

			start := time.Now()
			cancel()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("Run did not end after its context was cancelled")
			}
			if took := time.Since(start); took > time.Second {
				t.Errorf("Run took %v to end", took)
			}
		})
	}
}

// Fails without the time floor: five refusals 2 to 16 seconds apart (half a minute) ended an account whose password
// is right, also for NO [ALERT] "Too many simultaneous connections".
func TestRefusedLoginsMustSpanTenMinutesBeforeAuthFailed(t *testing.T) {
	sc := &script{login: func(int) error {
		return no(imap.ResponseCodeAlert, "Too many simultaneous connections. (Failure)")
	}}
	credentials, _ := scriptedServer(t, sc, "INBOX")
	fake := newMemAPI(credentials)
	opts := fastOptions()
	opts.RefusalsBeforeAuthFailed = 5
	opts.RefusalSpan = 10 * time.Minute
	opts.RefusalWait = 30 * time.Millisecond
	clk := newTestClock()

	done := runSyncerAt(t, fake, opts, clk)
	waitFor(t, "eight refused logins", func() bool { return sc.loginCount() >= 8 })
	if fake.hasStatus(api.StatusAuthFailed) {
		t.Fatalf("auth_failed after %d refusals within a minute", sc.loginCount())
	}
	sc.mu.Lock()
	for i := 1; i < len(sc.loginTimes); i++ {
		if gap := sc.loginTimes[i].Sub(sc.loginTimes[i-1]); gap < 25*time.Millisecond {
			t.Errorf("sessions %v apart while refusals were counted; want at least RefusalWait", gap)
		}
	}
	sc.mu.Unlock()

	clk.advance(11 * time.Minute)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("refusals over ten minutes did not end the run")
	}
	if !fake.hasStatus(api.StatusAuthFailed) {
		t.Errorf("statuses %v", fake.statuses)
	}
}
