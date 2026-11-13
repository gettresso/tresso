package googlecal

import (
	"context"
	"crypto/sha256"
	"encoding/base32"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/calsync"
	"tresso/sync/internal/ical"
	"tresso/sync/internal/providerhttp"
)

// The properties the API puts on an event's master about its meeting. They are read on the master only: on an
// occurrence they mean nothing (Google keeps one meeting for the whole series).
const (
	// ConferenceRequest asks the provider for an online meeting ("meet").
	ConferenceRequest = "X-TRESSO-CONFERENCE-REQUEST"
	// ConferenceNonce is the request's own id: a new request has a new one, and so a new Google request id.
	ConferenceNonce = "X-TRESSO-CONFERENCE-NONCE"
	// ConferenceRemove ("meet") asks to take Google's Meet meeting off the event. Only this word removes it: a master
	// that merely lacks X-GOOGLE-CONFERENCE never does.
	ConferenceRemove = "X-TRESSO-CONFERENCE-REMOVE"
)

// asksForMeet: the master asks Google for a Meet meeting.
func asksForMeet(master *ical.Component) bool {
	return master != nil && strings.EqualFold(strings.TrimSpace(master.Text(ConferenceRequest)), "meet")
}

// meetRequestID is the createRequest's requestId: derived from the UID and the request's nonce, so a write that is
// retried asks for the same meeting (Google makes one per request id) and a new request makes a new one. A master
// without a nonce (written by an API that did not have one yet) keeps the id derived from the UID alone.
func meetRequestID(uid, nonce string) string {
	nonce = strings.TrimSpace(nonce)
	if nonce == "" {
		return eventID(uid + "/meet")
	}
	return eventID(uid + "/meet/" + nonce)
}

// fields is the part of an event Tresso writes. Pointers and slices are always sent, so a cleared value is cleared
// at Google too; the JSON of two values compares their content.
type fields struct {
	Summary      string     `json:"summary"`
	Description  string     `json:"description"`
	Location     string     `json:"location"`
	Start        eventTime  `json:"start"`
	End          eventTime  `json:"end"`
	Recurrence   []string   `json:"recurrence"`
	Status       string     `json:"status"`
	Transparency string     `json:"transparency"`
	Visibility   string     `json:"visibility"`
	Attendees    []person   `json:"attendees"`
	Reminders    *reminders `json:"reminders"`
}

// fromVEvent reads what Tresso writes from one VEVENT. zone is the calendar's, for floating times.
func fromVEvent(v *ical.Component, info calendarInfo, master bool) (fields, error) {
	var f fields
	startProp := v.Get("DTSTART")
	if startProp == nil {
		return f, errors.New("the event has no start")
	}
	start, err := ical.ParseTime(*startProp)
	if err != nil {
		return f, err
	}
	end, err := ical.End(v, start)
	if err != nil {
		return f, err
	}
	f.Start, f.End = toGoogleTime(start, info.TimeZone), toGoogleTime(end, info.TimeZone)
	f.Summary, f.Description, f.Location = v.Text("SUMMARY"), v.Text("DESCRIPTION"), v.Text("LOCATION")
	f.Recurrence = []string{}
	if master {
		for _, p := range v.Props {
			switch p.Name {
			case "RRULE", "RDATE", "EXDATE":
				f.Recurrence = append(f.Recurrence, p.Line())
			}
		}
	}
	switch strings.ToUpper(v.Text("STATUS")) {
	case "TENTATIVE":
		f.Status = "tentative"
	case "CANCELLED":
		f.Status = "cancelled"
	default:
		f.Status = "confirmed"
	}
	f.Transparency = "opaque"
	if strings.EqualFold(v.Text("TRANSP"), "TRANSPARENT") {
		f.Transparency = "transparent"
	}
	switch strings.ToUpper(v.Text("CLASS")) {
	case "PRIVATE":
		f.Visibility = "private"
	case "CONFIDENTIAL":
		f.Visibility = "confidential"
	case "PUBLIC":
		f.Visibility = "public"
	default:
		f.Visibility = "default"
	}
	f.Attendees = []person{}
	for _, p := range v.All("ATTENDEE") {
		address := ical.Address(p.Value)
		if address == "" {
			continue
		}
		role := strings.ToUpper(p.Param("ROLE"))
		kind := strings.ToUpper(p.Param("CUTYPE"))
		f.Attendees = append(f.Attendees, person{
			Email:          address,
			DisplayName:    p.Param("CN"),
			Optional:       role == "OPT-PARTICIPANT" || role == "NON-PARTICIPANT",
			Resource:       kind == "RESOURCE" || kind == "ROOM",
			ResponseStatus: responseStatus(p.Param("PARTSTAT")),
		})
	}
	f.Reminders = toReminders(ical.Alarms(v), info)
	return f, nil
}

