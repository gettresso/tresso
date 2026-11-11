package imapsync

import (
	"context"
	"errors"
	"net"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-imap/v2/imapserver"
	"github.com/emersion/go-imap/v2/imapserver/imapmemserver"

	"tresso/sync/internal/api"
)

type plainDialer struct{}

func (plainDialer) DialContext(ctx context.Context, address string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "tcp", address)
}

// memServer runs an in-memory IMAP server with the given capabilities, with INBOX and Archive for kim.
func memServer(t *testing.T, caps imap.CapSet) api.Credentials {
	t.Helper()
	memory := imapmemserver.New()
	user := imapmemserver.NewUser("kim", "secret")
	for _, name := range []string{"INBOX", "Archive"} {
		if err := user.Create(name, nil); err != nil {
			t.Fatal(err)
		}
	}
	memory.AddUser(user)
	server := imapserver.New(&imapserver.Options{
		NewSession: func(*imapserver.Conn) (imapserver.Session, *imapserver.GreetingData, error) {
			return memory.NewSession(), nil, nil
		},
		Caps:         caps,
		InsecureAuth: true,
	})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	return api.Credentials{
		Connection: api.Connection{IMAP: api.ServerSettings{Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, Security: "none"}, Username: "kim"},
		Secrets:    map[string]string{"type": "password", "password": "secret"},
	}
}

