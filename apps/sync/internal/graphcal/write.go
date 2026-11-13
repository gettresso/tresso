package graphcal

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/calsync"
	"tresso/sync/internal/ical"
	"tresso/sync/internal/providerhttp"
)

// ConferenceRequest is the property the API puts on an event's master to ask the provider for an online meeting
// ("teams"). On an occurrence it means nothing. Graph makes a Teams meeting with the event and never takes it off
// again, so nothing here ever tries to remove one.
const ConferenceRequest = "X-TRESSO-CONFERENCE-REQUEST"

// fields is the part of an event Tresso writes. Attendees carry no answers: Graph takes those only through the
// response calls.
type fields struct {
	Subject                    string               `json:"subject"`
	Body                       itemBody             `json:"body"`
	Start                      dateTimeTimeZone     `json:"start"`
	End                        dateTimeTimeZone     `json:"end"`
	IsAllDay                   bool                 `json:"isAllDay"`
	Location                   location             `json:"location"`
	ShowAs                     string               `json:"showAs"`
	Sensitivity                string               `json:"sensitivity"`
	Attendees                  []attendee           `json:"attendees"`
	IsReminderOn               bool                 `json:"isReminderOn"`
	ReminderMinutesBeforeStart int                  `json:"reminderMinutesBeforeStart"`
	Recurrence                 *patternedRecurrence `json:"recurrence"`
}

// desired is what one VEVENT asks for.
type desired struct {
	fields
	cancelled bool
	// self is the user's own answer, "" when the event names them not.
	self string
}

func fromVEvent(v *ical.Component, master bool, self string) (desired, error) {
	var d desired
	startProp := v.Get("DTSTART")
	if startProp == nil {
		return d, errors.New("the event has no start")
	}
	start, err := ical.ParseTime(*startProp)
	if err != nil {
		return d, err
	}
	end, err := ical.End(v, start)
	if err != nil {
		return d, err
	}
	d.Start, d.End, d.IsAllDay = toGraphTime(start), toGraphTime(end), start.Date
	d.Subject = v.Text("SUMMARY")
	d.Body = itemBody{ContentType: "text", Content: v.Text("DESCRIPTION")}
	d.Location = location{DisplayName: v.Text("LOCATION")}
	d.ShowAs = "busy"
	if strings.EqualFold(v.Text("TRANSP"), "TRANSPARENT") {
		d.ShowAs = "free"
	}
	switch strings.ToUpper(v.Text("CLASS")) {
	case "PRIVATE":
		d.Sensitivity = "private"
	case "CONFIDENTIAL":
		d.Sensitivity = "confidential"
	default:
		d.Sensitivity = "normal"
	}
	d.cancelled = strings.EqualFold(v.Text("STATUS"), "CANCELLED")
	d.Attendees = []attendee{}
	for _, p := range v.All("ATTENDEE") {
		address := ical.Address(p.Value)
		if address == "" {
			continue
		}
		if address == self {
			d.self = strings.ToUpper(p.Param("PARTSTAT"))
		}
		kind := "required"
		switch {
		case strings.EqualFold(p.Param("CUTYPE"), "RESOURCE"), strings.EqualFold(p.Param("CUTYPE"), "ROOM"):
			kind = "resource"
		case strings.EqualFold(p.Param("ROLE"), "OPT-PARTICIPANT"):
			kind = "optional"
		}
		d.Attendees = append(d.Attendees, attendee{Type: kind, EmailAddress: emailAddress{Address: address, Name: p.Param("CN")}})
	}
	if alarms := ical.Alarms(v); len(alarms) > 0 {
		d.IsReminderOn, d.ReminderMinutesBeforeStart = true, alarms[0].Minutes
	}
	if master {
		if rule := v.Get("RRULE"); rule != nil {
			zoneName := start.Zone
			if zoneName == "" {
				zoneName = "UTC"
			}
			if d.Recurrence, err = fromRRule(rule.Value, start, zoneName); err != nil {
				return d, err
			}
		}
		if v.Get("RDATE") != nil {
			return d, errUnsupported{"it has extra dates"}
		}
	}
	return d, nil
}

