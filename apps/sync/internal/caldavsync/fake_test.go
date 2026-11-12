package caldavsync

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"tresso/sync/internal/api"
)

// fakeServer is a small CalDAV server: one principal with one calendar, sync-token or ctag only.
type fakeServer struct {
	t          *testing.T
	mu         sync.Mutex
	syncTokens bool
	objects    map[string]fakeObject // by path
	version    int
	changes    []fakeChange
	server     *httptest.Server
	// pageSize cuts sync-collection answers short after that many resources (RFC 6578 3.6); 0 never does.
	pageSize int
	// syncStatus, when set, is the answer to every sync-collection request.
	syncStatus int
	// etagStatus, when set, is the answer to a PROPFIND for one resource.
	etagStatus int
	// shared adds a second calendar that refuses the login, as one shared with the user and taken back does.
	shared bool
	// noETag leaves the getetag out of the answer to a PROPFIND for one resource.
	noETag bool
	// broken answers every request inside the calendar with 500, as a calendar the server cannot read.
	broken bool
	// afterSync runs after each sync-collection answer, with the server locked.
	afterSync func()
}

const sharedPath = "/dav/calendars/kim/shared/"

type fakeObject struct {
	etag string
	data string
}

type fakeChange struct {
	version int
	path    string
}

const (
	homePath     = "/dav/calendars/kim/"
	calendarPath = "/dav/calendars/kim/home/"
)

func newFakeServer(t *testing.T, syncTokens bool) *fakeServer {
	f := &fakeServer{t: t, syncTokens: syncTokens, objects: map[string]fakeObject{}}
	f.server = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeServer) put(path, data string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.version++
	f.objects[path] = fakeObject{etag: fmt.Sprintf(`"%d"`, f.version), data: data}
	f.changes = append(f.changes, fakeChange{version: f.version, path: path})
}

func (f *fakeServer) remove(path string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.version++
	delete(f.objects, path)
	f.changes = append(f.changes, fakeChange{version: f.version, path: path})
}

