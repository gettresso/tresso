package graphcal

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/calsync"
	"tresso/sync/internal/ical"
)

type staticToken struct{}

func (staticToken) Token(context.Context) (string, error)    { return "token", nil }
func (staticToken) Invalidate(context.Context, string) error { return nil }

// calendarWith is the default calendar as the worker knows it, with Teams or without.
func calendarWith(teams bool) calsync.Calendar {
	c := calsync.Calendar{RemoteCalendar: api.RemoteCalendar{RemoteID: defaultCalendar, Writable: true}, Data: calendarInfo{}}
	if teams {
		c.ConferenceProviders = []string{"teams"}
		c.Data = calendarInfo{TeamsProvider: "teamsForBusiness"}
	}
	return c
}

func openSession(t *testing.T, graph *fakeGraph) *session {
	t.Helper()
	opts := DefaultClientOptions()
	opts.BaseURL = graph.server.URL + "/v1.0"
	opts.HTTP.UnitsPerSecond, opts.HTTP.Burst = 0, 0
	opts.HTTP.MinBackoff, opts.HTTP.MaxBackoff = time.Millisecond, time.Millisecond
	return NewProvider(opts).Open(staticToken{}, graph.server.Client(), owner, slog.New(slog.NewTextHandler(io.Discard, nil))).(*session)
}

func write(t *testing.T, graph *fakeGraph, calendar calsync.Calendar, uid string, remoteID *string, text string) api.OperationResult {
	t.Helper()
	result, err := openSession(t, graph).Write(context.Background(), calendar, api.CalendarOperation{ID: "op", Kind: "put", CalendarRemoteID: defaultCalendar, UID: uid, RemoteID: remoteID, Ical: &text, Notify: true})
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	return result
}

// graphIcal is the event as Tresso stores it from Graph, with edit (when not nil) applied to its master.
func graphIcal(t *testing.T, graph *fakeGraph, id string, edit func(master *ical.Component)) string {
	t.Helper()
	e, found, err := openSession(t, graph).fetch(context.Background(), defaultCalendar, id)
	if err != nil || !found {
		t.Fatalf("fetch %s: %v %v", id, found, err)
	}
	text, err := toICalendar(e, owner)
	if err != nil {
		t.Fatal(err)
	}
	doc := parse(t, text)
	if edit != nil {
		edit(doc.Master())
	}
	return doc.Serialize()
}

func conferenceOf(result api.OperationResult) (string, string) {
	status, reason := "", ""
	if result.ConferenceStatus != nil {
		status = *result.ConferenceStatus
	}
	if result.ConferenceError != nil {
		reason = *result.ConferenceError
	}
	return status, reason
}

const teamsEvent = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Tresso//EN\r\nBEGIN:VEVENT\r\nUID:review@tresso\r\nDTSTAMP:20261001T000000Z\r\n" +
	"DTSTART;TZID=Europe/Amsterdam:20261020T140000\r\nDTEND;TZID=Europe/Amsterdam:20261020T150000\r\nSUMMARY:Review\r\n" +
	"ORGANIZER;CN=Kim:mailto:kim@example.com\r\nATTENDEE;CN=Lisa;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:lisa@example.org\r\n" +
	"X-TRESSO-CONFERENCE-REQUEST:teams\r\nX-TRESSO-CONFERENCE-NONCE:0a1b2c3d\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"

