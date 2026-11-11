package caldavsync

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/caldav"
	"tresso/sync/internal/calfailures"
)

func event(uid, summary string) string {
	return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Fake//EN\r\nBEGIN:VEVENT\r\nUID:" + uid + "\r\nDTSTART:20261019T090000Z\r\nSUMMARY:" + summary + "\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
}

func openRun(t *testing.T, server *fakeServer, fake *fakeAPI) *run {
	t.Helper()
	syncer := New(fake, plainDialer{}, "w1", Options{AllowHTTP: true}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	client := caldav.New(plainDialer{}, "kim@company.example", "app-password", true, caldav.NewTrust("", server.server.URL))
	account, err := client.Open(context.Background(), server.server.URL+"/dav/")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return &run{syncer: syncer, client: client, server: account, account: api.Account{ID: "a1"}, logger: syncer.logger, failing: calfailures.New(time.Minute, time.Hour)}
}

func TestSyncsWithSyncTokensAndReportsOnlyChanges(t *testing.T) {
	server := newFakeServer(t, true)
	server.put(calendarPath+"standup.ics", event("standup", "Standup"))
	server.put(calendarPath+"review.ics", event("review", "Review"))
	fake := newFakeAPI(server.server.URL + "/dav/")
	r := openRun(t, server, fake)

	if err := r.syncAll(context.Background()); err != nil {
		t.Fatalf("first sync: %v", err)
	}
	list := fake.lists[0]
	if len(list.Calendars) != 1 || list.Calendars[0].Name != "Home" || *list.Calendars[0].Color != "#2e7d32" || *list.Calendars[0].TimeZone != "Europe/Amsterdam" || !list.Calendars[0].Writable {
		t.Fatalf("calendar list = %+v", list.Calendars)
	}
	if list.ProviderSchedules {
		t.Error("the server does not schedule by itself")
	}
	if len(fake.etags) != 2 || len(fake.inventory) != 1 {
		t.Fatalf("the first sync is a full listing: inventory %d, stored %v", len(fake.inventory), fake.etags)
	}
	if cursor := fake.cursors["cal-Home"]; cursor == nil || !strings.Contains(*cursor, `"syncToken":"token-2"`) {
		t.Fatalf("cursor = %v", cursor)
	}

	batches := len(fake.batches)
	if err := r.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(fake.batches) != batches {
		t.Fatal("an unchanged calendar is not reported again")
	}

	server.put(calendarPath+"standup.ics", event("standup", "Standup, shorter"))
	server.remove(calendarPath + "review.ics")
	if err := r.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	last := fake.batches[len(fake.batches)-1]
	if len(last.Changed) != 1 || !strings.HasSuffix(last.Changed[0].RemoteID, "standup.ics") || !strings.Contains(*last.Changed[0].Ical, "Standup, shorter") {
		t.Fatalf("changed = %+v", last.Changed)
	}
	if len(last.Removed) != 1 || !strings.HasSuffix(last.Removed[0], "review.ics") {
		t.Fatalf("removed = %v", last.Removed)
	}
	if len(fake.inventory) != 1 {
		t.Fatal("changes come from sync-collection, not a full listing")
	}
}

func TestSyncsByCTagWithoutSyncTokens(t *testing.T) {
	server := newFakeServer(t, false)
	server.put(calendarPath+"standup.ics", event("standup", "Standup"))
	fake := newFakeAPI(server.server.URL + "/dav/")
	r := openRun(t, server, fake)

	if err := r.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(fake.etags) != 1 || !strings.Contains(*fake.cursors["cal-Home"], `"ctag":"ctag-1"`) {
		t.Fatalf("stored %v, cursor %v", fake.etags, *fake.cursors["cal-Home"])
	}

	if err := r.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(fake.inventory) != 1 {
		t.Fatal("an unchanged ctag skips the listing")
	}

	server.put(calendarPath+"planning.ics", event("planning", "Planning"))
	if err := r.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	last := fake.batches[len(fake.batches)-1]
	if len(last.Changed) != 1 || !strings.HasSuffix(last.Changed[0].RemoteID, "planning.ics") {
		t.Fatalf("only the new resource is fetched: %+v", last.Changed)
	}
}

func TestWritesCreatesUpdatesAndDeletes(t *testing.T) {
	server := newFakeServer(t, true)
	server.put(calendarPath+"standup.ics", event("standup", "Standup"))
	fake := newFakeAPI(server.server.URL + "/dav/")
	r := openRun(t, server, fake)
	calendarURL := server.server.URL + calendarPath
	created := event("new@tresso", "New")
	updated := event("standup", "Standup, moved")
	existing := server.server.URL + calendarPath + "standup.ics"
	etag := `"1"`
	stale := `"0"`
	fake.operations = []api.CalendarOperation{
		{ID: "create", Kind: "put", CalendarRemoteID: calendarURL, UID: "new@tresso", Ical: &created},
		{ID: "update", Kind: "put", CalendarRemoteID: calendarURL, UID: "standup", RemoteID: &existing, IfMatch: &etag, Ical: &updated},
	}

	if err := r.writeAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if result := fake.results["create"]; result.Outcome != api.OperationDone || !strings.HasSuffix(*result.RemoteID, "/home/new-tresso.ics") || result.ETag == nil {
		t.Fatalf("create = %+v", result)
	}
	if result := fake.results["update"]; result.Outcome != api.OperationDone || *result.ETag != `"3"` {
		t.Fatalf("update = %+v", result)
	}
	if !strings.Contains(server.objects[calendarPath+"standup.ics"].data, "Standup, moved") {
		t.Fatal("the update reached the server")
	}

	conflicting := event("standup", "Mine")
	fake.operations = []api.CalendarOperation{
		{ID: "conflict", Kind: "put", CalendarRemoteID: calendarURL, UID: "standup", RemoteID: &existing, IfMatch: &stale, Ical: &conflicting},
		{ID: "delete", Kind: "delete", CalendarRemoteID: calendarURL, UID: "new@tresso", RemoteID: fake.results["create"].RemoteID, IfMatch: fake.results["create"].ETag},
	}
	if err := r.writeAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	conflict := fake.results["conflict"]
	if conflict.Outcome != api.OperationConflict || conflict.Current == nil || !strings.Contains(*conflict.Current.Ical, "Standup, moved") {
		t.Fatalf("conflict = %+v", conflict)
	}
	if result := fake.results["delete"]; result.Outcome != api.OperationDone {
		t.Fatalf("delete = %+v", result)
	}
	if _, ok := server.objects[calendarPath+"new-tresso.ics"]; ok {
		t.Fatal("the delete reached the server")
	}
}

func TestAWrongPasswordIsReported(t *testing.T) {
	server := newFakeServer(t, true)
	client := caldav.New(plainDialer{}, "kim@company.example", "wrong", true, caldav.NewTrust("", server.server.URL))

	if _, err := client.Open(context.Background(), server.server.URL+"/dav/"); err != caldav.ErrUnauthorized {
		t.Fatalf("want ErrUnauthorized, got %v", err)
	}
}

func TestResourceNamesAreSafe(t *testing.T) {
	if got := resourceURL("https://dav.example/cal/home", "01a1@tresso/../x y"); got != "https://dav.example/cal/home/01a1-tresso-..-x-y.ics" {
		t.Fatalf("got %s", got)
	}
}

func TestReportsAProblemOnceUntilTheSyncWorksAgain(t *testing.T) {
	server := newFakeServer(t, true)
	fake := newFakeAPI(server.server.URL + "/dav/")
	syncer := New(fake, plainDialer{}, "w1", Options{AllowHTTP: true}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	status := newStatusReporter(syncer, "a1", syncer.logger)

	status.report(context.Background(), api.CalendarAuthFailed, "refused")
	status.report(context.Background(), api.CalendarAuthFailed, "refused")
	status.reset()
	status.report(context.Background(), api.CalendarAuthFailed, "refused")

	if len(fake.statuses) != 2 {
		t.Fatalf("want the status reported once per problem, got %v", fake.statuses)
	}
}

func TestAWrongPasswordReachesTheUser(t *testing.T) {
	server := newFakeServer(t, true)
	fake := newFakeAPI(server.server.URL + "/dav/")
	fake.password = "wrong"
	syncer := New(fake, plainDialer{}, "w1", Options{AllowHTTP: true, MinBackoff: time.Hour, MaxBackoff: time.Hour, NotFoundRetry: time.Hour}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- syncer.Run(ctx, api.Account{ID: "a1"}) }()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		fake.mu.Lock()
		reported := len(fake.statuses)
		fake.mu.Unlock()
		if reported > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	if len(fake.statuses) != 1 || fake.statuses[0] != api.CalendarAuthFailed {
		t.Fatalf("statuses = %v", fake.statuses)
	}
}

func TestAnUpdateWithoutAKnownETagIsNoFalseConflict(t *testing.T) {
	server := newFakeServer(t, true)
	server.put(calendarPath+"standup.ics", event("standup", "Standup"))
	fake := newFakeAPI(server.server.URL + "/dav/")
	r := openRun(t, server, fake)
	existing := server.server.URL + calendarPath + "standup.ics"
	updated := event("standup", "Standup, moved")
	// The last write got no ETag back, so the API has none for it.
	fake.operations = []api.CalendarOperation{
		{ID: "update", Kind: "put", CalendarRemoteID: server.server.URL + calendarPath, UID: "standup", RemoteID: &existing, Ical: &updated},
	}

	if err := r.writeAll(context.Background()); err != nil {
		t.Fatal(err)
	}

	if result := fake.results["update"]; result.Outcome != api.OperationDone {
		t.Fatalf("update = %+v", result)
	}
	if !strings.Contains(server.objects[calendarPath+"standup.ics"].data, "Standup, moved") {
		t.Fatal("the update did not reach the server")
	}
}

func TestACutShortListingIsPagedAndRemovesNothingLaterPagesList(t *testing.T) {
	server := newFakeServer(t, true)
	server.pageSize = 2
	for _, name := range []string{"a", "b", "c", "d", "e"} {
		server.put(calendarPath+name+".ics", event(name, name))
	}
	fake := newFakeAPI(server.server.URL + "/dav/")
	r := openRun(t, server, fake)

	if err := r.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}

	if len(fake.inventory) != 1 || len(fake.inventory[0]) != 5 || fake.partial[0] {
		t.Fatalf("want one complete listing of all five pages' resources, got %d listings: %v", len(fake.inventory), fake.inventory)
	}
	if len(fake.etags) != 5 {
		t.Fatalf("stored %v", fake.etags)
	}
	if cursor := fake.cursors["cal-Home"]; cursor == nil || !strings.Contains(*cursor, `"syncToken":"token-5"`) {
		t.Fatalf("the cursor is the last page's token, got %v", cursor)
	}
}

func TestCutShortChangesAreAppliedPageByPage(t *testing.T) {
	server := newFakeServer(t, true)
	server.put(calendarPath+"a.ics", event("a", "a"))
	fake := newFakeAPI(server.server.URL + "/dav/")
	r := openRun(t, server, fake)
	if err := r.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	server.pageSize = 2
	server.put(calendarPath+"b.ics", event("b", "b"))
	server.put(calendarPath+"c.ics", event("c", "c"))
	server.remove(calendarPath + "a.ics")

	if err := r.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}

	if len(fake.etags) != 2 || fake.etags[server.server.URL+calendarPath+"b.ics"] == "" || fake.etags[server.server.URL+calendarPath+"c.ics"] == "" {
		t.Fatalf("every page's changes are applied, stored %v", fake.etags)
	}
	if cursor := fake.cursors["cal-Home"]; !strings.Contains(*cursor, `"syncToken":"token-4"`) {
		t.Fatalf("cursor = %v", *cursor)
	}
	if len(fake.inventory) != 1 {
		t.Fatal("the changes come from sync-collection, not a listing")
	}
}

