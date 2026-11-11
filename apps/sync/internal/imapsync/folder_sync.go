package imapsync

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"time"

	"github.com/emersion/go-imap/v2"

	"tresso/sync/internal/api"
	"tresso/sync/internal/ingestmsg"
	"tresso/sync/internal/isolate"
)

// errFoldersChanged means a folder's UIDVALIDITY changed mid-session: the folder list must be reported again so the
// API can reset that folder.
var errFoldersChanged = errors.New("folder uidvalidity changed")

// errFolderUnavailable means the server refused to open a folder (SELECT answered NO). The folder is skipped until
// the folder list is refreshed; the others go on.
var errFolderUnavailable = errors.New("folder could not be opened")

type folderRun struct {
	folder       api.Folder
	cursor       *Cursor
	lastPresence time.Time
	// The folder as of the last sync's SELECT. A later SELECT that differs means something changed in between.
	seen mailboxState
	// unavailable is set when the server refused to open the folder; it is tried again with the next folder list.
	unavailable bool
	// modSeq is set when the last SELECT reported a HIGHESTMODSEQ: CONDSTORE works in this folder. A server with
	// CONDSTORE may still answer NOMODSEQ for a mailbox, which then needs the full flag check.
	modSeq bool
}

// condStoreIn reports whether flag changes in run's folder can be asked for by MODSEQ.
func (s *session) condStoreIn(run *folderRun) bool {
	return s.condStore && run.modSeq
}

type mailboxState struct {
	exists        uint32
	uidNext       uint32
	highestModSeq uint64
}

// expungedBetween reports whether a message was expunged between two SELECTs of a folder: it holds fewer messages
// than before plus the UIDs assigned since. previous is zero before the first sync of the session.
func expungedBetween(previous, current mailboxState) bool {
	if previous.uidNext == 0 || current.uidNext < previous.uidNext {
		return false
	}
	return current.exists < previous.exists+(current.uidNext-previous.uidNext)
}

func stateOf(sel *imap.SelectData) mailboxState {
	return mailboxState{exists: sel.NumMessages, uidNext: uint32(sel.UIDNext), highestModSeq: sel.HighestModSeq}
}

// syncFolder brings one folder up to date:
//  1. new mail (UIDs from the cursor's UIDNext up),
//  2. flag changes since the last MODSEQ (CONDSTORE),
//  3. when full: which UIDs still exist (presence ranges), and flags too when the server lacks CONDSTORE,
//  4. a budgeted step of the newest-first history backfill.
//
// The cursor only advances after the API accepted the work it describes, so a crash never skips mail.
func (s *session) syncFolder(ctx context.Context, run *folderRun, full bool) error {
	sel, err := s.client.Select(run.folder.RemoteName, &imap.SelectOptions{ReadOnly: true, CondStore: s.condStore}).Wait()
	if refusedByServer(err) {
		return fmt.Errorf("%w: select %q: %w", errFolderUnavailable, run.folder.RemoteName, err)
	}
	if err != nil {
		return fmt.Errorf("select %q: %w", run.folder.RemoteName, err)
	}
	uidNext := uint32(sel.UIDNext)
	if uidNext == 0 {
		// RFC 3501 lets a server leave UIDNEXT out. Without it nothing would ever look new: take the highest UID.
		if uidNext, err = s.highestUIDNext(); err != nil {
			return err
		}
	}
	run.modSeq = sel.HighestModSeq > 0

	if run.cursor != nil && sel.UIDValidity != run.cursor.UIDValidity {
		return errFoldersChanged
	}
	// Fewer messages than the last sync left plus the UIDs added since means something was expunged in between: only
	// the presence check finds out what. Without it a CONDSTORE server's deletions would wait for PresenceInterval.
	// (Without CONDSTORE updates get a full check anyway, at most every UpdatePresenceInterval.)
	if s.condStoreIn(run) && run.cursor != nil && expungedBetween(run.seen, stateOf(sel)) {
		full = true
	}
	run.seen = stateOf(sel)

	dirty := false
	if run.cursor == nil {
		run.cursor = &Cursor{UIDValidity: sel.UIDValidity, UIDNext: uidNext, BackfillBelow: uidNext, HighestModSeq: sel.HighestModSeq}
		dirty = true
		full = false // nothing stored yet to compare against
	}
	cursor := run.cursor

	// 1. New mail.
	if uidNext > cursor.UIDNext {
		uids, err := s.searchUIDs(&imap.UIDSet{imap.UIDRange{Start: imap.UID(cursor.UIDNext), Stop: imap.UID(uidNext - 1)}})
		if err != nil {
			return err
		}
		if err := s.ingest(ctx, run, uids, func(group []imap.UID) { cursor.UIDNext = max(cursor.UIDNext, uint32(slices.Max(group))+1) }); err != nil {
			return err
		}
		if cursor.UIDNext != uidNext {
			cursor.UIDNext = uidNext
			dirty = true
		}
	}

	// Placeholders whose message is due for another try.
	if changed, err := s.retryPlaceholders(ctx, run); err != nil {
		return err
	} else if changed {
		dirty = true
	}

	// 2. Flag changes since the last known MODSEQ.
	if s.condStore && sel.HighestModSeq > cursor.HighestModSeq {
		if cursor.HighestModSeq > 0 && cursor.UIDNext > 1 {
			if err := s.syncChangedFlags(ctx, run, sel.HighestModSeq); err != nil {
				return err
			}
			dirty = false
		} else {
			cursor.HighestModSeq = sel.HighestModSeq
			dirty = true
		}
	}

	// 3 and 4 need the folder's complete UID list.
	if full || !cursor.BackfillDone() {
		all, err := s.searchUIDs(nil)
		if err != nil {
			return err
		}
		if full {
			if err := s.reportPresence(ctx, run, all); err != nil {
				return err
			}
			run.lastPresence = time.Now()
			dirty = false
		}
		if !cursor.BackfillDone() {
			if err := s.backfill(ctx, run, all); err != nil {
				return err
			}
			dirty = false
		}
	}

	if dirty {
		_, err := s.api.Changes(ctx, s.account.ID, api.ChangeBatch{WorkerID: s.workerID, Folder: run.folder.RemoteName, Cursor: s.cursorString(run)})
		return err
	}
	return nil
}

