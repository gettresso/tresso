package graphcal

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
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

// joinLineFixture is shared with the API's MeetingJoinLineTest: both read the join line by the same rule.
const joinLineFixture = "../../../api/tests/Fixtures/meeting-join-lines.json"

func TestTheJoinLineIsReadByTheRuleTheAPIShares(t *testing.T) {
	data, err := os.ReadFile(joinLineFixture)
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name        string  `json:"name"`
		Description string  `json:"description"`
		Link        *string `json:"link"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 20 {
		t.Fatalf("only %d cases", len(cases))
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			want := ""
			if c.Link != nil {
				want = *c.Link
			}
			link, start := joinLine(lines(c.Description))
			if link != want || (start >= 0) != (want != "") {
				t.Errorf("joinLine(%q) = %q at %d; want %q", c.Description, link, start, want)
			}
		})
	}
}

// description sets the event's description at Graph by a write from Tresso, as the API would after edit, and gives
// the description Graph's version then has.
func setDescription(t *testing.T, graph *fakeGraph, id string, edit func(string) string) (string, int) {
	t.Helper()
	remoteID := id
	text := graphIcal(t, graph, id, func(m *ical.Component) {
		description := edit(m.Text("DESCRIPTION"))
		m.Remove("DESCRIPTION")
		m.AddText("DESCRIPTION", description)
	})
	before := len(graph.writes())
	result := write(t, graph, calendarWith(true), "uid-"+id, &remoteID, text)
	if result.Outcome != api.OperationDone || result.Current == nil {
		t.Fatalf("result = %+v", result)
	}
	return parse(t, *result.Current.Ical).Master().Text("DESCRIPTION"), len(graph.writes()) - before
}

// withLine is the description with every join line taken out and line (when not empty) put at its end, as the API's
// MeetingJoinLine::with does.
func withLine(description, line string) string {
	var kept []string
	for _, l := range strings.Split(description, "\n") {
		if !isJoinLine(strings.TrimRight(l, " \t")) {
			kept = append(kept, l)
		}
	}
	out := strings.TrimRight(strings.Join(kept, "\n"), " \t\n")
	if line == "" {
		return out
	}
	return out + "\n\n" + line
}

func TestTheJoinLineAfterATeamsBlockIsKeptOnceThroughEveryChange(t *testing.T) {
	graph := newFakeGraph(t)
	pasted := single("ev-pasted", "Planning")
	pasted.Body = &itemBody{ContentType: "html", Content: `<html><body><div>Agenda</div><div>________________<br>Microsoft Teams meeting<br><a href="https://teams.microsoft.com/l/meetup-join/abc">Join the meeting now</a></div></body></html>`}
	graph.put(pasted)
	first := "Join the meeting: https://rooms.example.com/kim?x=1&y=2"
	second := "Join the meeting: https://rooms.example.com/other"
	count := func(description, line string) int { return strings.Count(description, line) }

	// Added.
	description, _ := setDescription(t, graph, "ev-pasted", func(d string) string { return withLine(d, first) })
	if count(description, first) != 1 || !strings.HasSuffix(description, first) {
		t.Fatalf("added: %q", description)
	}
	// The text edited, the line as it was.
	description, _ = setDescription(t, graph, "ev-pasted", func(d string) string { return strings.Replace(d, "Agenda", "Agenda, v2", 1) })
	if count(description, first) != 1 || !strings.HasSuffix(description, first) || !strings.HasPrefix(description, "Agenda, v2") {
		t.Fatalf("edited: %q", description)
	}
	// Another link.
	description, _ = setDescription(t, graph, "ev-pasted", func(d string) string { return withLine(d, second) })
	if count(description, first) != 0 || count(description, second) != 1 || !strings.HasSuffix(description, second) {
		t.Fatalf("changed: %q", description)
	}
	// Removed: no line is left, so the removed link is not read back.
	description, _ = setDescription(t, graph, "ev-pasted", func(d string) string { return withLine(d, "") })
	if link, _ := joinLine(description); link != "" || strings.Contains(description, "rooms.example.com") {
		t.Fatalf("removed: %q", description)
	}
	if !strings.Contains(description, "Microsoft Teams meeting") {
		t.Errorf("the Teams block stays: %q", description)
	}
	// Unchanged: nothing is sent.
	if _, writes := setDescription(t, graph, "ev-pasted", func(d string) string { return d }); writes != 0 {
		t.Errorf("an unchanged event is written again (%d writes)", writes)
	}
	e, _ := graph.get("ev-pasted")
	if strings.Count(e.Body.Content, "teams.microsoft.com/l/meetup-join/abc") != 1 {
		t.Errorf("body = %s", e.Body.Content)
	}
}

func TestAJoinLineExchangeRewroteIsTakenOffTheBlockToo(t *testing.T) {
	block := `<div>________________<br>Microsoft Teams meeting<br><a href="https://teams.microsoft.com/l/meetup-join/abc">Join the meeting now</a></div>`
	cases := []struct{ name, tail string }{
		{"as Tresso wrote it", `<div>Join the meeting: https://rooms.example.com/kim?x=1&amp;y=2</div>`},
		{"with attributes", `<div class="x" style="font-family:Calibri">Join the meeting: https://rooms.example.com/kim</div>`},
		{"with the link made an anchor", `<div><span>Join the meeting: <a href="https://rooms.example.com/kim">https://rooms.example.com/kim</a></span></div>`},
		{"with the text typed below it", `<div>Join the meeting: https://rooms.example.com/kim<br>See you there<br>Bring the slides</div>`},
		{"with a line break at its end", `<div>Join the meeting: https://rooms.example.com/kim<BR/></div>`},
		{"as a paragraph", `<p class="MsoNormal">Join the meeting: https://rooms.example.com/kim</p>`},
		{"inside another div", `<div><div>Join the meeting: https://rooms.example.com/kim</div></div>`},
		{"a paragraph inside divs", `<div class="a"><div><p>Join the meeting: <a href="https://rooms.example.com/kim">https://rooms.example.com/kim</a></p></div></div>`},
		{"with entities", `<div>Join the meeting:&nbsp;https&#58;//rooms.example.com/kim</div>`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got, _ := withoutJoinLines(block + c.tail); got != block {
				t.Errorf("withoutJoinLines = %s", got)
			}
		})
	}
	// One element with text at most: the one above it is not Tresso's (the description would not give it back).
	upper := `<div>Join the meeting: https://rooms.example.com/kim</div>` + "\r\n"
	if got, _ := withoutJoinLines(block + upper + `<div>Join the meeting: https://rooms.example.com/old</div>`); got != block+upper {
		t.Errorf("two join elements: %s", got)
	}
	if _, below := withoutJoinLines(block + `<div>Join the meeting: https://rooms.example.com/kim<br>See you there<br>Bring  the slides</div>`); below != "See you there\nBring  the slides" {
		t.Errorf("below = %q", below)
	}
	if got := endingWith("________________\nMicrosoft Teams meeting\nSee you there\nBring the slides", "See you there\nBring  the slides"); got != "See you there\nBring the slides" {
		t.Errorf("endingWith = %q", got)
	}
	if got := endingWith("________________\nMicrosoft Teams meeting", "See you there"); got != "" {
		t.Errorf("text the user took out is not put back: %q", got)
	}
	for _, kept := range []string{
		block + `<div>See you there</div>`,
		block + `<div>See you there<br>Join the meeting: https://rooms.example.com/kim</div>`,
		block + `<div><div>Join the meeting: https://rooms.example.com/kim</div><div>See you there</div></div>`,
		`<div>Join the meeting: https://rooms.example.com/kim</div>`,
		`<div><div>Join the meeting: https://rooms.example.com/kim</div></div>`,
	} {
		if got, _ := withoutJoinLines(kept); got != kept {
			t.Errorf("withoutJoinLines(%s) = %s; other text, and the block's own first element, stay", kept, got)
		}
	}
}

