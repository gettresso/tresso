package imapsync

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/emersion/go-imap/v2"

	"tresso/sync/internal/api"
)

// ErrNoSentFolder means the account has no folder marked or named as Sent.
var ErrNoSentFolder = errors.New("no sent folder")

// Folder is one special folder (Sent, Drafts) of an account, over its own connection next to the one that syncs:
// copies are added to it and found or removed again by their Message-ID.
type Folder struct {
	client *connection
	name   string
}

// OpenSent logs in and finds the Sent folder: the one marked \Sent, or else the one named like it.
func OpenSent(ctx context.Context, d Dialer, credentials api.Credentials) (*Folder, error) {
	client, name, err := openRole(ctx, d, credentials, "sent")
	if err != nil {
		return nil, err
	}
	if name == "" {
		_ = client.Close()
		return nil, ErrNoSentFolder
	}
	return &Folder{client: client, name: name}, nil
}

// OpenDrafts logs in and finds the Drafts folder, creating one (marked \Drafts where the server allows it) when the
// account has none, as mail apps do when they save their first draft.
func OpenDrafts(ctx context.Context, d Dialer, credentials api.Credentials) (*Folder, error) {
	client, name, err := openRole(ctx, d, credentials, "drafts")
	if err != nil {
		return nil, err
	}
	if name == "" {
		name = "Drafts"
		options := &imap.CreateOptions{}
		if client.Caps().Has(imap.CapCreateSpecialUse) {
			options.SpecialUse = []imap.MailboxAttr{imap.MailboxAttrDrafts}
		}
		if err := client.Create(name, options).Wait(); err != nil {
			_ = client.Close()
			return nil, fmt.Errorf("create %s: %w", name, err)
		}
	}
	return &Folder{client: client, name: name}, nil
}

func openRole(ctx context.Context, d Dialer, credentials api.Credentials, role string) (*connection, string, error) {
	password, err := credentials.Password()
	if err != nil {
		return nil, "", err
	}
	client, err := connect(ctx, d, credentials.Connection.IMAP, credentials.Connection.Username, password, newServerEvents())
	if err != nil {
		return nil, "", err
	}
	list, err := listFolders(client.Client)
	if err != nil {
		_ = client.Close()
		return nil, "", fmt.Errorf("list folders: %w", err)
	}
	for _, folder := range list.folders {
		if folder.Role == role {
			return client, folder.RemoteName, nil
		}
	}
	return client, "", nil
}

// Contains reports whether a message with this Message-ID (without angle brackets) is in the folder.
func (f *Folder) Contains(messageID string) (bool, error) {
	uids, err := f.find(messageID, true)
	return len(uids) > 0, err
}

// Append files the message as read.
func (f *Folder) Append(raw []byte, at time.Time) error {
	return f.AppendWithFlags(raw, at, imap.FlagSeen)
}

// AppendDraft files a draft: marked \Draft and read, as mail apps file their own.
func (f *Folder) AppendDraft(raw []byte, at time.Time) error {
	return f.AppendWithFlags(raw, at, imap.FlagDraft, imap.FlagSeen)
}

// AppendWithFlags files the message with the given flags (a draft carries \Draft).
func (f *Folder) AppendWithFlags(raw []byte, at time.Time, flags ...imap.Flag) error {
	command := f.client.Append(f.name, int64(len(raw)), &imap.AppendOptions{Flags: flags, Time: at})
	if _, err := command.Write(raw); err != nil {
		_ = command.Close()
		return fmt.Errorf("append to %s: %w", f.name, err)
	}
	if err := command.Close(); err != nil {
		return fmt.Errorf("append to %s: %w", f.name, err)
	}
	if _, err := command.Wait(); err != nil {
		return fmt.Errorf("append to %s: %w", f.name, err)
	}
	return nil
}

// Remove deletes every copy with this Message-ID. Without UIDPLUS the folder is expunged as a whole, which also
// removes messages another client marked deleted there: in Sent and Drafts that is what those marks ask for.
func (f *Folder) Remove(messageID string) error {
	uids, err := f.find(messageID, false)
	if err != nil || len(uids) == 0 {
		return err
	}
	set := imap.UIDSetNum(uids...)
	if err := f.client.Store(set, &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true, Flags: []imap.Flag{imap.FlagDeleted}}, nil).Close(); err != nil {
		return fmt.Errorf("mark deleted in %s: %w", f.name, err)
	}
	if f.client.Caps().Has(imap.CapUIDPlus) {
		err = f.client.UIDExpunge(set).Close()
	} else {
		err = f.client.Expunge().Close()
	}
	if err != nil {
		return fmt.Errorf("expunge %s: %w", f.name, err)
	}
	return nil
}

func (f *Folder) find(messageID string, readOnly bool) ([]imap.UID, error) {
	if _, err := f.client.Select(f.name, &imap.SelectOptions{ReadOnly: readOnly}).Wait(); err != nil {
		return nil, fmt.Errorf("select %s: %w", f.name, err)
	}
	data, err := f.client.UIDSearch(&imap.SearchCriteria{
		Header: []imap.SearchCriteriaHeaderField{{Key: "Message-ID", Value: "<" + messageID + ">"}},
	}, nil).Wait()
	if err != nil {
		return nil, fmt.Errorf("search %s: %w", f.name, err)
	}
	return data.AllUIDs(), nil
}

func (f *Folder) Close() {
	_ = f.client.Logout().Wait()
	_ = f.client.Close()
}