// toGoogleTime writes a time the way Google takes it; a floating time is read in the calendar's zone.
func toGoogleTime(t ical.Time, calendarZone string) eventTime {
	switch {
	case t.Date:
		return eventTime{Date: t.T.Format("2006-01-02")}
	case t.Floating:
		zone := calendarZone
		loc, err := time.LoadLocation(zone)
		if zone == "" || err != nil {
			return eventTime{DateTime: t.T.Format(time.RFC3339), TimeZone: "UTC"}
		}
		wall := time.Date(t.T.Year(), t.T.Month(), t.T.Day(), t.T.Hour(), t.T.Minute(), t.T.Second(), 0, loc)
		return eventTime{DateTime: wall.Format(time.RFC3339), TimeZone: zone}
	case t.Zone == "":
		return eventTime{DateTime: t.T.UTC().Format(time.RFC3339), TimeZone: "UTC"}
	default:
		loc, err := time.LoadLocation(t.Zone)
		if err != nil {
			return eventTime{DateTime: t.T.UTC().Format(time.RFC3339), TimeZone: "UTC"}
		}
		return eventTime{DateTime: t.T.In(loc).Format(time.RFC3339), TimeZone: t.Zone}
	}
}

// Google keeps at most 5 reminders per event, of at most four weeks.
const (
	maxReminders       = 5
	maxReminderMinutes = 40320
)

// toReminders keeps the calendar's default reminders when the event has exactly those.
func toReminders(alarms []ical.Alarm, info calendarInfo) *reminders {
	out := []reminder{}
	for _, alarm := range alarms {
		if len(out) == maxReminders || alarm.Minutes > maxReminderMinutes {
			continue
		}
		method := "popup"
		if alarm.Email {
			method = "email"
		}
		out = append(out, reminder{Method: method, Minutes: alarm.Minutes})
	}
	if len(info.DefaultReminders) > 0 && sameReminders(out, info.DefaultReminders) {
		return &reminders{UseDefault: true, Overrides: []reminder{}}
	}
	return &reminders{UseDefault: false, Overrides: out}
}

func sameReminders(a, b []reminder) bool {
	if len(a) != len(b) {
		return false
	}
	count := map[reminder]int{}
	for _, r := range a {
		count[r]++
	}
	for _, r := range b {
		count[r]--
	}
	for _, n := range count {
		if n != 0 {
			return false
		}
	}
	return true
}

// currentFields reads Tresso's view of an event Google has, through the same conversion as the desired one, so
// differences in how either side spells a value never count as a change. A master is read with its series, whose
// cancelled occurrences are EXDATEs as Tresso stores them.
func currentFields(e event, info calendarInfo, original *ical.Time, whole series) (fields, error) {
	if original == nil && whole.master != nil {
		text, err := whole.toICalendar(info)
		if err != nil {
			return fields{}, err
		}
		doc, err := ical.Parse(text)
		if err != nil {
			return fields{}, err
		}
		if master := doc.Master(); master != nil {
			return fromVEvent(master, info, true)
		}
	}
	v, err := toVEvent(e, info, original)
	if err != nil {
		return fields{}, err
	}
	return fromVEvent(v, info, original == nil)
}

func equal(a, b any) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return string(left) == string(right)
}

// same compares two events as Tresso writes them. The recurrence is compared by meaning: Google keeps an occurrence
// the organizer cancelled as an exception of its own, which Tresso reads as an EXDATE, and either side may order the
// parts of a rule or the values of a date list differently.
func same(a, b fields) bool {
	a.Recurrence, b.Recurrence = canonicalRecurrence(a.Recurrence), canonicalRecurrence(b.Recurrence)
	return equal(a, b)
}

