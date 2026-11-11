package googlecal

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"tresso/sync/internal/ical"
)

// fakeGoogle is a small Google Calendar API v3: one user with calendars, events with exceptions, sync tokens and
// conditional writes.
type fakeGoogle struct {
	t      *testing.T
	mu     sync.Mutex
	server *httptest.Server

	calendars []calendarListEntry
	events    map[string]map[string]*fakeEvent // by calendar, then id
	version   int
	// oldest is the first version a sync token is still good for; older ones answer 410.
	oldest   int
	pageSize int
	requests []fakeRequest
	// forbidden answers every request with 403 insufficientPermissions.
	forbidden bool
	// refusedCalendars answer 403 for their events, as a calendar shared with the user and taken back does.
	refusedCalendars map[string]bool
	// failures answers requests whose method and path end like the key with that status, once each; refusals do so
	// every time.
	failures map[string]int
	refusals map[string]int
	// beforeGet runs, with the fake locked, before every GET, as a change someone makes at Google meanwhile.
	beforeGet func(path string)
	// beforeWrite does the same before every other request.
	beforeWrite func(method, path string)
}

type fakeEvent struct {
	event
	changed int // the version of its last change
}

type fakeRequest struct {
	Method, Path string
	Query        map[string]string
	IfMatch      string
	Body         map[string]any
}

func newFakeGoogle(t *testing.T) *fakeGoogle {
	f := &fakeGoogle{t: t, events: map[string]map[string]*fakeEvent{}, pageSize: 250, refusedCalendars: map[string]bool{}, failures: map[string]int{}}
	f.addCalendar(calendarListEntry{ID: "kim@example.com", Summary: "Kim", BackgroundColor: "#9FC6E7", TimeZone: "Europe/Amsterdam", AccessRole: "owner", Primary: true,
		DefaultReminders: []reminder{{Method: "popup", Minutes: 10}},
		ConferenceProperties: &struct {
			AllowedConferenceSolutionTypes []string `json:"allowedConferenceSolutionTypes"`
		}{AllowedConferenceSolutionTypes: []string{"hangoutsMeet"}}})
	f.server = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeGoogle) addCalendar(entry calendarListEntry) {
	f.calendars = append(f.calendars, entry)
	f.events[entry.ID] = map[string]*fakeEvent{}
}

// put stores an event as if a Google client changed it.
func (f *fakeGoogle) put(calendarID string, e event) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.store(calendarID, e)
}

func (f *fakeGoogle) store(calendarID string, e event) *fakeEvent {
	f.version++
	e.ETag = fmt.Sprintf(`"%d"`, f.version)
	e.Updated = time.Date(2026, 10, 1, 0, 0, f.version, 0, time.UTC).Format(time.RFC3339)
	if e.Status == "" {
		e.Status = "confirmed"
	}
	stored := &fakeEvent{event: e, changed: f.version}
	f.events[calendarID][e.ID] = stored
	return stored
}

func (f *fakeGoogle) get(calendarID, id string) (event, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	e, ok := f.events[calendarID][id]
	if !ok {
		return event{}, false
	}
	return e.event, true
}

// forget makes every sync token so far expire, as Google does after a while.
func (f *fakeGoogle) forget() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.oldest = f.version + 1
}

func (f *fakeGoogle) writes() []fakeRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []fakeRequest
	for _, r := range f.requests {
		if r.Method != http.MethodGet {
			out = append(out, r)
		}
	}
	return out
}

// fail answers an error as Google does: every 403 has the status PERMISSION_DENIED, and only a token without the
// scopes says ACCESS_TOKEN_SCOPE_INSUFFICIENT in its details.
func (f *fakeGoogle) fail(w http.ResponseWriter, status int, reason string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body := map[string]any{"code": status, "errors": []map[string]string{{"reason": reason}}}
	if status == http.StatusForbidden {
		body["status"] = "PERMISSION_DENIED"
	}
	if reason == "insufficientPermissions" {
		body["details"] = []map[string]string{{"reason": "ACCESS_TOKEN_SCOPE_INSUFFICIENT"}}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"error": body})
}