func TestTextTypedBelowTheJoinLineStaysWithIt(t *testing.T) {
	graph := newFakeGraph(t)
	pasted := single("ev-pasted", "Planning")
	pasted.Body = &itemBody{ContentType: "html", Content: `<html><body><div>Agenda</div><div>________________<br>Microsoft Teams meeting<br><a href="https://teams.microsoft.com/l/meetup-join/abc">Join the meeting now</a></div></body></html>`}
	graph.put(pasted)
	line := "Join the meeting: https://rooms.example.com/kim"
	other := "Join the meeting: https://rooms.example.com/other"
	below := "Bring the slides"
	check := func(step, description, line string, lines int) {
		t.Helper()
		if got := strings.Count(description, "Join the meeting: https://rooms.example.com/"); got != lines {
			t.Fatalf("%s: %d join lines in %q", step, got, description)
		}
		if got := strings.Count(description, below); got != 1 {
			t.Fatalf("%s: the text below appears %d times in %q", step, got, description)
		}
		if got := strings.Count(description, "Microsoft Teams meeting"); got != 1 {
			t.Fatalf("%s: the block appears %d times in %q", step, got, description)
		}
		link, _ := joinLine(description)
		if want := strings.TrimPrefix(line, "Join the meeting: "); link != want {
			t.Fatalf("%s: link %q; want %q", step, link, want)
		}
	}

	description, _ := setDescription(t, graph, "ev-pasted", func(d string) string { return d + "\n\n" + line + "\n" + below })
	if !strings.HasSuffix(description, line+"\n"+below) {
		t.Fatalf("description = %q", description)
	}
	check("added", description, line, 1)
	description, _ = setDescription(t, graph, "ev-pasted", func(d string) string { return strings.Replace(d, "Agenda", "Agenda v2", 1) })
	check("edited", description, line, 1)
	description, _ = setDescription(t, graph, "ev-pasted", func(d string) string { return strings.Replace(d, "Agenda v2", "Agenda v3", 1) })
	check("edited again", description, line, 1)
	description, _ = setDescription(t, graph, "ev-pasted", func(d string) string { return strings.Replace(d, line, other, 1) })
	check("changed", description, other, 1)
	description, _ = setDescription(t, graph, "ev-pasted", func(d string) string { return strings.Replace(d, other+"\n", "", 1) })
	if strings.Contains(description, "rooms.example.com") || strings.Count(description, below) != 1 || strings.Count(description, "Microsoft Teams meeting") != 1 {
		t.Fatalf("removed: %q", description)
	}
	if _, writes := setDescription(t, graph, "ev-pasted", func(d string) string { return d }); writes != 0 {
		t.Errorf("an unchanged event is written again (%d writes)", writes)
	}
}

