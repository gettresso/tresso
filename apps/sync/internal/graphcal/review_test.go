package graphcal

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"tresso/sync/internal/api"
	"tresso/sync/internal/calsync/calsynctest"
	"tresso/sync/internal/providerhttp"
)

const sharedCalendar = "AAMkShared"

func TestASharedCalendarIsReadAndWrittenUnderItsOwnPath(t *testing.T) {
	graph := newFakeGraph(t)
	graph.calendars = append(graph.calendars, calendarEntry{ID: sharedCalendar, Name: "Lisa", CanEdit: true})
	graph.putIn(sharedCalendar, single("ev-shared", "Lisa's planning"))
	fake := calsynctest.NewAPI(owner)
	run(t, graph, fake)
	calsynctest.Eventually(t, "the shared calendar", func() bool { _, ok := fake.Objects(sharedCalendar)["ev-shared"]; return ok })
	object := fake.Objects(sharedCalendar)["ev-shared"]

	remoteID, etag := "ev-shared", object.ETag
	renamed := strings.Replace(object.Ical, "SUMMARY:Lisa's planning", "SUMMARY:Planning", 1)
	fake.Queue(api.CalendarOperation{ID: "rename", Kind: "put", CalendarRemoteID: sharedCalendar, UID: "uid-ev-shared", RemoteID: &remoteID, IfMatch: &etag, Ical: &renamed, Notify: true})
	calsynctest.Eventually(t, "the write", func() bool { _, ok := fake.Result("rename"); return ok })

	if r, _ := fake.Result("rename"); r.Outcome != api.OperationDone {
		t.Fatalf("result = %+v", r)
	}
	writes := graph.writes()
	if len(writes) != 1 || writes[0].Path != "/v1.0/me/calendars/"+sharedCalendar+"/events/ev-shared" {
		t.Fatalf("writes = %+v", writes)
	}
	if _, ok := fake.Objects(sharedCalendar)["ev-shared"]; !ok {
		t.Fatal("the local copy stays")
	}
}

func TestEventsAreReadInTheirOwnZoneOrInUTC(t *testing.T) {
	graph := newFakeGraph(t)
	pacific := single("ev-pacific", "Standup in Seattle")
	pacific.OriginalStartTimeZone = "Pacific Standard Time"
	pacific.Start = &dateTimeTimeZone{DateTime: "2026-10-19T09:00:00.0000000", TimeZone: "Pacific Standard Time"}
	pacific.End = &dateTimeTimeZone{DateTime: "2026-10-19T09:30:00.0000000", TimeZone: "Pacific Standard Time"}
	graph.put(pacific)
	custom := single("ev-custom", "Made in an old Outlook")
	custom.OriginalStartTimeZone = "Customized Time Zone"
	custom.Start = &dateTimeTimeZone{DateTime: "2026-10-19T09:00:00.0000000", TimeZone: "Customized Time Zone"}
	custom.End = &dateTimeTimeZone{DateTime: "2026-10-19T10:00:00.0000000", TimeZone: "Customized Time Zone"}
	graph.put(custom)
	allDay := single("ev-day", "Off")
	allDay.IsAllDay = true
	allDay.Start = &dateTimeTimeZone{DateTime: "2026-10-20T00:00:00.0000000", TimeZone: "W. Europe Standard Time"}
	allDay.End = &dateTimeTimeZone{DateTime: "2026-10-22T00:00:00.0000000", TimeZone: "W. Europe Standard Time"}
	graph.put(allDay)
	fake := calsynctest.NewAPI(owner)
	run(t, graph, fake)
	calsynctest.Eventually(t, "the sync", func() bool { return len(fake.Objects(defaultCalendar)) == 3 })
	objects := fake.Objects(defaultCalendar)

	if start := parse(t, objects["ev-pacific"].Ical).Master().Get("DTSTART"); start.Param("TZID") != "America/Los_Angeles" || start.Value != "20261019T090000" {
		t.Errorf("Pacific: %+v", start)
	}
	if start := parse(t, objects["ev-custom"].Ical).Master().Get("DTSTART"); start.Value != "20261019T130000Z" {
		t.Errorf("a zone Tresso cannot place is read in UTC, at the right instant: %+v", start)
	}
	for _, request := range graph.gets("/events/ev-custom") {
		if request.Query.Get("$expand") != "" && !strings.Contains(strings.Join(request.Prefer, ","), `outlook.timezone="UTC"`) {
			t.Errorf("prefer = %v", request.Prefer)
		}
	}
	day := parse(t, objects["ev-day"].Ical).Master()
	if day.Get("DTSTART").Value != "20261020" || day.Get("DTEND").Value != "20261022" || day.Get("DTSTART").Param("VALUE") != "DATE" {
		t.Errorf("all day: %+v %+v", day.Get("DTSTART"), day.Get("DTEND"))
	}
}

