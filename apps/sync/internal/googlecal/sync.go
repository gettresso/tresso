package googlecal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"tresso/sync/internal/api"
	"tresso/sync/internal/calsync"
	"tresso/sync/internal/providerhttp"
)

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func (s *session) Calendars(ctx context.Context) ([]calsync.Calendar, error) {
	query := url.Values{"maxResults": {"250"}}
	var out []calsync.Calendar
	for range maxPages {
		var page struct {
			Items         []calendarListEntry `json:"items"`
			NextPageToken string              `json:"nextPageToken"`
		}
		if err := s.get(ctx, s.base+"/users/me/calendarList", query, &page); err != nil {
			return nil, err
		}
		for _, entry := range page.Items {
			// Free/busy only calendars have no events to show.
			if entry.Deleted || entry.AccessRole == "freeBusyReader" {
				continue
			}
			name := entry.SummaryOverride
			if name == "" {
				name = entry.Summary
			}
			remote := api.RemoteCalendar{RemoteID: entry.ID, Name: name, Writable: entry.AccessRole == "owner" || entry.AccessRole == "writer", IsDefault: entry.Primary}
			if hexColor.MatchString(entry.BackgroundColor) {
				color := strings.ToLower(entry.BackgroundColor)
				remote.Color = &color
			}
			if entry.TimeZone != "" {
				zone := entry.TimeZone
				remote.TimeZone = &zone
			}
			if remote.Writable && entry.ConferenceProperties != nil {
				for _, kind := range entry.ConferenceProperties.AllowedConferenceSolutionTypes {
					if kind == "hangoutsMeet" {
						remote.ConferenceProviders = []string{"meet"}
					}
				}
			}
			out = append(out, calsync.Calendar{RemoteCalendar: remote, Data: calendarInfo{TimeZone: entry.TimeZone, DefaultReminders: entry.DefaultReminders}})
		}
		if page.NextPageToken == "" {
			return out, nil
		}
		query.Set("pageToken", page.NextPageToken)
	}
	return nil, errTooManyPages
}

func info(calendar calsync.Calendar) calendarInfo {
	if data, ok := calendar.Data.(calendarInfo); ok {
		return data
	}
	return calendarInfo{}
}

type cursor struct {
	SyncToken string `json:"syncToken"`
}

func (s *session) Changes(ctx context.Context, calendar calsync.Calendar, raw string) (calsync.Changes, error) {
	var stored cursor
	if raw != "" {
		_ = json.Unmarshal([]byte(raw), &stored)
	}
	if stored.SyncToken != "" {
		changes, err := s.incremental(ctx, calendar, stored.SyncToken)
		// 410: the token expired, a full sync is needed (Google's fullSyncRequired).
		if err == nil || !providerhttp.IsStatus(err, http.StatusGone) {
			return changes, err
		}
	}
	items, token, err := s.listEvents(ctx, calendar.RemoteID, url.Values{})
	if err != nil {
		return calsync.Changes{}, err
	}
	objects, err := s.objects(calendar, group(items))
	if err != nil {
		return calsync.Changes{}, err
	}
	return calsync.Changes{Full: true, Objects: objects, Cursor: encodeCursor(token)}, nil
}

func encodeCursor(token string) string {
	data, _ := json.Marshal(cursor{SyncToken: token})
	return string(data)
}

// incremental reads what changed since the token. A changed exception changes its whole series, which is read again
// so the resource sent is complete.
func (s *session) incremental(ctx context.Context, calendar calsync.Calendar, token string) (calsync.Changes, error) {
	items, next, err := s.listEvents(ctx, calendar.RemoteID, url.Values{"syncToken": {token}})
	if err != nil {
		return calsync.Changes{}, err
	}
	if len(items) == 0 {
		if next == token {
			return calsync.Changes{Unchanged: true}, nil
		}
		return calsync.Changes{Cursor: encodeCursor(next)}, nil
	}
	changes := calsync.Changes{Cursor: encodeCursor(next)}
	seen := map[string]bool{}
	for _, item := range items {
		id := objectID(item)
		if seen[id] {
			continue
		}
		seen[id] = true
		if item.RecurringEventID == "" && item.cancelled() {
			changes.Removed = append(changes.Removed, id)
			continue
		}
		if item.RecurringEventID == "" && len(item.Recurrence) == 0 {
			if object, ok := s.object(calendar, id, series{master: &item}); ok {
				changes.Objects = append(changes.Objects, object)
			}
			continue
		}
		current, found, err := s.series(ctx, calendar.RemoteID, id, item.ICalUID)
		if err != nil {
			return calsync.Changes{}, err
		}
		if !found {
			changes.Removed = append(changes.Removed, id)
			continue
		}
		// An event that cannot be converted keeps its stored copy: neither changed nor removed.
		if object, ok := s.object(calendar, id, current); ok {
			changes.Objects = append(changes.Objects, object)
		}
	}
	return changes, nil
}

