package imapsync

import (
	"errors"
	"strings"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"

	"tresso/sync/internal/api"
)

// folderList is the account's mailboxes as listFolders found them.
type folderList struct {
	folders []api.Folder
	// gone are the mailboxes left out because the server says they do not exist or may not be read (STATUS answered
	// NO [NONEXISTENT] or NO [NOPERM]); the API removes them.
	gone map[string]error
	// unavailable are mailboxes whose STATUS was refused for another reason (UNAVAILABLE, INUSE, a damaged mailbox):
	// they stay listed, without a UIDVALIDITY so the API keeps what it has, and are skipped until the next list.
	unavailable map[string]error
}

// listFolders returns every selectable mailbox with its role and UIDVALIDITY. A refused STATUS never fails the
// listing, which would stop every other folder; only a mailbox that is gone (or that the user may no longer read) is
// left out, because the API deletes a folder that is not listed, with its messages.
func listFolders(c *imapclient.Client) (folderList, error) {
	options := &imap.ListOptions{}
	if c.Caps().Has(imap.CapSpecialUse) {
		options.ReturnSpecialUse = true
	}
	mailboxes, err := c.List("", "*", options).Collect()
	if err != nil {
		return folderList{}, err
	}

	selectable := make([]*imap.ListData, 0, len(mailboxes))
	for _, mailbox := range mailboxes {
		if hasAttr(mailbox.Attrs, imap.MailboxAttrNoSelect) || hasAttr(mailbox.Attrs, imap.MailboxAttrNonExistent) {
			continue
		}
		selectable = append(selectable, mailbox)
	}
	roles := assignRoles(selectable, personalPrefix(c))

	list := folderList{folders: make([]api.Folder, 0, len(selectable))}
	for i, mailbox := range selectable {
		folder := api.Folder{RemoteName: mailbox.Mailbox, DisplayName: displayName(mailbox.Mailbox, mailbox.Delim), Role: roles[i]}
		status, err := c.Status(mailbox.Mailbox, &imap.StatusOptions{UIDValidity: true}).Wait()
		var refused *imap.Error
		switch {
		case err == nil:
			uidValidity := status.UIDValidity
			folder.UIDValidity = &uidValidity
		case errors.As(err, &refused) && refused.Type == imap.StatusResponseTypeNo && (refused.Code == imap.ResponseCodeNonExistent || refused.Code == imap.ResponseCodeNoPerm):
			if list.gone == nil {
				list.gone = map[string]error{}
			}
			list.gone[mailbox.Mailbox] = err
			continue
		case refusedByServer(err):
			if list.unavailable == nil {
				list.unavailable = map[string]error{}
			}
			list.unavailable[mailbox.Mailbox] = err
		default:
			return folderList{}, err
		}
		list.folders = append(list.folders, folder)
	}

	// INBOX first: it is what users look at, so it syncs first.
	for i, f := range list.folders {
		if f.Role == "inbox" && i > 0 {
			list.folders[0], list.folders[i] = list.folders[i], list.folders[0]
			break
		}
	}
	return list, nil
}

// personalPrefix is the prefix of the user's own mailboxes (RFC 2342 NAMESPACE), such as "INBOX." or "Mail/"; ""
// when the server has none or does not say.
func personalPrefix(c *imapclient.Client) string {
	if !c.Caps().Has(imap.CapNamespace) {
		return ""
	}
	data, err := c.Namespace().Wait()
	if err != nil || data == nil || len(data.Personal) == 0 {
		return ""
	}
	return data.Personal[0].Prefix
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
// mailbox, a direct child of INBOX ("INBOX.Sent" on servers that keep everything below INBOX) or a direct child of
// the personal namespace prefix ("Mail/Sent"). A "Sent" deep in the user's own folders (Projects/2019/Sent) is
// theirs, not where Tresso files sent mail.
func assignRoles(mailboxes []*imap.ListData, prefix string) []string {
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
		if hasRoleAttr(mailbox.Attrs) || !nearTheTop(mailbox.Mailbox, mailbox.Delim, prefix) {
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

// nearTheTop reports whether a mailbox is top-level, a direct child of INBOX or a direct child of the personal
// namespace prefix.
func nearTheTop(name string, delim rune, prefix string) bool {
	if delim == 0 {
		return true
	}
	if prefix != "" && strings.HasPrefix(name, prefix) && !strings.ContainsRune(strings.TrimPrefix(name, prefix), delim) {
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