func (f *fakeGoogle) reply(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func (f *fakeGoogle) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer token" {
		f.fail(w, http.StatusUnauthorized, "authError")
		return
	}
	request := fakeRequest{Method: r.Method, Path: r.URL.Path, Query: map[string]string{}, IfMatch: r.Header.Get("If-Match")}
	for key := range r.URL.Query() {
		request.Query[key] = r.URL.Query().Get(key)
	}
	body, _ := io.ReadAll(r.Body)
	if len(body) > 0 {
		_ = json.Unmarshal(body, &request.Body)
	}
	f.requests = append(f.requests, request)
	if f.forbidden {
		f.fail(w, http.StatusForbidden, "insufficientPermissions")
		return
	}
	if f.beforeGet != nil && r.Method == http.MethodGet {
		f.beforeGet(r.URL.Path)
	}
	if f.beforeWrite != nil && r.Method != http.MethodGet {
		f.beforeWrite(r.Method, r.URL.Path)
	}
	for key, status := range f.refusals {
		method, suffix, _ := strings.Cut(key, " ")
		if r.Method == method && strings.HasSuffix(r.URL.Path, suffix) {
			f.fail(w, status, "badRequest")
			return
		}
	}
	for key, status := range f.failures {
		method, suffix, _ := strings.Cut(key, " ")
		if r.Method == method && strings.HasSuffix(r.URL.Path, suffix) {
			delete(f.failures, key)
			reason := "backendError"
			if status == http.StatusForbidden {
				reason = "requiredAccessLevel"
			}
			f.fail(w, status, reason)
			return
		}
	}

	path := strings.TrimPrefix(r.URL.Path, "/calendar/v3")
	if path == "/users/me/calendarList" {
		f.reply(w, map[string]any{"items": f.calendars})
		return
	}
	rest, ok := strings.CutPrefix(path, "/calendars/")
	if !ok {
		f.fail(w, http.StatusNotFound, "notFound")
		return
	}
	calendarID, rest, _ := strings.Cut(rest, "/events")
	if f.refusedCalendars[calendarID] {
		f.fail(w, http.StatusForbidden, "forbidden")
		return
	}
	events, ok := f.events[calendarID]
	if !ok {
		f.fail(w, http.StatusNotFound, "notFound")
		return
	}
	id := strings.TrimPrefix(rest, "/")
	switch {
	case id == "" && r.Method == http.MethodGet:
		f.list(w, r, events)
	case id == "" && r.Method == http.MethodPost:
		f.insert(w, calendarID, body)
	case strings.HasSuffix(id, "/move") && r.Method == http.MethodPost:
		f.move(w, calendarID, strings.TrimSuffix(id, "/move"), r.URL.Query().Get("destination"))
	case r.Method == http.MethodGet:
		e, ok := events[id]
		if !ok {
			instance, found := synthesize(events, id)
			if !found {
				f.fail(w, http.StatusNotFound, "notFound")
				return
			}
			f.reply(w, instance)
			return
		}
		f.reply(w, e.event)
	case r.Method == http.MethodPatch:
		f.patch(w, r, calendarID, id, body)
	case r.Method == http.MethodDelete:
		e, ok := events[id]
		if !ok || e.cancelled() {
			f.fail(w, http.StatusGone, "deleted")
			return
		}
		if match := r.Header.Get("If-Match"); match != "" && match != e.ETag {
			f.fail(w, http.StatusPreconditionFailed, "conditionNotMet")
			return
		}
		deleted := e.event
		deleted.Status = "cancelled"
		f.store(calendarID, deleted)
		w.WriteHeader(http.StatusNoContent)
	default:
		f.fail(w, http.StatusMethodNotAllowed, "notAllowed")
	}
}