func observer(t *testing.T, credentials api.Credentials) *imapclient.Client {
	t.Helper()
	client, err := imapclient.DialInsecure(net.JoinHostPort(credentials.Connection.IMAP.Host, strconv.Itoa(credentials.Connection.IMAP.Port)), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Login("kim", "secret").Wait(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func appendMessage(t *testing.T, client *imapclient.Client, folder, messageID string, flags ...imap.Flag) {
	t.Helper()
	appendAt(t, client, folder, messageID, time.Time{}, flags...)
}

func appendAt(t *testing.T, client *imapclient.Client, folder, messageID string, at time.Time, flags ...imap.Flag) {
	t.Helper()
	raw := "From: anna@finance.example\r\nTo: kim@company.example\r\nSubject: Plan\r\nMessage-ID: <" + messageID + ">\r\n\r\nPlan.\r\n"
	command := client.Append(folder, int64(len(raw)), &imap.AppendOptions{Flags: flags, Time: at})
	if _, err := command.Write([]byte(raw)); err != nil {
		t.Fatal(err)
	}
	if err := command.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := command.Wait(); err != nil {
		t.Fatal(err)
	}
}

// contents lists the folder's messages as uid and flags.
func contents(t *testing.T, client *imapclient.Client, folder string) (uint32, map[imap.UID][]imap.Flag) {
	t.Helper()
	data, err := client.Select(folder, nil).Wait()
	if err != nil {
		t.Fatal(err)
	}
	out := map[imap.UID][]imap.Flag{}
	if data.NumMessages == 0 {
		return data.UIDValidity, out
	}
	messages, err := client.Fetch(imap.SeqSetNum(1, data.NumMessages), &imap.FetchOptions{UID: true, Flags: true}).Collect()
	if err != nil {
		t.Fatal(err)
	}
	for _, message := range messages {
		out[message.UID] = message.Flags
	}
	return data.UIDValidity, out
}

func openFor(t *testing.T, credentials api.Credentials) *Mailbox {
	t.Helper()
	mailbox, err := OpenMailbox(context.Background(), plainDialer{}, credentials)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(mailbox.Close)
	return mailbox
}

func inboxCopy(t *testing.T, check *imapclient.Client) api.MailboxLocation {
	t.Helper()
	validity, messages := contents(t, check, "INBOX")
	var uids []imap.UID
	for uid := range messages {
		uids = append(uids, uid)
	}
	return api.MailboxLocation{Folder: "INBOX", UIDValidity: &validity, RemoteUID: strconv.FormatUint(uint64(slices.Max(uids)), 10)}
}

func TestMovesWithMoveAndReportsTheNewUid(t *testing.T) {
	credentials := memServer(t, imap.CapSet{imap.CapIMAP4rev1: {}, imap.CapMove: {}, imap.CapUIDPlus: {}})
	check := observer(t, credentials)
	appendMessage(t, check, "INBOX", "plan@finance.example")
	source := inboxCopy(t, check)

	uid, err := openFor(t, credentials).Move(source, "Archive", "plan@finance.example")
	if err != nil {
		t.Fatal(err)
	}

	if _, inbox := contents(t, check, "INBOX"); len(inbox) != 0 {
		t.Errorf("INBOX still has %v", inbox)
	}
	_, archive := contents(t, check, "Archive")
	if len(archive) != 1 || uid == "" {
		t.Fatalf("archive = %v, uid = %q", archive, uid)
	}
	for moved := range archive {
		if strconv.FormatUint(uint64(moved), 10) != uid {
			t.Errorf("reported uid %s, the copy has %d", uid, moved)
		}
	}
}

func TestWithoutMoveItCopiesMarksDeletedAndNeverExpungesTheFolder(t *testing.T) {
	credentials := memServer(t, imap.CapSet{imap.CapIMAP4rev1: {}})
	check := observer(t, credentials)
	// Another mail app marked this one deleted without expunging it: it must survive.
	appendMessage(t, check, "INBOX", "kept@finance.example", imap.FlagDeleted)
	appendMessage(t, check, "INBOX", "plan@finance.example")
	source := inboxCopy(t, check)

	uid, err := openFor(t, credentials).Move(source, "Archive", "plan@finance.example")
	if err != nil {
		t.Fatal(err)
	}

	_, inbox := contents(t, check, "INBOX")
	if len(inbox) != 2 {
		t.Fatalf("INBOX = %v: without UIDPLUS nothing is expunged", inbox)
	}
	for _, flags := range inbox {
		if !slices.Contains(flags, imap.FlagDeleted) {
			t.Errorf("flags = %v, want both marked deleted", flags)
		}
	}
	_, archive := contents(t, check, "Archive")
	if len(archive) != 1 || uid == "" {
		t.Fatalf("archive = %v, uid = %q: the uid is found by Message-ID", archive, uid)
	}
}

func TestWithUidplusButNoMoveOnlyThisCopyIsExpunged(t *testing.T) {
	credentials := memServer(t, imap.CapSet{imap.CapIMAP4rev1: {}, imap.CapUIDPlus: {}})
	check := observer(t, credentials)
	appendMessage(t, check, "INBOX", "kept@finance.example", imap.FlagDeleted)
	appendMessage(t, check, "INBOX", "plan@finance.example")
	source := inboxCopy(t, check)

	if _, err := openFor(t, credentials).Move(source, "Archive", "plan@finance.example"); err != nil {
		t.Fatal(err)
	}

	if _, inbox := contents(t, check, "INBOX"); len(inbox) != 1 {
		t.Errorf("INBOX = %v, want only the message another app marked deleted", inbox)
	}
}

func TestARetriedMoveDoesNotCopyTwice(t *testing.T) {
	credentials := memServer(t, imap.CapSet{imap.CapIMAP4rev1: {}})
	check := observer(t, credentials)
	appendMessage(t, check, "INBOX", "plan@finance.example")
	source := inboxCopy(t, check)
	// An earlier attempt copied it but did not get to mark the source deleted: COPY keeps size and arrival time.
	if _, err := check.Select("INBOX", nil).Wait(); err != nil {
		t.Fatal(err)
	}
	uid, _ := strconv.ParseUint(source.RemoteUID, 10, 32)
	if _, err := check.Copy(imap.UIDSetNum(imap.UID(uid)), "Archive").Wait(); err != nil {
		t.Fatal(err)
	}

	if _, err := openFor(t, credentials).Move(source, "Archive", "plan@finance.example"); err != nil {
		t.Fatal(err)
	}

	if _, archive := contents(t, check, "Archive"); len(archive) != 1 {
		t.Errorf("archive = %v, want one copy", archive)
	}
}

func TestAnotherMessageWithTheSameMessageIdIsNotTakenForTheCopy(t *testing.T) {
	credentials := memServer(t, imap.CapSet{imap.CapIMAP4rev1: {}})
	check := observer(t, credentials)
	// A different message that shares the Message-ID arrived a day earlier.
	appendAt(t, check, "Archive", "plan@finance.example", time.Now().Add(-24*time.Hour))
	appendMessage(t, check, "INBOX", "plan@finance.example")
	source := inboxCopy(t, check)

	if _, err := openFor(t, credentials).Move(source, "Archive", "plan@finance.example"); err != nil {
		t.Fatal(err)
	}

	if _, archive := contents(t, check, "Archive"); len(archive) != 2 {
		t.Errorf("archive = %v, want the moved message next to the other one", archive)
	}
}

func TestRefusesToMoveACopyThatIsGoneOrFromAResetFolder(t *testing.T) {
	credentials := memServer(t, imap.CapSet{imap.CapIMAP4rev1: {}, imap.CapMove: {}})
	check := observer(t, credentials)
	appendMessage(t, check, "INBOX", "plan@finance.example")
	source := inboxCopy(t, check)
	mailbox := openFor(t, credentials)

	gone := source
	gone.RemoteUID = "999"
	if _, err := mailbox.Move(gone, "Archive", ""); !errors.Is(err, ErrMessageGone) {
		t.Errorf("gone: %v", err)
	}
	stale := *source.UIDValidity + 1
	reset := source
	reset.UIDValidity = &stale
	if _, err := mailbox.Move(reset, "Archive", ""); !errors.Is(err, ErrFolderReset) {
		t.Errorf("reset: %v", err)
	}
	if err := mailbox.SetFlags(reset, nil, nil); !errors.Is(err, ErrFolderReset) {
		t.Errorf("reset flags: %v", err)
	}
}

func TestSetsAndClearsFlags(t *testing.T) {
	credentials := memServer(t, imap.CapSet{imap.CapIMAP4rev1: {}})
	check := observer(t, credentials)
	appendMessage(t, check, "INBOX", "plan@finance.example", imap.FlagFlagged)
	source := inboxCopy(t, check)
	yes, no := true, false

	if err := openFor(t, credentials).SetFlags(source, &yes, &no); err != nil {
		t.Fatal(err)
	}

	_, inbox := contents(t, check, "INBOX")
	for _, flags := range inbox {
		if !slices.Contains(flags, imap.FlagSeen) || slices.Contains(flags, imap.FlagFlagged) {
			t.Errorf("flags = %v, want \\Seen without \\Flagged", flags)
		}
	}
}

// Fails without the fix: connect left its context.AfterFunc registered on the long-lived context, so every closed
// connection stayed reachable until the worker stopped.
func TestClosingAConnectionDropsItsContextHook(t *testing.T) {
	credentials := memServer(t, imap.CapSet{imap.CapIMAP4rev1: {}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mailbox, err := OpenMailbox(ctx, plainDialer{}, credentials)
	if err != nil {
		t.Fatal(err)
	}
	mailbox.Close()
	if mailbox.client.stop() {
		t.Error("the context hook of a closed mailbox connection was still registered")
	}

	drafts, err := OpenDrafts(ctx, plainDialer{}, credentials)
	if err != nil {
		t.Fatal(err)
	}
	drafts.Close()
	if drafts.client.stop() {
		t.Error("the context hook of a closed folder connection was still registered")
	}
}