// backfill ingests a budgeted number of batches of older mail, newest first.
func (s *session) backfill(ctx context.Context, run *folderRun, all []imap.UID) error {
	cursor := run.cursor
	cut, _ := slices.BinarySearch(all, imap.UID(cursor.BackfillBelow))
	older := all[:cut]

	for budget := s.opts.BackfillBatchesPerPass; budget > 0 && len(older) > 0; budget-- {
		start := max(0, len(older)-s.opts.FetchBatch)
		group := older[start:]
		older = older[:start]
		if err := s.ingest(ctx, run, group, func(done []imap.UID) {
			cursor.BackfillBelow = min(cursor.BackfillBelow, uint32(slices.Min(done)))
		}); err != nil {
			return err
		}
	}

	if len(older) == 0 && !cursor.BackfillDone() {
		cursor.BackfillBelow = 1
		_, err := s.api.Changes(ctx, s.account.ID, api.ChangeBatch{WorkerID: s.workerID, Folder: run.folder.RemoteName, Cursor: s.cursorString(run)})
		return err
	}
	return nil
}

// ingest fetches messages in groups bounded by count and bytes, stores them and reports them with the cursor.
func (s *session) ingest(ctx context.Context, run *folderRun, uids []imap.UID, advance func(group []imap.UID)) error {
	if len(uids) == 0 {
		return nil
	}
	sizes, err := s.client.Fetch(imap.UIDSetNum(uids...), &imap.FetchOptions{UID: true, RFC822Size: true}).Collect()
	if err != nil {
		return fmt.Errorf("fetch sizes: %w", err)
	}
	sizeOf := make(map[imap.UID]int64, len(sizes))
	for _, m := range sizes {
		sizeOf[m.UID] = m.RFC822Size
	}

	var group []imap.UID
	var groupBytes int64
	flush := func() error {
		if len(group) == 0 {
			return nil
		}
		err := s.ingestGroup(ctx, run, group, advance)
		group, groupBytes = nil, 0
		return err
	}

	for _, uid := range uids {
		size, exists := sizeOf[uid]
		if !exists {
			continue // expunged meanwhile
		}
		if len(group) > 0 && (len(group) >= s.opts.FetchBatch || groupBytes+size > s.opts.MaxBatchBytes) {
			if err := flush(); err != nil {
				return err
			}
		}
		group = append(group, uid)
		groupBytes += size
	}
	return flush()
}