func (f *fakeServer) handle(w http.ResponseWriter, r *http.Request) {
	user, password, ok := r.BasicAuth()
	if !ok || user != "kim@company.example" || password != "app-password" || strings.HasPrefix(r.URL.Path, sharedPath) {
		w.Header().Set("WWW-Authenticate", `Basic realm="calendars"`)
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.broken && strings.HasPrefix(r.URL.Path, calendarPath) {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	switch {
	case r.Method == "PROPFIND" && r.URL.Path == "/dav/":
		f.multistatus(w, `<d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/dav/principals/kim/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)
	case r.Method == "PROPFIND" && r.URL.Path == "/dav/principals/kim/":
		f.multistatus(w, `<d:response><d:href>/dav/principals/kim/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>`+homePath+`</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)
	case r.Method == http.MethodOptions:
		w.Header().Set("DAV", "1, 2, 3, calendar-access")
	case r.Method == "PROPFIND" && r.URL.Path == homePath:
		token := ""
		if f.syncTokens {
			token = fmt.Sprintf("<d:sync-token>token-%d</d:sync-token>", f.version)
		}
		shared := ""
		if f.shared {
			shared = `<d:response><d:href>` + sharedPath + `</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Shared</d:displayname><cs:getctag>shared-1</cs:getctag><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
		}
		f.multistatus(w, shared+`<d:response><d:href>`+homePath+`</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`+
			`<d:response><d:href>`+calendarPath+`</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Home</d:displayname>`+
			`<a:calendar-color>#2E7D32FF</a:calendar-color><cs:getctag>ctag-`+fmt.Sprint(f.version)+`</cs:getctag>`+token+
			`<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>`+
			`<c:calendar-timezone>BEGIN:VCALENDAR&#13;
BEGIN:VTIMEZONE&#13;
TZID:Europe/Amsterdam&#13;
END:VTIMEZONE&#13;
END:VCALENDAR</c:calendar-timezone>`+
			`<d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>`+
			`</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`+
			`<d:response><d:href>/dav/calendars/kim/tasks/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Tasks</d:displayname><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)
	case r.Method == "PROPFIND" && r.URL.Path == calendarPath:
		responses := `<d:response><d:href>` + calendarPath + `</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
		for _, path := range f.paths() {
			responses += `<d:response><d:href>` + path + `</d:href><d:propstat><d:prop><d:getetag>` + xmlText(f.objects[path].etag) + `</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
		}
		f.multistatus(w, responses)
	case r.Method == "PROPFIND" && f.etagStatus != 0:
		w.WriteHeader(f.etagStatus)
	case r.Method == "PROPFIND" && f.noETag && r.URL.Path != calendarPath:
		f.multistatus(w, `<d:response><d:href>`+r.URL.Path+`</d:href><d:propstat><d:prop><d:getetag/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`)
	case r.Method == "PROPFIND":
		object, ok := f.objects[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		f.multistatus(w, `<d:response><d:href>`+r.URL.Path+`</d:href><d:propstat><d:prop><d:getetag>`+xmlText(object.etag)+`</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)
	case r.Method == "REPORT" && strings.Contains(string(body), "sync-collection"):
		if !f.syncTokens {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if f.syncStatus != 0 {
			w.WriteHeader(f.syncStatus)
			return
		}
		f.syncCollection(w, string(body))
		if f.afterSync != nil {
			f.afterSync()
		}
	case r.Method == "REPORT" && strings.Contains(string(body), "calendar-multiget"):
		var request struct {
			Hrefs []string `xml:"DAV: href"`
		}
		if err := xml.Unmarshal(body, &request); err != nil {
			f.t.Errorf("multiget: %v", err)
		}
		responses := ""
		for _, href := range request.Hrefs {
			object, ok := f.objects[href]
			if !ok {
				responses += `<d:response><d:href>` + href + `</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`
				continue
			}
			responses += `<d:response><d:href>` + href + `</d:href><d:propstat><d:prop><d:getetag>` + xmlText(object.etag) + `</d:getetag><c:calendar-data>` + xmlText(object.data) + `</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
		}
		f.multistatus(w, responses)
	case r.Method == http.MethodGet:
		object, ok := f.objects[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("ETag", object.etag)
		_, _ = io.WriteString(w, object.data)
	case r.Method == http.MethodPut:
		object, exists := f.objects[r.URL.Path]
		if match := r.Header.Get("If-Match"); match != "" && (!exists || match != object.etag) {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		if r.Header.Get("If-None-Match") == "*" && exists {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		f.mu.Unlock()
		f.put(r.URL.Path, string(body))
		f.mu.Lock()
		w.Header().Set("ETag", f.objects[r.URL.Path].etag)
		w.WriteHeader(http.StatusCreated)
	case r.Method == http.MethodDelete:
		object, exists := f.objects[r.URL.Path]
		if !exists {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if match := r.Header.Get("If-Match"); match != "" && match != object.etag {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		f.mu.Unlock()
		f.remove(r.URL.Path)
		f.mu.Lock()
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (f *fakeServer) syncCollection(w http.ResponseWriter, body string) {
	token := between(body, "<d:sync-token>", "</d:sync-token>")
	since := 0
	if token != "" {
		if _, err := fmt.Sscanf(token, "token-%d", &since); err != nil {
			w.WriteHeader(http.StatusForbidden)
			_, _ = io.WriteString(w, `<d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>`)
			return
		}
	}
	changed := map[string]bool{}
	upTo := f.version
	truncated := ""
	for _, change := range f.changes {
		if change.version <= since || changed[change.path] {
			continue
		}
		if f.pageSize > 0 && len(changed) == f.pageSize {
			// The rest comes with the next request, from the token of the last change on this page.
			truncated = `<d:response><d:href>` + calendarPath + `</d:href><d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response>`
			break
		}
		changed[change.path] = true
		upTo = change.version
	}
	if truncated == "" {
		upTo = f.version
	}
	paths := make([]string, 0, len(changed))
	for path := range changed {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	responses := ""
	for _, path := range paths {
		object, ok := f.objects[path]
		if !ok {
			if token != "" {
				responses += `<d:response><d:href>` + path + `</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`
			}
			continue
		}
		responses += `<d:response><d:href>` + path + `</d:href><d:propstat><d:prop><d:getetag>` + xmlText(object.etag) + `</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
	}
	f.multistatusWithToken(w, responses+truncated, fmt.Sprintf("token-%d", upTo))
}

func (f *fakeServer) paths() []string {
	paths := make([]string, 0, len(f.objects))
	for path := range f.objects {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

func (f *fakeServer) multistatus(w http.ResponseWriter, responses string) {
	f.multistatusWithToken(w, responses, "")
}

func (f *fakeServer) multistatusWithToken(w http.ResponseWriter, responses, token string) {
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.WriteHeader(http.StatusMultiStatus)
	tokenXML := ""
	if token != "" {
		tokenXML = "<d:sync-token>" + token + "</d:sync-token>"
	}
	_, _ = io.WriteString(w, `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/">`+responses+tokenXML+`</d:multistatus>`)
}

func between(s, start, end string) string {
	i := strings.Index(s, start)
	if i < 0 {
		return ""
	}
	s = s[i+len(start):]
	j := strings.Index(s, end)
	if j < 0 {
		return ""
	}
	return s[:j]
}

func xmlText(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// fakeAPI keeps what the syncer reports the way the API would.
type fakeAPI struct {
	mu         sync.Mutex
	caldavURL  string
	lists      []api.CalendarList
	cursors    map[string]*string
	etags      map[string]string // by remote id
	batches    []api.ObjectBatch
	inventory  [][]api.RemoteObject
	partial    []bool
	operations []api.CalendarOperation
	results    map[string]api.OperationResult
	statuses   []string
	details    []string
	// status is the account's calendar status as the API keeps it: a list makes it active unless it is an error.
	status    string
	foundURLs []string
	refuseURL bool // answer a report with an address with 422
	password  string
	// listFails answers the calendar list of that call (counted from 1) with an error; listedAt is when each came.
	listFails map[int]bool
	listedAt  []time.Time
}

func newFakeAPI(caldavURL string) *fakeAPI {
	return &fakeAPI{caldavURL: caldavURL, cursors: map[string]*string{}, etags: map[string]string{}, results: map[string]api.OperationResult{}}
}

func (a *fakeAPI) Credentials(context.Context, string, string) (api.Credentials, error) {
	return api.Credentials{
		AccountID:    "a1",
		EmailAddress: "kim@company.example",
		Provider:     "imap",
		Connection:   api.Connection{Username: "kim@company.example", CalDAV: a.caldavURL},
		Secrets:      map[string]string{"type": "password", "password": a.secret()},
	}, nil
}

func (a *fakeAPI) secret() string {
	if a.password != "" {
		return a.password
	}
	return "app-password"
}

func (a *fakeAPI) Calendars(_ context.Context, _ string, list api.CalendarList) (api.CalendarListAnswer, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.listedAt = append(a.listedAt, time.Now())
	if a.listFails[len(a.listedAt)] {
		return api.CalendarListAnswer{}, fmt.Errorf("calendar list %d: unexpected status 503", len(a.listedAt))
	}
	a.lists = append(a.lists, list)
	states := make([]api.CalendarState, 0, len(list.Calendars))
	for _, calendar := range list.Calendars {
		states = append(states, api.CalendarState{RemoteID: calendar.RemoteID, ID: "cal-" + calendar.Name, Cursor: a.cursors["cal-"+calendar.Name]})
	}
	if a.status != api.CalendarError {
		a.status = api.CalendarActive
	}
	return api.CalendarListAnswer{Calendars: states, Status: a.status}, nil
}

func (a *fakeAPI) CalendarInventory(_ context.Context, _, _, _ string, objects []api.RemoteObject, partial bool) (api.InventoryResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.inventory = append(a.inventory, objects)
	a.partial = append(a.partial, partial)
	listed := map[string]bool{}
	result := api.InventoryResult{Fetch: []string{}}
	for _, object := range objects {
		listed[object.RemoteID] = true
		if a.etags[object.RemoteID] != *object.ETag {
			result.Fetch = append(result.Fetch, object.RemoteID)
		}
	}
	for remoteID := range a.etags {
		if !listed[remoteID] && !partial {
			delete(a.etags, remoteID)
			result.Removed++
		}
	}
	return result, nil
}

func (a *fakeAPI) CalendarObjects(_ context.Context, _, calendarID string, batch api.ObjectBatch) (api.ObjectBatchResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.batches = append(a.batches, batch)
	for _, object := range batch.Changed {
		a.etags[object.RemoteID] = *object.ETag
	}
	for _, remoteID := range batch.Removed {
		delete(a.etags, remoteID)
	}
	if batch.Cursor != nil {
		a.cursors[calendarID] = batch.Cursor
	}
	return api.ObjectBatchResult{Stored: len(batch.Changed), Removed: len(batch.Removed)}, nil
}

func (a *fakeAPI) ClaimCalendarOperations(context.Context, string, string) ([]api.CalendarOperation, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	operations := a.operations
	a.operations = nil
	return operations, nil
}

func (a *fakeAPI) ReportCalendarOperation(_ context.Context, _, operationID string, result api.OperationResult) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.results[operationID] = result
	return nil
}

func (a *fakeAPI) CalendarStatus(_ context.Context, _, _, status, detail, foundURL string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.refuseURL && foundURL != "" {
		return &api.HTTPError{Method: http.MethodPost, Path: "/calendar-status", Status: http.StatusUnprocessableEntity}
	}
	a.statuses = append(a.statuses, status)
	a.details = append(a.details, detail)
	a.foundURLs = append(a.foundURLs, foundURL)
	if status != api.CalendarActive || a.status == api.CalendarError {
		a.status = status
	}
	return nil
}

type plainDialer struct{}

func (plainDialer) DialContext(ctx context.Context, address string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "tcp", address)
}
