package googlecal

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/calsync"
	"tresso/sync/internal/ical"
)

// kim is the fake's calendar as the worker knows it.
var kim = calsync.Calendar{
	RemoteCalendar: api.RemoteCalendar{RemoteID: calendarID, Writable: true, ConferenceProviders: []string{"meet"}},
	Data:           calendarInfo{TimeZone: "Europe/Amsterdam", DefaultReminders: []reminder{{Method: "popup", Minutes: 10}}},
}

// openSession opens a session on the fake for writes made straight through it.
func openSession(t *testing.T, google *fakeGoogle) calsync.Session {
	t.Helper()
	opts := DefaultClientOptions()
	opts.BaseURL = google.server.URL + "/calendar/v3"
	opts.HTTP.MinBackoff, opts.HTTP.MaxBackoff = time.Millisecond, time.Millisecond
	return NewProvider(opts).Open(staticToken{}, google.server.Client(), calendarID, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func write(t *testing.T, google *fakeGoogle, uid string, remoteID *string, text string) api.OperationResult {
	t.Helper()
	result, err := openSession(t, google).Write(context.Background(), kim, api.CalendarOperation{ID: "op", Kind: "put", CalendarRemoteID: calendarID, UID: uid, RemoteID: remoteID, Ical: &text, Notify: true})
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	return result
}

// googleIcal is the event as Tresso stores it from Google, with edit (when not nil) applied to its master.
func googleIcal(t *testing.T, google *fakeGoogle, id string, edit func(master *ical.Component)) string {
	t.Helper()
	e, ok := google.get(calendarID, id)
	if !ok {
		t.Fatalf("no event %s at Google", id)
	}
	text, err := series{master: &e}.toICalendar(info(kim))
	if err != nil {
		t.Fatal(err)
	}
	doc := parse(t, text)
	if edit != nil {
		edit(doc.Master())
	}
	return doc.Serialize()
}

// withMeet is an event that has a Google Meet meeting.
func withMeet(e event, code string) event {
	e.ConferenceData = solution(&conferenceData{EntryPoints: []entryPoint{{EntryPointType: "video", URI: "https://meet.google.com/" + code}}, ConferenceID: code}, "hangoutsMeet", "Google Meet")
	return e
}

func conferenceOf(t *testing.T, result api.OperationResult) (string, string) {
	t.Helper()
	status, reason := "", ""
	if result.ConferenceStatus != nil {
		status = *result.ConferenceStatus
	}
	if result.ConferenceError != nil {
		reason = *result.ConferenceError
	}
	return status, reason
}

func asking(nonce string) func(*ical.Component) {
	return func(master *ical.Component) {
		master.Add(ConferenceRequest, "meet")
		if nonce != "" {
			master.Add(ConferenceNonce, nonce)
		}
	}
}

func TestTheMeetRequestIDComesFromTheUIDAndTheNonce(t *testing.T) {
	cases := []struct {
		name, uid, nonce, want string
	}{
		{"without a nonce, the id of before", "planning@tresso", "", eventID("planning@tresso/meet")},
		{"a nonce makes its own id", "planning@tresso", "0a1b2c3d", eventID("planning@tresso/meet/0a1b2c3d")},
		{"another nonce, another id", "planning@tresso", "ffee0011", eventID("planning@tresso/meet/ffee0011")},
		{"another event, another id", "review@tresso", "0a1b2c3d", eventID("review@tresso/meet/0a1b2c3d")},
		{"spaces around the nonce do not count", "planning@tresso", " 0a1b2c3d ", eventID("planning@tresso/meet/0a1b2c3d")},
	}
	seen := map[string]string{}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := meetRequestID(c.uid, c.nonce)
			if got != c.want {
				t.Fatalf("meetRequestID(%q, %q) = %q; want %q", c.uid, c.nonce, got, c.want)
			}
			if got != meetRequestID(c.uid, c.nonce) {
				t.Fatal("the id is the same for a retried write")
			}
		})
		seen[meetRequestID(c.uid, c.nonce)] = c.name
	}
	if len(seen) != 4 {
		t.Errorf("distinct ids: %v", seen)
	}
}

