package gmailsync

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode"

	"tresso/sync/internal/providersend"
)

// fakeGmail is an in-memory Gmail mailbox behind the Gmail API's endpoints: labels, messages with raw MIME, and a
// history log with ids.
type fakeGmail struct {
	t      *testing.T
	server *httptest.Server

	mu       sync.Mutex
	token    string // the only access token accepted
	labels   []label
	messages map[string]*fakeMessage
	history  []fakeRecord
	// historyID is the mailbox's current history id; a startHistoryId below expiredBefore answers 404.
	historyID     int
	expiredBefore int
	// failNext answers the next request with this status and body, once.
	failNext     int
	failBody     string
	rawGets      map[string]int
	minimalGets  map[string]int
	sent         []sentRequest
	authRejected int
	// rewriteIDs makes sends and new drafts get a Message-ID of Gmail's own, as Gmail may do.
	rewriteIDs bool
	drafts     map[string]string // draft id -> message id
	nextID     int
	draftLists int
	// metadataGets counts header lookups (format=metadata), to show how much a duplicate check reads.
	metadataGets int
	// refuseRaw answers format=raw for these messages with the status and body, every time; refuseAllRaw for all.
	refuseRaw    map[string][2]string
	refuseAllRaw [2]string
}

type fakeMessage struct {
	id       string
	raw      []byte
	labels   []string
	received int64  // ms
	thread   string // "" means its own id
}

func (m *fakeMessage) threadID() string {
	if m.thread != "" {
		return m.thread
	}
	return m.id
}

type fakeRecord struct {
	id     int
	record historyRecord
}

type sentRequest struct {
	path        string
	contentType string
	raw         []byte
}

func newFakeGmail(t *testing.T) *fakeGmail {
	f := &fakeGmail{
		t:         t,
		token:     "token-1",
		messages:  map[string]*fakeMessage{},
		historyID: 100,
		labels: []label{
			{ID: "INBOX", Name: "INBOX", Type: "system"}, {ID: "SENT", Name: "SENT", Type: "system"},
			{ID: "DRAFT", Name: "DRAFT", Type: "system"}, {ID: "TRASH", Name: "TRASH", Type: "system"},
			{ID: "SPAM", Name: "SPAM", Type: "system"}, {ID: "UNREAD", Name: "UNREAD", Type: "system"},
			{ID: "STARRED", Name: "STARRED", Type: "system"}, {ID: "IMPORTANT", Name: "IMPORTANT", Type: "system"},
			{ID: "CATEGORY_PERSONAL", Name: "CATEGORY_PERSONAL", Type: "system"},
		},
		rawGets:     map[string]int{},
		minimalGets: map[string]int{},
	}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeGmail) addLabel(id, name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.labels = append(f.labels, label{ID: id, Name: name, Type: "user"})
}

// add puts a message in the mailbox; received orders messages (higher is newer). It records history unless quiet.
func (f *fakeGmail) add(id string, received int64, raw []byte, labels ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.messages[id] = &fakeMessage{id: id, raw: raw, labels: labels, received: received}
	f.record(historyRecord{MessagesAdded: []struct {
		Message historyMessage `json:"message"`
	}{{Message: historyMessage{ID: id, LabelIDs: labels}}}})
}

func (f *fakeGmail) addLabels(id string, labels ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	m := f.messages[id]
	for _, l := range labels {
		if !slices.Contains(m.labels, l) {
			m.labels = append(m.labels, l)
		}
	}
	f.record(historyRecord{LabelsAdded: []labelChange{{Message: historyMessage{ID: id}, LabelIDs: labels}}})
}

func (f *fakeGmail) removeLabels(id string, labels ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	m := f.messages[id]
	m.labels = slices.DeleteFunc(m.labels, func(l string) bool { return slices.Contains(labels, l) })
	f.record(historyRecord{LabelsRemoved: []labelChange{{Message: historyMessage{ID: id}, LabelIDs: labels}}})
}

// remove deletes a message; quiet leaves no history, as if the history had expired meanwhile.
func (f *fakeGmail) remove(id string, quiet bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.messages, id)
	if !quiet {
		f.record(historyRecord{MessagesDeleted: []struct {
			Message historyMessage `json:"message"`
		}{{Message: historyMessage{ID: id}}}})
	}
}

func (f *fakeGmail) record(r historyRecord) {
	f.historyID++
	f.history = append(f.history, fakeRecord{id: f.historyID, record: r})
}

func (f *fakeGmail) expireHistory() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.expiredBefore = f.historyID
}

func (f *fakeGmail) fail(status int, body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failNext, f.failBody = status, body
}

func (f *fakeGmail) gets(id string) (raw, minimal int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.rawGets[id], f.minimalGets[id]
}