// group sorts listed events into resources.
func group(items []event) map[string]*series {
	byID := map[string]*series{}
	for _, item := range items {
		id := objectID(item)
		entry := byID[id]
		if entry == nil {
			entry = &series{}
			byID[id] = entry
		}
		if item.RecurringEventID == "" {
			master := item
			entry.master = &master
		} else {
			entry.exceptions = append(entry.exceptions, item)
		}
	}
	return byID
}

// objects is a full listing. An event that cannot be converted is still listed, without its text, so the API keeps
// the copy it has instead of removing it; its fetch converts it again and leaves it out once more.
func (s *session) objects(calendar calsync.Calendar, byID map[string]*series) ([]calsync.Object, error) {
	var out []calsync.Object
	for id, entry := range byID {
		if !entry.exists() {
			continue
		}
		if object, ok := s.object(calendar, id, *entry); ok {
			out = append(out, object)
			continue
		}
		out = append(out, calsync.Object{RemoteID: id, ETag: entry.etag()})
	}
	return out, nil
}

// object converts a resource. ok is false for a deleted one, and for one iCalendar cannot describe, which is logged
// and skipped rather than holding up the calendar.
func (s *session) object(calendar calsync.Calendar, id string, entry series) (calsync.Object, bool) {
	if !entry.exists() {
		return calsync.Object{}, false
	}
	text, err := entry.toICalendar(info(calendar))
	if err != nil {
		s.logger.Info("skipping a Google event that cannot be converted", "event", id, "error", err)
		return calsync.Object{}, false
	}
	return calsync.Object{RemoteID: id, ETag: entry.etag(), Ical: text}, true
}

// instance reads one occurrence of a series by its instance id.
func (s *session) instance(ctx context.Context, calendarID, id string) (event, bool, error) {
	var instance event
	err := s.get(ctx, s.calendarURL(calendarID, id), nil, &instance)
	if providerhttp.IsStatus(err, http.StatusNotFound) || providerhttp.IsStatus(err, http.StatusGone) {
		return event{}, false, nil
	}
	return instance, err == nil, err
}

// series reads a resource with its exceptions: the master by id, then everything with its iCalendar UID.
func (s *session) series(ctx context.Context, calendarID, id, uid string) (series, bool, error) {
	var master event
	err := s.get(ctx, s.calendarURL(calendarID, id), nil, &master)
	switch {
	case providerhttp.IsStatus(err, http.StatusNotFound), providerhttp.IsStatus(err, http.StatusGone):
		if uid == "" {
			return series{}, false, nil
		}
	case err != nil:
		return series{}, false, err
	default:
		uid = master.ICalUID
	}
	if uid == "" {
		if master.cancelled() {
			return series{}, false, nil
		}
		return series{master: &master}, true, nil
	}
	items, _, err := s.listEvents(ctx, calendarID, url.Values{"iCalUID": {uid}})
	if err != nil {
		return series{}, false, err
	}
	entry := series{}
	for _, item := range items {
		if objectID(item) != id {
			continue
		}
		if item.RecurringEventID == "" {
			found := item
			entry.master = &found
		} else {
			entry.exceptions = append(entry.exceptions, item)
		}
	}
	if entry.master == nil && master.ID == id {
		entry.master = &master
	}
	return entry, entry.exists(), nil
}

// exists: the resource has a master that is not deleted, or (for an occurrence the user was invited to alone)
// an exception that is not cancelled.
func (s series) exists() bool {
	if s.master != nil {
		return !s.master.cancelled()
	}
	for _, exception := range s.exceptions {
		if !exception.cancelled() {
			return true
		}
	}
	return false
}

func (s *session) Fetch(ctx context.Context, calendar calsync.Calendar, remoteIDs []string) ([]calsync.Object, error) {
	var out []calsync.Object
	var skipped *calsync.FetchError
	for _, id := range remoteIDs {
		entry, found, err := s.series(ctx, calendar.RemoteID, id, "")
		if skip, transient := calsync.EventFailure(err, (&Provider{}).NotGranted); err != nil && skip {
			s.logger.Warn("an event could not be fetched; leaving it out", "event", id, "error", err)
			skipped = skipped.Add(err, transient)
			continue
		}
		if err != nil {
			return nil, err
		}
		if !found {
			continue
		}
		if object, ok := s.object(calendar, id, entry); ok {
			out = append(out, object)
		}
	}
	if skipped != nil {
		return out, skipped
	}
	return out, nil
}