func TestADescriptionEditKeepsTheTeamsJoinBlock(t *testing.T) {
	graph := newFakeGraph(t)
	meeting := single("ev-teams", "Planning")
	meeting.IsOnlineMeeting, meeting.OnlineMeetingProvider = true, "teamsForBusiness"
	meeting.OnlineMeeting = &onlineMeetingInfo{JoinURL: "https://teams.microsoft.com/l/meetup-join/abc"}
	meeting.Body = &itemBody{ContentType: "html", Content: `<html><body><div><b>Agenda</b></div><div style="color:#252424">________________<br>Microsoft Teams meeting<br><a href="https://teams.microsoft.com/l/meetup-join/abc">Join the meeting now</a></div></body></html>`}
	graph.put(meeting)
	fake := calsynctest.NewAPI(owner)
	run(t, graph, fake)
	calsynctest.Eventually(t, "the sync", func() bool { _, ok := fake.Objects(defaultCalendar)["ev-teams"]; return ok })
	object := fake.Objects(defaultCalendar)["ev-teams"]
	if !strings.Contains(object.Ical, "DESCRIPTION:Agenda") {
		t.Fatalf("ical:\n%s", object.Ical)
	}

	remoteID, etag := "ev-teams", object.ETag
	edited := strings.Replace(object.Ical, "DESCRIPTION:Agenda", "DESCRIPTION:Agenda & notes", 1)
	fake.Queue(api.CalendarOperation{ID: "edit", Kind: "put", CalendarRemoteID: defaultCalendar, UID: "uid-ev-teams", RemoteID: &remoteID, IfMatch: &etag, Ical: &edited, Notify: true})
	calsynctest.Eventually(t, "the write", func() bool { _, ok := fake.Result("edit"); return ok })

	writes := graph.writes()
	if len(writes) != 1 {
		t.Fatalf("writes = %+v", writes)
	}
	body := writes[0].Body["body"].(map[string]any)
	content := body["content"].(string)
	if body["contentType"] != "html" || !strings.Contains(content, "Agenda &amp; notes") || !strings.Contains(content, `<a href="https://teams.microsoft.com/l/meetup-join/abc">Join the meeting now</a>`) {
		t.Fatalf("body = %v", body)
	}
}