// canonicalRecurrence is a recurrence as a sorted list: each RRULE with its parts sorted (FREQ first), and every
// EXDATE and RDATE value as its own recurrence key.
func canonicalRecurrence(lines []string) []string {
	out := []string{}
	for _, line := range lines {
		prop, err := ical.ParseContentLine(line)
		if err != nil {
			out = append(out, line)
			continue
		}
		switch prop.Name {
		case "RRULE":
			parts := strings.Split(strings.ToUpper(prop.Value), ";")
			sort.Slice(parts, func(i, j int) bool {
				if strings.HasPrefix(parts[i], "FREQ=") != strings.HasPrefix(parts[j], "FREQ=") {
					return strings.HasPrefix(parts[i], "FREQ=")
				}
				return parts[i] < parts[j]
			})
			out = append(out, "RRULE:"+strings.Join(parts, ";"))
		case "EXDATE", "RDATE":
			times, err := ical.ParseTimes(prop)
			if err != nil {
				out = append(out, line)
				continue
			}
			for _, t := range times {
				out = append(out, prop.Name+":"+ical.RecurrenceKey(t))
			}
		default:
			out = append(out, line)
		}
	}
	sort.Strings(out)
	return out
}

// eventID is the id a new event gets: derived from its UID, so a create that is retried finds the event it made.
// Google takes 5 to 1024 characters of base32hex (a-v, 0-9).
func eventID(uid string) string {
	sum := sha256.Sum256([]byte("tresso:" + uid))
	return "tr" + strings.ToLower(base32.HexEncoding.WithPadding(base32.NoPadding).EncodeToString(sum[:20]))
}

// instanceID is Google's id of one occurrence of a series.
func instanceID(masterID string, original ical.Time) string {
	return masterID + "_" + ical.RecurrenceKey(original)
}

func (s *session) Write(ctx context.Context, calendar calsync.Calendar, operation api.CalendarOperation) (api.OperationResult, error) {
	info := info(calendar)
	if operation.Kind == "delete" {
		return s.delete(ctx, calendar, operation)
	}
	if operation.Ical == nil {
		return api.OperationResult{Outcome: api.OperationFailed, Error: text("The event was removed before it could be saved.")}, nil
	}
	doc, err := ical.Parse(*operation.Ical)
	if err != nil {
		return api.OperationResult{Outcome: api.OperationFailed, Error: text("The event could not be read.")}, nil
	}

	var current series
	exists := false
	if operation.RemoteID != nil {
		current, exists, err = s.series(ctx, calendar.RemoteID, *operation.RemoteID, operation.UID)
		if err != nil {
			return s.failure(ctx, calendar, operation, err)
		}
		if !exists {
			// Gone at Google: the API removes it.
			return api.OperationResult{Outcome: api.OperationConflict}, nil
		}
		if operation.IfMatch != nil && *operation.IfMatch != current.etag() {
			return s.conflict(calendar, *operation.RemoteID, current), nil
		}
	}

	notify := "none"
	if operation.Notify {
		notify = "all"
	}
	w := &writer{session: s, calendar: calendar, info: info, operation: operation, notify: notify, self: s.self, meetAsked: asksForMeet(doc.Master())}
	w.begin(current)
	var masterID string
	if !exists {
		masterID, err = w.create(ctx, doc)
	} else {
		masterID = *operation.RemoteID
		err = w.update(ctx, doc, current)
	}
	if err != nil {
		var refused *refusal
		if errors.As(err, &refused) {
			return s.refused(ctx, calendar, operation, refused.message)
		}
		if providerhttp.IsStatus(err, http.StatusPreconditionFailed) && masterID != "" {
			return s.reread(ctx, calendar, operation, masterID, true, nil)
		}
		result, accessErr := s.failure(ctx, calendar, operation, err)
		if result.Outcome == api.OperationRetry && masterID != "" {
			// A series is written step by step, and an earlier attempt may have written part of it: every retry
			// carries Google's version, so the next attempt starts from it, and when none is left Tresso keeps it.
			// Unless someone else changed the event meanwhile: then it is a conflict, as a 412 would have been.
			s.progress(ctx, calendar, operation, masterID, &result, w)
		}
		return result, accessErr
	}
	return s.reread(ctx, calendar, operation, masterID, false, w)
}