func (s *session) ingestGroup(ctx context.Context, run *folderRun, group []imap.UID, advance func(group []imap.UID)) error {
	fetched, failed, err := s.fetchGroup(run, group)
	if err != nil {
		return err
	}

	messages := make([]api.Message, 0, len(fetched))
	for _, buf := range fetched {
		msg, err := buildMessage(ctx, s.store, s.account.ID, buf, s.condStoreIn(run), s.logger.With("folder", run.folder.RemoteName))
		if errors.Is(err, errNoBody) {
			failed = append(failed, s.unreadable(run, buf.UID, buf.InternalDate, flagsOf(buf.Flags), err))
			continue
		}
		if err != nil {
			return err
		}
		messages = append(messages, msg)
	}
	placeholders, err := isolate.Unreadable(ctx, s.strikes, failed, len(messages), s.logger)
	if err != nil {
		return err
	}
	messages = append(messages, placeholders...)
	slices.SortFunc(messages, func(a, b api.Message) int { return cmp.Compare(uidOf(a), uidOf(b)) })

	advance(group)
	send := func(ctx context.Context, messages []api.Message, cursor *string) error {
		result, err := s.api.Messages(ctx, s.account.ID, api.MessageBatch{WorkerID: s.workerID, Folder: run.folder.RemoteName, Cursor: cursor, Messages: messages})
		if err == nil {
			s.logger.Debug("ingested", "folder", run.folder.RemoteName, "stored", result.Stored, "linked", result.Linked, "updated", result.Updated)
		}
		return err
	}
	placed := func(uids []string) error {
		run.cursor.Pending = run.cursor.Pending.Add(s.now(), uids...)
		return nil
	}
	return isolate.Batch(ctx, send, s.strikes, run.folder.RemoteName, messages, func() *string { return s.cursorString(run) }, placed, s.logger)
}

// fetchGroup downloads a group of messages. When the server refuses the FETCH (a NO, which a single damaged message
// causes on some servers), the messages are fetched one by one, and those still refused come back as failed.
func (s *session) fetchGroup(run *folderRun, group []imap.UID) (fetched []*imapFetchBuffer, failed []isolate.Failed, err error) {
	fetched, err = s.fetch(run, group)
	var refused *imap.Error
	if err != nil && errors.As(err, &refused) && len(group) > 1 {
		s.logger.Warn("the server refused to fetch a group of messages; fetching them one by one", "folder", run.folder.RemoteName, "error", err)
		fetched = nil
		for _, uid := range group {
			one, err := s.fetch(run, []imap.UID{uid})
			switch {
			case err == nil:
				fetched = append(fetched, one...)
			case errors.As(err, &refused):
				failed = append(failed, s.unreadable(run, uid, time.Time{}, api.Flags{}, err))
			default:
				return nil, nil, err
			}
		}
		err = nil
	} else if err != nil && errors.As(err, &refused) {
		failed = append(failed, s.unreadable(run, group[0], time.Time{}, api.Flags{}, err))
		fetched, err = nil, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("fetch messages: %w", err)
	}
	slices.SortFunc(fetched, func(a, b *imapFetchBuffer) int { return int(a.UID) - int(b.UID) })
	return fetched, failed, nil
}

func (s *session) fetch(run *folderRun, uids []imap.UID) ([]*imapFetchBuffer, error) {
	return s.client.Fetch(imap.UIDSetNum(uids...), &imap.FetchOptions{
		UID:          true,
		Flags:        true,
		InternalDate: true,
		RFC822Size:   true,
		ModSeq:       s.condStoreIn(run),
		BodySection:  []*imap.FetchItemBodySection{{Peek: true}},
	}).Collect()
}

// unreadable describes a message the server would not hand over (a refused FETCH, or one without the body). Like
// every such failure it only counts next to messages that came through (see isolate.Unreadable). When the FETCH was
// refused, the placeholder asks for the date and flags alone, so it does not show up as new unread mail.
func (s *session) unreadable(run *folderRun, uid imap.UID, receivedAt time.Time, flags api.Flags, err error) isolate.Failed {
	remoteUID := uidString(uid)
	return isolate.Failed{
		Folder: run.folder.RemoteName,
		UID:    remoteUID,
		Err:    err,
		Placeholder: func(ctx context.Context) (api.Message, error) {
			if receivedAt.IsZero() {
				if bufs, err := s.client.Fetch(imap.UIDSetNum(uid), &imap.FetchOptions{UID: true, Flags: true, InternalDate: true}).Collect(); err == nil && len(bufs) == 1 {
					receivedAt, flags = bufs[0].InternalDate, flagsOf(bufs[0].Flags)
				}
			}
			identity := fmt.Sprintf("%s\x00%d\x00%s", run.folder.RemoteName, run.cursor.UIDValidity, remoteUID)
			return ingestmsg.Unreadable(ctx, s.store, s.account.ID, identity, remoteUID, receivedAt, flags)
		},
	}
}