func toGraphTime(t ical.Time) dateTimeTimeZone {
	switch {
	case t.Date:
		return dateTimeTimeZone{DateTime: t.T.Format("2006-01-02") + "T00:00:00", TimeZone: "UTC"}
	case t.Floating, t.Zone == "":
		return dateTimeTimeZone{DateTime: t.T.UTC().Format("2006-01-02T15:04:05"), TimeZone: "UTC"}
	default:
		loc, err := time.LoadLocation(t.Zone)
		if err != nil {
			return dateTimeTimeZone{DateTime: t.T.UTC().Format("2006-01-02T15:04:05"), TimeZone: "UTC"}
		}
		return dateTimeTimeZone{DateTime: t.T.In(loc).Format("2006-01-02T15:04:05"), TimeZone: t.Zone}
	}
}

// currentFields is Tresso's view of an event Graph has, through the same conversion as the desired one.
func (s *session) currentFields(e event, recurrenceID *ical.Time) (desired, error) {
	v, err := toVEvent(e, s.owner, recurrenceID, e.uid())
	if err != nil {
		return desired{}, err
	}
	return fromVEvent(v, recurrenceID == nil, s.owner)
}

// changes are the fields whose values differ, as Graph's PATCH takes them.
func changes(want, have fields) map[string]json.RawMessage {
	var wantMap, haveMap map[string]json.RawMessage
	a, _ := json.Marshal(want)
	b, _ := json.Marshal(have)
	_ = json.Unmarshal(a, &wantMap)
	_ = json.Unmarshal(b, &haveMap)
	out := map[string]json.RawMessage{}
	for key, value := range wantMap {
		if string(haveMap[key]) != string(value) {
			out[key] = value
		}
	}
	return out
}

// transactionID makes a retried create return the event the first attempt made.
func transactionID(uid string) string {
	sum := sha256.Sum256([]byte("tresso:" + uid))
	return hex.EncodeToString(sum[:16])
}

type refusal struct{ message string }

func (r *refusal) Error() string { return r.message }

func (s *session) Write(ctx context.Context, calendar calsync.Calendar, operation api.CalendarOperation) (api.OperationResult, error) {
	if operation.Kind == "delete" {
		return s.delete(ctx, operation)
	}
	if operation.Ical == nil {
		return api.OperationResult{Outcome: api.OperationFailed, Error: text("The event was removed before it could be saved.")}, nil
	}
	doc, err := ical.Parse(*operation.Ical)
	if err != nil {
		return api.OperationResult{Outcome: api.OperationFailed, Error: text("The event could not be read.")}, nil
	}
	w := &writer{session: s, calendar: calendar, operation: operation, doc: doc}
	w.teamsAsked = doc.Master() != nil && w.wantsTeams(doc.Master())
	id := ""
	if operation.RemoteID != nil {
		id = *operation.RemoteID
		current, found, err := s.fetch(ctx, calendar.RemoteID, id)
		if err != nil {
			return s.failure(ctx, operation, err)
		}
		if !found {
			return api.OperationResult{Outcome: api.OperationConflict}, nil
		}
		if operation.IfMatch != nil && *operation.IfMatch != current.ChangeKey {
			return s.conflict(current), nil
		}
		w.masterID, w.known = id, current.ChangeKey
		err = w.update(ctx, current)
		if err != nil {
			return w.result(ctx, id, err)
		}
	} else {
		id, err = w.create(ctx)
		if err != nil {
			return w.result(ctx, id, err)
		}
	}
	return w.result(ctx, id, nil)
}

type writer struct {
	session   *session
	calendar  calsync.Calendar
	operation api.CalendarOperation
	doc       *ical.Component
	// masterID and known: the series and its changeKey as this attempt read it or as its own last step left it. Any
	// other changeKey is someone else's change (Exchange changes the master's with every change to the series).
	masterID string
	known    string
	// teamsAsked: the master asks for a Teams meeting, so the result says what became of it.
	teamsAsked bool
	// teamsNotSupported: the calendar cannot have Teams meetings; the event was written without one.
	teamsNotSupported bool
}

