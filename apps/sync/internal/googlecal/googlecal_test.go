package googlecal

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/calsync"
	"tresso/sync/internal/calsync/calsynctest"
	"tresso/sync/internal/ical"
	"tresso/sync/internal/netguard"
)

const calendarID = "kim@example.com"

// run syncs the fake against the fake API until the test ends.
func run(t *testing.T, google *fakeGoogle, fake *calsynctest.API) *calsync.Syncer {
	t.Helper()
	opts := DefaultClientOptions()
	opts.BaseURL = google.server.URL + "/calendar/v3"
	opts.HTTP.MinBackoff, opts.HTTP.MaxBackoff = time.Millisecond, time.Millisecond
	syncer := calsync.New(fake, NewProvider(opts), netguard.New(true), "w1",
		calsync.Options{Interval: 20 * time.Millisecond, NotGrantedRetry: 50 * time.Millisecond, MinBackoff: 10 * time.Millisecond, MaxBackoff: 50 * time.Millisecond},
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = syncer.Run(ctx, api.Account{ID: "a1", EmailAddress: calendarID, Provider: "gmail"})
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return syncer
}

func stored(fake *calsynctest.API, id string) (calsynctest.Stored, bool) {
	object, ok := fake.Objects(calendarID)[id]
	return object, ok
}

func TestSyncsCalendarsSeriesAndTheirChanges(t *testing.T) {
	google := newFakeGoogle(t)
	google.put(calendarID, meetingEvent("lunch", "Lunch"))
	weekly := meetingEvent("standup", "Standup")
	weekly.Recurrence = []string{"RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10"}
	google.put(calendarID, weekly)
	moved := meetingEvent("standup_20261026T070000Z", "Standup, later")
	moved.RecurringEventID = "standup"
	moved.ICalUID = weekly.ICalUID
	moved.OriginalStartTime = &eventTime{DateTime: "2026-10-26T08:00:00+01:00", TimeZone: "Europe/Amsterdam"}
	moved.Start = &eventTime{DateTime: "2026-10-26T10:00:00+01:00", TimeZone: "Europe/Amsterdam"}
	moved.End = &eventTime{DateTime: "2026-10-26T10:30:00+01:00", TimeZone: "Europe/Amsterdam"}
	google.put(calendarID, moved)
	skipped := event{ID: "standup_20261102T070000Z", ICalUID: weekly.ICalUID, RecurringEventID: "standup", Status: "cancelled", OriginalStartTime: &eventTime{DateTime: "2026-11-02T08:00:00+01:00", TimeZone: "Europe/Amsterdam"}}
	google.put(calendarID, skipped)
	fake := calsynctest.NewAPI(calendarID)
	run(t, google, fake)

	calsynctest.Eventually(t, "the first sync", func() bool { return len(fake.Objects(calendarID)) == 2 })
	list := fake.Lists()[0]
	if list.Source != "google" || !list.ProviderSchedules || list.ServerURL != nil {
		t.Fatalf("list = %+v", list)
	}
	calendar := list.Calendars[0]
	if calendar.Name != "Kim" || *calendar.Color != "#9fc6e7" || *calendar.TimeZone != "Europe/Amsterdam" || !calendar.Writable || !calendar.IsDefault || len(calendar.ConferenceProviders) != 1 || calendar.ConferenceProviders[0] != "meet" {
		t.Fatalf("calendar = %+v", calendar)
	}

	series, _ := stored(fake, "standup")
	doc := parse(t, series.Ical)
	master := doc.Master()
	if master.Text("UID") != "standup@google.com" || master.Get("RRULE").Value != "FREQ=WEEKLY;BYDAY=MO;COUNT=10" {
		t.Fatalf("master:\n%s", series.Ical)
	}
	if start := master.Get("DTSTART"); start.Param("TZID") != "Europe/Amsterdam" || start.Value != "20261019T090000" {
		t.Errorf("DTSTART = %+v", start)
	}
	if exdate := master.Get("EXDATE"); exdate == nil || exdate.Value != "20261102T080000" || exdate.Param("TZID") != "Europe/Amsterdam" {
		t.Errorf("the cancelled occurrence is an EXDATE: %+v", exdate)
	}
	overrides := doc.Overrides()
	if len(overrides) != 1 || overrides[0].Text("UID") != "standup@google.com" || overrides[0].Get("RECURRENCE-ID").Value != "20261026T080000" || overrides[0].Text("SUMMARY") != "Standup, later" {
		t.Fatalf("override:\n%s", series.Ical)
	}
	if alarms := master.Components("VALARM"); len(alarms) != 1 || alarms[0].Text("TRIGGER") != "-PT10M" {
		t.Errorf("the calendar's default reminder: %+v", alarms)
	}
	if !strings.Contains(fake.Cursor(calendarID), `"syncToken":"s4"`) {
		t.Errorf("cursor = %s", fake.Cursor(calendarID))
	}

	// A changed exception sends its whole series again; a deleted event goes.
	inventories, _ := fake.Counts()
	moved.Summary = "Standup, much later"
	google.put(calendarID, moved)
	lunch, _ := google.get(calendarID, "lunch")
	lunch.Status = "cancelled"
	google.put(calendarID, lunch)
	calsynctest.Eventually(t, "the changes", func() bool {
		object, ok := stored(fake, "standup")
		_, lunchThere := stored(fake, "lunch")
		return ok && strings.Contains(object.Ical, "much later") && !lunchThere
	})
	if after, _ := fake.Counts(); after != inventories {
		t.Error("changes come from the sync token, not a full listing")
	}
	if object, _ := stored(fake, "standup"); object.ETag == series.ETag {
		t.Error("a changed exception changes the series' ETag")
	}

	// An expired token lists the calendar again.
	google.forget()
	google.put(calendarID, meetingEvent("review", "Review"))
	calsynctest.Eventually(t, "a full listing", func() bool {
		_, ok := stored(fake, "review")
		after, _ := fake.Counts()
		return ok && after > inventories
	})
}

func TestAnOccurrenceTheUserWasInvitedToAloneIsKept(t *testing.T) {
	google := newFakeGoogle(t)
	single := meetingEvent("series_20261019T070000Z", "One of a series")
	single.RecurringEventID, single.ICalUID = "series", "series@elsewhere.example"
	single.OriginalStartTime = &eventTime{DateTime: "2026-10-19T09:00:00+02:00", TimeZone: "Europe/Amsterdam"}
	single.Organizer = &person{Email: "lisa@elsewhere.example"}
	google.put(calendarID, single)
	fake := calsynctest.NewAPI(calendarID)
	run(t, google, fake)

	calsynctest.Eventually(t, "the occurrence", func() bool { _, ok := stored(fake, "series"); return ok })
	object, _ := stored(fake, "series")
	doc := parse(t, object.Ical)
	if doc.Master() != nil || len(doc.Overrides()) != 1 || doc.Overrides()[0].Text("UID") != "series@elsewhere.example" {
		t.Fatalf("object:\n%s", object.Ical)
	}
}

const newEvent = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Tresso//EN\r\nBEGIN:VEVENT\r\nUID:planning@tresso\r\nDTSTAMP:20261001T000000Z\r\n" +
	"DTSTART;TZID=Europe/Amsterdam:20261020T140000\r\nDTEND;TZID=Europe/Amsterdam:20261020T150000\r\nSUMMARY:Planning\r\n" +
	"ORGANIZER;CN=Kim:mailto:kim@example.com\r\nATTENDEE;CN=Lisa;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:lisa@example.org\r\n" +
	"X-TRESSO-CONFERENCE-REQUEST:meet\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"

func TestANewEventGetsItsMeetMeetingAndInvitesItsGuests(t *testing.T) {
	google := newFakeGoogle(t)
	fake := calsynctest.NewAPI(calendarID)
	text := newEvent
	fake.Queue(api.CalendarOperation{ID: "op1", Kind: "put", CalendarRemoteID: calendarID, UID: "planning@tresso", Ical: &text, Notify: true})
	run(t, google, fake)

	calsynctest.Eventually(t, "the write", func() bool { _, ok := fake.Result("op1"); return ok })
	result, _ := fake.Result("op1")
	if result.Outcome != api.OperationDone || result.RemoteID == nil || *result.RemoteID != eventID("planning@tresso") || result.ETag == nil {
		t.Fatalf("result = %+v", result)
	}
	if result.Current == nil || !strings.Contains(*result.Current.Ical, "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij") || strings.Contains(*result.Current.Ical, "X-TRESSO-CONFERENCE-REQUEST") {
		t.Fatalf("the stored version is Google's, with the meeting: %+v", result.Current)
	}
	insert := google.writes()[0]
	if insert.Method != http.MethodPost || insert.Query["sendUpdates"] != "all" || insert.Query["conferenceDataVersion"] != "1" || insert.Body["iCalUID"] != "planning@tresso" {
		t.Fatalf("insert = %+v", insert)
	}
	if start := insert.Body["start"].(map[string]any); start["dateTime"] != "2026-10-20T14:00:00+02:00" || start["timeZone"] != "Europe/Amsterdam" {
		t.Errorf("start = %v", start)
	}
	overrides := insert.Body["reminders"].(map[string]any)["overrides"].([]any)
	if len(overrides) != 1 || overrides[0].(map[string]any)["minutes"] != float64(15) {
		t.Errorf("reminders = %v", insert.Body["reminders"])
	}
	created, _ := google.get(calendarID, eventID("planning@tresso"))
	if len(created.Attendees) != 1 || created.Attendees[0].Email != "lisa@example.org" {
		t.Errorf("attendees = %+v", created.Attendees)
	}

	// A create that is retried after Google took it finds the event instead of making a second one.
	again := newEvent
	fake.Queue(api.CalendarOperation{ID: "op2", Kind: "put", CalendarRemoteID: calendarID, UID: "planning@tresso", Ical: &again, Notify: true})
	calsynctest.Eventually(t, "the retried create", func() bool { _, ok := fake.Result("op2"); return ok })
	if retried, _ := fake.Result("op2"); retried.Outcome != api.OperationDone || *retried.RemoteID != eventID("planning@tresso") {
		t.Fatalf("retried = %+v", retried)
	}
}

func TestAnUnchangedEventIsNotSentAgainAndAChangeIsConditional(t *testing.T) {
	google := newFakeGoogle(t)
	google.put(calendarID, meetingEvent("lunch", "Lunch"))
	fake := calsynctest.NewAPI(calendarID)
	run(t, google, fake)
	calsynctest.Eventually(t, "the sync", func() bool { _, ok := stored(fake, "lunch"); return ok })
	object, _ := stored(fake, "lunch")

	remoteID, etag, text := "lunch", object.ETag, object.Ical
	fake.Queue(api.CalendarOperation{ID: "same", Kind: "put", CalendarRemoteID: calendarID, UID: "lunch@google.com", RemoteID: &remoteID, IfMatch: &etag, Ical: &text, Notify: true})
	calsynctest.Eventually(t, "the unchanged write", func() bool { _, ok := fake.Result("same"); return ok })
	if len(google.writes()) != 0 {
		t.Fatalf("nothing changed, nothing is sent: %+v", google.writes())
	}

	changed := strings.Replace(object.Ical, "SUMMARY:Lunch", "SUMMARY:Lunch at the canteen", 1)
	fake.Queue(api.CalendarOperation{ID: "change", Kind: "put", CalendarRemoteID: calendarID, UID: "lunch@google.com", RemoteID: &remoteID, IfMatch: &etag, Ical: &changed, Notify: false})
	calsynctest.Eventually(t, "the change", func() bool { _, ok := fake.Result("change"); return ok })
	writes := google.writes()
	if len(writes) != 1 || writes[0].Method != http.MethodPatch || writes[0].IfMatch == "" || writes[0].Query["sendUpdates"] != "none" {
		t.Fatalf("writes = %+v", writes)
	}
	if e, _ := google.get(calendarID, "lunch"); e.Summary != "Lunch at the canteen" {
		t.Errorf("summary = %q", e.Summary)
	}

	// A write based on an older version is a conflict: Google's version wins.
	stale := strings.Replace(object.Ical, "SUMMARY:Lunch", "SUMMARY:Brunch", 1)
	fake.Queue(api.CalendarOperation{ID: "stale", Kind: "put", CalendarRemoteID: calendarID, UID: "lunch@google.com", RemoteID: &remoteID, IfMatch: &etag, Ical: &stale, Notify: true})
	calsynctest.Eventually(t, "the stale write", func() bool { _, ok := fake.Result("stale"); return ok })
	result, _ := fake.Result("stale")
	if result.Outcome != api.OperationConflict || result.Current == nil || !strings.Contains(*result.Current.Ical, "Lunch at the canteen") {
		t.Fatalf("result = %+v", result)
	}
}

func TestAnInviteeAnswersThroughTheirResponse(t *testing.T) {
	google := newFakeGoogle(t)
	invite := meetingEvent("review", "Review")
	invite.Organizer = &person{Email: "lisa@example.org"}
	invite.Attendees = []person{{Email: "lisa@example.org", Organizer: true, ResponseStatus: "accepted"}, {Email: calendarID, Self: true, ResponseStatus: "needsAction"}}
	google.put(calendarID, invite)
	fake := calsynctest.NewAPI(calendarID)
	run(t, google, fake)
	calsynctest.Eventually(t, "the sync", func() bool { _, ok := stored(fake, "review"); return ok })
	object, _ := stored(fake, "review")
	if !strings.Contains(object.Ical, "PARTSTAT=NEEDS-ACTION") {
		t.Fatalf("ical:\n%s", object.Ical)
	}

	remoteID, etag := "review", object.ETag
	answered := answer(t, object.Ical, calendarID, "ACCEPTED")
	comment := "See you there"
	fake.Queue(api.CalendarOperation{ID: "rsvp", Kind: "put", CalendarRemoteID: calendarID, UID: "review@google.com", RemoteID: &remoteID, IfMatch: &etag, Ical: &answered, Notify: false, Comment: &comment})
	calsynctest.Eventually(t, "the answer", func() bool { _, ok := fake.Result("rsvp"); return ok })
	if result, _ := fake.Result("rsvp"); result.Outcome != api.OperationDone {
		t.Fatalf("result = %+v", result)
	}
	writes := google.writes()
	if len(writes) != 1 || writes[0].Query["sendUpdates"] != "none" || len(writes[0].Body) != 1 || writes[0].Body["attendees"] == nil {
		t.Fatalf("an answer patches the attendees only: %+v", writes)
	}
	e, _ := google.get(calendarID, "review")
	if e.Attendees[1].ResponseStatus != "accepted" || e.Attendees[1].Comment != "See you there" {
		t.Errorf("attendees = %+v", e.Attendees)
	}

	// Other changes are the organizer's; the user keeps seeing theirs.
	object, _ = stored(fake, "review")
	etag = object.ETag
	renamed := strings.Replace(object.Ical, "SUMMARY:Review", "SUMMARY:My review", 1)
	fake.Queue(api.CalendarOperation{ID: "rename", Kind: "put", CalendarRemoteID: calendarID, UID: "review@google.com", RemoteID: &remoteID, IfMatch: &etag, Ical: &renamed, Notify: true})
	calsynctest.Eventually(t, "the refused change", func() bool { _, ok := fake.Result("rename"); return ok })
	result, _ := fake.Result("rename")
	if result.Outcome != api.OperationFailed || result.Current == nil || !strings.Contains(*result.Current.Ical, "SUMMARY:Review") {
		t.Fatalf("result = %+v", result)
	}
}

// answer changes the attendee's PARTSTAT, as the API's RSVP does.
func answer(t *testing.T, text, address, partstat string) string {
	t.Helper()
	doc := parse(t, text)
	for _, v := range doc.Events() {
		for i, p := range v.Props {
			if p.Name != "ATTENDEE" || !strings.EqualFold(strings.TrimPrefix(p.Value, "mailto:"), address) {
				continue
			}
			var params []ical.Param
			for _, param := range p.Params {
				if param.Name != "PARTSTAT" && param.Name != "RSVP" {
					params = append(params, param)
				}
			}
			v.Props[i].Params = append(params, ical.Param{Name: "PARTSTAT", Values: []string{partstat}})
		}
	}
	return doc.Serialize()
}

func TestAnEditedOccurrenceBecomesAnExceptionAndADeleteTellsTheGuests(t *testing.T) {
	google := newFakeGoogle(t)
	weekly := meetingEvent("standup", "Standup")
	weekly.Recurrence = []string{"RRULE:FREQ=WEEKLY;BYDAY=MO"}
	google.put(calendarID, weekly)
	fake := calsynctest.NewAPI(calendarID)
	run(t, google, fake)
	calsynctest.Eventually(t, "the sync", func() bool { _, ok := stored(fake, "standup"); return ok })
	object, _ := stored(fake, "standup")

	override := "BEGIN:VEVENT\r\nUID:standup@google.com\r\nDTSTAMP:20261001T000000Z\r\nRECURRENCE-ID;TZID=Europe/Amsterdam:20261026T090000\r\n" +
		"DTSTART;TZID=Europe/Amsterdam:20261026T110000\r\nDTEND;TZID=Europe/Amsterdam:20261026T113000\r\nSUMMARY:Standup\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
	edited := strings.Replace(object.Ical, "END:VCALENDAR\r\n", override, 1)
	remoteID, etag := "standup", object.ETag
	fake.Queue(api.CalendarOperation{ID: "occurrence", Kind: "put", CalendarRemoteID: calendarID, UID: "standup@google.com", RemoteID: &remoteID, IfMatch: &etag, Ical: &edited, Notify: true})
	calsynctest.Eventually(t, "the occurrence", func() bool { _, ok := fake.Result("occurrence"); return ok })
	writes := google.writes()
	if len(writes) != 1 || !strings.HasSuffix(writes[0].Path, "/standup_20261026T080000Z") || writes[0].Body["recurrence"] != nil {
		t.Fatalf("only the occurrence is patched: %+v", writes)
	}
	result, _ := fake.Result("occurrence")
	if result.Outcome != api.OperationDone || result.Current == nil || !strings.Contains(*result.Current.Ical, "RECURRENCE-ID;TZID=Europe/Amsterdam:20261026T090000") {
		t.Fatalf("result = %+v", result)
	}

	etag = *result.ETag
	fake.Queue(api.CalendarOperation{ID: "delete", Kind: "delete", CalendarRemoteID: calendarID, UID: "standup@google.com", RemoteID: &remoteID, IfMatch: &etag, Notify: true})
	calsynctest.Eventually(t, "the delete", func() bool { _, ok := fake.Result("delete"); return ok })
	if result, _ := fake.Result("delete"); result.Outcome != api.OperationDone {
		t.Fatalf("result = %+v", result)
	}
	last := google.writes()[len(google.writes())-1]
	if last.Method != http.MethodDelete || last.Query["sendUpdates"] != "all" {
		t.Fatalf("delete = %+v", last)
	}
	if e, _ := google.get(calendarID, "standup"); !e.cancelled() {
		t.Error("the series is deleted")
	}
}

func TestCalendarAccessTheUserDidNotAllowIsReported(t *testing.T) {
	google := newFakeGoogle(t)
	google.forbidden = true
	fake := calsynctest.NewAPI(calendarID)
	run(t, google, fake)
	calsynctest.Eventually(t, "the status", func() bool {
		statuses := fake.Statuses()
		return len(statuses) > 0 && statuses[0] == api.CalendarNotGranted
	})
	time.Sleep(150 * time.Millisecond)
	if statuses := fake.Statuses(); len(statuses) != 1 {
		t.Fatalf("the status is reported once: %v", statuses)
	}
}

func TestNoTokenIsAskedForWhileCalendarsAreNotAllowed(t *testing.T) {
	google := newFakeGoogle(t)
	google.put(calendarID, meetingEvent("lunch", "Lunch"))
	fake := calsynctest.NewAPI(calendarID)
	fake.NotGranted = true
	syncer := run(t, google, fake)
	time.Sleep(30 * time.Millisecond)
	if len(fake.Lists()) != 0 {
		t.Fatal("nothing is synced without calendar access")
	}
	fake.Grant()
	syncer.Trigger("a1")
	calsynctest.Eventually(t, "the sync after the grant", func() bool { _, ok := stored(fake, "lunch"); return ok })
}

type staticToken struct{}

func (staticToken) Token(context.Context) (string, error)    { return "token", nil }
func (staticToken) Invalidate(context.Context, string) error { return nil }

// Fails without the fix: the first event Google refused ended the fetch, so the events after it never arrived.
func TestFetchLeavesOutAnEventGoogleRefusesAndCarriesOn(t *testing.T) {
	google := newFakeGoogle(t)
	google.put(calendarID, meetingEvent("lunch", "Lunch"))
	google.put(calendarID, meetingEvent("broken", "Broken"))
	google.put(calendarID, meetingEvent("dinner", "Dinner"))
	google.refusals = map[string]int{"GET /events/broken": http.StatusBadRequest}
	opts := DefaultClientOptions()
	opts.BaseURL = google.server.URL + "/calendar/v3"
	opts.HTTP.MinBackoff, opts.HTTP.MaxBackoff = time.Millisecond, time.Millisecond
	session := NewProvider(opts).Open(staticToken{}, google.server.Client(), calendarID, slog.New(slog.NewTextHandler(io.Discard, nil)))

	objects, err := session.Fetch(context.Background(), calsync.Calendar{RemoteCalendar: api.RemoteCalendar{RemoteID: calendarID}}, []string{"lunch", "broken", "dinner"})
	var skipped *calsync.FetchError
	if !errors.As(err, &skipped) || skipped.Permanent != 1 || skipped.Transient != 0 {
		t.Fatalf("err = %v; want a FetchError for the one refused event", err)
	}
	var ids []string
	for _, object := range objects {
		ids = append(ids, object.RemoteID)
	}
	if !slices.Equal(ids, []string{"lunch", "dinner"}) {
		t.Errorf("fetched %v", ids)
	}

	google.mu.Lock()
	google.refusals = map[string]int{"GET /events/broken": http.StatusServiceUnavailable}
	google.mu.Unlock()
	if _, err := session.Fetch(context.Background(), calsync.Calendar{RemoteCalendar: api.RemoteCalendar{RemoteID: calendarID}}, []string{"broken"}); !errors.As(err, &skipped) || skipped.Transient != 1 {
		t.Errorf("err = %v; a 5xx is a failure that may pass", err)
	}
}
