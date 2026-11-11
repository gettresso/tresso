package graphsync

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"tresso/sync/internal/providersend"
)

// fakeGraph is an in-memory Outlook mailbox behind the Graph endpoints the syncer uses: a folder tree, messages with
// raw MIME, and a change log that delta tokens point into.
type fakeGraph struct {
	t      *testing.T
	server *httptest.Server
	base   string

	mu        sync.Mutex
	token     string
	folders   []fakeFolder
	wellKnown map[string]string
	messages  map[string]*fakeMessage
	seq       int
	events    []fakeEvent
	// Delta tokens below expiredBefore answer 410 Gone.
	expiredBefore int
	// throttle answers that many requests with 429 and retryAfter.
	throttle     int
	retryAfter   string
	throttledAt  []time.Time
	failNext     int
	failBody     string
	rawGets      map[string]int
	rawQueries   []string
	noPrefer     []string
	sent         []sentRequest
	authRejected int
	// ops logs draft and lookup requests in order: "create <id>", "delete <id>", "lookup <id>".
	ops    []string
	nextID int
	// failDelta answers the delta query of this folder with 400, once.
	failDelta string
	// shortPages makes listings return one message per page while more follow, as Graph may.
	shortPages bool
	// rewriteIDs gives sent messages and new drafts a Message-ID of the fake's own, as Exchange may.
	rewriteIDs bool
	// headersAsProperties returns custom headers only as named extended properties, not as internetMessageHeaders.
	headersAsProperties bool
	// stripCustomHeaders drops the X- headers of a message it sends, as Exchange may.
	stripCustomHeaders bool
	// failSend answers the next draft send with this status, once.
	failSend int
	// failPatch answers the next PATCH with this status, once; failDelete the next permanentDelete.
	failPatch, failDelete int
	// refuseRecipientFilter answers a recipient filter with 400, as a Graph that does not support it would.
	refuseRecipientFilter bool
	// headerReads counts listed messages whose headers were asked for, to show how much a lookup reads.
	headerReads int
	// refuseRaw answers the $value of these messages with the status and body, every time.
	refuseRaw map[string]fakeRefusal
	// requestPaths lists the path of every request; deltaRequests counts the delta pages asked for, per folder.
	requestPaths  []string
	deltaRequests map[string]int
	// failDeltaRequest answers that delta page request of failDeltaFolder (counted from 1) with 400, once.
	failDeltaFolder  string
	failDeltaRequest int
	// deniedFolders answers every request below these folders (children, messages, delta) with 403
	// ErrorAccessDenied, as Graph does for a folder the user lost access to.
	deniedFolders map[string]bool
}

type fakeRefusal struct {
	status int
	body   string
}

type fakeFolder struct{ id, name, parent string }

type fakeMessage struct {
	id, folder string
	raw        []byte
	read       bool
	flagged    bool
	received   time.Time // zero: Graph reports no receive time, only the creation time
	created    time.Time
	draft      bool
	props      map[string]string // extended properties by id
}

type fakeEvent struct {
	seq        int
	folder, id string
}

type sentRequest struct {
	contentType string
	body        []byte
}

func newFakeGraph(t *testing.T) *fakeGraph {
	f := &fakeGraph{t: t, token: "token-1", messages: map[string]*fakeMessage{}, rawGets: map[string]int{}, seq: 1}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	f.base = f.server.URL + "/v1.0"
	t.Cleanup(func() {
		f.server.Close()
		if len(f.noPrefer) > 0 {
			t.Errorf("requests without the immutable id preference: %v", f.noPrefer)
		}
	})
	return f
}

// standardTree is Sent Items listed before Inbox (Graph's order is not alphabetical), nested folders under Inbox and
// no Archive folder.
func (f *fakeGraph) standardTree() {
	f.folders = []fakeFolder{
		{"f-sent", "Sent Items", ""}, {"f-inbox", "Inbox", ""}, {"f-proj", "Projects", "f-inbox"}, {"f-acme", "Acme", "f-proj"},
		{"f-drafts", "Drafts", ""}, {"f-trash", "Deleted Items", ""}, {"f-junk", "Junk Email", ""}, {"f-notes", "Notes", ""},
	}
	f.wellKnown = map[string]string{"inbox": "f-inbox", "sentitems": "f-sent", "drafts": "f-drafts", "deleteditems": "f-trash", "junkemail": "f-junk", "outbox": "f-outbox"}
}