func (f *fakeGoogle) list(w http.ResponseWriter, r *http.Request, events map[string]*fakeEvent) {
	q := r.URL.Query()
	since := 0
	if token := q.Get("syncToken"); token != "" {
		n, err := strconv.Atoi(strings.TrimPrefix(token, "s"))
		if err != nil || n < f.oldest {
			f.fail(w, http.StatusGone, "fullSyncRequired")
			return
		}
		since = n
	}
	var items []event
	for _, e := range events {
		if e.changed <= since {
			continue
		}
		if uid := q.Get("iCalUID"); uid != "" && e.ICalUID != uid {
			continue
		}
		// A full listing leaves deleted events out unless showDeleted; an incremental one always reports them.
		if since == 0 && e.cancelled() && e.RecurringEventID == "" && q.Get("showDeleted") != "true" {
			continue
		}
		items = append(items, e.event)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	offset, _ := strconv.Atoi(q.Get("pageToken"))
	page := map[string]any{}
	end := min(offset+f.pageSize, len(items))
	page["items"] = items[offset:end]
	if end < len(items) {
		page["nextPageToken"] = strconv.Itoa(end)
	} else if q.Get("iCalUID") == "" {
		page["nextSyncToken"] = "s" + strconv.Itoa(f.version)
	}
	f.reply(w, page)
}

func (f *fakeGoogle) insert(w http.ResponseWriter, calendarID string, body []byte) {
	var e event
	if err := json.Unmarshal(body, &e); err != nil {
		f.fail(w, http.StatusBadRequest, "invalid")
		return
	}
	if _, exists := f.events[calendarID][e.ID]; exists {
		f.fail(w, http.StatusConflict, "duplicate")
		return
	}
	f.conference(&e)
	if e.Organizer == nil {
		e.Organizer = &person{Email: calendarID, Self: true}
	}
	f.reply(w, f.store(calendarID, e).event)
}

// move takes an event to another calendar under the same id; the old calendar sees it deleted.
func (f *fakeGoogle) move(w http.ResponseWriter, from, id, to string) {
	e, ok := f.events[from][id]
	target, known := f.events[to]
	if !ok || e.cancelled() || !known {
		f.fail(w, http.StatusNotFound, "notFound")
		return
	}
	gone := e.event
	gone.Status = "cancelled"
	f.store(from, gone)
	f.reply(w, f.store(to, e.event).event)
	_ = target
}

// conference answers a Meet create request the way Google does: the meeting is there right away.
func (f *fakeGoogle) conference(e *event) {
	if e.ConferenceData == nil || e.ConferenceData.CreateRequest == nil {
		return
	}
	code := "abc-defg-hij"
	e.ConferenceData = &conferenceData{EntryPoints: []entryPoint{{EntryPointType: "video", URI: "https://meet.google.com/" + code}, {EntryPointType: "phone", URI: "tel:+31-20-123-4567"}}, ConferenceID: code}
	e.ConferenceData.ConferenceSolution = &struct {
		Key struct {
			Type string `json:"type"`
		} `json:"key"`
		Name string `json:"name,omitempty"`
	}{Name: "Google Meet"}
	e.ConferenceData.ConferenceSolution.Key.Type = "hangoutsMeet"
}

func (f *fakeGoogle) patch(w http.ResponseWriter, r *http.Request, calendarID, id string, body []byte) {
	events := f.events[calendarID]
	current, ok := events[id]
	if !ok {
		// An occurrence of a series becomes an exception.
		instance, found := synthesize(events, id)
		if !found {
			f.fail(w, http.StatusNotFound, "notFound")
			return
		}
		current = &fakeEvent{event: instance}
	} else if match := r.Header.Get("If-Match"); match != "" && match != current.ETag {
		f.fail(w, http.StatusPreconditionFailed, "conditionNotMet")
		return
	}
	updated := current.event
	data, _ := json.Marshal(updated)
	var merged map[string]any
	_ = json.Unmarshal(data, &merged)
	var changes map[string]any
	_ = json.Unmarshal(body, &changes)
	for key, value := range changes {
		merged[key] = value
	}
	data, _ = json.Marshal(merged)
	updated = event{}
	_ = json.Unmarshal(data, &updated)
	updated.ID, updated.RecurringEventID, updated.OriginalStartTime = current.ID, current.RecurringEventID, current.OriginalStartTime
	updated.ConferenceData = current.ConferenceData
	if _, asked := changes["conferenceData"]; asked {
		var request event
		_ = json.Unmarshal(body, &request)
		updated.ConferenceData = request.ConferenceData
		f.conference(&updated)
	}
	f.reply(w, f.store(calendarID, updated).event)
}

// synthesize is an occurrence of a series as Google answers for its instance id: the series' fields at the
// occurrence's own start and end.
func synthesize(events map[string]*fakeEvent, id string) (event, bool) {
	masterID, key, found := strings.Cut(id, "_")
	master, exists := events[masterID]
	if !found || !exists || len(master.Recurrence) == 0 {
		return event{}, false
	}
	instance := master.event
	instance.ID, instance.RecurringEventID, instance.Recurrence, instance.ETag = id, masterID, nil, `"i-`+id+`"`
	if t, err := time.Parse("20060102T150405Z", key); err == nil {
		start, _ := time.Parse(time.RFC3339, master.Start.DateTime)
		end, _ := time.Parse(time.RFC3339, master.End.DateTime)
		loc, _ := time.LoadLocation(master.Start.TimeZone)
		instance.OriginalStartTime = &eventTime{DateTime: t.In(loc).Format(time.RFC3339), TimeZone: master.Start.TimeZone}
		instance.Start = &eventTime{DateTime: t.In(loc).Format(time.RFC3339), TimeZone: master.Start.TimeZone}
		instance.End = &eventTime{DateTime: t.Add(end.Sub(start)).In(loc).Format(time.RFC3339), TimeZone: master.End.TimeZone}
		return instance, true
	}
	d, err := time.Parse("20060102", key)
	if err != nil {
		return event{}, false
	}
	instance.OriginalStartTime = &eventTime{Date: d.Format("2006-01-02")}
	instance.Start, instance.End = &eventTime{Date: d.Format("2006-01-02")}, &eventTime{Date: d.AddDate(0, 0, 1).Format("2006-01-02")}
	return instance, true
}

// meetingEvent is a timed event in Amsterdam on 19 October 2026.
func meetingEvent(id, summary string) event {
	return event{
		ID: id, ICalUID: id + "@google.com", Summary: summary,
		Start:     &eventTime{DateTime: "2026-10-19T09:00:00+02:00", TimeZone: "Europe/Amsterdam"},
		End:       &eventTime{DateTime: "2026-10-19T09:30:00+02:00", TimeZone: "Europe/Amsterdam"},
		Organizer: &person{Email: "kim@example.com", Self: true},
		Reminders: &reminders{UseDefault: true},
	}
}

func parse(t *testing.T, text string) *ical.Component {
	t.Helper()
	cal, err := ical.Parse(text)
	if err != nil {
		t.Fatalf("parse: %v\n%s", err, text)
	}
	return cal
}