// refusal is a change Google cannot take; it is reported to the user, not retried.
type refusal struct{ message string }

func (r *refusal) Error() string { return r.message }

type writer struct {
	session   *session
	calendar  calsync.Calendar
	info      calendarInfo
	operation api.CalendarOperation
	notify    string
	self      string
	// series is the resource as Google has it, for comparing the master with its cancelled occurrences.
	series series
	// known holds the ETag each event of the resource had when this attempt read it, or got from this attempt's own
	// write of it: any other ETag is someone else's change.
	known map[string]string
	// meetAsked: the master asks for a Meet meeting, so the result says what became of it.
	meetAsked bool
	// meetNotSupported: Google refused the write with the meeting request (400), and the event was written without it.
	meetNotSupported bool
}

// begin records the resource as this attempt found it.
func (w *writer) begin(current series) {
	w.series = current
	w.known = map[string]string{}
	for _, e := range current.events() {
		w.known[e.ID] = e.ETag
	}
}

// send makes one change at Google and records the ETag Google gave the event it wrote.
func (w *writer) send(ctx context.Context, method, rawURL string, query url.Values, ifMatch string, body any, out any) error {
	var written event
	if out == nil {
		out = &written
	}
	if err := w.session.send(ctx, method, rawURL, query, ifMatch, body, out); err != nil {
		return err
	}
	if e, ok := out.(*event); ok && e.ID != "" {
		w.known[e.ID] = e.ETag
	}
	return nil
}

// untouched: every event of the resource is as this attempt read or wrote it, so nobody else changed it meanwhile.
// A write Google took before answering with an error also counts as someone else's change: a conflict, never an
// overwrite.
func (w *writer) untouched(current series) bool {
	events := current.events()
	if len(events) != len(w.known) {
		return false
	}
	for _, e := range events {
		if etag, ok := w.known[e.ID]; !ok || etag != e.ETag {
			return false
		}
	}
	return true
}

func (w *writer) query(conference bool) url.Values {
	q := url.Values{"sendUpdates": {w.notify}}
	if conference {
		q.Set("conferenceDataVersion", "1")
	}
	return q
}

func (w *writer) create(ctx context.Context, doc *ical.Component) (string, error) {
	master := doc.Master()
	if master == nil {
		return "", &refusal{"Google cannot store an occurrence without its series."}
	}
	f, err := fromVEvent(master, w.info, true)
	if err != nil {
		return "", &refusal{"The event could not be read: " + err.Error()}
	}
	id := eventID(w.operation.UID)
	body := struct {
		fields
		ID             string          `json:"id"`
		ICalUID        string          `json:"iCalUID"`
		ConferenceData *conferenceData `json:"conferenceData,omitempty"`
	}{fields: f, ID: id, ICalUID: w.operation.UID, ConferenceData: w.conferenceRequest(master, nil)}
	var created event
	err = w.send(ctx, http.MethodPost, w.session.calendarURL(w.calendar.RemoteID), w.query(body.ConferenceData != nil), "", body, &created)
	if body.ConferenceData != nil && providerhttp.IsStatus(err, http.StatusBadRequest) {
		// Google refuses the meeting request (a calendar that cannot have Meet after all): the event is saved
		// without the meeting, never refused over it.
		w.meetNotSupported = true
		body.ConferenceData = nil
		err = w.send(ctx, http.MethodPost, w.session.calendarURL(w.calendar.RemoteID), w.query(false), "", body, &created)
	}
	if providerhttp.IsStatus(err, http.StatusConflict) {
		// A retried create: the event exists, and the rest of the write is an update of it.
		current, found, getErr := w.session.series(ctx, w.calendar.RemoteID, id, w.operation.UID)
		if getErr != nil {
			return "", getErr
		}
		if !found {
			return "", err
		}
		w.begin(current)
		return id, w.update(ctx, doc, current)
	}
	if err != nil {
		return "", err
	}
	if created.ID != "" {
		id = created.ID
	}
	current := series{master: &created}
	w.series = current
	return id, w.overrides(ctx, doc, id, current)
}