func TestAPartlyWrittenSeriesResumesFromWhatGraphHas(t *testing.T) {
	graph := newFakeGraph(t)
	master, occurrences := weekly("ev7")
	graph.put(master, occurrences...)
	fake := calsynctest.NewAPI(owner)
	run(t, graph, fake)
	calsynctest.Eventually(t, "the sync", func() bool { _, ok := fake.Objects(defaultCalendar)["ev7"]; return ok })
	object := fake.Objects(defaultCalendar)["ev7"]

	override := "BEGIN:VEVENT\r\nUID:uid-ev7\r\nDTSTAMP:20261001T000000Z\r\nRECURRENCE-ID;TZID=Europe/Amsterdam:20261026T090000\r\n" +
		"DTSTART;TZID=Europe/Amsterdam:20261026T100000\r\nDTEND;TZID=Europe/Amsterdam:20261026T103000\r\nSUMMARY:Standup\r\n" +
		"BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
	edited := strings.Replace(strings.Replace(object.Ical, "SUMMARY:Standup", "SUMMARY:Daily standup", 1), "END:VCALENDAR\r\n", override, 1)
	graph.mu.Lock()
	graph.failures["PATCH /events/ev7-occ1"] = http.StatusServiceUnavailable
	graph.mu.Unlock()
	remoteID, etag := "ev7", object.ETag
	fake.Queue(api.CalendarOperation{ID: "first", Kind: "put", CalendarRemoteID: defaultCalendar, UID: "uid-ev7", RemoteID: &remoteID, IfMatch: &etag, Ical: &edited, Notify: true})
	calsynctest.Eventually(t, "the first attempt", func() bool { _, ok := fake.Result("first"); return ok })

	first, _ := fake.Result("first")
	if first.Outcome != api.OperationRetry || first.ETag == nil || *first.ETag == object.ETag || first.RemoteID == nil || *first.RemoteID != "ev7" {
		t.Fatalf("the retry carries the changeKey the master's write made: %+v", first)
	}
	if first.Current == nil || !strings.Contains(*first.Current.Ical, "Daily standup") {
		t.Fatalf("and Graph's version, which Tresso keeps if no attempt succeeds: %+v", first.Current)
	}

	next := *first.ETag
	fake.Queue(api.CalendarOperation{ID: "again", Kind: "put", CalendarRemoteID: defaultCalendar, UID: "uid-ev7", RemoteID: &remoteID, IfMatch: &next, Ical: &edited, Notify: true})
	calsynctest.Eventually(t, "the retry", func() bool { _, ok := fake.Result("again"); return ok })
	if again, _ := fake.Result("again"); again.Outcome != api.OperationDone || again.Current == nil || len(parse(t, *again.Current.Ical).Overrides()) != 1 {
		t.Fatalf("the retry finishes the write: %+v", again)
	}
}

func TestGraphNeverSaysCalendarsAreNotAllowed(t *testing.T) {
	// Graph answers ErrorAccessDenied alike for a token without the scopes and for one calendar taken back; only a
	// refused calendar list speaks for the account (calsync).
	denied := &providerhttp.StatusError{Method: "GET", URL: "/me/calendars/x/events", StatusCode: http.StatusForbidden, Reasons: []string{"ErrorAccessDenied"}}
	if (&Provider{}).NotGranted(denied) {
		t.Fatal("a 403 on one calendar is no account problem")
	}
}

func TestAWriteGraphRefusesWith403SaysWhatIsKnown(t *testing.T) {
	graph := newFakeGraph(t)
	graph.put(single("ev10", "Lunch"))
	fake := calsynctest.NewAPI(owner)
	run(t, graph, fake)
	calsynctest.Eventually(t, "the sync", func() bool { _, ok := fake.Objects(defaultCalendar)["ev10"]; return ok })
	object := fake.Objects(defaultCalendar)["ev10"]
	graph.mu.Lock()
	graph.failures["PATCH /events/ev10"] = http.StatusForbidden
	graph.mu.Unlock()

	remoteID, etag := "ev10", object.ETag
	renamed := strings.Replace(object.Ical, "SUMMARY:Lunch", "SUMMARY:Brunch", 1)
	fake.Queue(api.CalendarOperation{ID: "rename", Kind: "put", CalendarRemoteID: defaultCalendar, UID: "uid-ev10", RemoteID: &remoteID, IfMatch: &etag, Ical: &renamed, Notify: true})
	calsynctest.Eventually(t, "the write", func() bool { _, ok := fake.Result("rename"); return ok })

	r, _ := fake.Result("rename")
	if r.Outcome != api.OperationFailed || r.Error == nil || *r.Error != "Microsoft refused the change (403). The calendar may be read-only for you." {
		t.Fatalf("a 403 on a write says what is known and the likely cause: %+v", r)
	}
}