// teamsProvider is the onlineMeetingProvider for a Teams meeting on this calendar. Empty when the calendar has none:
// the event is then written without the meeting (never refused over it) and the result says not_supported.
func (w *writer) teamsProvider() string {
	provider := info(w.calendar).TeamsProvider
	if provider == "" {
		w.teamsNotSupported = true
	}
	return provider
}

// settle reads the series' changeKey after a step of this write. One that cannot be read is unknown, and a retry
// then reports a conflict rather than adopt a version nobody checked.
func (w *writer) settle(ctx context.Context, err error) error {
	if err != nil || w.masterID == "" {
		return err
	}
	var key struct {
		ChangeKey string `json:"changeKey"`
	}
	w.known = ""
	if readErr := w.session.request(ctx, http.MethodGet, eventPath(w.calendar.RemoteID, w.masterID)+"?$select=changeKey", nil, &key); readErr == nil {
		w.known = key.ChangeKey
	}
	return nil
}

// result reports the write with the event as Graph now has it (with the Teams meeting Graph added).
func (w *writer) result(ctx context.Context, id string, writeErr error) (api.OperationResult, error) {
	s := w.session
	if writeErr != nil {
		var refused *refusal
		var unsupported errUnsupported
		switch {
		case errors.As(writeErr, &refused):
			return s.refused(ctx, w.operation, refused.message)
		case errors.As(writeErr, &unsupported):
			return s.refused(ctx, w.operation, unsupported.Error())
		case providerhttp.IsStatus(writeErr, http.StatusPreconditionFailed) && id != "":
			current, found, err := s.fetch(ctx, w.calendar.RemoteID, id)
			if err != nil {
				return s.failure(ctx, w.operation, err)
			}
			if !found {
				return api.OperationResult{Outcome: api.OperationConflict}, nil
			}
			return s.conflict(current), nil
		default:
			result, accessErr := s.failure(ctx, w.operation, writeErr)
			if result.Outcome == api.OperationRetry && id != "" {
				// Graph writes a series step by step (the master, then each occurrence), and an earlier attempt may
				// have written part of it: every retry carries Graph's version, so the next attempt resumes from it
				// instead of conflicting with it, and when none is left Tresso keeps it.
				s.progress(ctx, w.calendar.RemoteID, id, &result, w.known)
			}
			return result, accessErr
		}
	}
	current, found, err := s.fetch(ctx, w.calendar.RemoteID, id)
	if err != nil || !found {
		// Written, but not read back: the next sync brings Graph's version.
		result := api.OperationResult{Outcome: api.OperationDone, RemoteID: &id}
		w.teamsOutcome(&result, nil)
		return result, nil
	}
	etag := current.ChangeKey
	result := api.OperationResult{Outcome: api.OperationDone, RemoteID: &id, ETag: &etag}
	if text, err := toICalendar(current, s.owner); err == nil {
		result.Current = &api.RemoteObject{RemoteID: id, ETag: &etag, Ical: &text}
	}
	w.teamsOutcome(&result, &current)
	return result, nil
}

// teamsOutcome says in a done write's result what became of the Teams meeting the master asked for, when Graph's
// event (nil: not read back) has no join link: pending while Graph has the event as an online meeting, else not
// made. Nothing when none was asked for or the meeting is there (as the reader sees it: an https join link).
func (w *writer) teamsOutcome(result *api.OperationResult, current *event) {
	if !w.teamsAsked {
		return
	}
	made, pending := false, false
	if current != nil {
		made = current.OnlineMeeting != nil && strings.HasPrefix(current.OnlineMeeting.JoinURL, "https://")
		pending = current.IsOnlineMeeting
	}
	api.ConferenceOutcome(result, made, current != nil, pending, w.teamsNotSupported)
}