func (f *fakeGraph) add(id, folder string, received int, raw []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.messages[id] = &fakeMessage{id: id, folder: folder, raw: raw, received: time.Unix(int64(received), 0).UTC(), created: time.Unix(int64(received), 0).UTC()}
	f.event(folder, id)
}

// addUndated adds a message Graph reports without a receive time.
func (f *fakeGraph) addUndated(id, folder string, created int, raw []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.messages[id] = &fakeMessage{id: id, folder: folder, raw: raw, created: time.Unix(int64(created), 0).UTC()}
	f.event(folder, id)
}

// moveQuietly moves a message without an event in the folder it moves to, as if it moved there before that folder's
// delta started; the folder it left still reports the removal.
func (f *fakeGraph) moveQuietly(id, to string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	m := f.messages[id]
	f.event(m.folder, id)
	m.folder = to
}

func (f *fakeGraph) log() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.ops)
}

func (f *fakeGraph) markRead(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.messages[id].read = true
	f.event(f.messages[id].folder, id)
}

// move keeps the id: Graph's immutable ids survive moves.
func (f *fakeGraph) move(id, to string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	m := f.messages[id]
	f.event(m.folder, id)
	m.folder = to
	f.event(to, id)
}

// remove deletes a message; quiet leaves nothing in the change log, as if the delta token had expired meanwhile.
func (f *fakeGraph) remove(id string, quiet bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	folder := f.messages[id].folder
	delete(f.messages, id)
	if quiet {
		f.seq++
		return
	}
	f.event(folder, id)
}

func (f *fakeGraph) event(folder, id string) {
	f.seq++
	f.events = append(f.events, fakeEvent{seq: f.seq, folder: folder, id: id})
}

func (f *fakeGraph) expireDeltaTokens() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.expiredBefore = f.seq
}

func (f *fakeGraph) fail(status int, body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failNext, f.failBody = status, body
}

func (f *fakeGraph) paths() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.requestPaths)
}

func (f *fakeGraph) deltaPages(folder string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.deltaRequests[folder]
}

func (f *fakeGraph) gets(id string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.rawGets[id]
}