func TestAJoinLineExchangeWrappedIsReplacedNotKept(t *testing.T) {
	for _, wrapped := range []string{
		`<p>Join the meeting: https://rooms.example.com/kim</p>`,
		`<div><div>Join the meeting: https://rooms.example.com/kim</div></div>`,
	} {
		t.Run(wrapped, func(t *testing.T) {
			graph := newFakeGraph(t)
			pasted := single("ev-pasted", "Planning")
			pasted.Body = &itemBody{ContentType: "html", Content: `<html><body><div>Agenda</div><div>________________<br>Microsoft Teams meeting<br><a href="https://teams.microsoft.com/l/meetup-join/abc">Join the meeting now</a></div>` + wrapped + `</body></html>`}
			graph.put(pasted)
			description, _ := setDescription(t, graph, "ev-pasted", func(d string) string { return withLine(d, "Join the meeting: https://rooms.example.com/other") })
			if strings.Contains(description, "rooms.example.com/kim") || strings.Count(description, "rooms.example.com/other") != 1 {
				t.Fatalf("changed: %q", description)
			}
			description, _ = setDescription(t, graph, "ev-pasted", func(d string) string { return withLine(d, "") })
			if strings.Contains(description, "rooms.example.com") || !strings.Contains(description, "Microsoft Teams meeting") {
				t.Fatalf("removed: %q", description)
			}
		})
	}
}