func (w *writer) wantsTeams(v *ical.Component) bool {
	return strings.EqualFold(v.Text(ConferenceRequest), "teams")
}

func (w *writer) create(ctx context.Context) (string, error) {
	master := w.doc.Master()
	if master == nil {
		return "", &refusal{"Outlook cannot store an occurrence without its series."}
	}
	d, err := fromVEvent(master, true, w.session.owner)
	if err != nil {
		var unsupported errUnsupported
		if errors.As(err, &unsupported) {
			return "", unsupported
		}
		return "", &refusal{"The event could not be read: " + err.Error()}
	}
	body := map[string]any{}
	data, _ := json.Marshal(d.fields)
	_ = json.Unmarshal(data, &body)
	if d.Recurrence == nil {
		delete(body, "recurrence")
	}
	body["transactionId"] = transactionID(w.operation.UID)
	body["singleValueExtendedProperties"] = []extendedProperty{{ID: uidProperty, Value: w.operation.UID}}
	if w.wantsTeams(master) {
		if provider := w.teamsProvider(); provider != "" {
			body["isOnlineMeeting"], body["onlineMeetingProvider"] = true, provider
		}
	}
	if _, line := joinLine(lines(d.Body.Content)); line >= 0 {
		// A link Tresso knows travels as the description's join line: written as escaped text in an HTML body.
		body["body"] = textAsHTML(lines(d.Body.Content), "")
	}
	var created event
	err = w.session.request(ctx, http.MethodPost, eventsPath(w.calendar.RemoteID), body, &created)
	if withoutTeams(body, err) {
		// Graph refuses the meeting (the calendar's Teams setting changed since it was listed): the event is saved
		// without it, never refused over it.
		w.teamsNotSupported = true
		err = w.session.request(ctx, http.MethodPost, eventsPath(w.calendar.RemoteID), body, &created)
	}
	if err != nil {
		return "", err
	}
	if created.ID == "" {
		return "", errors.New("graph: the new event has no id")
	}
	w.masterID, w.known = created.ID, created.ChangeKey
	w.session.remember(created.ID, d.Start.TimeZone)
	if d.cancelled {
		return created.ID, nil
	}
	current, found, err := w.session.fetch(ctx, w.calendar.RemoteID, created.ID)
	if err != nil || !found {
		return created.ID, err
	}
	return created.ID, w.occurrences(ctx, current)
}

func (w *writer) update(ctx context.Context, current event) error {
	if master := w.doc.Master(); master != nil {
		if err := w.patch(ctx, master, current, nil); err != nil {
			return err
		}
	}
	if current.Type != "seriesMaster" {
		return nil
	}
	return w.occurrences(ctx, current)
}