func (f *fakeGraph) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if !strings.Contains(r.Header.Get("Prefer"), `IdType="ImmutableId"`) {
		f.noPrefer = append(f.noPrefer, r.URL.Path)
	}
	if r.Header.Get("Authorization") != "Bearer "+f.token {
		f.authRejected++
		writeError(w, http.StatusUnauthorized, `{"error":{"code":"InvalidAuthenticationToken"}}`)
		return
	}
	if f.throttle > 0 {
		f.throttle--
		f.throttledAt = append(f.throttledAt, time.Now())
		w.Header().Set("Retry-After", f.retryAfter)
		writeError(w, http.StatusTooManyRequests, `{"error":{"code":"ApplicationThrottled"}}`)
		return
	}
	if f.failNext != 0 {
		status, body := f.failNext, f.failBody
		f.failNext = 0
		writeError(w, status, body)
		return
	}

	f.rawQueries = append(f.rawQueries, r.URL.RawQuery)
	f.requestPaths = append(f.requestPaths, r.URL.Path)
	q := r.URL.Query()
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/v1.0/me/"), "/")
	if len(parts) >= 3 && parts[0] == "mailFolders" && f.deniedFolders[parts[1]] {
		writeError(w, http.StatusForbidden, `{"error":{"code":"ErrorAccessDenied","message":"Access is denied."}}`)
		return
	}
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/v1.0/me/messages":
		body, _ := io.ReadAll(r.Body)
		raw, err := base64.StdEncoding.DecodeString(string(body))
		if err != nil || r.Header.Get("Content-Type") != "text/plain" {
			writeError(w, http.StatusBadRequest, `{"error":{"code":"ErrorInvalidRequest"}}`)
			return
		}
		f.nextID++
		id := "draft-" + strconv.Itoa(f.nextID)
		f.messages[id] = &fakeMessage{id: id, folder: f.wellKnown["drafts"], raw: f.rewrite(raw, id), created: time.Now().UTC(), received: time.Now().UTC(), draft: true}
		f.event(f.wellKnown["drafts"], id)
		f.ops = append(f.ops, "create "+id)
		w.WriteHeader(http.StatusCreated)
		writeJSON(w, map[string]string{"id": id})
	case r.Method == http.MethodPost && len(parts) == 3 && parts[0] == "messages" && parts[2] == "move":
		m, ok := f.messages[parts[1]]
		if !ok {
			writeError(w, http.StatusNotFound, `{"error":{"code":"ErrorItemNotFound"}}`)
			return
		}
		var in struct{ DestinationID string }
		_ = json.NewDecoder(r.Body).Decode(&in)
		f.event(m.folder, m.id)
		m.folder = in.DestinationID
		f.event(m.folder, m.id)
		f.ops = append(f.ops, "move "+m.id+" "+m.folder)
		w.WriteHeader(http.StatusCreated)
		item := f.item(m)
		item["parentFolderId"] = m.folder
		writeJSON(w, item)
	case r.Method == http.MethodPatch && len(parts) == 2 && parts[0] == "messages":
		m, ok := f.messages[parts[1]]
		if !ok {
			writeError(w, http.StatusNotFound, `{"error":{"code":"ErrorItemNotFound"}}`)
			return
		}
		if f.failPatch != 0 {
			status := f.failPatch
			f.failPatch = 0
			f.ops = append(f.ops, "patch refused "+m.id)
			writeError(w, status, `{"error":{"code":"ErrorInvalidRequest","message":"The property cannot be set."}}`)
			return
		}
		var patch struct {
			Properties []struct{ ID, Value string } `json:"singleValueExtendedProperties"`
		}
		_ = json.NewDecoder(r.Body).Decode(&patch)
		for _, p := range patch.Properties {
			if m.props == nil {
				m.props = map[string]string{}
			}
			m.props[p.ID] = p.Value
		}
		writeJSON(w, f.item(m))
	case r.Method == http.MethodPost && len(parts) == 3 && parts[0] == "messages" && parts[2] == "send":
		m, ok := f.messages[parts[1]]
		if !ok || !m.draft {
			writeError(w, http.StatusNotFound, `{"error":{"code":"ErrorItemNotFound"}}`)
			return
		}
		if f.failSend != 0 {
			status := f.failSend
			f.failSend = 0
			writeError(w, status, `{"error":{"code":"ErrorSendFailed"}}`)
			return
		}
		// Sent: the copy goes to Sent Items, keeping its id and extended properties, maybe not its Message-ID and
		// X- headers.
		f.sent = append(f.sent, sentRequest{contentType: "text/plain", body: []byte(base64.StdEncoding.EncodeToString(m.raw))})
		f.event(m.folder, m.id)
		m.folder, m.draft, m.received = f.wellKnown["sentitems"], false, time.Now().UTC()
		m.raw = f.rewrite(m.raw, "sent-"+m.id)
		if f.stripCustomHeaders {
			m.raw = withoutCustomHeaders(m.raw)
		}
		f.event(m.folder, m.id)
		f.ops = append(f.ops, "send "+m.id)
		w.WriteHeader(http.StatusAccepted)
	case r.Method == http.MethodPost && len(parts) == 3 && parts[0] == "messages" && parts[2] == "permanentDelete" && f.failDelete != 0:
		status := f.failDelete
		f.failDelete = 0
		writeError(w, status, `{"error":{"code":"ServiceUnavailable"}}`)
	case r.Method == http.MethodPost && len(parts) == 3 && parts[0] == "messages" && parts[2] == "permanentDelete":
		m, ok := f.messages[parts[1]]
		if !ok {
			writeError(w, http.StatusNotFound, `{"error":{"code":"ErrorItemNotFound"}}`)
			return
		}
		delete(f.messages, m.id)
		f.event(m.folder, m.id)
		f.ops = append(f.ops, "delete "+m.id)
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodGet && len(parts) == 2 && parts[0] == "messages":
		m, ok := f.messages[parts[1]]
		f.ops = append(f.ops, "lookup "+parts[1])
		if !ok {
			writeError(w, http.StatusNotFound, `{"error":{"code":"ErrorItemNotFound"}}`)
			return
		}
		item := f.item(m)
		item["parentFolderId"] = m.folder
		writeJSON(w, item)
	case r.Method == http.MethodPost && r.URL.Path == "/v1.0/me/sendMail":
		body, _ := io.ReadAll(r.Body)
		f.sent = append(f.sent, sentRequest{contentType: r.Header.Get("Content-Type"), body: body})
		if folder, ok := f.wellKnown["sentitems"]; ok {
			raw, _ := base64.StdEncoding.DecodeString(string(body))
			f.nextID++
			id := "sent-" + strconv.Itoa(f.nextID)
			f.messages[id] = &fakeMessage{id: id, folder: folder, raw: f.rewrite(raw, id), created: time.Now().UTC(), received: time.Now().UTC()}
			f.event(folder, id)
		}
		w.WriteHeader(http.StatusAccepted)
	case len(parts) == 1 && parts[0] == "mailFolders":
		f.listFolders(w, "", q)
	case len(parts) == 3 && parts[0] == "mailFolders" && parts[2] == "childFolders":
		f.listFolders(w, parts[1], q)
	case len(parts) == 2 && parts[0] == "mailFolders":
		id, ok := f.wellKnown[parts[1]]
		if !ok {
			writeError(w, http.StatusNotFound, `{"error":{"code":"ErrorItemNotFound"}}`)
			return
		}
		writeJSON(w, map[string]string{"id": id})
	case len(parts) == 4 && parts[0] == "mailFolders" && parts[2] == "messages" && parts[3] == "delta":
		if f.failDelta == parts[1] {
			f.failDelta = ""
			writeError(w, http.StatusBadRequest, `{"error":{"code":"ErrorInvalidRequest","message":"Something went wrong."}}`)
			return
		}
		f.delta(w, parts[1], q)
	case len(parts) == 3 && parts[0] == "mailFolders" && parts[2] == "messages":
		folder := parts[1]
		if id, ok := f.wellKnown[folder]; ok {
			folder = id
		}
		f.listMessages(w, folder, q)
	case len(parts) == 3 && parts[0] == "messages" && parts[2] == "$value":
		m, ok := f.messages[parts[1]]
		if !ok {
			writeError(w, http.StatusNotFound, `{"error":{"code":"ErrorItemNotFound"}}`)
			return
		}
		f.rawGets[m.id]++
		if refusal, refused := f.refuseRaw[m.id]; refused {
			writeError(w, refusal.status, refusal.body)
			return
		}
		_, _ = w.Write(m.raw)
	case len(parts) == 1 && parts[0] == "messages":
		var value []map[string]any
		if id, want, ok := propertyFilter(q.Get("$filter")); ok {
			for _, m := range f.messages {
				if strings.EqualFold(m.props[id], want) {
					value = append(value, f.markedItem(m))
				}
			}
			writeJSON(w, map[string]any{"value": value})
			return
		}
		for _, m := range f.messages {
			if strings.Contains(q.Get("$filter"), "'<") && strings.Contains(string(m.raw), "Message-ID: "+strings.TrimSuffix(strings.SplitN(q.Get("$filter"), "'", 2)[1], "'")) {
				value = append(value, f.markedItem(m))
			}
		}
		writeJSON(w, map[string]any{"value": value})
	default:
		f.t.Errorf("unexpected request %s %s", r.Method, r.URL)
		http.NotFound(w, r)
	}
}