func TestAnOwnLinkStaysStableThroughExchangesTextRoundTrips(t *testing.T) {
	graph := newFakeGraph(t)
	room := "https://rooms.example.com/kim?x=1&y=2"
	// As Outlook may leave it: the address made a link, the text with runs of spaces.
	linked := single("ev-linked", "Planning")
	linked.Body = &itemBody{ContentType: "html", Content: `<html><body><div>Agenda:   budget	and hiring</div><div>Join the meeting: <a href="https://rooms.example.com/kim?x=1&amp;y=2">https://rooms.example.com/kim?x=1&amp;y=2</a></div></body></html>`}
	graph.put(linked)

	read := graphIcal(t, graph, "ev-linked", nil)
	description := parse(t, read).Master().Text("DESCRIPTION")
	if link, _ := joinLine(description); link != room {
		t.Fatalf("the link is read from %q: %q", description, link)
	}
	if !strings.HasPrefix(description, "Agenda: budget and hiring") {
		t.Errorf("description = %q", description)
	}
	for round := 1; round <= 3; round++ {
		// Tresso's own change of another field: the body as Exchange gave it back is no change.
		remoteID := "ev-linked"
		text := graphIcal(t, graph, "ev-linked", func(m *ical.Component) {
			m.Remove("SUMMARY")
			m.AddText("SUMMARY", fmt.Sprintf("Planning %d", round))
		})
		before := len(graph.writes())
		result := write(t, graph, calendarWith(true), "uid-ev-linked", &remoteID, text)
		writes := graph.writes()[before:]
		if result.Outcome != api.OperationDone || len(writes) != 1 || writes[0].Body["body"] != nil {
			t.Fatalf("round %d: %+v", round, writes)
		}
		if link, _ := joinLine(parse(t, *result.Current.Ical).Master().Text("DESCRIPTION")); link != room {
			t.Fatalf("round %d: link %q", round, link)
		}
	}
	// The API puts the line right (one clean line): written once, then stable.
	description, writes := setDescription(t, graph, "ev-linked", func(d string) string { return withLine(d, "Join the meeting: "+room) })
	if writes != 1 || strings.Count(description, "rooms.example.com") != 1 {
		t.Fatalf("put right: %q (%d writes)", description, writes)
	}
	for round := 1; round <= 3; round++ {
		if again, writes := setDescription(t, graph, "ev-linked", func(d string) string { return d }); writes != 0 || again != description {
			t.Fatalf("round %d: %q (%d writes)", round, again, writes)
		}
	}
}

func TestATeamsMeetingGraphRefusesStillSavesTheEvent(t *testing.T) {
	cases := []struct {
		name   string
		create bool
	}{{"create", true}, {"change", false}}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			graph := newFakeGraph(t)
			// The worker's calendar list still says Teams; Graph no longer allows it.
			graph.calendars[0].AllowedOnlineMeetingProviders = nil
			var result api.OperationResult
			if c.create {
				result = write(t, graph, calendarWith(true), "review@tresso", nil, teamsEvent)
			} else {
				graph.put(single("ev1", "Lunch"))
				remoteID := "ev1"
				result = write(t, graph, calendarWith(true), "uid-ev1", &remoteID, graphIcal(t, graph, "ev1", func(m *ical.Component) {
					m.Remove("SUMMARY")
					m.AddText("SUMMARY", "Lunch at noon")
					m.Add(ConferenceRequest, "teams")
				}))
			}
			if result.Outcome != api.OperationDone {
				t.Fatalf("result = %+v", result)
			}
			if status, reason := conferenceOf(result); status != api.ConferenceFailed || reason != api.ConferenceNotSupported {
				t.Errorf("conference = %q %q", status, reason)
			}
			writes := graph.writes()
			if len(writes) != 2 || writes[0].Body["isOnlineMeeting"] != true {
				t.Fatalf("writes = %+v", writes)
			}
			if _, sent := writes[1].Body["isOnlineMeeting"]; sent || writes[1].Body["onlineMeetingProvider"] != nil {
				t.Errorf("the second write leaves the meeting out: %+v", writes[1].Body)
			}
			if !c.create && writes[1].Body["subject"] != "Lunch at noon" {
				t.Errorf("the change is saved: %+v", writes[1].Body)
			}
		})
	}
}