// patch sends what changed of the event or one occurrence, the user's answer through Graph's response calls, and
// cancels what the user cancelled. An invited user can only answer and set their own reminder and free/busy.
func (w *writer) patch(ctx context.Context, v *ical.Component, current event, recurrenceID *ical.Time) error {
	s := w.session
	want, err := fromVEvent(v, recurrenceID == nil, s.owner)
	if err != nil {
		var unsupported errUnsupported
		if errors.As(err, &unsupported) {
			return unsupported
		}
		return &refusal{"The event could not be read: " + err.Error()}
	}
	have, err := s.currentFields(current, recurrenceID)
	if err != nil {
		return err
	}
	if want.cancelled && !have.cancelled {
		if !current.IsOrganizer && recurrenceID == nil {
			return w.respond(ctx, current, "DECLINED")
		}
		return w.settle(ctx, s.request(ctx, http.MethodDelete, eventPath(w.calendar.RemoteID, current.ID), nil, nil))
	}
	diff := changes(want.fields, have.fields)
	if recurrenceID != nil {
		delete(diff, "recurrence")
	}
	if !current.IsOrganizer {
		for key := range diff {
			switch key {
			case "isReminderOn", "reminderMinutesBeforeStart", "showAs":
			case "attendees":
				// The organizer's list; the user's own answer goes through respond.
				delete(diff, key)
			default:
				return &refusal{"Only the organizer can change this event; your change was not saved in Outlook."}
			}
		}
	}
	body := map[string]any{}
	for key, value := range diff {
		body[key] = value
	}
	if recurrenceID == nil && w.wantsTeams(v) && !current.IsOnlineMeeting && current.IsOrganizer {
		if provider := w.teamsProvider(); provider != "" {
			body["isOnlineMeeting"], body["onlineMeetingProvider"] = true, provider
		}
	}
	if _, changed := body["body"]; changed {
		html, err := w.htmlBody(ctx, current.ID, want.Body.Content)
		if err != nil {
			return err
		}
		body["body"] = html
	}
	if len(body) > 0 {
		send := func() error {
			req := providerhttp.Request{Method: http.MethodPatch, URL: s.base + eventPath(w.calendar.RemoteID, current.ID), Header: http.Header{}, ContentType: "application/json"}
			var err error
			if req.Body, err = json.Marshal(body); err != nil {
				return err
			}
			if current.ODataETag != "" {
				req.Header.Set("If-Match", current.ODataETag)
			}
			return s.http.JSON(ctx, req, nil)
		}
		err := send()
		if withoutTeams(body, err) {
			// Graph refuses the meeting: the rest of the change is saved all the same, once, without it.
			w.teamsNotSupported = true
			err = nil
			if len(body) > 0 {
				err = send()
			}
		}
		if err := w.settle(ctx, err); err != nil {
			return err
		}
	}
	if !current.IsOrganizer && want.self != "" && want.self != have.self {
		return w.respond(ctx, current, want.self)
	}
	return nil
}

// meetingSeparator starts the join block Outlook and Teams put at the end of an online meeting's body.
const meetingSeparator = "________________"

// htmlBody is the new description as Graph's HTML body. Tresso reads bodies as text; writing that text back would
// flatten the organizer's formatting and the Teams join block, so the block is kept as Graph has it and only the
// user's part before it is replaced.
func (w *writer) htmlBody(ctx context.Context, id, text string) (itemBody, error) {
	var current struct {
		Body itemBody `json:"body"`
	}
	if err := w.session.request(ctx, http.MethodGet, eventPath(w.calendar.RemoteID, id)+"?$select=body", nil, &current); err != nil {
		return itemBody{}, err
	}
	block := ""
	if strings.EqualFold(current.Body.ContentType, "html") {
		// The join line Tresso wrote after the block last time is no part of it: the description says what goes there.
		block = withoutJoinLines(meetingBlock(current.Body.Content))
	}
	normal := lines(text)
	_, line := joinLine(normal)
	if block == "" {
		if line >= 0 {
			return textAsHTML(normal, ""), nil
		}
		return itemBody{ContentType: "text", Content: text}, nil
	}
	i := strings.Index(normal, meetingSeparator)
	if i < 0 {
		// The user removed the join block from the description: the meeting stays, its text goes.
		return textAsHTML(normal, ""), nil
	}
	// The block's text is replaced by the block itself. Tresso's join line after it stays after it, and so does what
	// the user wrote below that line.
	tail := ""
	if line > i {
		tail = normal[line:]
	}
	return textAsHTML(normal[:i], block, tail), nil
}

// withoutTeams: Graph refused a write that asked for a Teams meeting with 400. The two meeting fields are taken out
// of body, so the write can be sent once more without them.
func withoutTeams(body map[string]any, err error) bool {
	if _, asked := body["isOnlineMeeting"]; !asked || !providerhttp.IsStatus(err, http.StatusBadRequest) {
		return false
	}
	delete(body, "isOnlineMeeting")
	delete(body, "onlineMeetingProvider")
	return true
}