// listFolders pages two folders at a time.
func (f *fakeGraph) listFolders(w http.ResponseWriter, parent string, q map[string][]string) {
	var level []map[string]any
	for _, folder := range f.folders {
		if folder.parent != parent {
			continue
		}
		children := 0
		for _, child := range f.folders {
			if child.parent == folder.id {
				children++
			}
		}
		level = append(level, map[string]any{"id": folder.id, "displayName": folder.name, "childFolderCount": children})
	}
	skip := 0
	if v := q["$skip"]; len(v) > 0 {
		skip, _ = strconv.Atoi(v[0])
	}
	end := min(skip+2, len(level))
	out := map[string]any{"value": level[skip:end]}
	if end < len(level) {
		path := "/me/mailFolders"
		if parent != "" {
			path += "/" + parent + "/childFolders"
		}
		out["@odata.nextLink"] = f.base + path + "?$top=100&$skip=" + strconv.Itoa(end)
	}
	writeJSON(w, out)
}

func (f *fakeGraph) item(m *fakeMessage) map[string]any {
	status := "notFlagged"
	if m.flagged {
		status = "flagged"
	}
	item := map[string]any{"id": m.id, "isRead": m.read, "isDraft": m.draft, "flag": map[string]string{"flagStatus": status},
		"receivedDateTime": nil, "createdDateTime": m.created.Format(time.RFC3339), "lastModifiedDateTime": m.created.Format(time.RFC3339)}
	if !m.received.IsZero() {
		item["receivedDateTime"] = m.received.Format(time.RFC3339)
	}
	return item
}

