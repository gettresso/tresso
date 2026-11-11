package imapsync

import (
	"errors"
	"fmt"
	"reflect"
	"slices"
	"testing"

	"github.com/emersion/go-imap/v2"

	"tresso/sync/internal/isolate"
	"tresso/sync/internal/netguard"
)

func TestCursorRoundTrip(t *testing.T) {
	in := Cursor{UIDValidity: 7, UIDNext: 120, BackfillBelow: 40, HighestModSeq: 99, Pending: isolate.PendingList{{UID: "3", Next: 5, Wait: 3600}}}
	encoded := in.Encode()

	out, err := DecodeCursor(&encoded)
	if err != nil || out == nil {
		t.Fatalf("decode: %v %v", out, err)
	}
	in.Version = cursorVersion
	if !reflect.DeepEqual(*out, in) {
		t.Errorf("got %+v, want %+v", *out, in)
	}
}

func TestEmptyOrOldCursorRestartsTheFolder(t *testing.T) {
	empty := ""
	old := `{"v":0,"uidNext":5}`
	for _, raw := range []*string{nil, &empty, &old} {
		c, err := DecodeCursor(raw)
		if err != nil || c != nil {
			t.Errorf("DecodeCursor(%v) = %v, %v; want nil, nil", raw, c, err)
		}
	}
	broken := "{not json"
	if _, err := DecodeCursor(&broken); err == nil {
		t.Error("expected an error for a broken cursor")
	}
}

func TestBackfillDone(t *testing.T) {
	if (Cursor{BackfillBelow: 2}).BackfillDone() || !(Cursor{BackfillBelow: 1}).BackfillDone() || !(Cursor{}).BackfillDone() {
		t.Error("BackfillDone is wrong")
	}
}

func TestRoleOf(t *testing.T) {
	cases := []struct {
		name  string
		delim rune
		attrs []imap.MailboxAttr
		want  string
	}{
		{"INBOX", '/', nil, "inbox"},
		{"inbox", '/', nil, "inbox"},
		{"Whatever", '/', []imap.MailboxAttr{imap.MailboxAttrSent}, "sent"},
		{"Bin", '/', []imap.MailboxAttr{"\\trash"}, "trash"},
		{"[Gmail]/All Mail", '/', []imap.MailboxAttr{imap.MailboxAttrAll, imap.MailboxAttrHasNoChildren}, "all"},
		{"INBOX.Sent Items", '.', nil, "sent"},
		{"Verzonden items", '/', nil, "sent"},
		{"Ongewenste e-mail", '/', nil, "spam"},
		{"Projects/Acme", '/', nil, "custom"},
	}
	for _, c := range cases {
		if got := assignRoles([]*imap.ListData{{Mailbox: c.name, Delim: c.delim, Attrs: c.attrs}})[0]; got != c.want {
			t.Errorf("role of %q %v = %q, want %q", c.name, c.attrs, got, c.want)
		}
	}
}

// Fails without the fix: every mailbox named like a role got it, at any depth and next to a marked one.
func TestEachRoleGoesToOneFolderAndNamesOnlyCountNearTheTop(t *testing.T) {
	mailboxes := []*imap.ListData{
		{Mailbox: "INBOX", Delim: '/'},
		{Mailbox: "Archive/Sent", Delim: '/'},
		{Mailbox: "Sent Items", Delim: '/', Attrs: []imap.MailboxAttr{imap.MailboxAttrSent}},
		{Mailbox: "Projects/2019/Trash", Delim: '/'},
		{Mailbox: "Drafts", Delim: '/'},
		{Mailbox: "Concepten", Delim: '/'},
		{Mailbox: "Clients.Trash", Delim: '.'},
	}
	want := []string{"inbox", "custom", "sent", "custom", "drafts", "custom", "custom"}
	if got := assignRoles(mailboxes); !slices.Equal(got, want) {
		t.Errorf("roles = %v, want %v", got, want)
	}
}

func TestDisplayName(t *testing.T) {
	if displayName("INBOX", '/') != "Inbox" || displayName("Projects/Acme", '/') != "Acme" || displayName("INBOX.Sent", '.') != "Sent" || displayName("Flat", 0) != "Flat" {
		t.Error("displayName is wrong")
	}
}

func TestUserFacingDetailNeverLeaksServerText(t *testing.T) {
	cases := map[error]string{
		fmt.Errorf("%w: [AUTHENTICATIONFAILED] secret server text", ErrAuth): "The mail server rejected the username or password.",
		fmt.Errorf("dial: %w", netguard.ErrBlockedAddress):                   "The mail server address is not allowed.",
		errors.New("something internal with a token=abc"):                    "Syncing failed. Tresso keeps retrying.",
	}
	for err, want := range cases {
		if got := userFacingDetail(err); got != want {
			t.Errorf("userFacingDetail(%v) = %q, want %q", err, got, want)
		}
	}
}

func TestJunkKeywords(t *testing.T) {
	cases := []struct {
		flags []imap.Flag
		want  bool
	}{
		{nil, false},
		{[]imap.Flag{imap.FlagSeen, "$Junk"}, true},
		{[]imap.Flag{"Junk"}, true},
		{[]imap.Flag{"$Junk", "$NotJunk"}, false},
		{[]imap.Flag{"NonJunk", "$Junk"}, false},
	}
	for _, c := range cases {
		if got := isJunk(c.flags); got != c.want {
			t.Errorf("isJunk(%v) = %v, want %v", c.flags, got, c.want)
		}
	}
}

func TestExpungedBetween(t *testing.T) {
	cases := []struct {
		name              string
		previous, current mailboxState
		want              bool
	}{
		{"first sync of the session", mailboxState{}, mailboxState{exists: 3, uidNext: 10}, false},
		{"nothing changed", mailboxState{exists: 3, uidNext: 10}, mailboxState{exists: 3, uidNext: 10}, false},
		{"new mail", mailboxState{exists: 3, uidNext: 10}, mailboxState{exists: 5, uidNext: 12}, false},
		{"one expunged", mailboxState{exists: 3, uidNext: 10}, mailboxState{exists: 2, uidNext: 10}, true},
		{"new mail and one expunged", mailboxState{exists: 3, uidNext: 10}, mailboxState{exists: 4, uidNext: 12}, true},
		{"moved here and away again", mailboxState{exists: 3, uidNext: 10}, mailboxState{exists: 3, uidNext: 11}, true},
	}
	for _, c := range cases {
		if got := expungedBetween(c.previous, c.current); got != c.want {
			t.Errorf("%s: expungedBetween = %v, want %v", c.name, got, c.want)
		}
	}
}