func TestANewEventReportsWhatBecameOfItsMeetMeeting(t *testing.T) {
	cases := []struct {
		name, meet     string
		status, reason string
		posts          int
		conference     bool
	}{
		{name: "made", meet: "", posts: 1, conference: true},
		{name: "still being made", meet: "pending", status: api.ConferencePending, posts: 1},
		{name: "not made", meet: "failure", status: api.ConferenceFailed, reason: api.ConferenceRefused, posts: 1},
		{name: "refused with the write", meet: "refuse", status: api.ConferenceFailed, reason: api.ConferenceNotSupported, posts: 2},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			google := newFakeGoogle(t)
			google.meet = c.meet
			text := strings.Replace(newEvent, "X-TRESSO-CONFERENCE-REQUEST:meet\r\n", "X-TRESSO-CONFERENCE-REQUEST:meet\r\nX-TRESSO-CONFERENCE-NONCE:0a1b2c3d\r\n", 1)
			result := write(t, google, "planning@tresso", nil, text)

			// Never refused over the meeting: the event is at Google either way.
			if result.Outcome != api.OperationDone || result.Current == nil {
				t.Fatalf("result = %+v", result)
			}
			if _, ok := google.get(calendarID, eventID("planning@tresso")); !ok {
				t.Fatal("the event is saved")
			}
			if status, reason := conferenceOf(t, result); status != c.status || reason != c.reason {
				t.Errorf("conference = %q %q; want %q %q", status, reason, c.status, c.reason)
			}
			if has := strings.Contains(*result.Current.Ical, "X-GOOGLE-CONFERENCE:https://meet.google.com/"); has != c.conference {
				t.Errorf("meeting in Google's version = %v:\n%s", has, *result.Current.Ical)
			}
			writes := google.writes()
			if len(writes) != c.posts {
				t.Fatalf("writes = %+v", writes)
			}
			request := writes[0].Body["conferenceData"].(map[string]any)["createRequest"].(map[string]any)
			if request["requestId"] != meetRequestID("planning@tresso", "0a1b2c3d") || writes[0].Query["conferenceDataVersion"] != "1" {
				t.Errorf("request = %v, query %v", request, writes[0].Query)
			}
			if c.posts == 2 {
				if _, carried := writes[1].Body["conferenceData"]; carried || writes[1].Query["conferenceDataVersion"] != "" {
					t.Errorf("the second write leaves the meeting out: %+v", writes[1])
				}
			}
		})
	}
}

func TestAMeetRequestIsMadeOnceAndANewNonceMakesANewMeeting(t *testing.T) {
	google := newFakeGoogle(t)
	google.put(calendarID, meetingEvent("lunch", "Lunch"))
	remoteID := "lunch"

	first := write(t, google, "lunch@google.com", &remoteID, googleIcal(t, google, "lunch", asking("0a1b2c3d")))
	if status, _ := conferenceOf(t, first); status != "" || !strings.Contains(*first.Current.Ical, "https://meet.google.com/abc-defg-hij") {
		t.Fatalf("first = %+v", first)
	}

	// The same request again (a retried write): the event has the meeting, so nothing is asked or written.
	before := len(google.writes())
	again := write(t, google, "lunch@google.com", &remoteID, googleIcal(t, google, "lunch", asking("0a1b2c3d")))
	if status, _ := conferenceOf(t, again); status != "" || len(google.writes()) != before {
		t.Fatalf("again = %+v, writes %+v", again, google.writes()[before:])
	}
	// A new request on an event that has Meet makes no new meeting either.
	renewed := write(t, google, "lunch@google.com", &remoteID, googleIcal(t, google, "lunch", asking("ffee0011")))
	if len(google.writes()) != before || !strings.Contains(*renewed.Current.Ical, "abc-defg-hij") {
		t.Fatalf("renewed = %+v", renewed)
	}

	// Removed, then asked for with the old nonce: Google has seen that request id and makes nothing.
	write(t, google, "lunch@google.com", &remoteID, googleIcal(t, google, "lunch", func(m *ical.Component) {
		m.Remove("X-GOOGLE-CONFERENCE")
		m.Remove("CONFERENCE")
		m.Add(ConferenceRemove, "meet")
	}))
	if e, _ := google.get(calendarID, "lunch"); e.ConferenceData != nil {
		t.Fatalf("removed: %+v", e.ConferenceData)
	}
	stale := write(t, google, "lunch@google.com", &remoteID, googleIcal(t, google, "lunch", asking("0a1b2c3d")))
	if status, reason := conferenceOf(t, stale); status != api.ConferenceFailed || reason != api.ConferenceRefused {
		t.Errorf("stale = %q %q", status, reason)
	}
	// A new nonce is a new request: a new meeting.
	fresh := write(t, google, "lunch@google.com", &remoteID, googleIcal(t, google, "lunch", asking("ffee0011")))
	if status, _ := conferenceOf(t, fresh); status != "" || !strings.Contains(*fresh.Current.Ical, "https://meet.google.com/abc-defg-001") {
		t.Fatalf("fresh = %+v", fresh)
	}
}