func TestAFailingSyncCollectionFallsBackToAListing(t *testing.T) {
	server := newFakeServer(t, true)
	server.syncStatus = http.StatusInternalServerError
	server.put(calendarPath+"standup.ics", event("standup", "Standup"))
	fake := newFakeAPI(server.server.URL + "/dav/")
	r := openRun(t, server, fake)

	if err := r.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}

	if len(fake.etags) != 1 {
		t.Fatalf("the calendar is synced from a listing, stored %v", fake.etags)
	}
	if cursor := fake.cursors["cal-Home"]; cursor == nil || strings.Contains(*cursor, "syncToken") {
		t.Fatalf("no sync token is kept from a listing, got %v", cursor)
	}
}

func TestRemovalsGoInBatchesTheAPITakesWithTheCursorLast(t *testing.T) {
	server := newFakeServer(t, true)
	fake := newFakeAPI(server.server.URL + "/dav/")
	r := openRun(t, server, fake)
	removed := make([]string, 2*removedBatch+1)
	for i := range removed {
		removed[i] = fmt.Sprintf("%s%d.ics", calendarPath, i)
	}

	if err := r.upload(context.Background(), caldav.Calendar{URL: server.server.URL + calendarPath}, api.CalendarState{ID: "cal-Home"}, nil, removed, cursor{SyncToken: "next"}); err != nil {
		t.Fatal(err)
	}

	if len(fake.batches) != 3 {
		t.Fatalf("want three batches, got %d", len(fake.batches))
	}
	total := 0
	for i, batch := range fake.batches {
		if len(batch.Removed) > removedBatch {
			t.Fatalf("batch %d removes %d", i, len(batch.Removed))
		}
		if (batch.Cursor != nil) != (i == len(fake.batches)-1) {
			t.Fatalf("only the last batch carries the cursor, batch %d has %v", i, batch.Cursor)
		}
		total += len(batch.Removed)
	}
	if total != len(removed) {
		t.Fatalf("removed %d of %d", total, len(removed))
	}
}

