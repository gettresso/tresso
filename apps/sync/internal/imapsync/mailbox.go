package imapsync

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"time"

	"github.com/emersion/go-imap/v2"

	"tresso/sync/internal/api"
)

// ErrFolderReset means the folder's UIDVALIDITY changed since the uid was learnt: the uid may name another message.
var ErrFolderReset = errors.New("the folder was reset on the server")

// ErrMessageGone means the copy is no longer in the folder, e.g. another mail app moved or deleted it.
var ErrMessageGone = errors.New("the message is no longer in the folder")

// Mailbox makes the user's changes (flags, moves) on the server, over its own connection next to the one that syncs.
type Mailbox struct {
	client   *connection
	selected string
	validity uint32
}

// OpenMailbox logs in for making changes.
func OpenMailbox(ctx context.Context, d Dialer, credentials api.Credentials) (*Mailbox, error) {
	password, err := credentials.Password()
	if err != nil {
		return nil, err
	}
	client, err := connect(ctx, d, credentials.Connection.IMAP, credentials.Connection.Username, password, newServerEvents())
	if err != nil {
		return nil, err
	}
	return &Mailbox{client: client}, nil
}

// SetFlags sets \Seen and/or \Flagged on the copy (nil leaves a flag alone). A copy that is gone needs nothing.
func (m *Mailbox) SetFlags(location api.MailboxLocation, seen, flagged *bool) error {
	uid, err := m.open(location)
	if err != nil {
		return err
	}
	var add, remove []imap.Flag
	for _, flag := range []struct {
		want *bool
		name imap.Flag
	}{{seen, imap.FlagSeen}, {flagged, imap.FlagFlagged}} {
		switch {
		case flag.want == nil:
		case *flag.want:
			add = append(add, flag.name)
		default:
			remove = append(remove, flag.name)
		}
	}
	set := imap.UIDSetNum(uid)
	if len(add) > 0 {
		if err := m.client.Store(set, &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true, Flags: add}, nil).Close(); err != nil {
			return fmt.Errorf("set flags in %s: %w", location.Folder, err)
		}
	}
	if len(remove) > 0 {
		if err := m.client.Store(set, &imap.StoreFlags{Op: imap.StoreFlagsDel, Silent: true, Flags: remove}, nil).Close(); err != nil {
			return fmt.Errorf("clear flags in %s: %w", location.Folder, err)
		}
	}
	return nil
}

// Move moves the copy to the target folder and returns its uid there, from the server (UIDPLUS) or found by its
// Message-ID (messageID, without angle brackets; "" when it has none), else "".
//
// Servers without MOVE get COPY, then \Deleted on the source, each only after the step before succeeded; the source
// is expunged only with UIDPLUS, so that only this copy goes: expunging the whole folder would also erase messages
// another mail app merely marked deleted. A copy an earlier attempt already put in the target (same Message-ID, size
// and arrival time, which COPY keeps) is not copied again.
func (m *Mailbox) Move(source api.MailboxLocation, target, messageID string) (string, error) {
	uid, err := m.open(source)
	if err != nil {
		return "", err
	}
	set := imap.UIDSetNum(uid)
	// A uid that is gone would make MOVE succeed without doing anything; say so instead.
	present, err := m.client.Fetch(set, &imap.FetchOptions{UID: true, RFC822Size: true, InternalDate: true}).Collect()
	if err != nil {
		return "", fmt.Errorf("look up the message in %s: %w", source.Folder, err)
	}
	if len(present) == 0 {
		return "", ErrMessageGone
	}

	var dest imap.NumSet
	copied := ""
	if m.client.Caps().Has(imap.CapMove) {
		data, err := m.client.Move(set, target).Wait()
		if err != nil {
			return "", fmt.Errorf("move from %s to %s: %w", source.Folder, target, err)
		}
		dest = data.DestUIDs
	} else {
		if messageID != "" {
			if copied, err = m.findCopy(target, messageID, present[0].RFC822Size, present[0].InternalDate); err != nil {
				return "", err
			}
			if _, err := m.open(source); err != nil {
				return "", err
			}
		}
		if copied == "" {
			data, err := m.client.Copy(set, target).Wait()
			if err != nil {
				return "", fmt.Errorf("copy from %s to %s: %w", source.Folder, target, err)
			}
			dest = data.DestUIDs
		}
		if err := m.client.Store(set, &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true, Flags: []imap.Flag{imap.FlagDeleted}}, nil).Close(); err != nil {
			return "", fmt.Errorf("mark the moved message deleted in %s: %w", source.Folder, err)
		}
		if m.client.Caps().Has(imap.CapUIDPlus) {
			if err := m.client.UIDExpunge(set).Close(); err != nil {
				return "", fmt.Errorf("expunge the moved message from %s: %w", source.Folder, err)
			}
		}
	}

	if uids, ok := dest.(imap.UIDSet); ok {
		if nums, ok := uids.Nums(); ok && len(nums) == 1 {
			return strconv.FormatUint(uint64(nums[0]), 10), nil
		}
	}
	if copied != "" || messageID == "" {
		return copied, nil
	}
	return m.find(target, messageID)
}