func (f *fakeGmail) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if r.Header.Get("Authorization") != "Bearer "+f.token {
		f.authRejected++
		writeError(w, http.StatusUnauthorized, `{"error":{"code":401,"status":"UNAUTHENTICATED"}}`)
		return
	}
	if f.failNext != 0 {
		status, body := f.failNext, f.failBody
		f.failNext = 0
		writeError(w, status, body)
		return
	}

	q := r.URL.Query()
	path := r.URL.Path
	switch {
	case r.Method == http.MethodPost && (path == "/gmail/v1/users/me/messages/send" || path == "/upload/gmail/v1/users/me/messages/send"):
		body, _ := io.ReadAll(r.Body)
		f.sent = append(f.sent, sentRequest{path: path + "?" + r.URL.RawQuery, contentType: r.Header.Get("Content-Type"), raw: body})
		raw, threadID := f.decodeMessage(r.Header.Get("Content-Type"), body, false)
		m := f.store(raw, threadID, "SENT")
		writeJSON(w, map[string]string{"id": m.id, "threadId": m.threadID()})
	case r.Method == http.MethodPost && (path == "/gmail/v1/users/me/drafts" || path == "/upload/gmail/v1/users/me/drafts"):
		body, _ := io.ReadAll(r.Body)
		f.sent = append(f.sent, sentRequest{path: path + "?" + r.URL.RawQuery, contentType: r.Header.Get("Content-Type"), raw: body})
		raw, threadID := f.decodeMessage(r.Header.Get("Content-Type"), body, true)
		m := f.store(raw, threadID, "DRAFT")
		f.nextID++
		draftID := "r" + strconv.Itoa(f.nextID)
		if f.drafts == nil {
			f.drafts = map[string]string{}
		}
		f.drafts[draftID] = m.id
		writeJSON(w, map[string]any{"id": draftID, "message": map[string]string{"id": m.id, "threadId": m.threadID()}})
	case r.Method == http.MethodGet && path == "/gmail/v1/users/me/drafts":
		var out []map[string]any
		ids := make([]string, 0, len(f.drafts))
		for id := range f.drafts {
			ids = append(ids, id)
		}
		// Newest first, as Gmail lists them.
		slices.SortFunc(ids, func(a, b string) int {
			if c := f.messages[f.drafts[b]].received - f.messages[f.drafts[a]].received; c != 0 {
				return int(c)
			}
			return strings.Compare(b, a)
		})
		f.draftLists++
		for _, id := range ids {
			m := f.messages[f.drafts[id]]
			if want, ok := strings.CutPrefix(q.Get("q"), "rfc822msgid:"); ok && providersend.HeaderValue(m.raw, "Message-ID") != "<"+want+">" {
				continue
			}
			if after, ok := strings.CutPrefix(q.Get("q"), "after:"); ok {
				if seconds, _ := strconv.ParseInt(after, 10, 64); m.received < seconds*1000 {
					continue
				}
			}
			out = append(out, map[string]any{"id": id, "message": map[string]string{"id": m.id}})
		}
		writeJSON(w, map[string]any{"drafts": out})
	case r.Method == http.MethodDelete && strings.HasPrefix(path, "/gmail/v1/users/me/drafts/"):
		id := strings.TrimPrefix(path, "/gmail/v1/users/me/drafts/")
		messageID, ok := f.drafts[id]
		if !ok {
			writeError(w, http.StatusNotFound, `{"error":{"code":404}}`)
			return
		}
		delete(f.drafts, id)
		delete(f.messages, messageID)
		w.WriteHeader(http.StatusNoContent)
	case path == "/gmail/v1/users/me/profile":
		writeJSON(w, map[string]string{"emailAddress": "kim@example.test", "historyId": strconv.Itoa(f.historyID)})
	case path == "/gmail/v1/users/me/labels":
		writeJSON(w, map[string]any{"labels": f.labels})
	case path == "/gmail/v1/users/me/messages":
		f.list(w, q)
	case r.Method == http.MethodPost && strings.HasPrefix(path, "/gmail/v1/users/me/messages/"):
		id, action, _ := strings.Cut(strings.TrimPrefix(path, "/gmail/v1/users/me/messages/"), "/")
		m, ok := f.messages[id]
		if !ok {
			writeError(w, http.StatusNotFound, `{"error":{"code":404}}`)
			return
		}
		var add, remove []string
		switch action {
		case "modify":
			var in struct{ AddLabelIds, RemoveLabelIds []string }
			_ = json.NewDecoder(r.Body).Decode(&in)
			add, remove = in.AddLabelIds, in.RemoveLabelIds
		case "trash":
			add, remove = []string{"TRASH"}, []string{"INBOX"}
		default:
			f.t.Errorf("unexpected message action %s", action)
		}
		m.labels = slices.DeleteFunc(m.labels, func(l string) bool { return slices.Contains(remove, l) })
		m.labels = append(m.labels, add...)
		if len(add) > 0 {
			f.record(historyRecord{LabelsAdded: []labelChange{{Message: historyMessage{ID: id}, LabelIDs: add}}})
		}
		if len(remove) > 0 {
			f.record(historyRecord{LabelsRemoved: []labelChange{{Message: historyMessage{ID: id}, LabelIDs: remove}}})
		}
		writeJSON(w, map[string]any{"id": id, "labelIds": m.labels})
	case strings.HasPrefix(path, "/gmail/v1/users/me/messages/"):
		id := strings.TrimPrefix(path, "/gmail/v1/users/me/messages/")
		m, ok := f.messages[id]
		if !ok {
			writeError(w, http.StatusNotFound, `{"error":{"code":404,"message":"Requested entity was not found."}}`)
			return
		}
		out := map[string]any{"id": m.id, "threadId": m.threadID(), "labelIds": m.labels, "internalDate": strconv.FormatInt(m.received, 10)}
		if q.Get("format") == "metadata" {
			f.metadataGets++
			var headers []map[string]string
			for _, name := range q["metadataHeaders"] {
				if value := providersend.HeaderValue(m.raw, name); value != "" {
					headers = append(headers, map[string]string{"name": name, "value": value})
				}
			}
			out["payload"] = map[string]any{"headers": headers}
		}
		if q.Get("format") == "raw" {
			f.rawGets[id]++
			refusal, refused := f.refuseRaw[id]
			if !refused && f.refuseAllRaw[0] != "" {
				refusal, refused = f.refuseAllRaw, true
			}
			if refused {
				status, _ := strconv.Atoi(refusal[0])
				writeError(w, status, refusal[1])
				return
			}
			out["raw"] = base64.URLEncoding.EncodeToString(m.raw)
		} else {
			f.minimalGets[id]++
		}
		writeJSON(w, out)
	case path == "/gmail/v1/users/me/history":
		start, _ := strconv.Atoi(q.Get("startHistoryId"))
		if start < f.expiredBefore {
			writeError(w, http.StatusNotFound, `{"error":{"code":404,"message":"Requested entity was not found."}}`)
			return
		}
		var records []historyRecord
		for _, h := range f.history {
			if h.id > start {
				records = append(records, h.record)
			}
		}
		// One record per page, to exercise paging.
		offset, _ := strconv.Atoi(q.Get("pageToken"))
		page := map[string]any{"historyId": strconv.Itoa(f.historyID)}
		if offset < len(records) {
			page["history"] = records[offset : offset+1]
			if offset+1 < len(records) {
				page["nextPageToken"] = strconv.Itoa(offset + 1)
			}
		}
		writeJSON(w, page)
	default:
		f.t.Errorf("unexpected request %s %s", r.Method, r.URL)
		http.NotFound(w, r)
	}
}