// delta lists a folder from scratch, or its changes since a delta token, two items per page.
func (f *fakeGraph) delta(w http.ResponseWriter, folder string, q map[string][]string) {
	get := func(name string) string {
		if v := q[name]; len(v) > 0 {
			return v[0]
		}
		return ""
	}
	if get("$select") == "" && get("$deltatoken") == "" && get("$skiptoken") == "" {
		f.t.Errorf("delta query without $select")
	}
	if f.deltaRequests == nil {
		f.deltaRequests = map[string]int{}
	}
	f.deltaRequests[folder]++
	if folder == f.failDeltaFolder && f.deltaRequests[folder] == f.failDeltaRequest {
		writeError(w, http.StatusBadRequest, `{"error":{"code":"ErrorInvalidRequest"}}`)
		return
	}
	// $skiptoken is "<from token>.<offset>"; "-" as from token means from scratch.
	from, offset := get("$deltatoken"), 0
	if skip := get("$skiptoken"); skip != "" {
		token, off, _ := strings.Cut(skip, ".")
		from, offset = token, mustAtoi(off)
	}
	if from == "" {
		from = "-"
	}

	var items []map[string]any
	if from == "-" {
		var ids []string
		for id, m := range f.messages {
			if m.folder == folder {
				ids = append(ids, id)
			}
		}
		slices.Sort(ids)
		for _, id := range ids {
			items = append(items, f.item(f.messages[id]))
		}
	} else {
		token := mustAtoi(from)
		if token < f.expiredBefore {
			writeError(w, http.StatusGone, `{"error":{"code":"SyncStateNotFound","message":"The sync state generation is not found."}}`)
			return
		}
		seen := map[string]bool{}
		for _, e := range f.events {
			if e.seq <= token || e.folder != folder || seen[e.id] {
				continue
			}
			seen[e.id] = true
			if m, ok := f.messages[e.id]; ok && m.folder == folder {
				items = append(items, f.item(m))
			} else {
				items = append(items, map[string]any{"id": e.id, "@removed": map[string]string{"reason": "deleted"}})
			}
		}
	}

	end := min(offset+2, len(items))
	out := map[string]any{"value": items[min(offset, len(items)):end]}
	link := f.base + "/me/mailFolders/" + folder + "/messages/delta?"
	if end < len(items) {
		out["@odata.nextLink"] = link + "$skiptoken=" + from + "." + strconv.Itoa(end)
	} else {
		out["@odata.deltaLink"] = link + "$deltatoken=" + strconv.Itoa(f.seq)
	}
	writeJSON(w, out)
}