// conferenceRequest asks Google for a Meet meeting when the master asks for one and Google's event has no meeting
// yet (a Meet meeting, or any other Google keeps: a request would replace it). Call it for the master only.
func (w *writer) conferenceRequest(master *ical.Component, current *event) *conferenceData {
	if !asksForMeet(master) {
		return nil
	}
	if current != nil && current.ConferenceData != nil && len(current.ConferenceData.EntryPoints) > 0 {
		return nil
	}
	request := &createRequest{RequestID: meetRequestID(w.operation.UID, master.Text(ConferenceNonce))}
	request.ConferenceSolutionKey.Type = meetSolution
	return &conferenceData{CreateRequest: request}
}

// removesMeet: the write takes Google's Meet meeting off the event. Only on the explicit word on the master
// (X-TRESSO-CONFERENCE-REMOVE:meet), of an event the user organizes, that asks for no new Meet meeting, and only
// when Google's event has a Meet meeting. Call it for the master only.
func removesMeet(master *ical.Component, current event, organizes bool) bool {
	return organizes && strings.EqualFold(strings.TrimSpace(master.Text(ConferenceRemove)), "meet") && !asksForMeet(master) && current.ConferenceData.hasMeet()
}

// withoutMeet is the patch body that takes Google's Meet meeting off the event: "conferenceData": null, sent with
// conferenceDataVersion=1 (without it Google ignores conference changes). The body struct leaves an empty
// conferenceData out, so the explicit null needs a map. Google documents no other way to remove a meeting through
// the API; that null removes it is checked by hand with a real account.
func withoutMeet(body any) map[string]any {
	data, _ := json.Marshal(body)
	m := map[string]any{}
	_ = json.Unmarshal(data, &m)
	m["conferenceData"] = nil
	return m
}

func (w *writer) organizes(current series) bool {
	e := current.master
	if e == nil && len(current.exceptions) > 0 {
		e = &current.exceptions[0]
	}
	if e == nil || e.Organizer == nil {
		return true
	}
	return e.Organizer.Self || ical.Address(e.Organizer.Email) == w.self
}

func (w *writer) update(ctx context.Context, doc *ical.Component, current series) error {
	master := doc.Master()
	if master != nil && current.master != nil {
		if err := w.patch(ctx, master, *current.master, nil, w.organizes(current)); err != nil {
			return err
		}
	}
	return w.overrides(ctx, doc, objectIDOf(current), current)
}

func objectIDOf(s series) string {
	if s.master != nil {
		return s.master.ID
	}
	return s.exceptions[0].RecurringEventID
}

// overrides writes each changed occurrence to its instance at Google.
func (w *writer) overrides(ctx context.Context, doc *ical.Component, masterID string, current series) error {
	organizes := w.organizes(current)
	byKey := map[string]event{}
	zone := w.info.TimeZone
	if current.master != nil {
		zone = zoneOf(current.master.Start, w.info)
	}
	for _, exception := range current.exceptions {
		if exception.OriginalStartTime == nil {
			continue
		}
		if original, err := googleTime(*exception.OriginalStartTime, zone); err == nil {
			byKey[ical.RecurrenceKey(original)] = exception
		}
	}
	for _, override := range doc.Overrides() {
		original, err := ical.ParseTime(*override.Get("RECURRENCE-ID"))
		if err != nil {
			return &refusal{"An occurrence of the event could not be read."}
		}
		existing, ok := byKey[ical.RecurrenceKey(original)]
		if ok && existing.cancelled() {
			continue
		}
		if !ok {
			// The occurrence as Google has it (its own start, end and attendees); patching it makes it an exception.
			if current.master == nil {
				continue
			}
			instance, found, err := w.session.instance(ctx, w.calendar.RemoteID, instanceID(masterID, original))
			if err != nil {
				return err
			}
			if !found || instance.cancelled() {
				continue
			}
			existing = instance
		}
		if err := w.patch(ctx, override, existing, &original, organizes); err != nil {
			return err
		}
	}
	return nil
}