// textAsHTML is plain text as an HTML body: escaped, its line breaks as <br>, then the HTML of block (a meeting's join
// block as Graph has it, or empty) and the text of each tail as a paragraph of its own.
func textAsHTML(text, block string, tail ...string) itemBody {
	content := "<html><body><div>" + escapedLines(text) + "</div>" + block
	for _, t := range tail {
		if strings.TrimSpace(t) != "" {
			content += "<div>" + escapedLines(t) + "</div>"
		}
	}
	return itemBody{ContentType: "html", Content: content + "</body></html>"}
}

func escapedLines(text string) string {
	return strings.ReplaceAll(html.EscapeString(strings.TrimRight(text, "\n")), "\n", "<br>")
}

// joinLinePattern is the line Tresso keeps in a description for a meeting link it knows ("Join the meeting: <url>",
// "Join with <App>: <url>"). It is the rule of the API's MeetingJoinLine::PATTERN, and both are checked against the
// same fixture (apps/api/tests/Fixtures/meeting-join-lines.json): a line of its own, an https link up to the first
// space (Unicode spaces too) or angle bracket, and, as Exchange gives a linked address back in a text body, the link
// again in angle brackets after it.
var joinLinePattern = regexp.MustCompile(`(?m)^Join (?:the meeting|with [^:\r\n]{1,40}):[ \t\x{A0}]+(https://` + linkChars + `+)(?:[ \t\x{A0}]*<https://` + linkChars + `+>)?[ \t\x{A0}]*$`)

const linkChars = `[^\s<>\x{0B}\x{85}\x{A0}\x{1680}\x{2000}-\x{200B}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]`

// lines is text with its line ends as "\n" only, so the pattern's line anchors find every line.
func lines(text string) string {
	return strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(text)
}

// joinLine is the description's join line as the API reads it: the last one anywhere. It gives the line's link and
// where the line starts in text (whose line ends must be "\n"), or "" and -1 when there is none.
func joinLine(text string) (string, int) {
	matches := joinLinePattern.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		return "", -1
	}
	last := matches[len(matches)-1]
	return text[last[2]:last[3]], last[0]
}

// isJoinLine: text is one join line and nothing else.
func isJoinLine(text string) bool {
	where := joinLinePattern.FindStringIndex(text)
	return where != nil && where[0] == 0 && where[1] == len(text)
}

var htmlTag = regexp.MustCompile(`<[^>]*>`)

// withoutJoinLines is a join block without the join lines Tresso put after it on an earlier write: each element at its
// end that is a div of its own (with any attributes, around a link or other inline markup, as Exchange may rewrite
// it) whose text is a join line. The block's own first element is never taken.
func withoutJoinLines(block string) string {
	for {
		trimmed := strings.TrimRight(block, " \t\r\n")
		lower := strings.ToLower(trimmed)
		if !strings.HasSuffix(lower, "</div>") {
			return block
		}
		start := strings.LastIndex(lower[:len(lower)-len("</div>")], "<div")
		if start <= 0 || strings.Contains(lower[start:len(lower)-len("</div>")], "</div") {
			return block
		}
		text := strings.TrimSpace(html.UnescapeString(htmlTag.ReplaceAllString(trimmed[start:], "")))
		if !isJoinLine(text) {
			return block
		}
		block = trimmed[:start]
	}
}

// meetingBlock is the HTML of an online meeting's join block in a body: from the element the separator line is in to
// the end of the body. Empty when the body has no join block.
func meetingBlock(body string) string {
	i := strings.Index(body, meetingSeparator)
	if i < 0 || !strings.Contains(body[i:], "teams.microsoft.com") {
		return ""
	}
	start := strings.LastIndex(body[:i], "<div")
	if start < 0 {
		start = i
	}
	block := body[start:]
	if end := strings.LastIndex(strings.ToLower(block), "</body>"); end >= 0 {
		block = block[:end]
	}
	return block
}