// list answers messages.list newest first, filtered by one label, without Trash and Spam unless asked for.
func (f *fakeGmail) list(w http.ResponseWriter, q map[string][]string) {
	get := func(name string) string {
		if v := q[name]; len(v) > 0 {
			return v[0]
		}
		return ""
	}
	var all []*fakeMessage
	for _, m := range f.messages {
		search := get("q")
		if id, ok := strings.CutPrefix(search, "rfc822msgid:"); ok && providersend.HeaderValue(m.raw, "Message-ID") != "<"+id+">" {
			continue
		}
		// in:sent never finds a sent copy in Trash, even with includeSpamTrash; from:me does.
		if rest, ok := strings.CutPrefix(search, "in:sent after:"); ok {
			after, recipients, _ := strings.Cut(rest, " ")
			seconds, _ := strconv.ParseInt(after, 10, 64)
			if !slices.Contains(m.labels, "SENT") || slices.Contains(m.labels, "TRASH") || m.received < seconds*1000 {
				continue
			}
			if recipients != "" && !f.sentTo(m, recipients) {
				continue
			}
		}
		if rest, ok := strings.CutPrefix(search, "from:me after:"); ok {
			after, narrowing, _ := strings.Cut(rest, " ")
			seconds, _ := strconv.ParseInt(after, 10, 64)
			if !slices.Contains(m.labels, "SENT") || m.received < seconds*1000 {
				continue
			}
			group, subject, _ := strings.Cut(narrowing, ` subject:"`)
			if group != "" && !f.sentTo(m, group) {
				continue
			}
			// Gmail matches a subject by its words: a term without any matches nothing.
			if subject = strings.TrimSuffix(subject, `"`); subject != "" && (!hasWord(subject) || !strings.Contains(strings.ToLower(providersend.HeaderValue(m.raw, "Subject")), strings.ToLower(subject))) {
				continue
			}
		}
		// Gmail lists chats unless the query leaves them out.
		if search == "-in:chats" && slices.Contains(m.labels, "CHAT") {
			continue
		}
		if labelID := get("labelIds"); labelID != "" && !slices.Contains(m.labels, labelID) {
			continue
		}
		hidden := slices.Contains(m.labels, "TRASH") || slices.Contains(m.labels, "SPAM")
		if hidden && get("includeSpamTrash") != "true" {
			continue
		}
		all = append(all, m)
	}
	slices.SortFunc(all, func(a, b *fakeMessage) int { return int(b.received - a.received) })

	// A page token is the receive time of the last message listed, so mail arriving meanwhile does not shift pages.
	if token := get("pageToken"); token != "" {
		before, _ := strconv.ParseInt(token, 10, 64)
		all = slices.DeleteFunc(all, func(m *fakeMessage) bool { return m.received >= before })
	}
	size, _ := strconv.Atoi(get("maxResults"))
	end := min(size, len(all))
	ids := []map[string]string{}
	for _, m := range all[:end] {
		ids = append(ids, map[string]string{"id": m.id, "threadId": m.threadID()})
	}
	out := map[string]any{"messages": ids}
	if end < len(all) {
		out["nextPageToken"] = strconv.FormatInt(all[end-1].received, 10)
	}
	writeJSON(w, out)
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

// decodeMessage reads what messages.send or drafts.create got: JSON with base64url raw, or a multipart upload of JSON
// metadata and the message. draft says the metadata is wrapped as {"message": ...}.
func (f *fakeGmail) decodeMessage(contentType string, body []byte, draft bool) (raw []byte, threadID string) {
	type message struct {
		Raw      string `json:"raw"`
		ThreadID string `json:"threadId"`
	}
	decodeMeta := func(data []byte) message {
		var m message
		if draft {
			var wrapped struct{ Message message }
			_ = json.Unmarshal(data, &wrapped)
			return wrapped.Message
		}
		_ = json.Unmarshal(data, &m)
		return m
	}
	mediaType, params, _ := mime.ParseMediaType(contentType)
	if mediaType != "multipart/related" {
		m := decodeMeta(body)
		raw, _ = base64.URLEncoding.DecodeString(m.Raw)
		return raw, m.ThreadID
	}
	reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	meta, err := reader.NextPart()
	if err != nil {
		f.t.Fatalf("multipart upload: %v", err)
	}
	metadata, _ := io.ReadAll(meta)
	part, err := reader.NextPart()
	if err != nil || part.Header.Get("Content-Type") != "message/rfc822" {
		f.t.Fatalf("multipart upload without the message: %v", err)
	}
	raw, _ = io.ReadAll(part)
	return raw, decodeMeta(metadata).ThreadID
}

// store keeps a sent message or draft. With rewriteIDs it gets a Message-ID of the fake's own.
func (f *fakeGmail) store(raw []byte, threadID, label string) *fakeMessage {
	f.nextID++
	id := "g" + strconv.Itoa(f.nextID)
	if f.rewriteIDs {
		replaced, err := providersend.SetHeader(raw, "Message-ID", "<"+id+"@mail.gmail.com>")
		if err != nil {
			f.t.Fatal(err)
		}
		raw = replaced
	}
	m := &fakeMessage{id: id, raw: raw, labels: []string{label}, received: time.Now().UnixMilli(), thread: threadID}
	f.messages[id] = m
	return m
}

// sentTo reports whether m was sent to the address of a ` {to:"x" cc:"x" bcc:"x"}` search group.
func (f *fakeGmail) sentTo(m *fakeMessage, group string) bool {
	start := strings.Index(group, `to:"`)
	if start < 0 {
		f.t.Errorf("unexpected recipient search %q", group)
		return false
	}
	address := group[start+4:]
	address = address[:strings.IndexByte(address, '"')]
	for _, header := range []string{"To", "Cc", "Bcc"} {
		if strings.Contains(strings.ToLower(providersend.HeaderValue(m.raw, header)), strings.ToLower(address)) {
			return true
		}
	}
	return false
}

// addDraft files a draft directly, received at ms.
func (f *fakeGmail) addDraft(raw []byte, ms int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	m := f.store(raw, "", "DRAFT")
	m.received = ms
	f.nextID++
	if f.drafts == nil {
		f.drafts = map[string]string{}
	}
	f.drafts["r"+strconv.Itoa(f.nextID)] = m.id
}

// addSent puts a sent message in the mailbox directly, received at ms.
func (f *fakeGmail) addSent(raw []byte, ms int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	m := f.store(raw, "", "SENT")
	m.received = ms
}

func hasWord(s string) bool {
	return strings.ContainsFunc(s, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) })
}
