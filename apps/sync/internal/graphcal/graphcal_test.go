package graphcal

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
	"tresso/sync/internal/calsync/calsynctest"
	"tresso/sync/internal/ical"
	"tresso/sync/internal/netguard"
)

const owner = "kim@example.com"

func run(t *testing.T, graph *fakeGraph, fake *calsynctest.API) *calsync.Syncer {
	t.Helper()
	opts := DefaultClientOptions()
	opts.BaseURL = graph.server.URL + "/v1.0"
	opts.HTTP.UnitsPerSecond, opts.HTTP.Burst = 0, 0
	opts.HTTP.MinBackoff, opts.HTTP.MaxBackoff = time.Millisecond, time.Millisecond
	syncer := calsync.New(fake, NewProvider(opts), netguard.New(true), "w1",
		calsync.Options{Interval: 20 * time.Millisecond, NotGrantedRetry: 50 * time.Millisecond, MinBackoff: 10 * time.Millisecond, MaxBackoff: 50 * time.Millisecond},
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = syncer.Run(ctx, api.Account{ID: "a1", EmailAddress: owner, Provider: "microsoft"})
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return syncer
}

func stored(fake *calsynctest.API, id string) (calsynctest.Stored, bool) {
	object, ok := fake.Objects(defaultCalendar)[id]
	return object, ok
}

func parse(t *testing.T, text string) *ical.Component {
	t.Helper()
	doc, err := ical.Parse(text)
	if err != nil {
		t.Fatalf("parse: %v\n%s", err, text)
	}
	return doc
}

func TestSyncsCalendarsSeriesAndTheirChanges(t *testing.T) {
	graph := newFakeGraph(t)
	meeting := single("ev1", "Planning")
	meeting.IsOnlineMeeting, meeting.OnlineMeetingProvider = true, "teamsForBusiness"
	meeting.OnlineMeeting = &onlineMeetingInfo{JoinURL: "https://teams.microsoft.com/l/meetup-join/abc", TollNumber: "+31 20 123 4567"}
	graph.put(meeting)
	master, occurrences := weekly("ev2")
	occurrences[1].Type, occurrences[1].Subject = "exception", "Standup, moved"
	occurrences[1].Start, occurrences[1].End = amsterdam("2026-10-26T11:00:00"), amsterdam("2026-10-26T11:30:00")
	master.CancelledOccurrences = []string{"OID.ev2.2026-11-02"}
	graph.put(master, occurrences[:2]...)
	graph.put(single("ev3", "Lunch"))
	fake := calsynctest.NewAPI(owner)
	run(t, graph, fake)

	calsynctest.Eventually(t, "the first sync", func() bool { return len(fake.Objects(defaultCalendar)) == 3 })
	list := fake.Lists()[0]
	calendar := list.Calendars[0]
	if list.Source != "microsoft" || !list.ProviderSchedules || calendar.Name != "Calendar" || *calendar.Color != "#e3008c" || !calendar.IsDefault || len(calendar.ConferenceProviders) != 1 || calendar.ConferenceProviders[0] != "teams" {
		t.Fatalf("list = %+v", list)
	}

	planning, _ := stored(fake, "ev1")
	doc := parse(t, planning.Ical)
	event := doc.Master()
	if start := event.Get("DTSTART"); start.Param("TZID") != "Europe/Berlin" || start.Value != "20261019T090000" {
		t.Errorf("the Windows zone becomes its IANA name (CLDR): %+v", start)
	}
	if event.Text("X-MICROSOFT-SKYPETEAMSMEETINGURL") != "https://teams.microsoft.com/l/meetup-join/abc" || len(event.All("CONFERENCE")) != 2 {
		t.Errorf("Teams meeting:\n%s", planning.Ical)
	}
	if alarms := event.Components("VALARM"); len(alarms) != 1 || alarms[0].Text("TRIGGER") != "-PT15M" {
		t.Errorf("reminder: %+v", alarms)
	}
	if planning.ETag == "" || event.Text("UID") != "uid-ev1" {
		t.Errorf("etag %q, uid %q", planning.ETag, event.Text("UID"))
	}

	series, _ := stored(fake, "ev2")
	doc = parse(t, series.Ical)
	if rule := doc.Master().Get("RRULE"); rule == nil || rule.Value != "FREQ=WEEKLY;BYDAY=MO;WKST=MO;COUNT=3" {
		t.Errorf("RRULE = %+v", rule)
	}
	if exdate := doc.Master().Get("EXDATE"); exdate == nil || exdate.Value != "20261102T090000" || exdate.Param("TZID") != "Europe/Berlin" {
		t.Errorf("the cancelled occurrence is an EXDATE: %+v", exdate)
	}
	overrides := doc.Overrides()
	if len(overrides) != 1 || overrides[0].Get("RECURRENCE-ID").Value != "20261026T090000" || overrides[0].Text("SUMMARY") != "Standup, moved" || overrides[0].Text("UID") != "uid-ev2" {
		t.Fatalf("override:\n%s", series.Ical)
	}
	for _, request := range graph.gets("/events/ev2") {
		if request.Query.Get("$expand") != "" && !strings.Contains(strings.Join(request.Prefer, ","), `outlook.timezone="W. Europe Standard Time"`) {
			t.Errorf("an event is read in the zone it was made in: %v", request.Prefer)
		}
	}

	// Nothing changed: no listing.
	inventories, _ := fake.Counts()
	time.Sleep(80 * time.Millisecond)
	if after, _ := fake.Counts(); after != inventories {
		t.Fatalf("an unchanged calendar is not listed again (%d, %d)", inventories, after)
	}

	// A change and a removal: the delta says so, the listing finds them.
	changed := single("ev3", "Lunch, later")
	graph.put(changed)
	graph.remove("ev1")
	calsynctest.Eventually(t, "the changes", func() bool {
		lunch, ok := stored(fake, "ev3")
		_, planningThere := stored(fake, "ev1")
		return ok && strings.Contains(lunch.Ical, "Lunch\\, later") && !planningThere
	})
}

const newEvent = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Tresso//EN\r\nBEGIN:VEVENT\r\nUID:planning@tresso\r\nDTSTAMP:20261001T000000Z\r\n" +
	"DTSTART;TZID=Europe/Amsterdam:20261020T140000\r\nDTEND;TZID=Europe/Amsterdam:20261020T150000\r\nSUMMARY:Planning\r\n" +
	"RRULE:FREQ=MONTHLY;BYDAY=2TU;UNTIL=20271231T130000Z\r\n" +
	"ORGANIZER;CN=Kim:mailto:kim@example.com\r\nATTENDEE;CN=Lisa;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:lisa@example.org\r\n" +
	"X-TRESSO-CONFERENCE-REQUEST:teams\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"

func TestANewEventGetsItsTeamsMeetingAndKeepsItsUID(t *testing.T) {
	graph := newFakeGraph(t)
	fake := calsynctest.NewAPI(owner)
	text := newEvent
	fake.Queue(api.CalendarOperation{ID: "op1", Kind: "put", CalendarRemoteID: defaultCalendar, UID: "planning@tresso", Ical: &text, Notify: true})
	run(t, graph, fake)

	calsynctest.Eventually(t, "the write", func() bool { _, ok := fake.Result("op1"); return ok })
	result, _ := fake.Result("op1")
	if result.Outcome != api.OperationDone || result.RemoteID == nil || *result.RemoteID != "ev-new-1" || result.Current == nil {
		t.Fatalf("result = %+v", result)
	}
	current := parse(t, *result.Current.Ical).Master()
	if current.Text("UID") != "planning@tresso" || current.Text("X-MICROSOFT-SKYPETEAMSMEETINGURL") != "https://teams.microsoft.com/l/meetup-join/ev-new-1" {
		t.Fatalf("Graph's version keeps Tresso's UID and has the meeting:\n%s", *result.Current.Ical)
	}
	if rule := current.Get("RRULE"); rule == nil || rule.Value != "FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2;UNTIL=20271231T130000Z" {
		t.Errorf("RRULE = %+v", rule)
	}
	create := graph.writes()[0]
	if create.Method != http.MethodPost || create.Body["transactionId"] != transactionID("planning@tresso") || create.Body["isOnlineMeeting"] != true || create.Body["onlineMeetingProvider"] != "teamsForBusiness" {
		t.Fatalf("create = %+v", create)
	}
	recurrence := create.Body["recurrence"].(map[string]any)
	pattern, rangeOf := recurrence["pattern"].(map[string]any), recurrence["range"].(map[string]any)
	if pattern["type"] != "relativeMonthly" || pattern["index"] != "second" || rangeOf["type"] != "endDate" || rangeOf["endDate"] != "2027-12-31" || rangeOf["recurrenceTimeZone"] != "Europe/Amsterdam" {
		t.Errorf("recurrence = %v", recurrence)
	}
	if start := create.Body["start"].(map[string]any); start["dateTime"] != "2026-10-20T14:00:00" || start["timeZone"] != "Europe/Amsterdam" {
		t.Errorf("start = %v", start)
	}

	// A create retried after Graph took it returns the same event (transactionId).
	again := newEvent
	fake.Queue(api.CalendarOperation{ID: "op2", Kind: "put", CalendarRemoteID: defaultCalendar, UID: "planning@tresso", Ical: &again, Notify: true})
	calsynctest.Eventually(t, "the retried create", func() bool { _, ok := fake.Result("op2"); return ok })
	if retried, _ := fake.Result("op2"); *retried.RemoteID != "ev-new-1" {
		t.Fatalf("retried = %+v", retried)
	}
}

func TestOnlyChangesAreSentAndAStaleVersionIsAConflict(t *testing.T) {
	graph := newFakeGraph(t)
	graph.put(single("ev3", "Lunch"))
	fake := calsynctest.NewAPI(owner)
	run(t, graph, fake)
	calsynctest.Eventually(t, "the sync", func() bool { _, ok := stored(fake, "ev3"); return ok })
	object, _ := stored(fake, "ev3")

	remoteID, etag, text := "ev3", object.ETag, object.Ical
	fake.Queue(api.CalendarOperation{ID: "same", Kind: "put", CalendarRemoteID: defaultCalendar, UID: "uid-ev3", RemoteID: &remoteID, IfMatch: &etag, Ical: &text, Notify: true})
	calsynctest.Eventually(t, "the unchanged write", func() bool { _, ok := fake.Result("same"); return ok })
	if writes := graph.writes(); len(writes) != 0 {
		t.Fatalf("nothing changed, so nothing (no update mail either) is sent: %+v", writes)
	}

	changed := strings.Replace(object.Ical, "SUMMARY:Lunch", "SUMMARY:Lunch at noon", 1)
	fake.Queue(api.CalendarOperation{ID: "change", Kind: "put", CalendarRemoteID: defaultCalendar, UID: "uid-ev3", RemoteID: &remoteID, IfMatch: &etag, Ical: &changed, Notify: true})
	calsynctest.Eventually(t, "the change", func() bool { _, ok := fake.Result("change"); return ok })
	writes := graph.writes()
	if len(writes) != 1 || writes[0].Method != http.MethodPatch || len(writes[0].Body) != 1 || writes[0].Body["subject"] != "Lunch at noon" || writes[0].IfMatch == "" {
		t.Fatalf("only the changed field is patched: %+v", writes)
	}

	stale := strings.Replace(object.Ical, "SUMMARY:Lunch", "SUMMARY:Brunch", 1)
	fake.Queue(api.CalendarOperation{ID: "stale", Kind: "put", CalendarRemoteID: defaultCalendar, UID: "uid-ev3", RemoteID: &remoteID, IfMatch: &etag, Ical: &stale, Notify: true})
	calsynctest.Eventually(t, "the stale write", func() bool { _, ok := fake.Result("stale"); return ok })
	if result, _ := fake.Result("stale"); result.Outcome != api.OperationConflict || result.Current == nil || !strings.Contains(*result.Current.Ical, "Lunch at noon") {
		t.Fatalf("result = %+v", result)
	}
}

func TestAnInviteeAnswersThroughTheResponseCalls(t *testing.T) {
	graph := newFakeGraph(t)
	invite := single("ev4", "Review")
	invite.IsOrganizer = false
	invite.Organizer = &recipient{EmailAddress: emailAddress{Address: "lisa@example.org", Name: "Lisa"}}
	invite.Attendees = []attendee{{Type: "required", EmailAddress: emailAddress{Address: owner, Name: "Kim"}, Status: &responseStatus{Response: "none"}}}
	invite.ResponseStatus = &responseStatus{Response: "notResponded"}
	graph.put(invite)
	fake := calsynctest.NewAPI(owner)
	run(t, graph, fake)
	calsynctest.Eventually(t, "the sync", func() bool { _, ok := stored(fake, "ev4"); return ok })
	object, _ := stored(fake, "ev4")
	if !strings.Contains(object.Ical, "PARTSTAT=NEEDS-ACTION") {
		t.Fatalf("ical:\n%s", object.Ical)
	}

	remoteID, etag := "ev4", object.ETag
	answered := strings.Replace(object.Ical, "PARTSTAT=NEEDS-ACTION", "PARTSTAT=TENTATIVE", 1)
	comment := "Might be late"
	fake.Queue(api.CalendarOperation{ID: "rsvp", Kind: "put", CalendarRemoteID: defaultCalendar, UID: "uid-ev4", RemoteID: &remoteID, IfMatch: &etag, Ical: &answered, Notify: false, Comment: &comment})
	calsynctest.Eventually(t, "the answer", func() bool { _, ok := fake.Result("rsvp"); return ok })
	writes := graph.writes()
	if len(writes) != 1 || !strings.HasSuffix(writes[0].Path, "/me/calendars/AAMkCal1/events/ev4/tentativelyAccept") || writes[0].Body["sendResponse"] != false || writes[0].Body["comment"] != "Might be late" {
		t.Fatalf("writes = %+v", writes)
	}
	result, _ := fake.Result("rsvp")
	if result.Outcome != api.OperationDone || !strings.Contains(*result.Current.Ical, "PARTSTAT=TENTATIVE") {
		t.Fatalf("result = %+v", result)
	}

	etag = *result.ETag
	renamed := strings.Replace(*result.Current.Ical, "SUMMARY:Review", "SUMMARY:My review", 1)
	fake.Queue(api.CalendarOperation{ID: "rename", Kind: "put", CalendarRemoteID: defaultCalendar, UID: "uid-ev4", RemoteID: &remoteID, IfMatch: &etag, Ical: &renamed, Notify: true})
	calsynctest.Eventually(t, "the refused change", func() bool { _, ok := fake.Result("rename"); return ok })
	if refused, _ := fake.Result("rename"); refused.Outcome != api.OperationFailed || refused.Current == nil {
		t.Fatalf("an invitee cannot rename the organizer's event: %+v", refused)
	}
}

func TestOccurrencesAreChangedAndCancelledOneByOne(t *testing.T) {
	graph := newFakeGraph(t)
	master, occurrences := weekly("ev5")
	graph.put(master, occurrences...)
	fake := calsynctest.NewAPI(owner)
	run(t, graph, fake)
	calsynctest.Eventually(t, "the sync", func() bool { _, ok := stored(fake, "ev5"); return ok })
	object, _ := stored(fake, "ev5")

	override := "BEGIN:VEVENT\r\nUID:uid-ev5\r\nDTSTAMP:20261001T000000Z\r\nRECURRENCE-ID;TZID=Europe/Amsterdam:20261026T090000\r\n" +
		"DTSTART;TZID=Europe/Amsterdam:20261026T100000\r\nDTEND;TZID=Europe/Amsterdam:20261026T103000\r\nSUMMARY:Standup\r\n" +
		"BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
	edited := strings.Replace(object.Ical, "END:VCALENDAR\r\n", override, 1)
	edited = strings.Replace(edited, "RRULE:", "EXDATE;TZID=Europe/Amsterdam:20261102T090000\r\nRRULE:", 1)
	remoteID, etag := "ev5", object.ETag
	fake.Queue(api.CalendarOperation{ID: "occurrences", Kind: "put", CalendarRemoteID: defaultCalendar, UID: "uid-ev5", RemoteID: &remoteID, IfMatch: &etag, Ical: &edited, Notify: true})
	calsynctest.Eventually(t, "the write", func() bool { _, ok := fake.Result("occurrences"); return ok })

	writes := graph.writes()
	if len(writes) != 2 || writes[0].Method != http.MethodPatch || !strings.HasSuffix(writes[0].Path, "/ev5-occ1") || writes[1].Method != http.MethodDelete || !strings.HasSuffix(writes[1].Path, "/ev5-occ2") {
		t.Fatalf("writes = %+v", writes)
	}
	if start := writes[0].Body["start"].(map[string]any); start["dateTime"] != "2026-10-26T10:00:00" || len(writes[0].Body) != 2 {
		t.Errorf("the occurrence gets its new time only: %v", writes[0].Body)
	}
	result, _ := fake.Result("occurrences")
	doc := parse(t, *result.Current.Ical)
	if len(doc.Overrides()) != 1 || doc.Master().Get("EXDATE") == nil {
		t.Fatalf("current:\n%s", *result.Current.Ical)
	}

	etag = *result.ETag
	fake.Queue(api.CalendarOperation{ID: "delete", Kind: "delete", CalendarRemoteID: defaultCalendar, UID: "uid-ev5", RemoteID: &remoteID, IfMatch: &etag, Notify: true})
	calsynctest.Eventually(t, "the delete", func() bool { _, ok := fake.Result("delete"); return ok })
	if _, ok := graph.get("ev5"); ok {
		t.Fatal("the series is deleted")
	}
}

func TestARuleOutlookCannotRepeatIsRefused(t *testing.T) {
	graph := newFakeGraph(t)
	fake := calsynctest.NewAPI(owner)
	text := strings.Replace(newEvent, "RRULE:FREQ=MONTHLY;BYDAY=2TU;UNTIL=20271231T130000Z", "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1", 1)
	fake.Queue(api.CalendarOperation{ID: "op1", Kind: "put", CalendarRemoteID: defaultCalendar, UID: "planning@tresso", Ical: &text, Notify: true})
	run(t, graph, fake)
	calsynctest.Eventually(t, "the write", func() bool { _, ok := fake.Result("op1"); return ok })
	result, _ := fake.Result("op1")
	if result.Outcome != api.OperationFailed || result.Error == nil || !strings.HasPrefix(*result.Error, "Outlook cannot repeat an event this way") {
		t.Fatalf("result = %+v", result)
	}
	if len(graph.writes()) != 0 {
		t.Fatal("nothing is created")
	}
}

// Graph answers ErrorAccessDenied alike for a token without the calendar scopes and for a mailbox or tenant that does
// not allow calendars; the API only hands out a calendar token with the scopes, so it is the latter: an error with
// Graph's code, not a request to sign in again (which would loop).
func TestARefusedCalendarListIsReportedWithGraphsCode(t *testing.T) {
	graph := newFakeGraph(t)
	graph.forbidden = true
	fake := calsynctest.NewAPI(owner)
	run(t, graph, fake)
	calsynctest.Eventually(t, "the status", func() bool {
		statuses := fake.Statuses()
		return len(statuses) > 0 && statuses[0] == api.CalendarError && strings.Contains(fake.Details()[0], "(ErrorAccessDenied)")
	})
}

func TestADeltaTokenGraphForgotStartsANewRound(t *testing.T) {
	graph := newFakeGraph(t)
	graph.put(single("ev3", "Lunch"))
	fake := calsynctest.NewAPI(owner)
	run(t, graph, fake)
	calsynctest.Eventually(t, "the sync", func() bool { _, ok := stored(fake, "ev3"); return ok })
	graph.mu.Lock()
	graph.oldest = graph.version + 1
	graph.mu.Unlock()
	graph.put(single("ev6", "Review"))
	calsynctest.Eventually(t, "the new round", func() bool { _, ok := stored(fake, "ev6"); return ok })
}

// Fails without the fix: the first event Graph refused ended the fetch, so the events after it and the cursor never
// arrived, and the first sync of the calendar started over every minute.
func TestAnEventGraphRefusesIsLeftOutAndTheCalendarMovesOn(t *testing.T) {
	graph := newFakeGraph(t)
	graph.put(single("ev1", "Planning"))
	graph.put(single("ev2", "Broken"))
	graph.put(single("ev3", "Lunch"))
	graph.refusals = map[string]int{"GET /events/ev2": http.StatusBadRequest}
	fake := calsynctest.NewAPI(owner)
	run(t, graph, fake)

	calsynctest.Eventually(t, "the other events and the cursor", func() bool {
		_, planning := stored(fake, "ev1")
		_, lunch := stored(fake, "ev3")
		return planning && lunch && fake.Cursor(defaultCalendar) != ""
	})
	if _, ok := stored(fake, "ev2"); ok {
		t.Error("the refused event was stored")
	}
}

func TestAnEventGraphFailsOnKeepsTheCursorSoItIsAskedForAgain(t *testing.T) {
	graph := newFakeGraph(t)
	graph.put(single("ev1", "Planning"))
	graph.put(single("ev2", "Flaky"))
	graph.refusals = map[string]int{"GET /events/ev2": http.StatusServiceUnavailable}
	fake := calsynctest.NewAPI(owner)
	run(t, graph, fake)

	calsynctest.Eventually(t, "the other event", func() bool { _, ok := stored(fake, "ev1"); return ok })
	time.Sleep(50 * time.Millisecond)
	if cursor := fake.Cursor(defaultCalendar); cursor != "" {
		t.Fatalf("the cursor %q was stored while an event may still come through", cursor)
	}
	graph.mu.Lock()
	graph.refusals = nil
	graph.mu.Unlock()
	calsynctest.Eventually(t, "the event once Graph answers", func() bool {
		_, ok := stored(fake, "ev2")
		return ok && fake.Cursor(defaultCalendar) != ""
	})
}