// respond answers the invitation, telling the organizer unless the user asked not to.
func (w *writer) respond(ctx context.Context, current event, partstat string) error {
	action := map[string]string{"ACCEPTED": "accept", "TENTATIVE": "tentativelyAccept", "DECLINED": "decline"}[partstat]
	if action == "" {
		return nil
	}
	body := map[string]any{"sendResponse": w.operation.Notify}
	if w.operation.Comment != nil {
		body["comment"] = *w.operation.Comment
	}
	return w.settle(ctx, w.session.request(ctx, http.MethodPost, eventPath(w.calendar.RemoteID, current.ID, action), body, nil))
}

// occurrences writes the series' changed and cancelled occurrences.
func (w *writer) occurrences(ctx context.Context, master event) error {
	s := w.session
	start, err := graphTime(master.Start, master.IsAllDay)
	if err != nil {
		return err
	}
	exceptions := map[string]event{}
	for _, exception := range master.ExceptionOccurrences {
		if original, err := occurrenceTime(exception.OriginalStart, start, master.OriginalStartTimeZone); err == nil {
			exceptions[ical.RecurrenceKey(original)] = exception
		}
	}
	cancelled := map[string]bool{}
	for _, occurrence := range master.CancelledOccurrences {
		if t, ok := cancelledTime(occurrence, start); ok {
			cancelled[ical.RecurrenceKey(t)] = true
		}
	}
	for _, override := range w.doc.Overrides() {
		original, err := ical.ParseTime(*override.Get("RECURRENCE-ID"))
		if err != nil {
			return &refusal{"An occurrence of the event could not be read."}
		}
		key := ical.RecurrenceKey(original)
		if cancelled[key] {
			continue
		}
		instance, ok := exceptions[key]
		if !ok {
			if instance, ok, err = w.instance(ctx, master, key, start); err != nil {
				return err
			}
			if !ok {
				continue
			}
		}
		if err := w.patch(ctx, override, instance, &original); err != nil {
			return err
		}
	}
	if doc := w.doc.Master(); doc != nil && master.IsOrganizer {
		for _, exdate := range doc.All("EXDATE") {
			times, err := ical.ParseTimes(exdate)
			if err != nil {
				return &refusal{"An excluded date of the event could not be read."}
			}
			for _, t := range times {
				key := ical.RecurrenceKey(t)
				if cancelled[key] {
					continue
				}
				instance, ok, err := w.instance(ctx, master, key, start)
				if err != nil {
					return err
				}
				if ok {
					if err := w.settle(ctx, s.request(ctx, http.MethodDelete, eventPath(w.calendar.RemoteID, instance.ID), nil, nil)); err != nil && !gone(err) {
						return err
					}
				}
			}
		}
	}
	return nil
}

// instance finds the occurrence of a series by its recurrence key.
func (w *writer) instance(ctx context.Context, master event, key string, seriesStart ical.Time) (event, bool, error) {
	at, err := time.Parse("20060102T150405Z", key)
	if err != nil {
		if at, err = time.Parse("20060102", key); err != nil {
			return event{}, false, nil
		}
	}
	query := url.Values{
		"startDateTime": {at.Add(-36 * time.Hour).UTC().Format(time.RFC3339)},
		"endDateTime":   {at.Add(60 * time.Hour).UTC().Format(time.RFC3339)},
		"$select":       {eventFields},
	}
	var page struct {
		Value []event `json:"value"`
	}
	err = w.session.request(ctx, http.MethodGet, eventPath(w.calendar.RemoteID, master.ID, "instances")+"?"+query.Encode(), nil, &page,
		`outlook.timezone="`+preferZone(master.OriginalStartTimeZone)+`"`, `outlook.body-content-type="text"`)
	if err != nil {
		return event{}, false, err
	}
	for _, instance := range page.Value {
		if instance.OriginalStart == "" {
			continue
		}
		original, err := occurrenceTime(instance.OriginalStart, seriesStart, master.OriginalStartTimeZone)
		if err == nil && ical.RecurrenceKey(original) == key {
			return instance, true, nil
		}
	}
	return event{}, false, nil
}