func TestAnOccurrenceThatKeepsFailingStillReportsGraphsVersion(t *testing.T) {
	graph := newFakeGraph(t)
	master, occurrences := weekly("ev8")
	graph.put(master, occurrences...)
	fake := calsynctest.NewAPI(owner)
	run(t, graph, fake)
	calsynctest.Eventually(t, "the sync", func() bool { _, ok := fake.Objects(defaultCalendar)["ev8"]; return ok })
	object := fake.Objects(defaultCalendar)["ev8"]
	override := "BEGIN:VEVENT\r\nUID:uid-ev8\r\nDTSTAMP:20261001T000000Z\r\nRECURRENCE-ID;TZID=Europe/Amsterdam:20261026T090000\r\n" +
		"DTSTART;TZID=Europe/Amsterdam:20261026T100000\r\nDTEND;TZID=Europe/Amsterdam:20261026T103000\r\nSUMMARY:Standup\r\n" +
		"BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
	edited := strings.Replace(strings.Replace(object.Ical, "SUMMARY:Standup", "SUMMARY:Daily standup", 1), "END:VCALENDAR\r\n", override, 1)

	remoteID, etag := "ev8", object.ETag
	for attempt := range 3 {
		graph.mu.Lock()
		graph.failures["PATCH /events/ev8-occ1"] = http.StatusServiceUnavailable
		graph.mu.Unlock()
		id, ifMatch := fmt.Sprintf("attempt-%d", attempt), etag
		fake.Queue(api.CalendarOperation{ID: id, Kind: "put", CalendarRemoteID: defaultCalendar, UID: "uid-ev8", RemoteID: &remoteID, IfMatch: &ifMatch, Ical: &edited, Notify: true})
		calsynctest.Eventually(t, "attempt "+id, func() bool { _, ok := fake.Result(id); return ok })
		r, _ := fake.Result(id)
		if r.Outcome != api.OperationRetry || r.ETag == nil || r.Current == nil || !strings.Contains(*r.Current.Ical, "Daily standup") {
			t.Fatalf("attempt %d reports Graph's version, which Tresso keeps when no attempt is left: %+v", attempt, r)
		}
		etag = *r.ETag
	}
}

func TestAnEditAtMicrosoftBeforeAFailedWriteIsAConflictNotAnOverwrite(t *testing.T) {
	graph := newFakeGraph(t)
	graph.put(single("ev9", "Lunch"))
	fake := calsynctest.NewAPI(owner)
	run(t, graph, fake)
	calsynctest.Eventually(t, "the sync", func() bool { _, ok := fake.Objects(defaultCalendar)["ev9"]; return ok })
	object := fake.Objects(defaultCalendar)["ev9"]
	// Lisa edits the event after the worker read it; Graph then answers the worker's write with a 503, not a 412.
	graph.mu.Lock()
	graph.beforeWrite = func(method, path string) {
		if method != http.MethodPatch || !strings.HasSuffix(path, "/events/ev9") || graph.beforeWrite == nil {
			return
		}
		e := graph.events["ev9"]
		e.Subject = "Lunch, Lisa's version"
		graph.touch(e)
		graph.beforeWrite = nil
	}
	graph.failures["PATCH /events/ev9"] = http.StatusServiceUnavailable
	graph.mu.Unlock()

	remoteID, etag := "ev9", object.ETag
	renamed := strings.Replace(object.Ical, "SUMMARY:Lunch", "SUMMARY:Brunch", 1)
	fake.Queue(api.CalendarOperation{ID: "rename", Kind: "put", CalendarRemoteID: defaultCalendar, UID: "uid-ev9", RemoteID: &remoteID, IfMatch: &etag, Ical: &renamed, Notify: true})
	calsynctest.Eventually(t, "the write", func() bool { _, ok := fake.Result("rename"); return ok })

	r, _ := fake.Result("rename")
	if r.Outcome != api.OperationConflict || r.Current == nil || !strings.Contains(*r.Current.Ical, "Lisa's version") {
		t.Fatalf("a retry would pass the If-Match and overwrite Lisa's edit; it is a conflict: %+v", r)
	}
	if e, _ := graph.get("ev9"); e.Subject != "Lunch, Lisa's version" {
		t.Fatalf("subject = %q", e.Subject)
	}
}