// retryPlaceholders tries the messages of the folder's due placeholders again: one that the server now hands over
// and the API takes replaces its placeholder (see isolate.Replace); one that is gone is forgotten; any other waits
// twice as long. It reports whether the cursor changed.
func (s *session) retryPlaceholders(ctx context.Context, run *folderRun) (bool, error) {
	due := run.cursor.Pending.Due(s.now())
	if len(due) == 0 {
		return false, nil
	}
	folder := run.folder.RemoteName
	send := func(ctx context.Context, messages []api.Message, cursor *string) error {
		_, err := s.api.Messages(ctx, s.account.ID, api.MessageBatch{WorkerID: s.workerID, Folder: folder, Cursor: cursor, Messages: messages})
		return err
	}
	vanish := func(ctx context.Context, uid string) error {
		_, err := s.api.Changes(ctx, s.account.ID, api.ChangeBatch{WorkerID: s.workerID, Folder: folder, Vanished: []string{uid}})
		return err
	}
	for _, remoteUID := range due {
		uid, err := strconv.ParseUint(remoteUID, 10, 32)
		if err != nil {
			run.cursor.Pending = run.cursor.Pending.Drop(remoteUID)
			continue
		}
		bufs, err := s.fetch(run, []imap.UID{imap.UID(uid)})
		var refused *imap.Error
		switch {
		case errors.As(err, &refused):
			run.cursor.Pending = run.cursor.Pending.Later(remoteUID, s.now())
			continue
		case err != nil:
			return false, fmt.Errorf("fetch messages: %w", err)
		case len(bufs) == 0:
			// Expunged: the presence check removes the placeholder.
			run.cursor.Pending = run.cursor.Pending.Drop(remoteUID)
			continue
		}
		msg, err := buildMessage(ctx, s.store, s.account.ID, bufs[0], s.condStoreIn(run), s.logger.With("folder", folder))
		if errors.Is(err, errNoBody) {
			run.cursor.Pending = run.cursor.Pending.Later(remoteUID, s.now())
			continue
		}
		if err != nil {
			return false, err
		}
		err = isolate.Replace(ctx, send, vanish, msg)
		switch {
		case err == nil:
			s.logger.Info("a placeholder was replaced by its message", "folder", folder, "uid", remoteUID)
			run.cursor.Pending = run.cursor.Pending.Drop(remoteUID)
		case isolate.Classify(err) == isolate.NotRefused:
			return false, err
		default:
			s.logger.Info("the API still refuses a placeholder's message", "folder", folder, "uid", remoteUID, "error", err)
			run.cursor.Pending = run.cursor.Pending.Later(remoteUID, s.now())
		}
	}
	return true, nil
}

func uidOf(m api.Message) uint64 {
	uid, _ := strconv.ParseUint(m.RemoteUID, 10, 32)
	return uid
}

// syncChangedFlags reports flags of messages changed since the cursor's MODSEQ.
func (s *session) syncChangedFlags(ctx context.Context, run *folderRun, highestModSeq uint64) error {
	cursor := run.cursor
	changed, err := s.client.Fetch(
		imap.UIDSet{imap.UIDRange{Start: 1, Stop: imap.UID(cursor.UIDNext - 1)}},
		&imap.FetchOptions{UID: true, Flags: true, ModSeq: true, ChangedSince: cursor.HighestModSeq},
	).Collect()
	if err != nil {
		return fmt.Errorf("fetch changed flags: %w", err)
	}

	changes := make([]api.FlagChange, 0, len(changed))
	for _, m := range changed {
		modSeq := m.ModSeq
		changes = append(changes, api.FlagChange{RemoteUID: uidString(m.UID), ModSeq: &modSeq, Flags: flagsOf(m.Flags)})
	}
	cursor.HighestModSeq = highestModSeq
	return s.sendFlagChanges(ctx, run, changes)
}