func TestMeetIsRemovedOnlyOnTheWordOfTheOrganizersMaster(t *testing.T) {
	invited := func(e event) event {
		e.Organizer = &person{Email: "lisa@example.org"}
		e.Attendees = []person{{Email: "lisa@example.org", Organizer: true, ResponseStatus: "accepted"}, {Email: calendarID, Self: true, ResponseStatus: "accepted"}}
		return e
	}
	other := func(e event) event {
		e.ConferenceData = solution(&conferenceData{EntryPoints: []entryPoint{{EntryPointType: "video", URI: "https://zoom.example.com/j/1"}}}, "addOn", "Zoom")
		return e
	}
	remove := func(m *ical.Component) {
		m.Remove("X-GOOGLE-CONFERENCE")
		m.Remove("CONFERENCE")
		m.Add(ConferenceRemove, "meet")
	}
	ownLink := func(m *ical.Component) {
		remove(m)
		m.Add("CONFERENCE", "https://rooms.example.com/kim", ical.Param{Name: "VALUE", Values: []string{"URI"}}, ical.Param{Name: "FEATURE", Values: []string{"VIDEO"}})
		m.Remove("DESCRIPTION")
		m.AddText("DESCRIPTION", "Agenda\n\nJoin the meeting: https://rooms.example.com/kim")
	}
	cases := []struct {
		name    string
		event   event
		edit    func(*ical.Component)
		removed bool
		writes  int
	}{
		{name: "the word removes Meet", event: withMeet(meetingEvent("e", "Sync"), "abc-defg-hij"), edit: remove, removed: true, writes: 1},
		{name: "the word next to an own link", event: withMeet(meetingEvent("e", "Sync"), "abc-defg-hij"), edit: ownLink, removed: true, writes: 1},
		{name: "a master without X-GOOGLE-CONFERENCE alone keeps Meet", event: withMeet(meetingEvent("e", "Sync"), "abc-defg-hij"), edit: func(m *ical.Component) {
			m.Remove("X-GOOGLE-CONFERENCE")
			m.Remove("CONFERENCE")
		}},
		{name: "a guest's copy keeps Meet", event: invited(withMeet(meetingEvent("e", "Sync"), "abc-defg-hij")), edit: remove},
		{name: "nothing to remove without Meet", event: meetingEvent("e", "Sync"), edit: remove},
		{name: "another app's meeting stays", event: other(meetingEvent("e", "Sync")), edit: remove},
		{name: "a new request wins over the word", event: withMeet(meetingEvent("e", "Sync"), "abc-defg-hij"), edit: func(m *ical.Component) {
			remove(m)
			asking("0a1b2c3d")(m)
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			google := newFakeGoogle(t)
			google.put(calendarID, c.event)
			remoteID := "e"
			result := write(t, google, "e@google.com", &remoteID, googleIcal(t, google, "e", c.edit))
			if result.Outcome != api.OperationDone {
				t.Fatalf("result = %+v", result)
			}
			writes := google.writes()
			if len(writes) != c.writes {
				t.Fatalf("writes = %+v", writes)
			}
			e, _ := google.get(calendarID, "e")
			if gone := e.ConferenceData == nil; gone != c.removed && c.event.ConferenceData != nil {
				t.Errorf("meeting removed = %v", gone)
			}
			if !c.removed {
				return
			}
			patch := writes[0]
			value, carried := patch.Body["conferenceData"]
			if !carried || value != nil || patch.Query["conferenceDataVersion"] != "1" || patch.Method != http.MethodPatch {
				t.Errorf("removal = %+v", patch)
			}
			if strings.Contains(*result.Current.Ical, "X-GOOGLE-CONFERENCE") || strings.Contains(*result.Current.Ical, "meet.google.com") {
				t.Errorf("Google's version has no Meet:\n%s", *result.Current.Ical)
			}
		})
	}
}

func TestTheWordOnAnOccurrenceNeitherAsksNorRemoves(t *testing.T) {
	google := newFakeGoogle(t)
	weekly := withMeet(meetingEvent("standup", "Standup"), "abc-defg-hij")
	weekly.Recurrence = []string{"RRULE:FREQ=WEEKLY;BYDAY=MO"}
	google.put(calendarID, weekly)
	text := googleIcal(t, google, "standup", nil)
	override := "BEGIN:VEVENT\r\nUID:standup@google.com\r\nDTSTAMP:20261001T000000Z\r\nRECURRENCE-ID;TZID=Europe/Amsterdam:20261026T090000\r\n" +
		"DTSTART;TZID=Europe/Amsterdam:20261026T110000\r\nDTEND;TZID=Europe/Amsterdam:20261026T113000\r\nSUMMARY:Standup\r\n" +
		"X-TRESSO-CONFERENCE-REQUEST:meet\r\nX-TRESSO-CONFERENCE-NONCE:0a1b2c3d\r\nX-TRESSO-CONFERENCE-REMOVE:meet\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
	remoteID := "standup"
	result := write(t, google, "standup@google.com", &remoteID, strings.Replace(text, "END:VCALENDAR\r\n", override, 1))
	if result.Outcome != api.OperationDone || result.ConferenceStatus != nil {
		t.Fatalf("result = %+v", result)
	}
	writes := google.writes()
	if len(writes) != 1 || !strings.HasSuffix(writes[0].Path, "/standup_20261026T080000Z") {
		t.Fatalf("only the occurrence is written: %+v", writes)
	}
	if _, carried := writes[0].Body["conferenceData"]; carried || writes[0].Query["conferenceDataVersion"] != "" {
		t.Errorf("the occurrence's write = %+v", writes[0])
	}
	if master, _ := google.get(calendarID, "standup"); !master.ConferenceData.hasMeet() {
		t.Error("the series keeps its meeting")
	}
}