// teamsBodyWith is an event body with a Teams join block, and extra after it.
func teamsBodyWith(extra string) string {
	return `<html><body><div>Agenda</div><div>________________<br>Microsoft Teams meeting<br><a href="https://teams.microsoft.com/l/meetup-join/abc">Join the meeting now</a></div>` + extra + `</body></html>`
}

func TestWhatOthersWroteAfterATeamsBlockIsNeitherLostNorDoubled(t *testing.T) {
	cases := []struct {
		name, extra string
		once        []string
	}{
		{
			name:  "two paragraphs that start with a join line, notes under each",
			extra: `<p>Join with Zoom: https://zoom.us/j/1<br>NOTES-A backup room</p><p>Join the meeting: https://m.example.com/2<br>NOTES-B</p>`,
			once:  []string{"Join with Zoom: https://zoom.us/j/1", "NOTES-A backup room", "Join the meeting: https://m.example.com/2", "NOTES-B"},
		},
		{
			name:  "a join line below other text in its paragraph",
			extra: `<p>BACKUP ROOM<br>Join with Zoom: https://zoom.us/j/1</p>`,
			once:  []string{"BACKUP ROOM", "Join with Zoom: https://zoom.us/j/1"},
		},
		{
			name:  "a join paragraph above a plain one",
			extra: `<p>Join with Zoom: https://zoom.us/j/1</p><p>KEEP-ME</p>`,
			once:  []string{"Join with Zoom: https://zoom.us/j/1", "KEEP-ME"},
		},
		{
			name:  "a plain paragraph above a join one",
			extra: `<p>KEEP-ME</p><p>Join with Zoom: https://zoom.us/j/1</p>`,
			once:  []string{"KEEP-ME", "Join with Zoom: https://zoom.us/j/1"},
		},
		{
			name:  "a line below the join line that reads like one",
			extra: `<div>Join the meeting: https://rooms.example.com/kim<br>Join with Zoom: https://zoom.us/j/9</div>`,
			once:  []string{"Join the meeting: https://rooms.example.com/kim", "Join with Zoom: https://zoom.us/j/9"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			graph := newFakeGraph(t)
			pasted := single("ev-pasted", "Planning")
			pasted.Body = &itemBody{ContentType: "html", Content: teamsBodyWith(c.extra)}
			graph.put(pasted)
			for step, edit := range []func(string) string{
				func(d string) string { return strings.Replace(d, "Agenda", "Agenda v2", 1) },
				func(d string) string { return strings.Replace(d, "Agenda v2", "Agenda v3", 1) },
			} {
				description, _ := setDescription(t, graph, "ev-pasted", edit)
				for _, text := range append(c.once, "Microsoft Teams meeting") {
					if got := strings.Count(description, text); got != 1 {
						t.Fatalf("edit %d: %q appears %d times in %q", step+1, text, got, description)
					}
				}
			}
			if _, writes := setDescription(t, graph, "ev-pasted", func(d string) string { return d }); writes != 0 {
				t.Errorf("an unchanged event is written again (%d writes)", writes)
			}
		})
	}
}