// patch sends what changed of one event or occurrence. An invited user can only answer and set their reminders;
// other changes of theirs are refused, and the user keeps seeing Google's version.
func (w *writer) patch(ctx context.Context, v *ical.Component, current event, original *ical.Time, organizes bool) error {
	desired, err := fromVEvent(v, w.info, original == nil)
	if err != nil {
		return &refusal{"The event could not be read: " + err.Error()}
	}
	have, err := currentFields(current, w.info, original, w.series)
	if err != nil {
		return err
	}
	if !organizes {
		// A guest's copy: only the answer and the reminders, never the meeting.
		return w.answer(ctx, desired, have, current)
	}
	// The meeting is the series': an occurrence's own request or removal word means nothing.
	var conference *conferenceData
	remove := false
	if original == nil {
		conference = w.conferenceRequest(v, &current)
		remove = removesMeet(v, current, organizes)
	}
	if same(desired, have) && conference == nil && !remove {
		return nil
	}
	if current.ID == "" {
		return fmt.Errorf("google: no event id to update")
	}
	body := struct {
		fields
		ConferenceData *conferenceData `json:"conferenceData,omitempty"`
	}{fields: desired, ConferenceData: conference}
	if original != nil {
		// An occurrence keeps the series' recurrence.
		body.Recurrence = nil
	}
	rawURL := w.session.calendarURL(w.calendar.RemoteID, current.ID)
	var payload any = patchBody(body, original != nil)
	if remove {
		payload = withoutMeet(body)
	}
	err = w.send(ctx, http.MethodPatch, rawURL, w.query(conference != nil || remove), current.ETag, payload, nil)
	if (conference != nil || remove) && providerhttp.IsStatus(err, http.StatusBadRequest) {
		// Google refuses the meeting part of the write: the rest of the event is saved all the same, never refused
		// over its meeting. A refused request is reported as not supported; a refused removal leaves Google's meeting,
		// which its version shows.
		w.meetNotSupported = w.meetNotSupported || conference != nil
		body.ConferenceData = nil
		if same(desired, have) {
			return nil
		}
		err = w.send(ctx, http.MethodPatch, rawURL, w.query(false), current.ETag, patchBody(body, original != nil), nil)
	}
	return err
}

// patchBody leaves the recurrence out of an occurrence's patch.
func patchBody(body any, occurrence bool) any {
	if !occurrence {
		return body
	}
	data, _ := json.Marshal(body)
	var m map[string]any
	_ = json.Unmarshal(data, &m)
	delete(m, "recurrence")
	return m
}

// answer sends the invited user's response (with the comment) and reminders.
func (w *writer) answer(ctx context.Context, desired, have fields, current event) error {
	other := desired
	other.Attendees, other.Reminders = have.Attendees, have.Reminders
	if !same(other, have) {
		return &refusal{"Only the organizer can change this event; your change was not saved at Google."}
	}
	want := ""
	for _, attendee := range desired.Attendees {
		if ical.Address(attendee.Email) == w.self {
			want = attendee.ResponseStatus
		}
	}
	attendees := make([]person, len(current.Attendees))
	copy(attendees, current.Attendees)
	answered := false
	for i := range attendees {
		if attendees[i].Self || ical.Address(attendees[i].Email) == w.self {
			if want != "" && attendees[i].ResponseStatus != want {
				attendees[i].ResponseStatus = want
				if w.operation.Comment != nil {
					attendees[i].Comment = *w.operation.Comment
				}
				answered = true
			}
		}
	}
	body := map[string]any{}
	if answered {
		body["attendees"] = attendees
	}
	if !equal(desired.Reminders, have.Reminders) {
		body["reminders"] = desired.Reminders
	}
	if len(body) == 0 {
		return nil
	}
	return w.send(ctx, http.MethodPatch, w.session.calendarURL(w.calendar.RemoteID, current.ID), w.query(false), current.ETag, body, nil)
}

