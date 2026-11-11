package graphcal

import (
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeGraph is a small Microsoft Graph calendar API: calendars, events with series, exceptions and cancelled
// occurrences, calendarView delta as a change signal, and the response calls.
type fakeGraph struct {
	t      *testing.T
	mu     sync.Mutex
	server *httptest.Server

	calendars []calendarEntry
	events    map[string]*fakeEvent // by id
	version   int
	// changedAt is the version of every event's last change (removed ones too), for delta.
	changedAt map[string]int
	oldest    int
	nextID    int
	requests  []fakeRequest
	forbidden bool
	// failures answers requests whose method and path end like the key with that status, once each; refusals do
	// so every time.
	failures map[string]int
	refusals map[string]int
	// beforeWrite runs, with the fake locked, before every request other than a GET, as a change someone makes at
	// Microsoft meanwhile.
	beforeWrite func(method, path string)
	// transactions maps a create's transactionId to the event it made.
	transactions map[string]string
}

type fakeEvent struct {
	event
	calendarID string
	// occurrences of a series master, as instances lists them (cancelled ones are left out).
	occurrences []event
	extended    string
}

type fakeRequest struct {
	Method, Path string
	Query        url.Values
	Prefer       []string
	IfMatch      string
	Body         map[string]any
}

const defaultCalendar = "AAMkCal1"

func newFakeGraph(t *testing.T) *fakeGraph {
	f := &fakeGraph{t: t, events: map[string]*fakeEvent{}, changedAt: map[string]int{}, transactions: map[string]string{}, failures: map[string]int{}}
	f.calendars = []calendarEntry{{ID: defaultCalendar, Name: "Calendar", HexColor: "#E3008C", CanEdit: true, IsDefaultCalendar: true, AllowedOnlineMeetingProviders: []string{"teamsForBusiness"}, DefaultOnlineMeetingProvider: "teamsForBusiness"}}
	f.server = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.server.Close)
	return f
}

// touch gives the event a new changeKey, as Exchange does on every change of it or its series.
func (f *fakeGraph) touch(e *fakeEvent) {
	f.version++
	e.ChangeKey = "ck" + strconv.Itoa(f.version)
	e.ODataETag = `W/"` + e.ChangeKey + `"`
	e.LastModifiedDateTime = time.Date(2026, 10, 1, 0, 0, f.version, 0, time.UTC).Format(time.RFC3339)
	f.changedAt[e.ID] = f.version
}

func (f *fakeGraph) put(e event, occurrences ...event) {
	f.putIn(defaultCalendar, e, occurrences...)
}

func (f *fakeGraph) putIn(calendarID string, e event, occurrences ...event) {
	f.mu.Lock()
	defer f.mu.Unlock()
	stored := &fakeEvent{event: e, calendarID: calendarID, occurrences: occurrences}
	f.events[e.ID] = stored
	f.touch(stored)
}

// inCalendar: the event, or the series an occurrence belongs to, is in the calendar.
func (f *fakeGraph) inCalendar(calendarID, id string) bool {
	e, master, _ := f.lookup(id)
	if e == nil {
		e = master
	}
	return e != nil && e.calendarID == calendarID
}

// asRequested gives an event the way the request's Prefer headers ask for it: times in the preferred zone, the body
// as text.
func asRequested(e event, prefer []string) event {
	for _, value := range prefer {
		if zoneName, ok := strings.CutPrefix(value, "outlook.timezone="); ok {
			zoneName = strings.Trim(zoneName, `"`)
			if !e.IsAllDay && e.Start != nil && e.Start.TimeZone != zoneName {
				e.Start, e.End = inZone(e.Start, zoneName), inZone(e.End, zoneName)
			}
		}
		if value == `outlook.body-content-type="text"` && e.Body != nil && e.Body.ContentType == "html" {
			e.Body = &itemBody{ContentType: "text", Content: htmlText(e.Body.Content)}
		}
	}
	for i := range e.ExceptionOccurrences {
		e.ExceptionOccurrences[i] = asRequested(e.ExceptionOccurrences[i], prefer)
	}
	return e
}

// fakeZone places zone names as Exchange does, including a custom zone Tresso does not know.
func fakeZone(name string) *time.Location {
	if name == "Customized Time Zone" {
		name = "America/New_York"
	}
	return mustZone(name)
}

func inZone(t *dateTimeTimeZone, zoneName string) *dateTimeTimeZone {
	wall, err := time.ParseInLocation("2006-01-02T15:04:05", strings.SplitN(t.DateTime, ".", 2)[0], fakeZone(t.TimeZone))
	if err != nil {
		panic(err)
	}
	return &dateTimeTimeZone{DateTime: wall.In(fakeZone(zoneName)).Format("2006-01-02T15:04:05") + ".0000000", TimeZone: zoneName}
}

