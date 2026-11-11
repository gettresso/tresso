package imapsync

import (
	"errors"
	"strings"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"

	"tresso/sync/internal/api"
)

// listFolders returns every selectable mailbox with its role and UIDVALIDITY. A mailbox whose STATUS the server
// refuses (a shared folder the user may list but not open, one deleted since the LIST, a damaged one) is left out and
// returned in unreadable: listing it would give the user a folder nobody can fill, and failing the listing would stop
// every other folder.
func listFolders(c *imapclient.Client) (folders []api.Folder, unreadable map[string]error, err error) {
	options := &imap.ListOptions{}
	if c.Caps().Has(imap.CapSpecialUse) {
		options.ReturnSpecialUse = true
	}
	mailboxes, err := c.List("", "*", options).Collect()
	if err != nil {
		return nil, nil, err
	}

	selectable := make([]*imap.ListData, 0, len(mailboxes))
	for _, mailbox := range mailboxes {
		if hasAttr(mailbox.Attrs, imap.MailboxAttrNoSelect) || hasAttr(mailbox.Attrs, imap.MailboxAttrNonExistent) {
			continue
		}
		selectable = append(selectable, mailbox)
	}
	roles := assignRoles(selectable)

	folders = make([]api.Folder, 0, len(selectable))
	for i, mailbox := range selectable {
		status, err := c.Status(mailbox.Mailbox, &imap.StatusOptions{UIDValidity: true}).Wait()
		if refusedByServer(err) {
			if unreadable == nil {
				unreadable = map[string]error{}
			}
			unreadable[mailbox.Mailbox] = err
			continue
		}
		if err != nil {
			return nil, nil, err
		}
		uidValidity := status.UIDValidity
		folders = append(folders, api.Folder{
			RemoteName:  mailbox.Mailbox,
			DisplayName: displayName(mailbox.Mailbox, mailbox.Delim),
			Role:        roles[i],
			UIDValidity: &uidValidity,
		})
	}

	// INBOX first: it is what users look at, so it syncs first.
	for i, f := range folders {
		if f.Role == "inbox" && i > 0 {
			folders[0], folders[i] = folders[i], folders[0]
			break
		}
	}
	return folders, unreadable, nil
}

// refusedByServer reports whether the server answered NO: about this one command, not the connection.
func refusedByServer(err error) bool {
	var imapErr *imap.Error
	return errors.As(err, &imapErr) && imapErr.Type == imap.StatusResponseTypeNo
}

var roleByAttr = map[imap.MailboxAttr]string{
	imap.MailboxAttrSent:    "sent",
	imap.MailboxAttrDrafts:  "drafts",
	imap.MailboxAttrTrash:   "trash",
	imap.MailboxAttrJunk:    "spam",
	imap.MailboxAttrArchive: "archive",
	imap.MailboxAttrAll:     "all",
}

// Names servers use without SPECIAL-USE, in the languages Tresso's users have their mailboxes in.
var roleByName = map[string]string{
	"sent": "sent", "sent items": "sent", "sent messages": "sent", "sent mail": "sent", "verzonden items": "sent", "verzonden": "sent", "gesendet": "sent",
	"drafts": "drafts", "draft": "drafts", "concepten": "drafts", "entwürfe": "drafts",
	"trash": "trash", "deleted items": "trash", "deleted messages": "trash", "bin": "trash", "prullenbak": "trash", "verwijderde items": "trash", "papierkorb": "trash",
	"junk": "spam", "spam": "spam", "junk e-mail": "spam", "ongewenste e-mail": "spam",
	"archive": "archive", "archief": "archive", "archiv": "archive",
}

// assignRoles gives each mailbox its role. Every role but custom goes to one folder at most, the first that claims it:
// the special-use attribute first, then, for a role no mailbox is marked with, the name, but only of a top-level
// mailbox or a direct child of INBOX ("INBOX.Sent" on servers that keep everything below INBOX). A "Sent" deep in
// the user's own folders (Projects/2019/Sent) is theirs, not where Tresso files sent mail.
func assignRoles(mailboxes []*imap.ListData) []string {
	roles := make([]string, len(mailboxes))
	taken := map[string]bool{}
	for i, mailbox := range mailboxes {
		role := roleByAttrs(mailbox.Mailbox, mailbox.Attrs)
		if role != "" && !taken[role] {
			roles[i], taken[role] = role, true
		}
	}
	for i, mailbox := range mailboxes {
		if roles[i] != "" {
			continue
		}
		roles[i] = "custom"
		if hasRoleAttr(mailbox.Attrs) || !nearTheTop(mailbox.Mailbox, mailbox.Delim) {
			continue
		}
		if role, ok := roleByName[leafName(mailbox.Mailbox, mailbox.Delim)]; ok && !taken[role] {
			roles[i], taken[role] = role, true
		}
	}
	return roles
}

// roleByAttrs is the role INBOX and the special-use attributes give, or "".
func roleByAttrs(name string, attrs []imap.MailboxAttr) string {
	if strings.EqualFold(name, "INBOX") {
		return "inbox"
	}
	for _, attr := range attrs {
		for known, role := range roleByAttr {
			if strings.EqualFold(string(known), string(attr)) {
				return role
			}
		}
	}
	return ""
}

func hasRoleAttr(attrs []imap.MailboxAttr) bool {
	return roleByAttrs("", attrs) != ""
}

// nearTheTop reports whether a mailbox is top-level or a direct child of INBOX.
func nearTheTop(name string, delim rune) bool {
	if delim == 0 {
		return true
	}
	parts := strings.Split(name, string(delim))
	return len(parts) == 1 || (len(parts) == 2 && strings.EqualFold(parts[0], "INBOX"))
}

func leafName(name string, delim rune) string {
	if delim == 0 {
		return strings.ToLower(name)
	}
	return strings.ToLower(lastSegment(name, delim))
}

func displayName(name string, delim rune) string {
	if strings.EqualFold(name, "INBOX") {
		return "Inbox"
	}
	if delim == 0 {
		return name
	}
	return lastSegment(name, delim)
}

func lastSegment(name string, delim rune) string {
	if i := strings.LastIndex(name, string(delim)); i >= 0 && i < len(name)-1 {
		return name[i+1:]
	}
	return name
}

func hasAttr(attrs []imap.MailboxAttr, want imap.MailboxAttr) bool {
	for _, attr := range attrs {
		if strings.EqualFold(string(attr), string(want)) {
			return true
		}
	}
	return false
}