// listMessages lists a folder, newest first (messages without a receive time last) when ordered, filtered by receive
// time ("receivedDateTime lt|eq <time>", which never matches an undated message) or Message-ID ("internetMessageId eq
// '<id>'"), paged with $top. Like Graph, its next links skip a number of messages ($skip), so a page shifts when an
// earlier message goes.
func (f *fakeGraph) listMessages(w http.ResponseWriter, folder string, q map[string][]string) {
	get := func(name string) string {
		if v := q[name]; len(v) > 0 {
			return v[0]
		}
		return ""
	}
	if orderby := get("$orderby"); orderby != "" && orderby != "receivedDateTime desc" {
		f.t.Errorf("listing ordered by %q", orderby)
	}
	keep := func(*fakeMessage) bool { return true }
	if id, value, ok := propertyFilter(get("$filter")); ok {
		keep = func(m *fakeMessage) bool { return strings.EqualFold(m.props[id], value) }
	} else if filter := get("$filter"); strings.HasPrefix(filter, "internetMessageId eq '") {
		id := strings.TrimSuffix(strings.TrimPrefix(filter, "internetMessageId eq '"), "'")
		keep = func(m *fakeMessage) bool { return strings.Contains(string(m.raw), "Message-ID: "+id+"\r\n") }
	} else if after, ok := strings.CutPrefix(filter, "sentDateTime ge "); ok {
		value, recipients, narrowed := strings.Cut(after, " and (")
		at, err := time.Parse(time.RFC3339Nano, value)
		if err != nil {
			f.t.Errorf("unexpected $filter %q", filter)
		}
		address := ""
		if narrowed {
			if f.refuseRecipientFilter {
				writeError(w, http.StatusBadRequest, `{"error":{"code":"ErrorInvalidUrlQueryFilter","message":"The query filter contains one or more invalid nodes."}}`)
				return
			}
			start := strings.Index(recipients, "address eq '") + len("address eq '")
			address = recipients[start : start+strings.IndexByte(recipients[start:], '\'')]
		}
		keep = func(m *fakeMessage) bool {
			if m.received.Before(at) {
				return false
			}
			if address == "" {
				return true
			}
			for _, header := range []string{"To", "Cc", "Bcc"} {
				if strings.Contains(strings.ToLower(providersend.HeaderValue(m.raw, header)), strings.ToLower(address)) {
					return true
				}
			}
			return false
		}
	} else if after, ok := strings.CutPrefix(filter, "createdDateTime ge "); ok {
		at, err := time.Parse(time.RFC3339Nano, after)
		if err != nil {
			f.t.Errorf("unexpected $filter %q", filter)
		}
		keep = func(m *fakeMessage) bool { return !m.created.Before(at) }
	} else if filter != "" {
		fields := strings.Fields(filter)
		if len(fields) != 3 || fields[0] != "receivedDateTime" {
			f.t.Errorf("unexpected $filter %q", filter)
		}
		at, err := time.Parse(time.RFC3339Nano, fields[2])
		if err != nil {
			f.t.Errorf("unexpected $filter %q (Graph's support for null comparisons is not relied on)", filter)
		}
		switch fields[1] {
		case "lt":
			keep = func(m *fakeMessage) bool { return !m.received.IsZero() && m.received.Before(at) }
		case "eq":
			keep = func(m *fakeMessage) bool { return !m.received.IsZero() && m.received.Equal(at) }
		default:
			f.t.Errorf("unexpected $filter operator %q", fields[1])
		}
	}
	var all []*fakeMessage
	for _, m := range f.messages {
		if m.folder == folder && keep(m) {
			all = append(all, m)
		}
	}
	slices.SortFunc(all, func(a, b *fakeMessage) int {
		if c := b.received.Compare(a.received); c != 0 {
			return c
		}
		return strings.Compare(a.id, b.id)
	})
	top, skip := mustAtoi(get("$top")), mustAtoi(get("$skip"))
	end := min(skip+top, len(all))
	if f.shortPages {
		end = min(skip+1, len(all))
	}
	items := []map[string]any{}
	for _, m := range all[min(skip, len(all)):end] {
		items = append(items, f.listItem(m, get("$select"), get("$expand")))
	}
	out := map[string]any{"value": items}
	if end < len(all) {
		// Like Graph, the next link keeps the query: selection, expansion, filter and order.
		sel := get("$select")
		if sel == "" {
			sel = messageFields
		}
		link := f.base + "/me/mailFolders/" + folder + "/messages?$select=" + sel + "&$top=" + strconv.Itoa(top) + "&$skip=" + strconv.Itoa(end)
		if expand := get("$expand"); expand != "" {
			link += "&$expand=" + queryEscape(expand)
		}
		if filter := get("$filter"); filter != "" {
			link += "&$filter=" + queryEscape(filter)
		}
		if get("$orderby") != "" {
			link += "&$orderby=receivedDateTime%20desc"
		}
		out["@odata.nextLink"] = link
	}
	writeJSON(w, out)
}

func mustAtoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

// rewrite gives raw a Message-ID of the fake's own when rewriteIDs is set.
func (f *fakeGraph) rewrite(raw []byte, id string) []byte {
	if !f.rewriteIDs {
		return raw
	}
	replaced, err := providersend.SetHeader(raw, "Message-ID", "<"+id+"@outlook.example>")
	if err != nil {
		f.t.Fatal(err)
	}
	return replaced
}

// listItem is a listed message with what $select and $expand ask for: the custom X- headers as
// internetMessageHeaders, or as named extended properties of the internet headers property set.
func (f *fakeGraph) listItem(m *fakeMessage, sel, expand string) map[string]any {
	item := f.item(m)
	item["parentFolderId"] = m.folder
	if strings.Contains(sel, "internetMessageHeaders") {
		f.headerReads++
	}
	var custom [][2]string
	for _, line := range strings.Split(string(m.raw[:max(0, strings.Index(string(m.raw), "\r\n\r\n"))]), "\r\n") {
		if name, value, ok := strings.Cut(line, ":"); ok && strings.HasPrefix(strings.ToLower(name), "x-") {
			custom = append(custom, [2]string{name, strings.TrimSpace(value)})
		}
	}
	if strings.Contains(sel, "internetMessageHeaders") && !f.headersAsProperties {
		var headers []map[string]string
		for _, h := range custom {
			headers = append(headers, map[string]string{"name": h[0], "value": h[1]})
		}
		item["internetMessageHeaders"] = headers
	}
	if strings.HasPrefix(expand, "singleValueExtendedProperties") {
		var props []map[string]string
		for _, h := range custom {
			id := "String " + internetHeadersSet + " Name " + h[0]
			if strings.Contains(expand, "'"+id+"'") {
				props = append(props, map[string]string{"id": id, "value": h[1]})
			}
		}
		if props != nil {
			item["singleValueExtendedProperties"] = props
		}
	}
	return item
}

// addAt puts a message in a folder directly, created (and sent) at t.
func (f *fakeGraph) addAt(id, folder string, t time.Time, raw []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.messages[id] = &fakeMessage{id: id, folder: folder, raw: raw, received: t.UTC(), created: t.UTC()}
}

// propertyFilter reads a "singleValueExtendedProperties/Any(ep: ep/id eq '<id>' and ep/value eq '<value>')" filter.
func propertyFilter(filter string) (id, value string, ok bool) {
	rest, ok := strings.CutPrefix(filter, "singleValueExtendedProperties/Any(ep: ep/id eq '")
	if !ok {
		return "", "", false
	}
	id, rest, _ = strings.Cut(rest, "' and ep/value eq '")
	value = strings.ReplaceAll(strings.TrimSuffix(rest, "')"), "''", "'")
	return id, value, true
}

// withoutCustomHeaders drops every X- header of raw's header section.
func withoutCustomHeaders(raw []byte) []byte {
	head, body, _ := strings.Cut(string(raw), "\r\n\r\n")
	var kept []string
	for _, line := range strings.Split(head, "\r\n") {
		if !strings.HasPrefix(strings.ToLower(line), "x-") {
			kept = append(kept, line)
		}
	}
	return []byte(strings.Join(kept, "\r\n") + "\r\n\r\n" + body)
}

// markedItem is a message as the lookups of earlier attempts read it.
func (f *fakeGraph) markedItem(m *fakeMessage) map[string]any {
	return map[string]any{"id": m.id, "isDraft": m.draft, "parentFolderId": m.folder, "lastModifiedDateTime": m.created.Format(time.RFC3339)}
}

// age makes a message look last changed d ago.
func (f *fakeGraph) age(id string, d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.messages[id].created = time.Now().Add(-d).UTC()
}
