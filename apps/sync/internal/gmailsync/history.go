package gmailsync

import (
	"context"
	"net/http"

	"tresso/sync/internal/api"
	"tresso/sync/internal/providerhttp"
	"tresso/sync/internal/providersync"
)

// historyRound applies Gmail's history since the cursor: every message it mentions is looked up (labels only), then
// linked to the folders it is in now and removed from the folders it left. An expired history id (404) leads to a full
// resync.
func (s *session) historyRound(ctx context.Context) error {
	mentioned := map[string]map[string]bool{} // message id -> label ids history named for it
	var order []string
	unknownLabel := false
	note := func(m historyMessage, labelIDs ...[]string) {
		if m.ID == "" {
			return
		}
		labels, ok := mentioned[m.ID]
		if !ok {
			labels = map[string]bool{}
			mentioned[m.ID] = labels
			order = append(order, m.ID)
		}
		for _, list := range append(labelIDs, m.LabelIDs) {
			for _, id := range list {
				labels[id] = true
				if !s.labels[id] {
					unknownLabel = true
				}
			}
		}
	}

	var latest, pageToken string
	for {
		page, err := s.gmail.history(ctx, s.cursor.HistoryID, pageToken)
		if providerhttp.IsStatus(err, http.StatusNotFound) {
			s.logger.Info("gmail history expired, resyncing the account", "historyId", s.cursor.HistoryID)
			return s.fullResync(ctx)
		}
		if err != nil {
			return err
		}
		for _, record := range page.History {
			for _, m := range record.Messages {
				note(m)
			}
			for _, added := range record.MessagesAdded {
				note(added.Message)
			}
			for _, deleted := range record.MessagesDeleted {
				note(deleted.Message)
			}
			for _, change := range record.LabelsAdded {
				note(change.Message, change.LabelIDs)
			}
			for _, change := range record.LabelsRemoved {
				note(change.Message, change.LabelIDs)
			}
		}
		if page.NextPageToken == "" {
			latest = page.HistoryID
			break
		}
		pageToken = page.NextPageToken
	}

	if unknownLabel {
		if err := s.refreshFolders(ctx); err != nil {
			return err
		}
		if s.cursor == nil {
			return nil // the API reset the account; the next step starts it again
		}
	}

	for start := 0; start < len(order); start += max(1, s.opts.ChangeChunk) {
		chunk := order[start:min(start+max(1, s.opts.ChangeChunk), len(order))]
		if err := s.applyTouched(ctx, chunk, mentioned); err != nil {
			return err
		}
	}

	if latest == "" || latest == s.cursor.HistoryID {
		return nil
	}
	next := *s.cursor
	next.HistoryID = latest
	if err := s.storeCursor(ctx, &next); err != nil {
		return err
	}
	s.cursor = &next
	return nil
}

// applyTouched brings messages that history mentioned up to date in every folder. A message can only have left the
// folders of the labels history named for it (and All Mail, which it leaves by moving to Trash or Spam); a deleted
// message leaves every folder.
func (s *session) applyTouched(ctx context.Context, ids []string, mentioned map[string]map[string]bool) error {
	labels, gone, err := s.labelsOf(ctx, ids)
	if err != nil {
		return err
	}
	if s.hasUnknownLabel(labels) {
		if err := s.refreshFolders(ctx); err != nil {
			return err
		}
	}

	adds := map[string][]api.FlagChange{}
	removes := map[string][]string{}
	for _, id := range ids {
		if gone[id] {
			for _, f := range s.folders {
				removes[f.RemoteName] = append(removes[f.RemoteName], id)
			}
			continue
		}
		current := labels[id]
		in := map[string]bool{}
		for _, folder := range foldersOf(current, s.isFolder) {
			in[folder] = true
			adds[folder] = append(adds[folder], api.FlagChange{RemoteUID: id, Flags: flagsOf(current)})
		}
		candidates := []string{allMailFolder}
		hidden := false
		for labelID := range mentioned[id] {
			if s.isFolder[labelID] {
				candidates = append(candidates, labelID)
			}
			hidden = hidden || hidingLabel(labelID)
		}
		if hidden {
			// Into or out of Trash or Spam: the message left, or came back to, the other folders. It can only have
			// been in those of the labels it still has (Gmail keeps a trashed message's labels) and of those history
			// named (a label taken off). Every other folder never had it, and asking each of them (hundreds of
			// labels on some accounts) to remove it would cost a request per folder.
			for _, labelID := range current {
				if s.isFolder[labelID] {
					candidates = append(candidates, labelID)
				}
			}
		}
		for _, folder := range candidates {
			if !in[folder] {
				removes[folder] = append(removes[folder], id)
				in[folder] = true // listed once
			}
		}
	}
	return s.apply(ctx, adds, removes)
}