func TestAGuestsCopyIsAnsweredWithoutAMeeting(t *testing.T) {
	google := newFakeGoogle(t)
	invite := meetingEvent("review", "Review")
	invite.Organizer = &person{Email: "lisa@example.org"}
	invite.Attendees = []person{{Email: "lisa@example.org", Organizer: true, ResponseStatus: "accepted"}, {Email: calendarID, Self: true, ResponseStatus: "needsAction"}}
	google.put(calendarID, invite)
	remoteID := "review"
	text := answer(t, googleIcal(t, google, "review", asking("0a1b2c3d")), calendarID, "ACCEPTED")
	result := write(t, google, "review@google.com", &remoteID, text)
	if result.Outcome != api.OperationDone {
		t.Fatalf("result = %+v", result)
	}
	writes := google.writes()
	if len(writes) != 1 || len(writes[0].Body) != 1 || writes[0].Body["attendees"] == nil || writes[0].Query["conferenceDataVersion"] != "" {
		t.Fatalf("a guest's copy gets the answer only: %+v", writes)
	}
	if status, reason := conferenceOf(t, result); status != api.ConferenceFailed || reason != api.ConferenceRefused {
		t.Errorf("conference = %q %q", status, reason)
	}
}

func TestARefusedRemovalStillSavesTheRestOfTheEvent(t *testing.T) {
	google := newFakeGoogle(t)
	google.put(calendarID, withMeet(meetingEvent("e", "Sync"), "abc-defg-hij"))
	google.meet = "refuse"
	remoteID := "e"
	result := write(t, google, "e@google.com", &remoteID, googleIcal(t, google, "e", func(m *ical.Component) {
		m.Remove("X-GOOGLE-CONFERENCE")
		m.Remove("CONFERENCE")
		m.Add(ConferenceRemove, "meet")
		m.Remove("SUMMARY")
		m.AddText("SUMMARY", "Sync, renamed")
	}))
	if result.Outcome != api.OperationDone || result.ConferenceStatus != nil {
		t.Fatalf("result = %+v", result)
	}
	writes := google.writes()
	if len(writes) != 2 {
		t.Fatalf("writes = %+v", writes)
	}
	if _, carried := writes[1].Body["conferenceData"]; carried || writes[1].Body["summary"] != "Sync, renamed" {
		t.Errorf("second write = %+v", writes[1])
	}
	if e, _ := google.get(calendarID, "e"); e.Summary != "Sync, renamed" || !e.ConferenceData.hasMeet() {
		t.Errorf("event = %+v", e)
	}
}

func TestTheJoinLineSurvivesGoogle(t *testing.T) {
	google := newFakeGoogle(t)
	line := "Join the meeting: https://rooms.example.com/kim?pwd=a,b;c&x=1"
	description := "Agenda: budget, hiring; planning\n\n" + line
	text := strings.Replace(newEvent, "X-TRESSO-CONFERENCE-REQUEST:meet\r\n", "CONFERENCE;VALUE=URI;FEATURE=VIDEO:https://rooms.example.com/kim?pwd=a,b;c&x=1\r\nDESCRIPTION:"+ical.EscapeText(description)+"\r\n", 1)
	result := write(t, google, "planning@tresso", nil, text)
	if result.Outcome != api.OperationDone || result.ConferenceStatus != nil || result.Current == nil {
		t.Fatalf("result = %+v", result)
	}
	if insert := google.writes()[0]; insert.Body["description"] != description {
		t.Errorf("description sent = %q", insert.Body["description"])
	}
	master := parse(t, *result.Current.Ical).Master()
	if got := master.Text("DESCRIPTION"); got != description {
		t.Fatalf("description read back = %q", got)
	}
	lines := strings.Split(master.Text("DESCRIPTION"), "\n")
	if lines[len(lines)-1] != line {
		t.Errorf("the last line = %q", lines[len(lines)-1])
	}

	// Google's version written back unchanged sends nothing: the line is the same on both sides.
	before := len(google.writes())
	id := eventID("planning@tresso")
	write(t, google, "planning@tresso", &id, *result.Current.Ical)
	if len(google.writes()) != before {
		t.Errorf("an unchanged event is written again: %+v", google.writes()[before:])
	}
}