func TestAListingTooLargeForOneRequestGoesInPagesThatRemoveNothing(t *testing.T) {
	server := newFakeServer(t, true)
	fake := newFakeAPI(server.server.URL + "/dav/")
	r := openRun(t, server, fake)
	members := make([]caldav.Member, inventoryBatch+1)
	for i := range members {
		members[i] = caldav.Member{Href: fmt.Sprintf("%s%d.ics", calendarPath, i), ETag: `"1"`}
		fake.etags[members[i].Href] = `"1"`
	}
	fake.etags["gone.ics"] = `"1"`

	if err := r.applyListing(context.Background(), caldav.Calendar{URL: server.server.URL + calendarPath}, api.CalendarState{ID: "cal-Home"}, members, cursor{SyncToken: "next"}); err != nil {
		t.Fatal(err)
	}

	if len(fake.inventory) != 2 || len(fake.inventory[0]) != inventoryBatch || len(fake.inventory[1]) != 1 {
		t.Fatalf("want two pages, got %d", len(fake.inventory))
	}
	if !fake.partial[0] || !fake.partial[1] {
		t.Fatal("a page of a listing must not remove what other pages list")
	}
}

func TestResourcesTheAPICannotTakeAreLeftOut(t *testing.T) {
	server := newFakeServer(t, true)
	fake := newFakeAPI(server.server.URL + "/dav/")
	r := openRun(t, server, fake)
	long := calendarPath + strings.Repeat("x", maxHref) + ".ics"
	members := []caldav.Member{
		{Href: calendarPath + "ok.ics", ETag: `"1"`},
		{Href: long, ETag: `"1"`},
		{Href: calendarPath + "etag.ics", ETag: `"` + strings.Repeat("e", maxETag) + `"`},
	}
	fake.etags[calendarPath+"ok.ics"] = `"1"`

	if err := r.applyListing(context.Background(), caldav.Calendar{URL: server.server.URL + calendarPath}, api.CalendarState{ID: "cal-Home"}, members, cursor{}); err != nil {
		t.Fatal(err)
	}

	if len(fake.inventory[0]) != 1 || fake.inventory[0][0].RemoteID != calendarPath+"ok.ics" {
		t.Fatalf("inventory = %v", fake.inventory[0])
	}
}