func (s *session) hasUnknownLabel(labels map[string][]string) bool {
	for _, list := range labels {
		for _, id := range list {
			if !s.labels[id] {
				return true
			}
		}
	}
	return false
}

// apply sends flag changes (downloading what the API does not know) for every folder, then the removals.
func (s *session) apply(ctx context.Context, adds map[string][]api.FlagChange, removes map[string][]string) error {
	fetch := s.fetcher(providersync.NewMessageCache(providersync.DefaultCacheSize))
	for _, f := range s.folders {
		if changes := adds[f.RemoteName]; len(changes) > 0 {
			if err := s.ingest.ApplyFlags(ctx, f.RemoteName, changes, fetch); err != nil {
				return err
			}
		}
	}
	for _, f := range s.folders {
		if ids := removes[f.RemoteName]; len(ids) > 0 {
			if err := s.ingest.Vanish(ctx, f.RemoteName, ids, nil); err != nil {
				return err
			}
		}
	}
	return nil
}

// fullResync rebuilds every folder from Gmail's listings when history is no longer available: flags for every listed
// message (downloading the ones the API does not know), then removal of what the API has but Gmail no longer lists.
// The history id is taken before listing, so changes made meanwhile are applied by the next history round.
func (s *session) fullResync(ctx context.Context) error {
	historyID, err := s.gmail.profile(ctx)
	if err != nil {
		return err
	}
	if err := s.refreshFolders(ctx); err != nil {
		return err
	}
	if s.cursor == nil {
		return nil
	}

	unread, err := s.listSet(ctx, labelUnread, true)
	if err != nil {
		return err
	}
	starred, err := s.listSet(ctx, labelStarred, true)
	if err != nil {
		return err
	}
	drafts, err := s.listSet(ctx, labelDraft, true)
	if err != nil {
		return err
	}

	listings := make(map[string][]string, len(s.folders))
	for _, f := range s.folders {
		var ids []string
		switch {
		case f.RemoteName == allMailFolder:
			ids, err = s.gmail.listAll(ctx, "", false)
		case hidingLabel(f.RemoteName):
			ids, err = s.gmail.listAll(ctx, f.RemoteName, true)
		default:
			// Without Trash and Spam, which hide a message from its other labels (see foldersOf).
			ids, err = s.gmail.listAll(ctx, f.RemoteName, false)
		}
		if err != nil {
			return err
		}
		listings[f.RemoteName] = ids
	}

	fetch := s.fetcher(providersync.NewMessageCache(providersync.DefaultCacheSize))
	for _, f := range s.folders {
		ids := listings[f.RemoteName]
		changes := make([]api.FlagChange, 0, len(ids))
		for _, id := range ids {
			changes = append(changes, api.FlagChange{RemoteUID: id, Flags: api.Flags{Seen: !unread[id], Flagged: starred[id], Draft: drafts[id]}})
		}
		if err := s.ingest.ApplyFlags(ctx, f.RemoteName, changes, fetch); err != nil {
			return err
		}
	}
	for _, f := range s.folders {
		present := make(map[string]bool, len(listings[f.RemoteName]))
		for _, id := range listings[f.RemoteName] {
			present[id] = true
		}
		missing, err := s.ingest.Missing(ctx, f.RemoteName, present)
		if err != nil {
			return err
		}
		if err := s.ingest.Vanish(ctx, f.RemoteName, missing, nil); err != nil {
			return err
		}
	}

	// Every message is in now, so a backfill that was still running is complete as well.
	next := Cursor{HistoryID: historyID, BackfillDone: true}
	if err := s.storeCursor(ctx, &next); err != nil {
		return err
	}
	s.cursor = &next
	s.logger.Info("gmail account resynced", "historyId", historyID)
	return nil
}

func (s *session) listSet(ctx context.Context, labelID string, includeSpamTrash bool) (map[string]bool, error) {
	ids, err := s.gmail.listAll(ctx, labelID, includeSpamTrash)
	if err != nil {
		return nil, err
	}
	set := make(map[string]bool, len(ids))
	for _, id := range ids {
		set[id] = true
	}
	return set, nil
}