func (s *session) delete(ctx context.Context, calendar calsync.Calendar, operation api.CalendarOperation) (api.OperationResult, error) {
	if operation.RemoteID == nil {
		return api.OperationResult{Outcome: api.OperationDone}, nil
	}
	current, exists, err := s.series(ctx, calendar.RemoteID, *operation.RemoteID, operation.UID)
	if err != nil {
		return s.failure(ctx, calendar, operation, err)
	}
	if !exists {
		return api.OperationResult{Outcome: api.OperationDone}, nil
	}
	if operation.IfMatch != nil && *operation.IfMatch != current.etag() {
		return s.conflict(calendar, *operation.RemoteID, current), nil
	}
	notify := "none"
	if operation.Notify {
		notify = "all"
	}
	tag := ""
	if current.master != nil {
		tag = current.master.ETag
	}
	err = s.send(ctx, http.MethodDelete, s.calendarURL(calendar.RemoteID, *operation.RemoteID), url.Values{"sendUpdates": {notify}}, tag, nil, nil)
	switch {
	case err == nil, providerhttp.IsStatus(err, http.StatusNotFound), providerhttp.IsStatus(err, http.StatusGone):
		return api.OperationResult{Outcome: api.OperationDone}, nil
	case providerhttp.IsStatus(err, http.StatusPreconditionFailed):
		return s.reread(ctx, calendar, operation, *operation.RemoteID, true, nil)
	default:
		return s.failure(ctx, calendar, operation, err)
	}
}

// reread reports the event as Google has it after the write (with a Meet link Google added), or after a conflict.
// w is the write that was done (nil after a conflict or a delete): its result also says what became of the Meet
// meeting the master asked for.
func (s *session) reread(ctx context.Context, calendar calsync.Calendar, operation api.CalendarOperation, masterID string, conflict bool, w *writer) (api.OperationResult, error) {
	current, found, err := s.series(ctx, calendar.RemoteID, masterID, operation.UID)
	if err != nil {
		if conflict {
			return s.failure(ctx, calendar, operation, err)
		}
		// Written, but not read back: the next sync brings Google's version.
		result := api.OperationResult{Outcome: api.OperationDone, RemoteID: &masterID}
		w.meetOutcome(&result, nil)
		return result, nil
	}
	if conflict {
		if !found {
			return api.OperationResult{Outcome: api.OperationConflict}, nil
		}
		return s.conflict(calendar, masterID, current), nil
	}
	if !found {
		result := api.OperationResult{Outcome: api.OperationDone, RemoteID: &masterID}
		w.meetOutcome(&result, nil)
		return result, nil
	}
	etag := current.etag()
	result := api.OperationResult{Outcome: api.OperationDone, RemoteID: &masterID, ETag: &etag}
	if text, err := current.toICalendar(info(calendar)); err == nil {
		result.Current = &api.RemoteObject{RemoteID: masterID, ETag: &etag, Ical: &text}
	}
	w.meetOutcome(&result, current.master)
	return result, nil
}

// meetOutcome says in a done write's result what became of the Meet meeting the master asked for, when Google's
// master (nil: not read back) shows no meeting. Nothing when none was asked for or the meeting is there.
func (w *writer) meetOutcome(result *api.OperationResult, master *event) {
	if w == nil || !w.meetAsked {
		return
	}
	made, pending := false, false
	if master != nil {
		made, pending = master.ConferenceData.joinLink() != "", master.ConferenceData.pending()
	}
	api.ConferenceOutcome(result, made, master != nil, pending, w.meetNotSupported)
}

// progress puts Google's id, ETag and version of a partly written event into a retry, so the API bases the next
// attempt on that version.
func (s *session) progress(ctx context.Context, calendar calsync.Calendar, operation api.CalendarOperation, masterID string, result *api.OperationResult, w *writer) {
	current, found, err := s.series(ctx, calendar.RemoteID, masterID, operation.UID)
	if err != nil || !found {
		return
	}
	if !w.untouched(current) {
		*result = s.conflict(calendar, masterID, current)
		return
	}
	etag := current.etag()
	result.RemoteID, result.ETag = &masterID, &etag
	// If no retry succeeds, this is the version Tresso keeps.
	if text, err := current.toICalendar(info(calendar)); err == nil {
		result.Current = &api.RemoteObject{RemoteID: masterID, ETag: &etag, Ical: &text}
	}
}

