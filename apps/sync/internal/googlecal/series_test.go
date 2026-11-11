package googlecal

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"tresso/sync/internal/api"
	"tresso/sync/internal/calsync/calsynctest"
	"tresso/sync/internal/ical"
)

// invitedSeries is a weekly series Lisa organizes, with Kim invited and one occurrence cancelled by Lisa.
func invitedSeries(google *fakeGoogle) event {
	series := meetingEvent("review", "Review")
	series.Recurrence = []string{"RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=5"}
	series.Organizer = &person{Email: "lisa@example.org"}
	series.Attendees = []person{{Email: "lisa@example.org", Organizer: true, ResponseStatus: "accepted"}, {Email: calendarID, Self: true, ResponseStatus: "needsAction"}}
	google.put(calendarID, series)
	cancelled := event{ID: "review_20261026T080000Z", ICalUID: series.ICalUID, RecurringEventID: "review", Status: "cancelled",
		OriginalStartTime: &eventTime{DateTime: "2026-10-26T09:00:00+01:00", TimeZone: "Europe/Amsterdam"}}
	google.put(calendarID, cancelled)
	return series
}

func synced(t *testing.T, google *fakeGoogle, id string) (*calsynctest.API, calsynctest.Stored) {
	t.Helper()
	fake := calsynctest.NewAPI(calendarID)
	run(t, google, fake)
	calsynctest.Eventually(t, "the sync", func() bool { _, ok := stored(fake, id); return ok })
	object, _ := stored(fake, id)
	return fake, object
}

func queue(fake *calsynctest.API, id, remoteID, etag, text string, notify bool) {
	fake.Queue(api.CalendarOperation{ID: id, Kind: "put", CalendarRemoteID: calendarID, UID: remoteID + "@google.com", RemoteID: &remoteID, IfMatch: &etag, Ical: &text, Notify: notify})
}

func result(t *testing.T, fake *calsynctest.API, id string) api.OperationResult {
	t.Helper()
	calsynctest.Eventually(t, "the write "+id, func() bool { _, ok := fake.Result(id); return ok })
	r, _ := fake.Result(id)
	return r
}

func TestAnInviteeAnswersASeriesTheOrganizerCancelledAnOccurrenceOf(t *testing.T) {
	google := newFakeGoogle(t)
	invitedSeries(google)
	fake, object := synced(t, google, "review")
	if !strings.Contains(object.Ical, "EXDATE") {
		t.Fatalf("the cancelled occurrence is an EXDATE:\n%s", object.Ical)
	}

	queue(fake, "rsvp", "review", object.ETag, answer(t, object.Ical, calendarID, "ACCEPTED"), true)

	if r := result(t, fake, "rsvp"); r.Outcome != api.OperationDone {
		t.Fatalf("result = %+v", r)
	}
	writes := google.writes()
	if len(writes) != 1 || !strings.HasSuffix(writes[0].Path, "/events/review") || len(writes[0].Body) != 1 || writes[0].Body["attendees"] == nil {
		t.Fatalf("the answer patches the series' attendees only: %+v", writes)
	}
	if e, _ := google.get(calendarID, "review"); e.Attendees[1].ResponseStatus != "accepted" {
		t.Errorf("attendees = %+v", e.Attendees)
	}
}