func TestANewEventReportsWhatBecameOfItsTeamsMeeting(t *testing.T) {
	cases := []struct {
		name, teams    string
		calendarTeams  bool
		status, reason string
		asked          bool
	}{
		{name: "made", calendarTeams: true, asked: true},
		{name: "still being made", teams: "pending", calendarTeams: true, status: api.ConferencePending, asked: true},
		{name: "not made", teams: "ignored", calendarTeams: true, status: api.ConferenceFailed, reason: api.ConferenceRefused, asked: true},
		{name: "a calendar without Teams", calendarTeams: false, status: api.ConferenceFailed, reason: api.ConferenceNotSupported},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			graph := newFakeGraph(t)
			graph.teams = c.teams
			if !c.calendarTeams {
				graph.calendars[0].AllowedOnlineMeetingProviders = nil
			}
			result := write(t, graph, calendarWith(c.calendarTeams), "review@tresso", nil, teamsEvent)

			// Never refused over the meeting: the event is in Outlook either way.
			if result.Outcome != api.OperationDone || result.RemoteID == nil || result.Current == nil {
				t.Fatalf("result = %+v", result)
			}
			if status, reason := conferenceOf(result); status != c.status || reason != c.reason {
				t.Errorf("conference = %q %q; want %q %q", status, reason, c.status, c.reason)
			}
			create := graph.writes()[0]
			if _, sent := create.Body["isOnlineMeeting"]; sent != c.asked {
				t.Errorf("create = %+v", create.Body)
			}
			if c.status == "" && !strings.Contains(*result.Current.Ical, "X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/") {
				t.Errorf("Graph's version has the meeting:\n%s", *result.Current.Ical)
			}
		})
	}
}

func TestAnEventOnACalendarWithoutTeamsIsSavedWithoutTheMeeting(t *testing.T) {
	graph := newFakeGraph(t)
	graph.calendars[0].AllowedOnlineMeetingProviders = nil
	graph.put(single("ev1", "Lunch"))
	remoteID := "ev1"
	text := graphIcal(t, graph, "ev1", func(m *ical.Component) {
		m.Remove("SUMMARY")
		m.AddText("SUMMARY", "Lunch at noon")
		m.Add(ConferenceRequest, "teams")
	})
	result := write(t, graph, calendarWith(false), "uid-ev1", &remoteID, text)
	if result.Outcome != api.OperationDone {
		t.Fatalf("result = %+v", result)
	}
	if status, reason := conferenceOf(result); status != api.ConferenceFailed || reason != api.ConferenceNotSupported {
		t.Errorf("conference = %q %q", status, reason)
	}
	writes := graph.writes()
	if len(writes) != 1 || writes[0].Body["subject"] != "Lunch at noon" || writes[0].Body["isOnlineMeeting"] != nil {
		t.Fatalf("writes = %+v", writes)
	}
}

func TestAnExistingTeamsMeetingIsReportedAsThereAndNeverRemoved(t *testing.T) {
	graph := newFakeGraph(t)
	meeting := single("ev1", "Planning")
	meeting.IsOnlineMeeting, meeting.OnlineMeetingProvider = true, "teamsForBusiness"
	meeting.OnlineMeeting = &onlineMeetingInfo{JoinURL: "https://teams.microsoft.com/l/meetup-join/abc"}
	graph.put(meeting)
	remoteID := "ev1"

	asked := write(t, graph, calendarWith(true), "uid-ev1", &remoteID, graphIcal(t, graph, "ev1", func(m *ical.Component) { m.Add(ConferenceRequest, "teams") }))
	if asked.Outcome != api.OperationDone || asked.ConferenceStatus != nil || len(graph.writes()) != 0 {
		t.Fatalf("asked = %+v, writes %+v", asked, graph.writes())
	}

	// Whatever the master says, nothing asks Graph to take the meeting off.
	removed := write(t, graph, calendarWith(true), "uid-ev1", &remoteID, graphIcal(t, graph, "ev1", func(m *ical.Component) {
		m.Remove("X-MICROSOFT-SKYPETEAMSMEETINGURL")
		m.Remove("CONFERENCE")
		m.Add("X-TRESSO-CONFERENCE-REMOVE", "meet")
		m.Remove("SUMMARY")
		m.AddText("SUMMARY", "Planning, moved")
	}))
	if removed.Outcome != api.OperationDone {
		t.Fatalf("removed = %+v", removed)
	}
	for _, request := range graph.writes() {
		if _, ok := request.Body["isOnlineMeeting"]; ok {
			t.Errorf("a write touched the meeting: %+v", request)
		}
		if _, ok := request.Body["onlineMeetingProvider"]; ok {
			t.Errorf("a write touched the meeting: %+v", request)
		}
	}
	if e, _ := graph.get("ev1"); !e.IsOnlineMeeting || e.OnlineMeeting == nil {
		t.Errorf("the meeting stays: %+v", e.event)
	}
}