// htmlText is an HTML body as Graph gives it as text.
func htmlText(body string) string {
	body = strings.NewReplacer("<br>", "\n", "</div>", "\n", "</p>", "\n").Replace(body)
	var out strings.Builder
	inTag := false
	for _, r := range body {
		switch {
		case r == '<':
			inTag = true
		case r == '>':
			inTag = false
		case !inTag:
			out.WriteRune(r)
		}
	}
	return strings.TrimSpace(html.UnescapeString(out.String()))
}

func (f *fakeGraph) remove(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.events, id)
	f.version++
	f.changedAt[id] = f.version
}

func (f *fakeGraph) get(id string) (fakeEvent, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	e, ok := f.events[id]
	if !ok {
		return fakeEvent{}, false
	}
	return *e, true
}

func (f *fakeGraph) writes() []fakeRequest {
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

func (f *fakeGraph) gets(path string) []fakeRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []fakeRequest
	for _, r := range f.requests {
		if r.Method == http.MethodGet && strings.HasSuffix(r.Path, path) {
			out = append(out, r)
		}
	}
	return out
}

func (f *fakeGraph) fail(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"code": code, "message": code}})
}

func (f *fakeGraph) reply(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func (f *fakeGraph) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer token" {
		f.fail(w, http.StatusUnauthorized, "InvalidAuthenticationToken")
		return
	}
	request := fakeRequest{Method: r.Method, Path: r.URL.Path, Query: r.URL.Query(), Prefer: r.Header.Values("Prefer"), IfMatch: r.Header.Get("If-Match")}
	body, _ := io.ReadAll(r.Body)
	if len(body) > 0 {
		_ = json.Unmarshal(body, &request.Body)
	}
	f.requests = append(f.requests, request)
	if f.forbidden {
		f.fail(w, http.StatusForbidden, "ErrorAccessDenied")
		return
	}
	if f.beforeWrite != nil && r.Method != http.MethodGet {
		f.beforeWrite(r.Method, r.URL.Path)
	}
	for key, status := range f.failures {
		method, suffix, _ := strings.Cut(key, " ")
		if r.Method == method && strings.HasSuffix(r.URL.Path, suffix) {
			delete(f.failures, key)
			f.fail(w, status, "ServiceUnavailable")
			return
		}
	}
	for key, status := range f.refusals {
		method, suffix, _ := strings.Cut(key, " ")
		if r.Method == method && strings.HasSuffix(r.URL.Path, suffix) {
			f.fail(w, status, "ErrorInvalidRequest")
			return
		}
	}
	path := strings.TrimPrefix(r.URL.Path, "/v1.0")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	switch {
	case path == "/me/calendars":
		f.reply(w, map[string]any{"value": f.calendars})
	case len(parts) == 5 && parts[1] == "calendars" && parts[3] == "calendarView" && parts[4] == "delta":
		f.delta(w, r, parts[2])
	case len(parts) == 4 && parts[1] == "calendars" && parts[3] == "events" && r.Method == http.MethodGet:
		f.list(w, r, parts[2])
	case len(parts) == 4 && parts[1] == "calendars" && parts[3] == "events" && r.Method == http.MethodPost:
		f.create(w, parts[2], request.Body)
	case len(parts) >= 5 && parts[1] == "calendars" && parts[3] == "events" && !f.inCalendar(parts[2], parts[4]):
		// An event is found only under the calendar it is in (also one shared with the user).
		f.fail(w, http.StatusNotFound, "ErrorItemNotFound")
	case len(parts) == 5 && parts[1] == "calendars" && parts[3] == "events":
		f.event(w, r, parts[4], request)
	case len(parts) == 6 && parts[1] == "calendars" && parts[3] == "events" && parts[5] == "instances":
		f.instances(w, parts[4])
	case len(parts) == 6 && parts[1] == "calendars" && parts[3] == "events" && r.Method == http.MethodPost:
		f.respond(w, parts[4], parts[5])
	default:
		f.fail(w, http.StatusNotFound, "ErrorItemNotFound")
	}
}

func (f *fakeGraph) delta(w http.ResponseWriter, r *http.Request, calendarID string) {
	since := f.version
	if token := r.URL.Query().Get("$deltatoken"); token != "" {
		n, err := strconv.Atoi(token)
		if err != nil || n < f.oldest {
			f.fail(w, http.StatusGone, "syncStateNotFound")
			return
		}
		since = n
	} else if r.URL.Query().Get("startDateTime") == "" {
		f.fail(w, http.StatusBadRequest, "ErrorInvalidParameter")
		return
	}
	var value []map[string]any
	for id, at := range f.changedAt {
		if at > since {
			if _, ok := f.events[id]; ok {
				value = append(value, map[string]any{"id": id})
			} else {
				value = append(value, map[string]any{"id": id, "@removed": map[string]string{"reason": "deleted"}})
			}
		}
	}
	link := f.server.URL + "/v1.0/me/calendars/" + calendarID + "/calendarView/delta?$deltatoken=" + strconv.Itoa(f.version)
	f.reply(w, map[string]any{"value": value, "@odata.deltaLink": link})
}