// findCopy returns the uid of a copy in the folder that is this very message: same Message-ID, size and arrival
// time. Another message that merely shares the Message-ID does not count.
func (m *Mailbox) findCopy(folder, messageID string, size int64, arrived time.Time) (string, error) {
	if _, err := m.find(folder, messageID); err != nil {
		return "", err
	}
	data, err := m.client.UIDSearch(&imap.SearchCriteria{
		Header: []imap.SearchCriteriaHeaderField{{Key: "Message-ID", Value: "<" + messageID + ">"}},
	}, nil).Wait()
	if err != nil {
		return "", fmt.Errorf("search %s: %w", folder, err)
	}
	if len(data.AllUIDs()) == 0 {
		return "", nil
	}
	candidates, err := m.client.Fetch(imap.UIDSetNum(data.AllUIDs()...), &imap.FetchOptions{UID: true, RFC822Size: true, InternalDate: true}).Collect()
	if err != nil {
		return "", fmt.Errorf("look up copies in %s: %w", folder, err)
	}
	for _, candidate := range candidates {
		if candidate.RFC822Size == size && candidate.InternalDate.Equal(arrived) {
			return strconv.FormatUint(uint64(candidate.UID), 10), nil
		}
	}
	return "", nil
}

// find returns the uid of the newest copy with this Message-ID in the folder, or "".
func (m *Mailbox) find(folder, messageID string) (string, error) {
	if m.selected != folder {
		data, err := m.client.Select(folder, nil).Wait()
		if err != nil {
			m.selected = ""
			return "", fmt.Errorf("select %s: %w", folder, err)
		}
		m.selected, m.validity = folder, data.UIDValidity
	}
	data, err := m.client.UIDSearch(&imap.SearchCriteria{
		Header: []imap.SearchCriteriaHeaderField{{Key: "Message-ID", Value: "<" + messageID + ">"}},
	}, nil).Wait()
	if err != nil {
		return "", fmt.Errorf("search %s: %w", folder, err)
	}
	uids := data.AllUIDs()
	if len(uids) == 0 {
		return "", nil
	}
	return strconv.FormatUint(uint64(slices.Max(uids)), 10), nil
}

func (m *Mailbox) open(location api.MailboxLocation) (imap.UID, error) {
	uid, err := strconv.ParseUint(location.RemoteUID, 10, 32)
	if err != nil || uid == 0 {
		return 0, fmt.Errorf("%q is not an IMAP uid", location.RemoteUID)
	}
	if m.selected != location.Folder {
		data, err := m.client.Select(location.Folder, nil).Wait()
		if err != nil {
			m.selected = ""
			return 0, fmt.Errorf("select %s: %w", location.Folder, err)
		}
		m.selected, m.validity = location.Folder, data.UIDValidity
	}
	if location.UIDValidity != nil && *location.UIDValidity != m.validity {
		return 0, ErrFolderReset
	}
	return imap.UID(uid), nil
}

func (m *Mailbox) Close() {
	_ = m.client.Logout().Wait()
	_ = m.client.Close()
}