func TestAnInviteeAnswersOneOccurrenceThatIsNoExceptionYet(t *testing.T) {
	google := newFakeGoogle(t)
	invitedSeries(google)
	fake, object := synced(t, google, "review")

	// The API answers one occurrence by adding an override that copies the occurrence, with the answer.
	doc := parse(t, object.Ical)
	master := doc.Master()
	override := &ical.Component{Name: "VEVENT"}
	for _, p := range master.Props {
		switch p.Name {
		case "RRULE", "EXDATE", "DTSTART", "DTEND":
			continue
		}
		override.Props = append(override.Props, p)
	}
	override.Add("RECURRENCE-ID", "20261102T090000", ical.Param{Name: "TZID", Values: []string{"Europe/Amsterdam"}})
	override.Add("DTSTART", "20261102T090000", ical.Param{Name: "TZID", Values: []string{"Europe/Amsterdam"}})
	override.Add("DTEND", "20261102T093000", ical.Param{Name: "TZID", Values: []string{"Europe/Amsterdam"}})
	override.Children = master.Children
	doc.Children = append(doc.Children, override)
	for i, p := range doc.Overrides()[0].Props {
		if p.Name == "ATTENDEE" && strings.Contains(p.Value, calendarID) {
			doc.Overrides()[0].Props[i].Params = []ical.Param{{Name: "PARTSTAT", Values: []string{"DECLINED"}}}
		}
	}

	queue(fake, "occurrence", "review", object.ETag, doc.Serialize(), false)

	if r := result(t, fake, "occurrence"); r.Outcome != api.OperationDone {
		t.Fatalf("result = %+v", r)
	}
	writes := google.writes()
	if len(writes) != 1 || !strings.HasSuffix(writes[0].Path, "/events/review_20261102T080000Z") || len(writes[0].Body) != 1 || writes[0].Query["sendUpdates"] != "none" {
		t.Fatalf("only the occurrence's attendees are patched: %+v", writes)
	}
	attendees := writes[0].Body["attendees"].([]any)
	if attendees[1].(map[string]any)["responseStatus"] != "declined" {
		t.Errorf("attendees = %v", attendees)
	}
}

func TestAnUnchangedSeriesWithACancelledOccurrenceIsNotWritten(t *testing.T) {
	google := newFakeGoogle(t)
	series := meetingEvent("standup", "Standup")
	series.Recurrence = []string{"RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=5"}
	series.Attendees = []person{{Email: "lisa@example.org", ResponseStatus: "accepted"}}
	google.put(calendarID, series)
	google.put(calendarID, event{ID: "standup_20261026T080000Z", ICalUID: series.ICalUID, RecurringEventID: "standup", Status: "cancelled",
		OriginalStartTime: &eventTime{DateTime: "2026-10-26T09:00:00+01:00", TimeZone: "Europe/Amsterdam"}})
	fake, object := synced(t, google, "standup")

	queue(fake, "same", "standup", object.ETag, object.Ical, true)

	if r := result(t, fake, "same"); r.Outcome != api.OperationDone {
		t.Fatalf("result = %+v", r)
	}
	if writes := google.writes(); len(writes) != 0 {
		t.Fatalf("nothing changed, so nothing is sent and Lisa gets no update: %+v", writes)
	}
}

func TestAPartlyWrittenChangeResumesFromWhatGoogleHas(t *testing.T) {
	google := newFakeGoogle(t)
	series := meetingEvent("standup", "Standup")
	series.Recurrence = []string{"RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=5"}
	google.put(calendarID, series)
	fake, object := synced(t, google, "standup")

	override := "BEGIN:VEVENT\r\nUID:standup@google.com\r\nDTSTAMP:20261001T000000Z\r\nRECURRENCE-ID;TZID=Europe/Amsterdam:20261026T090000\r\n" +
		"DTSTART;TZID=Europe/Amsterdam:20261026T110000\r\nDTEND;TZID=Europe/Amsterdam:20261026T113000\r\nSUMMARY:Standup, later\r\n" +
		"BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
	edited := strings.Replace(strings.Replace(object.Ical, "SUMMARY:Standup", "SUMMARY:Daily standup", 1), "END:VCALENDAR\r\n", override, 1)
	google.mu.Lock()
	google.failures["PATCH /events/standup_20261026T080000Z"] = http.StatusServiceUnavailable
	google.mu.Unlock()

	queue(fake, "first", "standup", object.ETag, edited, true)

	first := result(t, fake, "first")
	if first.Outcome != api.OperationRetry || first.ETag == nil || *first.ETag == object.ETag || first.RemoteID == nil || *first.RemoteID != "standup" {
		t.Fatalf("the retry carries the version the master's write made: %+v", first)
	}
	if e, _ := google.get(calendarID, "standup"); e.Summary != "Daily standup" {
		t.Fatalf("summary = %q", e.Summary)
	}
	if first.Current == nil || !strings.Contains(*first.Current.Ical, "Daily standup") {
		t.Fatalf("the retry carries Google's version too, which Tresso keeps if no attempt succeeds: %+v", first.Current)
	}

	queue(fake, "again", "standup", *first.ETag, edited, true)

	again := result(t, fake, "again")
	if again.Outcome != api.OperationDone || again.Current == nil || !strings.Contains(*again.Current.Ical, "Standup\\, later") || !strings.Contains(*again.Current.Ical, "Daily standup") {
		t.Fatalf("the retry finishes the write: %+v", again)
	}
}