func (f *fakeGraph) list(w http.ResponseWriter, r *http.Request, calendarID string) {
	var ids []string
	for id, e := range f.events {
		if e.calendarID == calendarID && (e.Type == "singleInstance" || e.Type == "seriesMaster") {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	skip, _ := strconv.Atoi(r.URL.Query().Get("$skip"))
	end := min(skip+2, len(ids))
	var value []map[string]string
	for _, id := range ids[skip:end] {
		e := f.events[id]
		value = append(value, map[string]string{"id": id, "changeKey": e.ChangeKey, "originalStartTimeZone": e.OriginalStartTimeZone})
	}
	page := map[string]any{"value": value}
	if end < len(ids) {
		page["@odata.nextLink"] = f.server.URL + "/v1.0/me/calendars/" + calendarID + "/events?$skip=" + strconv.Itoa(end)
	}
	f.reply(w, page)
}

// lookup finds an event, also an occurrence of a series.
func (f *fakeGraph) lookup(id string) (*fakeEvent, *fakeEvent, int) {
	if e, ok := f.events[id]; ok {
		return e, nil, -1
	}
	for _, master := range f.events {
		for i, occurrence := range master.occurrences {
			if occurrence.ID == id {
				return nil, master, i
			}
		}
	}
	return nil, nil, -1
}

func (f *fakeGraph) full(e *fakeEvent) event {
	out := e.event
	if e.extended != "" {
		out.SingleValueExtendedProperties = []extendedProperty{{ID: uidProperty, Value: e.extended}}
	}
	if e.Type == "seriesMaster" {
		for _, occurrence := range e.occurrences {
			if occurrence.Type == "exception" {
				out.ExceptionOccurrences = append(out.ExceptionOccurrences, occurrence)
			}
		}
	}
	return out
}

func (f *fakeGraph) event(w http.ResponseWriter, r *http.Request, id string, request fakeRequest) {
	e, master, index := f.lookup(id)
	if e == nil && master == nil {
		f.fail(w, http.StatusNotFound, "ErrorItemNotFound")
		return
	}
	switch r.Method {
	case http.MethodGet:
		if e == nil {
			f.reply(w, master.occurrences[index])
			return
		}
		switch r.URL.Query().Get("$select") {
		case "originalStartTimeZone":
			f.reply(w, map[string]string{"originalStartTimeZone": e.OriginalStartTimeZone})
			return
		case "body":
			f.reply(w, map[string]any{"body": e.Body})
			return
		}
		f.reply(w, asRequested(f.full(e), request.Prefer))
	case http.MethodPatch:
		if e != nil && request.IfMatch != "" && request.IfMatch != e.ODataETag {
			f.fail(w, http.StatusPreconditionFailed, "ErrorIrresolvableConflict")
			return
		}
		var target *event
		if e != nil {
			target = &e.event
		} else {
			target = &master.occurrences[index]
			target.Type = "exception"
		}
		merge(target, request.Body)
		if body, ok := request.Body["isOnlineMeeting"]; ok && body == true {
			target.OnlineMeeting = &onlineMeetingInfo{JoinURL: "https://teams.microsoft.com/l/meetup-join/" + target.ID}
		}
		if e != nil {
			f.touch(e)
			f.reply(w, f.full(e))
		} else {
			f.touch(master)
			f.reply(w, *target)
		}
	case http.MethodDelete:
		if e != nil {
			delete(f.events, id)
			f.version++
			f.changedAt[id] = f.version
		} else {
			occurrence := master.occurrences[index]
			master.occurrences = append(master.occurrences[:index], master.occurrences[index+1:]...)
			original, _ := time.Parse(time.RFC3339, occurrence.OriginalStart)
			master.CancelledOccurrences = append(master.CancelledOccurrences, "OID."+master.ID+"."+original.In(mustZone(master.OriginalStartTimeZone)).Format("2006-01-02"))
			f.touch(master)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func mustZone(name string) *time.Location {
	loc, err := time.LoadLocation(zone(name))
	if err != nil {
		panic(err)
	}
	return loc
}

// merge applies a PATCH body the way Graph does: the named properties are replaced.
func merge(e *event, body map[string]any) {
	data, _ := json.Marshal(e)
	var current map[string]any
	_ = json.Unmarshal(data, &current)
	for key, value := range body {
		current[key] = value
	}
	data, _ = json.Marshal(current)
	var merged event
	_ = json.Unmarshal(data, &merged)
	*e = merged
}

func (f *fakeGraph) instances(w http.ResponseWriter, id string) {
	master, ok := f.events[id]
	if !ok {
		f.fail(w, http.StatusNotFound, "ErrorItemNotFound")
		return
	}
	f.reply(w, map[string]any{"value": master.occurrences})
}

func (f *fakeGraph) create(w http.ResponseWriter, calendarID string, body map[string]any) {
	if tx, ok := body["transactionId"].(string); ok {
		if id, seen := f.transactions[tx]; seen {
			f.reply(w, f.full(f.events[id]))
			return
		}
	}
	f.nextID++
	id := fmt.Sprintf("ev-new-%d", f.nextID)
	var e event
	data, _ := json.Marshal(body)
	_ = json.Unmarshal(data, &e)
	e.ID, e.ICalUID, e.IsOrganizer = id, "040000008200E00074C5B7101A82E008"+strconv.Itoa(f.nextID), true
	e.Organizer = &recipient{EmailAddress: emailAddress{Address: "kim@example.com", Name: "Kim"}}
	e.OriginalStartTimeZone = e.Start.TimeZone
	e.Type = "singleInstance"
	if e.Recurrence != nil {
		e.Type = "seriesMaster"
	}
	if e.IsOnlineMeeting {
		e.OnlineMeeting = &onlineMeetingInfo{JoinURL: "https://teams.microsoft.com/l/meetup-join/" + id}
	}
	stored := &fakeEvent{event: e, calendarID: calendarID}
	if props, ok := body["singleValueExtendedProperties"].([]any); ok && len(props) == 1 {
		stored.extended, _ = props[0].(map[string]any)["value"].(string)
	}
	stored.SingleValueExtendedProperties = nil
	f.events[id] = stored
	f.touch(stored)
	if tx, ok := body["transactionId"].(string); ok {
		f.transactions[tx] = id
	}
	f.reply(w, f.full(stored))
}

func (f *fakeGraph) respond(w http.ResponseWriter, id, action string) {
	e, master, index := f.lookup(id)
	response := map[string]string{"accept": "accepted", "tentativelyAccept": "tentativelyAccepted", "decline": "declined"}[action]
	if response == "" || e == nil && master == nil {
		f.fail(w, http.StatusNotFound, "ErrorItemNotFound")
		return
	}
	if e != nil {
		e.ResponseStatus = &responseStatus{Response: response}
		f.touch(e)
	} else {
		master.occurrences[index].ResponseStatus = &responseStatus{Response: response}
		master.occurrences[index].Type = "exception"
		f.touch(master)
	}
	w.WriteHeader(http.StatusAccepted)
}

// amsterdam is a time in W. Europe Standard Time, as Graph gives it when asked for that zone.
func amsterdam(wall string) *dateTimeTimeZone {
	return &dateTimeTimeZone{DateTime: wall + ".0000000", TimeZone: "W. Europe Standard Time"}
}

func single(id, subject string) event {
	return event{
		ID: id, ICalUID: "uid-" + id, Type: "singleInstance", Subject: subject, OriginalStartTimeZone: "W. Europe Standard Time",
		Start: amsterdam("2026-10-19T09:00:00"), End: amsterdam("2026-10-19T09:30:00"),
		IsOrganizer: true, Organizer: &recipient{EmailAddress: emailAddress{Address: "kim@example.com", Name: "Kim"}},
		ShowAs: "busy", Sensitivity: "normal", Body: &itemBody{ContentType: "text", Content: ""},
		ResponseStatus: &responseStatus{Response: "organizer"}, IsReminderOn: true, ReminderMinutesBeforeStart: 15,
	}
}

// weekly is a series on Mondays at 09:00 Amsterdam with its first three occurrences.
func weekly(id string) (event, []event) {
	master := single(id, "Standup")
	master.Type = "seriesMaster"
	master.Recurrence = &patternedRecurrence{
		Pattern: recurrencePattern{Type: "weekly", Interval: 1, DaysOfWeek: []string{"monday"}, FirstDayOfWeek: "monday"},
		Range:   recurrenceRange{Type: "numbered", StartDate: "2026-10-19", NumberOfOccurrences: 3, RecurrenceTimeZone: "W. Europe Standard Time"},
	}
	var occurrences []event
	for i, day := range []string{"2026-10-19", "2026-10-26", "2026-11-02"} {
		occurrence := single(fmt.Sprintf("%s-occ%d", id, i), "Standup")
		occurrence.Type, occurrence.SeriesMasterID = "occurrence", id
		occurrence.Start, occurrence.End = amsterdam(day+"T09:00:00"), amsterdam(day+"T09:30:00")
		start, _ := time.ParseInLocation("2006-01-02T15:04:05", day+"T09:00:00", mustZone("W. Europe Standard Time"))
		occurrence.OriginalStart = start.UTC().Format(time.RFC3339)
		occurrences = append(occurrences, occurrence)
	}
	return master, occurrences
}