func TestATeamsRequestOnAnOccurrenceOrAGuestsCopyIsNotSent(t *testing.T) {
	graph := newFakeGraph(t)
	master, occurrences := weekly("ev-series")
	graph.put(master, occurrences...)
	invite := single("ev-invite", "Their review")
	invite.IsOrganizer = false
	invite.Organizer = &recipient{EmailAddress: emailAddress{Address: "lisa@example.org", Name: "Lisa"}}
	invite.Attendees = []attendee{{Type: "required", EmailAddress: emailAddress{Address: owner, Name: "Kim"}, Status: &responseStatus{Response: "none"}}}
	invite.ResponseStatus = &responseStatus{Response: "notResponded"}
	graph.put(invite)

	// An occurrence's own request means nothing: the occurrence is written as it is, without a meeting.
	seriesID := "ev-series"
	override := "BEGIN:VEVENT\r\nUID:uid-ev-series\r\nDTSTAMP:20261001T000000Z\r\nRECURRENCE-ID;TZID=Europe/Amsterdam:20261026T090000\r\n" +
		"DTSTART;TZID=Europe/Amsterdam:20261026T110000\r\nDTEND;TZID=Europe/Amsterdam:20261026T113000\r\nSUMMARY:Standup\r\n" +
		"X-TRESSO-CONFERENCE-REQUEST:teams\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
	text := strings.Replace(graphIcal(t, graph, "ev-series", nil), "END:VCALENDAR\r\n", override, 1)
	result := write(t, graph, calendarWith(true), "uid-ev-series", &seriesID, text)
	if result.Outcome != api.OperationDone || result.ConferenceStatus != nil {
		t.Fatalf("result = %+v", result)
	}
	writes := graph.writes()
	if len(writes) != 1 || !strings.HasSuffix(writes[0].Path, "/ev-series-occ1") || writes[0].Body["isOnlineMeeting"] != nil {
		t.Fatalf("writes = %+v", writes)
	}

	// A guest's copy: the answer only.
	inviteID := "ev-invite"
	answered := strings.Replace(graphIcal(t, graph, "ev-invite", func(m *ical.Component) { m.Add(ConferenceRequest, "teams") }), "PARTSTAT=NEEDS-ACTION", "PARTSTAT=ACCEPTED", 1)
	before := len(graph.writes())
	guest := write(t, graph, calendarWith(true), "uid-ev-invite", &inviteID, answered)
	if guest.Outcome != api.OperationDone {
		t.Fatalf("guest = %+v", guest)
	}
	writes = graph.writes()[before:]
	if len(writes) != 1 || !strings.HasSuffix(writes[0].Path, "/ev-invite/accept") {
		t.Fatalf("a guest's copy gets the answer only: %+v", writes)
	}
	if status, reason := conferenceOf(guest); status != api.ConferenceFailed || reason != api.ConferenceRefused {
		t.Errorf("conference = %q %q", status, reason)
	}
}

func TestTheJoinLineSurvivesGraph(t *testing.T) {
	graph := newFakeGraph(t)
	line := "Join the meeting: https://rooms.example.com/kim?pwd=a,b;c&x=1"
	description := "Agenda: budget & hiring <draft>\n\n" + line
	text := strings.Replace(teamsEvent, "X-TRESSO-CONFERENCE-REQUEST:teams\r\nX-TRESSO-CONFERENCE-NONCE:0a1b2c3d\r\n",
		"CONFERENCE;VALUE=URI;FEATURE=VIDEO:https://rooms.example.com/kim?pwd=a,b;c&x=1\r\nDESCRIPTION:"+ical.EscapeText(description)+"\r\n", 1)
	result := write(t, graph, calendarWith(true), "review@tresso", nil, text)
	if result.Outcome != api.OperationDone || result.ConferenceStatus != nil || result.Current == nil {
		t.Fatalf("result = %+v", result)
	}
	body := graph.writes()[0].Body["body"].(map[string]any)
	content := body["content"].(string)
	if body["contentType"] != "html" || !strings.Contains(content, "Agenda: budget &amp; hiring &lt;draft&gt;<br><br>Join the meeting: https://rooms.example.com/kim?pwd=a,b;c&amp;x=1") || strings.Contains(content, "<a ") {
		t.Fatalf("the line is escaped text in the HTML body: %v", body)
	}
	master := parse(t, *result.Current.Ical).Master()
	if got := master.Text("DESCRIPTION"); got != description {
		t.Fatalf("description read back = %q", got)
	}

	// Graph's version written back unchanged sends nothing.
	before := len(graph.writes())
	write(t, graph, calendarWith(true), "review@tresso", result.RemoteID, *result.Current.Ical)
	if len(graph.writes()) != before {
		t.Errorf("an unchanged event is written again: %+v", graph.writes()[before:])
	}
}