func (s *session) conflict(calendar calsync.Calendar, remoteID string, current series) api.OperationResult {
	etag := current.etag()
	text, err := current.toICalendar(info(calendar))
	if err != nil {
		return api.OperationResult{Outcome: api.OperationConflict}
	}
	return api.OperationResult{Outcome: api.OperationConflict, Current: &api.RemoteObject{RemoteID: remoteID, ETag: &etag, Ical: &text}}
}

// failure turns a provider error into the outcome the API needs; lost access also ends the session.
func (s *session) failure(ctx context.Context, calendar calsync.Calendar, operation api.CalendarOperation, err error) (api.OperationResult, error) {
	var statusErr *providerhttp.StatusError
	switch {
	case errors.Is(err, providerhttp.ErrUnauthorized), errors.Is(err, api.ErrReauthorize), errors.Is(err, api.ErrNotGranted):
		return api.OperationResult{Outcome: api.OperationRetry, Error: text("Google refused Tresso's access to this calendar.")}, err
	case (&Provider{}).NotGranted(err):
		// The token lacks the calendar scopes: the whole account waits for the user to allow them.
		return api.OperationResult{Outcome: api.OperationRetry, Error: text("Tresso is not allowed to use the calendars of this account at Google.")}, err
	case errors.As(err, &statusErr) && statusErr.StatusCode == http.StatusForbidden:
		return s.refused(ctx, calendar, operation, "Google refused the change: the calendar is read-only for you.")
	case errors.As(err, &statusErr) && statusErr.StatusCode >= 400 && statusErr.StatusCode < 500 && statusErr.StatusCode != http.StatusTooManyRequests:
		return s.refused(ctx, calendar, operation, fmt.Sprintf("Google refused the event (HTTP %d).", statusErr.StatusCode))
	case errors.As(err, &statusErr):
		return api.OperationResult{Outcome: api.OperationRetry, Error: text(fmt.Sprintf("Google had a problem (HTTP %d).", statusErr.StatusCode))}, nil
	default:
		return api.OperationResult{Outcome: api.OperationRetry, Error: text("Google could not be reached.")}, nil
	}
}

// refused reports a change Google will not take, with Google's version so the user sees what is there.
func (s *session) refused(ctx context.Context, calendar calsync.Calendar, operation api.CalendarOperation, message string) (api.OperationResult, error) {
	result := api.OperationResult{Outcome: api.OperationFailed, Error: text(message)}
	if operation.RemoteID == nil {
		return result, nil
	}
	current, found, err := s.series(ctx, calendar.RemoteID, *operation.RemoteID, operation.UID)
	if err != nil || !found {
		return result, nil
	}
	result.Current = s.conflict(calendar, *operation.RemoteID, current).Current
	return result, nil
}

func text(s string) *string {
	return &s
}

// Move moves an event to another calendar of the account (events.move), telling no one: for attendees nothing
// changed. The id stays the same. An event changed at Google since Tresso's version is not moved.
func (s *session) Move(ctx context.Context, from, to calsync.Calendar, remoteID string, ifMatch *string) (string, string, error) {
	current, found, err := s.series(ctx, from.RemoteID, remoteID, "")
	if err != nil {
		return "", "", err
	}
	if !found || ifMatch != nil && *ifMatch != current.etag() {
		return "", "", calsync.ErrMoveConflict
	}
	var moved event
	if err := s.send(ctx, http.MethodPost, s.calendarURL(from.RemoteID, remoteID, "move"), url.Values{"destination": {to.RemoteID}, "sendUpdates": {"none"}}, "", nil, &moved); err != nil {
		return "", "", err
	}
	id := remoteID
	if moved.ID != "" {
		id = moved.ID
	}
	there, found, err := s.series(ctx, to.RemoteID, id, current.uid())
	if err != nil {
		return "", "", err
	}
	if !found {
		return "", "", fmt.Errorf("google: the moved event %s is not in its new calendar", id)
	}
	return id, there.etag(), nil
}
