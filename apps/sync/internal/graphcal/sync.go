package graphcal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"tresso/sync/internal/calsync"
	"tresso/sync/internal/ical"
	"tresso/sync/internal/providerhttp"
)

// cursor is the calendar's delta link and when the calendar was last listed in full.
type cursor struct {
	DeltaLink string    `json:"deltaLink"`
	ListedAt  time.Time `json:"listedAt"`
}

// The delta window, and how often the calendar is listed even when the delta reports nothing (Graph only promises
// changes inside its window, and the listing is the authority).
const (
	windowBack   = 365 * 24 * time.Hour
	windowAhead  = 5 * 365 * 24 * time.Hour
	relistAfter  = 24 * time.Hour
	deltaPageMax = "odata.maxpagesize=200"
)

// now is the clock, replaced in tests.
var now = time.Now

func (s *session) Changes(ctx context.Context, calendar calsync.Calendar, raw string) (calsync.Changes, error) {
	var stored cursor
	if raw != "" {
		_ = json.Unmarshal([]byte(raw), &stored)
	}
	if stored.DeltaLink != "" && s.sameHost(stored.DeltaLink) && now().Sub(stored.ListedAt) < relistAfter {
		changed, link, err := s.delta(ctx, stored.DeltaLink)
		switch {
		case err == nil && !changed:
			return calsync.Changes{Unchanged: true}, nil
		case err == nil:
			return s.listing(ctx, calendar, link)
		case !expired(err):
			return calsync.Changes{}, err
		}
	}
	// A new round: the delta link first, so changes made during the listing show in the next round.
	start := now().UTC()
	first := eventsPath(calendar.RemoteID)
	first = strings.TrimSuffix(first, "/events") + "/calendarView/delta?" + url.Values{
		"startDateTime": {start.Add(-windowBack).Format("2006-01-02T15:04:05")},
		"endDateTime":   {start.Add(windowAhead).Format("2006-01-02T15:04:05")},
	}.Encode()
	_, link, err := s.delta(ctx, first)
	if err != nil {
		return calsync.Changes{}, err
	}
	return s.listing(ctx, calendar, link)
}

// expired: Graph no longer knows the delta token and a new round is needed.
func expired(err error) bool {
	var statusErr *providerhttp.StatusError
	return providerhttp.IsStatus(err, http.StatusGone) ||
		(errorsAs(err, &statusErr) && (statusErr.HasReason("syncStateNotFound") || statusErr.HasReason("resyncRequired") || statusErr.HasReason("SyncStateInvalid")))
}

// delta follows a delta round to its end; changed says whether any page named an event.
func (s *session) delta(ctx context.Context, link string) (changed bool, deltaLink string, err error) {
	next := link
	for range maxPages {
		var page struct {
			Value     []json.RawMessage `json:"value"`
			NextLink  string            `json:"@odata.nextLink"`
			DeltaLink string            `json:"@odata.deltaLink"`
		}
		if err := s.request(ctx, http.MethodGet, next, nil, &page, deltaPageMax); err != nil {
			return false, "", err
		}
		changed = changed || len(page.Value) > 0
		switch {
		case page.DeltaLink != "":
			if !s.sameHost(page.DeltaLink) {
				return false, "", errForeignLink
			}
			return changed, page.DeltaLink, nil
		case page.NextLink != "":
			if !s.sameHost(page.NextLink) {
				return false, "", errForeignLink
			}
			next = page.NextLink
		default:
			return false, "", errNoDeltaLink
		}
	}
	return false, "", errTooManyPages
}