func (s *session) delete(ctx context.Context, operation api.CalendarOperation) (api.OperationResult, error) {
	if operation.RemoteID == nil {
		return api.OperationResult{Outcome: api.OperationDone}, nil
	}
	current, found, err := s.fetch(ctx, operation.CalendarRemoteID, *operation.RemoteID)
	if err != nil {
		return s.failure(ctx, operation, err)
	}
	if !found {
		return api.OperationResult{Outcome: api.OperationDone}, nil
	}
	if operation.IfMatch != nil && *operation.IfMatch != current.ChangeKey {
		return s.conflict(current), nil
	}
	err = s.request(ctx, http.MethodDelete, eventPath(operation.CalendarRemoteID, *operation.RemoteID), nil, nil)
	if err == nil || gone(err) {
		return api.OperationResult{Outcome: api.OperationDone}, nil
	}
	return s.failure(ctx, operation, err)
}

// progress puts Graph's id, changeKey and version of the event into a retry.
// A changeKey other than known means someone else changed the event meanwhile (Graph may answer a write that
// conflicts with a 5xx instead of a 412): that is a conflict, not a version to adopt and overwrite.
func (s *session) progress(ctx context.Context, calendarID, id string, result *api.OperationResult, known string) {
	current, found, err := s.fetch(ctx, calendarID, id)
	if err != nil || !found {
		return
	}
	if known == "" || current.ChangeKey != known {
		*result = s.conflict(current)
		return
	}
	etag := current.ChangeKey
	result.RemoteID, result.ETag = &id, &etag
	if text, err := toICalendar(current, s.owner); err == nil {
		result.Current = &api.RemoteObject{RemoteID: id, ETag: &etag, Ical: &text}
	}
}

func (s *session) conflict(current event) api.OperationResult {
	etag := current.ChangeKey
	text, err := toICalendar(current, s.owner)
	if err != nil {
		return api.OperationResult{Outcome: api.OperationConflict}
	}
	return api.OperationResult{Outcome: api.OperationConflict, Current: &api.RemoteObject{RemoteID: current.ID, ETag: &etag, Ical: &text}}
}

func (s *session) failure(ctx context.Context, operation api.CalendarOperation, err error) (api.OperationResult, error) {
	var statusErr *providerhttp.StatusError
	switch {
	case errors.Is(err, providerhttp.ErrUnauthorized), errors.Is(err, api.ErrReauthorize), errors.Is(err, api.ErrNotGranted):
		return api.OperationResult{Outcome: api.OperationRetry, Error: text("Microsoft refused Tresso's access to this calendar.")}, err
	case errors.As(err, &statusErr) && statusErr.StatusCode == http.StatusForbidden:
		// Graph does not say why; a calendar shared to read only is the common cause, not the only one.
		return s.refused(ctx, operation, "Microsoft refused the change (403). The calendar may be read-only for you.")
	case errors.As(err, &statusErr) && statusErr.StatusCode >= 400 && statusErr.StatusCode < 500 && statusErr.StatusCode != http.StatusTooManyRequests:
		return s.refused(ctx, operation, fmt.Sprintf("Outlook refused the event (HTTP %d).", statusErr.StatusCode))
	case errors.As(err, &statusErr):
		return api.OperationResult{Outcome: api.OperationRetry, Error: text(fmt.Sprintf("Outlook had a problem (HTTP %d).", statusErr.StatusCode))}, nil
	default:
		return api.OperationResult{Outcome: api.OperationRetry, Error: text("Outlook could not be reached.")}, nil
	}
}

// refused reports a change Graph will not take, with Graph's version so the user sees what is there.
func (s *session) refused(ctx context.Context, operation api.CalendarOperation, message string) (api.OperationResult, error) {
	result := api.OperationResult{Outcome: api.OperationFailed, Error: text(message)}
	if operation.RemoteID == nil {
		return result, nil
	}
	current, found, err := s.fetch(ctx, operation.CalendarRemoteID, *operation.RemoteID)
	if err != nil || !found {
		return result, nil
	}
	result.Current = s.conflict(current).Current
	return result, nil
}

func text(s string) *string {
	return &s
}