func TestAGoogleEventThatCannotBeConvertedKeepsItsCopy(t *testing.T) {
	google := newFakeGoogle(t)
	google.put(calendarID, meetingEvent("lunch", "Lunch"))
	fake, object := synced(t, google, "lunch")

	broken := meetingEvent("lunch", "Lunch, moved")
	broken.Recurrence = []string{"not a content line"}
	google.put(calendarID, broken)
	google.put(calendarID, meetingEvent("review", "Review"))
	calsynctest.Eventually(t, "the next change", func() bool { _, ok := stored(fake, "review"); return ok })
	if kept, ok := stored(fake, "lunch"); !ok || kept.Ical != object.Ical {
		t.Fatal("an event that cannot be converted keeps its stored copy")
	}

	google.forget()
	google.put(calendarID, meetingEvent("planning", "Planning"))
	calsynctest.Eventually(t, "the full listing", func() bool { _, ok := stored(fake, "planning"); return ok })
	if _, ok := stored(fake, "lunch"); !ok {
		t.Fatal("a full listing does not remove it either")
	}
}

func TestOneRefusedCalendarDoesNotStopTheOthers(t *testing.T) {
	google := newFakeGoogle(t)
	google.addCalendar(calendarListEntry{ID: "team@group.calendar.google.com", Summary: "Team", AccessRole: "reader", TimeZone: "Europe/Amsterdam"})
	google.refusedCalendars["team@group.calendar.google.com"] = true
	google.put(calendarID, meetingEvent("lunch", "Lunch"))
	fake, _ := synced(t, google, "lunch")

	google.put(calendarID, meetingEvent("review", "Review"))
	calsynctest.Eventually(t, "the next sync", func() bool { _, ok := stored(fake, "review"); return ok })
	if statuses := fake.Statuses(); len(statuses) != 0 {
		t.Fatalf("one calendar taken back is no account problem: %v", statuses)
	}
}

func TestAWriteToACalendarTheUserMayOnlyReadIsRefusedNotRetried(t *testing.T) {
	google := newFakeGoogle(t)
	google.put(calendarID, meetingEvent("lunch", "Lunch"))
	fake, object := synced(t, google, "lunch")
	google.mu.Lock()
	google.failures["PATCH /events/lunch"] = http.StatusForbidden
	google.mu.Unlock()

	queue(fake, "rename", "lunch", object.ETag, strings.Replace(object.Ical, "SUMMARY:Lunch", "SUMMARY:Brunch", 1), true)

	r := result(t, fake, "rename")
	if r.Outcome != api.OperationFailed || r.Current == nil || !strings.Contains(*r.Error, "read-only") {
		t.Fatalf("result = %+v", r)
	}
	// A refused write is no account problem; the only status is the active a start reports once.
	for _, status := range fake.Statuses() {
		if status != api.CalendarActive {
			t.Fatalf("statuses = %v", fake.Statuses())
		}
	}
}

func TestMovingAnEventToAnotherCalendarUsesGooglesMove(t *testing.T) {
	google := newFakeGoogle(t)
	google.addCalendar(calendarListEntry{ID: "team@group.calendar.google.com", Summary: "Team", AccessRole: "writer", TimeZone: "Europe/Amsterdam", DefaultReminders: []reminder{{Method: "popup", Minutes: 10}}})
	lunch := meetingEvent("lunch", "Lunch")
	lunch.Attendees = []person{{Email: "lisa@example.org", ResponseStatus: "accepted"}}
	google.put(calendarID, lunch)
	fake, object := synced(t, google, "lunch")

	// The API queues a move as a delete in the old calendar and a create in the new one.
	remoteID, etag, text := "lunch", object.ETag, object.Ical
	fake.Queue(api.CalendarOperation{ID: "out", Kind: "delete", CalendarRemoteID: calendarID, UID: "lunch@google.com", RemoteID: &remoteID, IfMatch: &etag, Notify: true})
	fake.Queue(api.CalendarOperation{ID: "in", Kind: "put", CalendarRemoteID: "team@group.calendar.google.com", UID: "lunch@google.com", Ical: &text, Notify: true})

	in := result(t, fake, "in")
	if out, _ := fake.Result("out"); out.Outcome != api.OperationDone || in.Outcome != api.OperationDone || in.RemoteID == nil || *in.RemoteID != "lunch" {
		t.Fatalf("out = %+v, in = %+v", out, in)
	}
	writes := google.writes()
	if len(writes) != 1 || !strings.HasSuffix(writes[0].Path, "/events/lunch/move") || writes[0].Query["destination"] != "team@group.calendar.google.com" || writes[0].Query["sendUpdates"] != "none" {
		t.Fatalf("one move, no delete and no new invitation: %+v", writes)
	}
	if e, ok := google.get("team@group.calendar.google.com", "lunch"); !ok || e.cancelled() {
		t.Fatal("the event is in the team calendar")
	}
}