func TestTheJoinLineStaysLastAfterATeamsBlock(t *testing.T) {
	graph := newFakeGraph(t)
	pasted := single("ev-pasted", "Planning")
	pasted.Body = &itemBody{ContentType: "html", Content: `<html><body><div>Agenda</div><div>________________<br>Microsoft Teams meeting<br><a href="https://teams.microsoft.com/l/meetup-join/abc">Join the meeting now</a></div></body></html>`}
	graph.put(pasted)
	remoteID := "ev-pasted"
	line := "Join the meeting: https://rooms.example.com/kim?x=1&y=2"
	text := graphIcal(t, graph, "ev-pasted", func(m *ical.Component) {
		description := m.Text("DESCRIPTION") + "\n\n" + line
		m.Remove("DESCRIPTION")
		m.AddText("DESCRIPTION", description)
	})
	result := write(t, graph, calendarWith(true), "uid-ev-pasted", &remoteID, text)
	if result.Outcome != api.OperationDone {
		t.Fatalf("result = %+v", result)
	}
	writes := graph.writes()
	if len(writes) != 1 {
		t.Fatalf("writes = %+v", writes)
	}
	content := writes[0].Body["body"].(map[string]any)["content"].(string)
	block := `<a href="https://teams.microsoft.com/l/meetup-join/abc">Join the meeting now</a>`
	at := strings.Index(content, block)
	if at < 0 || !strings.HasSuffix(content, "<div>Join the meeting: https://rooms.example.com/kim?x=1&amp;y=2</div></body></html>") || strings.Index(content, "rooms.example.com") < at {
		t.Fatalf("content = %s", content)
	}
	description := parse(t, *result.Current.Ical).Master().Text("DESCRIPTION")
	lines := strings.Split(description, "\n")
	if lines[len(lines)-1] != line || !strings.Contains(description, "Microsoft Teams meeting") {
		t.Errorf("description read back = %q", description)
	}
}

func TestJoinLineAtFindsOnlyTheLastLine(t *testing.T) {
	cases := []struct {
		name, text string
		want       int
	}{
		{"alone", "Join the meeting: https://rooms.example.com/kim", 0},
		{"after the text", "Agenda\n\nJoin the meeting: https://rooms.example.com/kim", 8},
		{"with an app", "Agenda\nJoin with Zoom: https://zoom.us/j/1?pwd=x", 7},
		{"trailing spaces and lines", "Agenda\nJoin the meeting: https://rooms.example.com/kim  \n\n", 7},
		{"crlf", "Agenda\r\nJoin the meeting: https://rooms.example.com/kim\r\n", 8},
		{"not last", "Join the meeting: https://rooms.example.com/kim\nSee you", -1},
		{"not https", "Join the meeting: http://rooms.example.com/kim", -1},
		{"text after the link", "Join the meeting: https://rooms.example.com/kim and more", -1},
		{"an app name too long", "Join with " + strings.Repeat("x", 41) + ": https://rooms.example.com/kim", -1},
		{"empty", "", -1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := joinLineAt(c.text); got != c.want {
				t.Errorf("joinLineAt(%q) = %d; want %d", c.text, got, c.want)
			}
		})
	}
}