// listing lists every single event and series master with its changeKey; the API names what to fetch.
func (s *session) listing(ctx context.Context, calendar calsync.Calendar, deltaLink string) (calsync.Changes, error) {
	next := eventsPath(calendar.RemoteID) + "?$top=200&$select=id,changeKey,originalStartTimeZone"
	var objects []calsync.Object
	for range maxPages {
		var page struct {
			Value []struct {
				ID                    string `json:"id"`
				ChangeKey             string `json:"changeKey"`
				OriginalStartTimeZone string `json:"originalStartTimeZone"`
			} `json:"value"`
			NextLink string `json:"@odata.nextLink"`
		}
		if err := s.request(ctx, http.MethodGet, next, nil, &page); err != nil {
			return calsync.Changes{}, err
		}
		for _, item := range page.Value {
			if item.ID == "" || item.ChangeKey == "" {
				continue
			}
			s.remember(item.ID, item.OriginalStartTimeZone)
			objects = append(objects, calsync.Object{RemoteID: item.ID, ETag: item.ChangeKey})
		}
		if page.NextLink == "" {
			data, _ := json.Marshal(cursor{DeltaLink: deltaLink, ListedAt: now().UTC()})
			return calsync.Changes{Full: true, Objects: objects, Cursor: string(data)}, nil
		}
		if !s.sameHost(page.NextLink) {
			return calsync.Changes{}, errForeignLink
		}
		next = page.NextLink
	}
	return calsync.Changes{}, errTooManyPages
}

const eventFields = "id,changeKey,iCalUId,type,seriesMasterId,originalStart,originalStartTimeZone,lastModifiedDateTime,subject,body,start,end,isAllDay,isCancelled,isOrganizer,organizer,attendees,location,showAs,sensitivity,isReminderOn,reminderMinutesBeforeStart,recurrence,responseStatus,isOnlineMeeting,onlineMeetingProvider,onlineMeeting"

// fetch reads one event as a resource: a series with its exceptions and cancelled occurrences, times in the zone the
// event was made in. found is false when it is gone.
func (s *session) fetch(ctx context.Context, calendarID, id string) (event, bool, error) {
	zoneName, known := s.zoneHint(id)
	if !known {
		var probe struct {
			OriginalStartTimeZone string `json:"originalStartTimeZone"`
		}
		err := s.request(ctx, http.MethodGet, eventPath(calendarID, id)+"?$select=originalStartTimeZone", nil, &probe)
		if gone(err) {
			return event{}, false, nil
		}
		if err != nil {
			return event{}, false, err
		}
		zoneName = probe.OriginalStartTimeZone
		s.remember(id, zoneName)
	}
	query := url.Values{
		"$select": {eventFields + ",cancelledOccurrences,exceptionOccurrences"},
		"$expand": {"exceptionOccurrences($select=" + eventFields + "),singleValueExtendedProperties($filter=id eq '" + uidProperty + "')"},
	}
	var e event
	err := s.request(ctx, http.MethodGet, eventPath(calendarID, id)+"?"+query.Encode(), nil, &e,
		`outlook.timezone="`+preferZone(zoneName)+`"`, `outlook.body-content-type="text"`)
	if gone(err) {
		return event{}, false, nil
	}
	if err != nil {
		return event{}, false, err
	}
	return e, true, nil
}

// preferZone is the zone to read an event in: the name Graph gave when Tresso knows that zone, else UTC. A time read
// in a zone Tresso cannot place would be taken for UTC and move the event.
func preferZone(name string) string {
	if name == "" || strings.HasPrefix(name, "tzone://") || strings.ContainsAny(name, `"\`) {
		return "UTC"
	}
	if _, _, err := ical.ZoneOf(name); err != nil {
		return "UTC"
	}
	return name
}

func gone(err error) bool {
	return providerhttp.IsStatus(err, http.StatusNotFound) || providerhttp.IsStatus(err, http.StatusGone)
}

func (s *session) Fetch(ctx context.Context, calendar calsync.Calendar, remoteIDs []string) ([]calsync.Object, error) {
	var out []calsync.Object
	var skipped *calsync.FetchError
	for _, id := range remoteIDs {
		e, found, err := s.fetch(ctx, calendar.RemoteID, id)
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
		object, ok := s.object(e)
		if ok {
			out = append(out, object)
		}
	}
	if skipped != nil {
		return out, skipped
	}
	return out, nil
}

// object converts a fetched event; an event Graph describes in a way iCalendar cannot is left out, not retried.
func (s *session) object(e event) (calsync.Object, bool) {
	text, err := toICalendar(e, s.self())
	if err != nil {
		return calsync.Object{}, false
	}
	return calsync.Object{RemoteID: e.ID, ETag: e.ChangeKey, Ical: text}, true
}