func TestAnEventChangedAtGoogleBeforeItsMoveIsNotMovedOver(t *testing.T) {
	google := newFakeGoogle(t)
	google.addCalendar(calendarListEntry{ID: "team@group.calendar.google.com", Summary: "Team", AccessRole: "writer", TimeZone: "Europe/Amsterdam", DefaultReminders: []reminder{{Method: "popup", Minutes: 10}}})
	google.put(calendarID, meetingEvent("lunch", "Lunch"))
	fake, object := synced(t, google, "lunch")
	google.put(calendarID, meetingEvent("lunch", "Lunch, moved to noon by Lisa"))

	remoteID, etag, text := "lunch", object.ETag, object.Ical
	fake.Queue(api.CalendarOperation{ID: "out", Kind: "delete", CalendarRemoteID: calendarID, UID: "lunch@google.com", RemoteID: &remoteID, IfMatch: &etag, Notify: true})
	fake.Queue(api.CalendarOperation{ID: "in", Kind: "put", CalendarRemoteID: "team@group.calendar.google.com", UID: "lunch@google.com", Ical: &text, Notify: true})
	result(t, fake, "in")

	// The create is answered by the move, the delete after it.
	if out := result(t, fake, "out"); out.Outcome != api.OperationConflict || out.Current == nil || !strings.Contains(*out.Current.Ical, "Lisa") {
		t.Fatalf("the delete is a conflict with Lisa's version: %+v", out)
	}
	for _, write := range google.writes() {
		if strings.HasSuffix(write.Path, "/move") || strings.Contains(write.Path, "/calendars/team@group.calendar.google.com/") {
			t.Fatalf("nothing is moved, and no second copy is made in the team calendar: %+v", google.writes())
		}
	}
	if in, _ := fake.Result("in"); in.Outcome != api.OperationConflict {
		t.Fatalf("the create is held back as a conflict: %+v", in)
	}
	if _, ok := google.get("team@group.calendar.google.com", "lunch"); ok {
		t.Fatal("the team calendar has no copy")
	}
	if e, _ := google.get(calendarID, "lunch"); e.Summary != "Lunch, moved to noon by Lisa" || e.cancelled() {
		t.Fatalf("Lisa's change stays: %+v", e)
	}
}

func TestAChangeAtGoogleAfterTheMoveIsAConflictForTheUpdate(t *testing.T) {
	google := newFakeGoogle(t)
	google.addCalendar(calendarListEntry{ID: "team@group.calendar.google.com", Summary: "Team", AccessRole: "writer", TimeZone: "Europe/Amsterdam", DefaultReminders: []reminder{{Method: "popup", Minutes: 10}}})
	google.put(calendarID, meetingEvent("lunch", "Lunch"))
	fake, object := synced(t, google, "lunch")
	// Lisa edits the event in its new calendar after the move, before Tresso's update of it reads it.
	reads := 0
	google.mu.Lock()
	google.beforeGet = func(path string) {
		if !strings.HasSuffix(path, "/team@group.calendar.google.com/events/lunch") {
			return
		}
		if reads++; reads == 2 {
			e := google.events["team@group.calendar.google.com"]["lunch"].event
			e.Summary = "Lunch, Lisa's version"
			google.store("team@group.calendar.google.com", e)
		}
	}
	google.mu.Unlock()

	remoteID, etag := "lunch", object.ETag
	text := strings.Replace(object.Ical, "SUMMARY:Lunch", "SUMMARY:Team lunch", 1)
	fake.Queue(api.CalendarOperation{ID: "out", Kind: "delete", CalendarRemoteID: calendarID, UID: "lunch@google.com", RemoteID: &remoteID, IfMatch: &etag, Notify: true})
	fake.Queue(api.CalendarOperation{ID: "in", Kind: "put", CalendarRemoteID: "team@group.calendar.google.com", UID: "lunch@google.com", Ical: &text, Notify: true})

	in := result(t, fake, "in")
	if in.Outcome != api.OperationConflict || in.Current == nil || !strings.Contains(*in.Current.Ical, "Lisa's version") {
		t.Fatalf("the update after the move is a conflict, not an overwrite: %+v", in)
	}
	if e, _ := google.get("team@group.calendar.google.com", "lunch"); e.Summary != "Lunch, Lisa's version" {
		t.Fatalf("summary = %q", e.Summary)
	}
}

