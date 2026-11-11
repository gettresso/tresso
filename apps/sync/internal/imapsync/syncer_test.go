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
	"tresso/sync/internal/storage/storagetest"
)

// script makes the in-memory server misbehave the way real servers do: refuse logins, folders or fetches.
type script struct {
	mu        sync.Mutex
	logins    int
	login     func(attempt int) error
	selectErr map[string]error
	statusErr map[string]error
	// noUIDNext leaves UIDNEXT out of SELECT answers (it is sent as 0), as RFC 3501 allows.
	noUIDNext bool
}

func (s *script) loginErr() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.logins++
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
	raw := "From: anna@finance.example\r\nTo: kim@company.example\r\nSubject: " + subject + "\r\nMessage-ID: <" + messageID + ">\r\n\r\nHello.\r\n"
	if _, err := user.Append(folder, literal(raw), &imap.AppendOptions{Time: time.Now()}); err != nil {
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
	refuse      func(batch api.MessageBatch) error
	calls       int
}

func newMemAPI(credentials api.Credentials) *memAPI {
	return &memAPI{credentials: credentials, cursors: map[string]*string{}, messages: map[string]map[string]api.Message{}}
}

func (m *memAPI) Credentials(context.Context, string, string) (api.Credentials, error) {
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
	if batch.Cursor != nil {
		m.cursors[batch.Folder] = batch.Cursor
	}
	return api.ChangeBatchResult{}, nil
}

func (m *memAPI) Status(_ context.Context, _, _, status, _ string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.statuses = append(m.statuses, status)
	return nil
}

func (m *memAPI) message(folder, uid string) (api.Message, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	msg, ok := m.messages[folder][uid]
	return msg, ok
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
	return o
}

// runSyncer runs the syncer until the test ends and returns a channel that is closed when Run returned.
func runSyncer(t *testing.T, fake *memAPI, opts Options) <-chan struct{} {
	t.Helper()
	syncer := New(fake, storagetest.New(), plainDialer{}, "test-worker", opts, slog.New(slog.NewTextHandler(io.Discard, nil)))
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
	for _, code := range []imap.ResponseCode{imap.ResponseCodeUnavailable, imap.ResponseCodeInUse, imap.ResponseCodeLimit, imap.ResponseCodeServerBug, imap.ResponseCodeContactAdmin, imap.ResponseCodeAlert} {
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
			if msg.RemoteUID == uid && msg.Subject != ingestmsg.PlaceholderSubject {
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
	if msg, _ := fake.message("INBOX", "2"); msg.Subject != ingestmsg.PlaceholderSubject || msg.RawObjectKey == "" {
		t.Errorf("uid 2 = %+v, want a placeholder that keeps the raw message", msg)
	}
	for _, uid := range []string{"1", "3"} {
		if msg, _ := fake.message("INBOX", uid); msg.Subject == ingestmsg.PlaceholderSubject || msg.Subject == "" {
			t.Errorf("uid %s = %+v, want the message itself", uid, msg)
		}
	}

	deliver(t, user, "INBOX", "d@x", "Later")
	waitFor(t, "new mail after the refused message", func() bool { return fake.count("INBOX") == 4 })
}

func TestAMessageTheAPIFailsOnIsOnlyReplacedOnceItKeepsFailing(t *testing.T) {
	credentials, user := scriptedServer(t, &script{}, "INBOX")
	for _, id := range []string{"a@x", "b@x", "c@x"} {
		deliver(t, user, "INBOX", id, "Message "+id)
	}
	fake := newMemAPI(credentials)
	fake.refuse = refuseUID("2", http.StatusInternalServerError)

	runSyncer(t, fake, fastOptions())
	waitFor(t, "the folder's backfill finished", func() bool {
		c := fake.cursor("INBOX")
		return c != nil && c.BackfillDone() && fake.count("INBOX") == 3
	})
	if msg, _ := fake.message("INBOX", "2"); msg.Subject != ingestmsg.PlaceholderSubject {
		t.Errorf("uid 2 = %+v, want a placeholder", msg)
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
		if msg, _ := fake.message("INBOX", uid); msg.Subject == ingestmsg.PlaceholderSubject {
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