// reportPresence tells the API which UIDs exist, in ranges, so removed messages disappear. Without CONDSTORE it also
// reports every message's flags, as there is no cheaper way to learn about changes.
func (s *session) reportPresence(ctx context.Context, run *folderRun, all []imap.UID) error {
	cursor := run.cursor
	if cursor.UIDNext <= 1 {
		return nil
	}
	last := imap.UID(cursor.UIDNext - 1)
	cut, _ := slices.BinarySearch(all, last+1)
	known := all[:cut]

	var ranges []api.PresenceRange
	from := imap.UID(1)
	for len(known) > 0 {
		n := min(len(known), s.opts.PresenceChunk)
		chunk := known[:n]
		known = known[n:]
		to := chunk[n-1]
		if len(known) == 0 {
			to = last
		}
		ranges = append(ranges, api.PresenceRange{FromUID: uint32(from), ToUID: uint32(to), UIDs: toUint32(chunk)})
		from = to + 1
	}
	if from <= last {
		ranges = append(ranges, api.PresenceRange{FromUID: uint32(from), ToUID: uint32(last), UIDs: []uint32{}})
	}

	for i := 0; i < len(ranges); i += maxRangesPerRequest {
		batch := ranges[i:min(i+maxRangesPerRequest, len(ranges))]
		if _, err := s.api.Changes(ctx, s.account.ID, api.ChangeBatch{WorkerID: s.workerID, Folder: run.folder.RemoteName, Cursor: s.cursorString(run), Presence: batch}); err != nil {
			return err
		}
	}

	if s.condStoreIn(run) || len(all[:cut]) == 0 {
		return nil
	}
	return s.syncAllFlags(ctx, run, all[:cut])
}

func (s *session) syncAllFlags(ctx context.Context, run *folderRun, uids []imap.UID) error {
	for i := 0; i < len(uids); i += maxFlagChangesPerRequest {
		chunk := uids[i:min(i+maxFlagChangesPerRequest, len(uids))]
		fetched, err := s.client.Fetch(imap.UIDSetNum(chunk...), &imap.FetchOptions{UID: true, Flags: true}).Collect()
		if err != nil {
			return fmt.Errorf("fetch flags: %w", err)
		}
		changes := make([]api.FlagChange, 0, len(fetched))
		for _, m := range fetched {
			changes = append(changes, api.FlagChange{RemoteUID: uidString(m.UID), Flags: flagsOf(m.Flags)})
		}
		if err := s.sendFlagChanges(ctx, run, changes); err != nil {
			return err
		}
	}
	return nil
}

// sendFlagChanges reports changes in chunks. It always sends at least one request, which also stores the cursor.
func (s *session) sendFlagChanges(ctx context.Context, run *folderRun, changes []api.FlagChange) error {
	for start := 0; ; start += maxFlagChangesPerRequest {
		end := min(start+maxFlagChangesPerRequest, len(changes))
		batch := api.ChangeBatch{WorkerID: s.workerID, Folder: run.folder.RemoteName, Cursor: s.cursorString(run), Flags: changes[start:end]}
		if _, err := s.api.Changes(ctx, s.account.ID, batch); err != nil {
			return err
		}
		if end >= len(changes) {
			return nil
		}
	}
}

// highestUIDNext is the UIDNEXT of the selected folder for a server that did not report it: one above the highest
// UID, or 1 for an empty folder.
func (s *session) highestUIDNext() (uint32, error) {
	all, err := s.searchUIDs(nil)
	if err != nil {
		return 0, err
	}
	if len(all) == 0 {
		return 1, nil
	}
	return uint32(all[len(all)-1]) + 1, nil
}

func (s *session) searchUIDs(set *imap.UIDSet) ([]imap.UID, error) {
	criteria := &imap.SearchCriteria{}
	if set != nil {
		criteria.UID = []imap.UIDSet{*set}
	}
	data, err := s.client.UIDSearch(criteria, nil).Wait()
	if err != nil {
		return nil, fmt.Errorf("uid search: %w", err)
	}
	uids := data.AllUIDs()
	slices.Sort(uids)
	return uids, nil
}

func (s *session) cursorString(run *folderRun) *string {
	encoded := run.cursor.Encode()
	return &encoded
}

func toUint32(uids []imap.UID) []uint32 {
	out := make([]uint32, len(uids))
	for i, uid := range uids {
		out[i] = uint32(uid)
	}
	return out
}

func uidString(uid imap.UID) string {
	return fmt.Sprintf("%d", uid)
}

const (
	maxRangesPerRequest      = 50
	maxFlagChangesPerRequest = 2000
)