func TestAnOccurrenceThatKeepsFailingStillReportsGooglesVersion(t *testing.T) {
	google := newFakeGoogle(t)
	series := meetingEvent("standup", "Standup")
	series.Recurrence = []string{"RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=5"}
	google.put(calendarID, series)
	fake, object := synced(t, google, "standup")
	override := "BEGIN:VEVENT\r\nUID:standup@google.com\r\nDTSTAMP:20261001T000000Z\r\nRECURRENCE-ID;TZID=Europe/Amsterdam:20261026T090000\r\n" +
		"DTSTART;TZID=Europe/Amsterdam:20261026T110000\r\nDTEND;TZID=Europe/Amsterdam:20261026T113000\r\nSUMMARY:Standup, later\r\n" +
		"BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
	edited := strings.Replace(strings.Replace(object.Ical, "SUMMARY:Standup", "SUMMARY:Daily standup", 1), "END:VCALENDAR\r\n", override, 1)

	etag := object.ETag
	for attempt := range 3 {
		google.mu.Lock()
		google.failures["PATCH /events/standup_20261026T080000Z"] = http.StatusServiceUnavailable
		google.mu.Unlock()
		id := fmt.Sprintf("attempt-%d", attempt)
		queue(fake, id, "standup", etag, edited, true)
		r := result(t, fake, id)
		// After the first attempt the master is written, so later ones write nothing before the occurrence fails.
		if r.Outcome != api.OperationRetry || r.ETag == nil || r.Current == nil || !strings.Contains(*r.Current.Ical, "Daily standup") {
			t.Fatalf("attempt %d reports Google's version, which Tresso keeps when no attempt is left: %+v", attempt, r)
		}
		etag = *r.ETag
	}
}

func TestAnEditAtGoogleBeforeAFailedWriteIsAConflictNotAnOverwrite(t *testing.T) {
	google := newFakeGoogle(t)
	google.put(calendarID, meetingEvent("lunch", "Lunch"))
	fake, object := synced(t, google, "lunch")
	// Lisa edits the event after the worker read it; Google then answers the worker's write with a 503, not a 412.
	google.mu.Lock()
	google.beforeWrite = func(method, path string) {
		if method != http.MethodPatch || !strings.HasSuffix(path, "/events/lunch") || google.beforeWrite == nil {
			return
		}
		e := google.events[calendarID]["lunch"].event
		e.Summary = "Lunch, Lisa's version"
		google.store(calendarID, e)
		google.beforeWrite = nil
	}
	google.failures["PATCH /events/lunch"] = http.StatusServiceUnavailable
	google.mu.Unlock()

	queue(fake, "rename", "lunch", object.ETag, strings.Replace(object.Ical, "SUMMARY:Lunch", "SUMMARY:Brunch", 1), true)

	r := result(t, fake, "rename")
	if r.Outcome != api.OperationConflict || r.Current == nil || !strings.Contains(*r.Current.Ical, "Lisa's version") {
		t.Fatalf("a retry would pass the If-Match and overwrite Lisa's edit; it is a conflict: %+v", r)
	}
	if e, _ := google.get(calendarID, "lunch"); e.Summary != "Lunch, Lisa's version" {
		t.Fatalf("summary = %q", e.Summary)
	}
}