func TestCalendarsTheAPICannotTakeAreLeftOutOfTheList(t *testing.T) {
	r := &run{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	calendars := []caldav.Calendar{{URL: "https://dav.example/" + strings.Repeat("x", maxHref)}}
	for i := range maxCalendars + 1 {
		calendars = append(calendars, caldav.Calendar{URL: fmt.Sprintf("https://dav.example/%d/", i)})
	}

	kept := r.acceptable(calendars)

	if len(kept) != maxCalendars || kept[0].URL != "https://dav.example/0/" {
		t.Fatalf("kept %d, first %s", len(kept), kept[0].URL)
	}
}

func TestAnUpdateIsNotSentWhenItsETagCannotBeRead(t *testing.T) {
	server := newFakeServer(t, true)
	server.put(calendarPath+"standup.ics", event("standup", "Standup"))
	fake := newFakeAPI(server.server.URL + "/dav/")
	r := openRun(t, server, fake)
	server.etagStatus = http.StatusServiceUnavailable
	existing := server.server.URL + calendarPath + "standup.ics"
	updated := event("standup", "Standup, moved")
	fake.operations = []api.CalendarOperation{
		{ID: "update", Kind: "put", CalendarRemoteID: server.server.URL + calendarPath, UID: "standup", RemoteID: &existing, Ical: &updated},
	}

	if err := r.writeAll(context.Background()); err != nil {
		t.Fatal(err)
	}

	if result := fake.results["update"]; result.Outcome != api.OperationRetry {
		t.Fatalf("update = %+v", result)
	}
	if strings.Contains(server.objects[calendarPath+"standup.ics"].data, "moved") {
		t.Fatal("the update went out without a precondition")
	}
}

func TestACalendarThatRefusesTheLoginDoesNotStopTheOthers(t *testing.T) {
	server := newFakeServer(t, true)
	server.shared = true
	server.put(calendarPath+"standup.ics", event("standup", "Standup"))
	fake := newFakeAPI(server.server.URL + "/dav/")
	r := openRun(t, server, fake)

	if err := r.syncAll(context.Background()); err != nil {
		t.Fatalf("one refusing calendar ended the sync: %v", err)
	}
	if len(fake.etags) != 1 {
		t.Fatalf("the other calendar is synced, stored %v", fake.etags)
	}
}

func TestStatusDetailsAreShortAndShowNoLogin(t *testing.T) {
	server := newFakeServer(t, true)
	fake := newFakeAPI(server.server.URL + "/dav/")
	syncer := New(fake, plainDialer{}, "w1", Options{AllowHTTP: true}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	status := newStatusReporter(syncer, "a1", syncer.logger)

	status.report(context.Background(), api.CalendarError, strings.Repeat("é", maxDetail+10))

	if got := []rune(fake.details[0]); len(got) != maxDetail {
		t.Fatalf("detail has %d characters", len(got))
	}
	if got := displayURL("https://kim:secret@dav.example/cal/?token=abc#x"); got != "https://dav.example/cal/" {
		t.Fatalf("displayURL = %s", got)
	}
}

func TestAResourceALaterPageReportsRemovedIsNotListed(t *testing.T) {
	server := newFakeServer(t, true)
	server.pageSize = 1
	server.put(calendarPath+"gone.ics", event("gone", "Gone"))
	server.put(calendarPath+"a.ics", event("a", "A"))
	server.put(calendarPath+"b.ics", event("b", "B"))
	pages := 0
	server.afterSync = func() {
		pages++
		if pages == 1 {
			// Removed while the listing is under way: a later page reports it gone.
			server.version++
			delete(server.objects, calendarPath+"gone.ics")
			server.changes = append(server.changes, fakeChange{version: server.version, path: calendarPath + "gone.ics"})
		}
	}
	fake := newFakeAPI(server.server.URL + "/dav/")
	r := openRun(t, server, fake)

	if err := r.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}

	if len(fake.inventory) != 1 {
		t.Fatalf("want one listing, got %d", len(fake.inventory))
	}
	for _, object := range fake.inventory[0] {
		if strings.HasSuffix(object.RemoteID, "gone.ics") {
			t.Fatalf("a resource reported gone on a later page is listed: %v", fake.inventory[0])
		}
	}
	if len(fake.inventory[0]) != 2 {
		t.Fatalf("inventory = %v", fake.inventory[0])
	}
}

func TestAnUpdateIsNotSentWhenTheServerNamesNoETag(t *testing.T) {
	server := newFakeServer(t, true)
	server.put(calendarPath+"standup.ics", event("standup", "Standup"))
	fake := newFakeAPI(server.server.URL + "/dav/")
	r := openRun(t, server, fake)
	server.noETag = true
	existing := server.server.URL + calendarPath + "standup.ics"
	updated := event("standup", "Standup, moved")
	fake.operations = []api.CalendarOperation{
		{ID: "update", Kind: "put", CalendarRemoteID: server.server.URL + calendarPath, UID: "standup", RemoteID: &existing, Ical: &updated},
	}

	if err := r.writeAll(context.Background()); err != nil {
		t.Fatal(err)
	}

	if result := fake.results["update"]; result.Outcome != api.OperationConflict || result.Current == nil {
		t.Fatalf("update = %+v", result)
	}
	if strings.Contains(server.objects[calendarPath+"standup.ics"].data, "moved") {
		t.Fatal("the update went out without a precondition")
	}
}

// runSyncer runs the syncer until the test ends.
func runSyncer(t *testing.T, fake *fakeAPI, opts Options) {
	t.Helper()
	opts.AllowHTTP = true
	syncer := New(fake, plainDialer{}, "w1", opts, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- syncer.Run(ctx, api.Account{ID: "a1"}) }()
	t.Cleanup(func() {
		cancel()
		<-done
	})
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// Fails without the fix: failures were counted over the account's whole lease, so the third unrelated blip reported
// an error, and the backoff kept doubling.
func TestAGoodSessionResetsTheFailureCountAndTheBackoff(t *testing.T) {
	server := newFakeServer(t, true)
	fake := newFakeAPI(server.server.URL + "/dav/")
	fake.listFails = map[int]bool{1: true, 3: true, 5: true, 7: true}
	runSyncer(t, fake, Options{Interval: time.Millisecond, MinBackoff: 50 * time.Millisecond, MaxBackoff: time.Second, NotFoundRetry: time.Hour})

	eventually(t, "eight calendar lists", func() bool { fake.mu.Lock(); defer fake.mu.Unlock(); return len(fake.listedAt) >= 8 })
	fake.mu.Lock()
	defer fake.mu.Unlock()
	for _, status := range fake.statuses {
		if status != api.CalendarActive {
			t.Errorf("statuses = %v; failures between good sessions are not in a row", fake.statuses)
		}
	}
	if wait := fake.listedAt[7].Sub(fake.listedAt[6]); wait > 150*time.Millisecond {
		t.Errorf("the wait after the fourth failure was %v, want about MinBackoff (50ms)", wait)
	}
}

// Fails without the fix: a calendar that failed every time was synced every interval and never reported.
func TestACalendarThatKeepsFailingIsBackedOffAndReported(t *testing.T) {
	server := newFakeServer(t, true)
	server.put(calendarPath+"standup.ics", event("standup", "Standup"))
	server.broken = true
	fake := newFakeAPI(server.server.URL + "/dav/")
	runSyncer(t, fake, Options{Interval: 5 * time.Millisecond, MinBackoff: 5 * time.Millisecond, MaxBackoff: 40 * time.Millisecond, NotFoundRetry: time.Hour})

	eventually(t, "the error status", func() bool { fake.mu.Lock(); defer fake.mu.Unlock(); return len(fake.statuses) > 0 })
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.statuses[0] != api.CalendarError || fake.details[0] != `The calendar "Home" could not be synced; trying again.` {
		t.Errorf("statuses %v, details %v", fake.statuses, fake.details)
	}
}

// The unconfirmed status carries the full found address as a field, and the sentence clients older than that field
// read the address from keeps its wording (address cut at 200 characters, without query).
func TestTheUnconfirmedStatusCarriesTheFoundAddress(t *testing.T) {
	fake := newFakeAPI("https://dav.example.com/")
	syncer := New(fake, plainDialer{}, "w1", Options{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	found := "https://dav.example.com/calendars/kim/?session=" + strings.Repeat("s", 300)

	newStatusReporter(syncer, "a1", syncer.logger).reportFound(context.Background(), api.CalendarUnconfirmed, unconfirmedDetail(found), found)

	if len(fake.foundURLs) != 1 || fake.foundURLs[0] != found {
		t.Fatalf("found urls %v, want the full address", fake.foundURLs)
	}
	want := "A calendar server was found at https://dav.example.com/calendars/kim/. To sync your calendars there, confirm this address in the account settings."
	if fake.details[0] != want {
		t.Errorf("detail %q, want %q", fake.details[0], want)
	}

	// An address the API would refuse (not https, no domain) is left out, so the status still goes in.
	for _, refused := range []string{"http://dav.example.com/", "https://localhost/dav/", "https://kim:secret@dav.example.com/"} {
		fake := newFakeAPI("https://dav.example.com/")
		syncer := New(fake, plainDialer{}, "w1", Options{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
		newStatusReporter(syncer, "a1", syncer.logger).reportFound(context.Background(), api.CalendarUnconfirmed, unconfirmedDetail(refused), refused)
		if len(fake.statuses) != 1 || fake.foundURLs[0] != "" {
			t.Errorf("%s: statuses %v, url %q", refused, fake.statuses, fake.foundURLs)
		}
	}
}

// Fails without the fix: once the broken calendar synced again, nothing told the API, which keeps the error.
func TestACalDAVRecoveryReportsActiveOnce(t *testing.T) {
	server := newFakeServer(t, true)
	server.put(calendarPath+"standup.ics", event("standup", "Standup"))
	server.broken = true
	fake := newFakeAPI(server.server.URL + "/dav/")
	runSyncer(t, fake, Options{Interval: 5 * time.Millisecond, MinBackoff: 5 * time.Millisecond, MaxBackoff: 20 * time.Millisecond, NotFoundRetry: time.Hour})

	active := func() int {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		n := 0
		for _, status := range fake.statuses {
			if status == api.CalendarActive {
				n++
			}
		}
		return n
	}
	eventually(t, "the error", func() bool { fake.mu.Lock(); defer fake.mu.Unlock(); return len(fake.statuses) > 0 })
	if active() != 0 {
		t.Fatal("active was reported while a calendar failed")
	}
	server.mu.Lock()
	server.broken = false
	server.mu.Unlock()
	eventually(t, "the recovery", func() bool { return active() == 1 })
	lists := func() int { fake.mu.Lock(); defer fake.mu.Unlock(); return len(fake.listedAt) }
	before := lists()
	eventually(t, "more rounds", func() bool { return lists() > before+5 })
	if n := active(); n != 1 {
		t.Errorf("active reported %d times, want once", n)
	}
}
