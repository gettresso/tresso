package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The real routes behind protect: every case below is answered before the handlers need WhatsApp or the store.
func protectedAPI(token string) http.Handler {
	return protect(newRESTHandler(nil, nil), token, 8741)
}

func ptr(s string) *string { return &s }

// Contract points 3 to 6 of docs/whatsapp-bridge.md: host, token, content type, probe.
func TestProtect(t *testing.T) {
	const j = "application/json"
	cases := []struct {
		name, method, target, host, token string
		contentType                       *string
		body                              string
		want                              int
		wantBody                          string
	}{
		{"probe without token", "POST", "/api/send", "127.0.0.1:8741", "", ptr(j), "{}", 401, "Unauthorized\n"},
		{"probe with token and JSON", "POST", "/api/send", "127.0.0.1:8741", testToken, ptr(j), "{}", 400, "Recipient is required\n"},
		{"download probe with token and JSON", "POST", "/api/download", "127.0.0.1:8741", testToken, ptr(j), "{}", 400, "Message ID and Chat JID are required\n"},
		{"localhost host", "POST", "/api/send", "localhost:8741", testToken, ptr(j), "{}", 400, "Recipient is required\n"},
		{"host in upper case", "POST", "/api/send", "LOCALHOST:8741", testToken, ptr(j), "{}", 400, "Recipient is required\n"},

		{"wrong host with token", "POST", "/api/send", "evil.example:8741", testToken, ptr(j), "{}", 403, "Forbidden host\n"},
		{"wrong host without token", "POST", "/api/send", "evil.example", "", ptr(j), "{}", 403, "Forbidden host\n"},
		{"wrong port in host", "POST", "/api/send", "127.0.0.1:8080", testToken, ptr(j), "{}", 403, "Forbidden host\n"},
		{"host without port", "POST", "/api/send", "127.0.0.1", testToken, ptr(j), "{}", 403, "Forbidden host\n"},
		{"host with trailing dot", "POST", "/api/send", "localhost.:8741", testToken, ptr(j), "{}", 403, "Forbidden host\n"},
		{"IPv6 loopback host", "POST", "/api/send", "[::1]:8741", testToken, ptr(j), "{}", 403, "Forbidden host\n"},
		{"wrong host on another path", "GET", "/", "evil.example:8741", "", nil, "", 403, "Forbidden host\n"},

		{"wrong token of the same length", "POST", "/api/send", "127.0.0.1:8741", strings.Repeat("f", 64), ptr(j), "{}", 401, "Unauthorized\n"},
		{"wrong token, shorter", "POST", "/api/send", "127.0.0.1:8741", testToken[:10], ptr(j), "{}", 401, "Unauthorized\n"},
		{"wrong token, longer", "POST", "/api/send", "127.0.0.1:8741", testToken + "0", ptr(j), "{}", 401, "Unauthorized\n"},
		{"token in the query string only", "POST", "/api/send?X-Bridge-Token=" + testToken + "&token=" + testToken, "127.0.0.1:8741", "", ptr(j), "{}", 401, "Unauthorized\n"},
		{"no token and text/plain: token first", "POST", "/api/send", "127.0.0.1:8741", "", ptr("text/plain"), "{}", 401, "Unauthorized\n"},

		{"text/plain", "POST", "/api/send", "127.0.0.1:8741", testToken, ptr("text/plain"), "{}", 415, ""},
		{"form", "POST", "/api/send", "127.0.0.1:8741", testToken, ptr("application/x-www-form-urlencoded"), "{}", 415, ""},
		{"no content type", "POST", "/api/send", "127.0.0.1:8741", testToken, nil, "{}", 415, ""},
		{"JSON look-alike", "POST", "/api/send", "127.0.0.1:8741", testToken, ptr("application/jsonx"), "{}", 415, ""},
		{"JSON with charset", "POST", "/api/send", "127.0.0.1:8741", testToken, ptr("application/json; charset=utf-8"), "{}", 400, "Recipient is required\n"},
		{"JSON in mixed case", "POST", "/api/send", "127.0.0.1:8741", testToken, ptr("Application/JSON"), "{}", 400, "Recipient is required\n"},
		{"GET with JSON", "GET", "/api/send", "127.0.0.1:8741", testToken, ptr(j), "", 405, ""},

		{"OPTIONS preflight without token", "OPTIONS", "/api/send", "127.0.0.1:8741", "", nil, "", 401, "Unauthorized\n"},
		{"unknown path without token", "POST", "/nope", "127.0.0.1:8741", "", ptr(j), "{}", 401, "Unauthorized\n"},
		{"unknown path with token", "POST", "/nope", "127.0.0.1:8741", testToken, ptr(j), "{}", 404, ""},
	}
	handler := protectedAPI(testToken)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.target, strings.NewReader(tc.body))
			r.Host = tc.host
			if tc.token != "" {
				r.Header.Set("X-Bridge-Token", tc.token)
			}
			if tc.contentType != nil {
				r.Header.Set("Content-Type", *tc.contentType)
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.want || (tc.wantBody != "" && w.Body.String() != tc.wantBody) {
				t.Errorf("got %d %q, want %d %q", w.Code, w.Body.String(), tc.want, tc.wantBody)
			}
			if origin := w.Header().Get("Access-Control-Allow-Origin"); origin != "" {
				t.Errorf("CORS header set: %q", origin)
			}
		})
	}
}

// There is no mode without a token: protect given an empty one lets nothing through, an empty header included (a
// constant-time compare of two empty strings would say they match).
func TestProtectWithoutTokenRefusesEverything(t *testing.T) {
	handler := protectedAPI("")
	for _, header := range []*string{nil, ptr(""), ptr(testToken)} {
		r := httptest.NewRequest(http.MethodPost, "/api/send", strings.NewReader("{}"))
		r.Host = "127.0.0.1:8741"
		r.Header.Set("Content-Type", "application/json")
		if header != nil {
			r.Header["X-Bridge-Token"] = []string{*header}
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("token header %v: got %d %q, want 401", header, w.Code, w.Body.String())
		}
	}
}

func TestRequestBodyLimit(t *testing.T) {
	handler := newRESTHandler(nil, nil)
	for _, path := range []string{"/api/send", "/api/download"} {
		big := `{"recipient":"` + strings.Repeat("a", maxRequestBody) + `"}`
		r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(big))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("%s with a body over 1 MiB: got %d %q, want 413", path, w.Code, w.Body.String())
		}

		r = httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}"))
		w = httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s with an empty JSON object: got %d %q, want 400", path, w.Code, w.Body.String())
		}
	}
}

// Contract points 2 and 6 over a real socket: the API binds 127.0.0.1 only, and the probe answers 401 without the
// token and 400 Recipient is required with it, as the desktop app's probe expects.
func TestServerBindsLoopbackAndAnswersTheProbe(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()

	listener, err = listenREST(port)
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().(*net.TCPAddr)
	if !address.IP.Equal(net.IPv4(127, 0, 0, 1)) || address.Port != port {
		t.Fatalf("listens on %v, want 127.0.0.1:%d", address, port)
	}
	server := newRESTServer(protect(newRESTHandler(nil, nil), testToken, port))
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })

	// Nothing listens on the other addresses of this computer for that port.
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			ip, _, _ := net.ParseCIDR(a.String())
			if ip == nil || ip.IsLoopback() || ip.To4() == nil {
				continue
			}
			if conn, err := net.DialTimeout("tcp4", net.JoinHostPort(ip.String(), fmt.Sprint(port)), 300*time.Millisecond); err == nil {
				conn.Close()
				t.Errorf("the API answers on %s", ip)
			}
		}
	}

	client := &http.Client{Timeout: 5 * time.Second}
	probe := func(token string) (int, string) {
		r, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/api/send", port), strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set("X-Bridge-Token", token)
		}
		response, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, _ := io.ReadAll(response.Body)
		return response.StatusCode, string(body)
	}
	if status, body := probe(""); status != 401 || body != "Unauthorized\n" {
		t.Errorf("probe without token: %d %q", status, body)
	}
	if status, body := probe(testToken); status != 400 || body != "Recipient is required\n" {
		t.Errorf("probe with token: %d %q", status, body)
	}
}

// Contract point 7: a stored name keeps only its last part, ".." and the like are refused, a chat JID with a path in
// it is refused, and the file lands in <store>/<chat>/<message id>_<name>.
func TestDownloadNames(t *testing.T) {
	store := testStore(t)
	chat := "31612345678@s.whatsapp.net"
	when := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	if err := store.StoreChat(chat, "A chat", when); err != nil {
		t.Fatal(err)
	}
	data := []byte("the document")
	sum := sha256.Sum256(data)
	stored := func(id, name string) {
		t.Helper()
		if err := store.StoreMessage(id, chat, "31612345678", "", when, false, "document", name, "https://mmg.whatsapp.net/v/x.enc", []byte{1}, sum[:], sum[:], uint64(len(data))); err != nil {
			t.Fatal(err)
		}
	}
	stored("3EB0AAAA", "../../Library/LaunchAgents/x.plist")
	stored("3EB0BBBB", "..")
	stored("3EB0CCCC", "/")

	// A file downloaded before with the right hash is handed back without WhatsApp: the client stays nil.
	chatDir := filepath.Join(store.dir, chat)
	if err := os.MkdirAll(chatDir, 0o700); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(chatDir, "3EB0AAAA_x.plist")
	if err := writePrivateFile(want, data); err != nil {
		t.Fatal(err)
	}
	ok, mediaType, filename, path, err := downloadMedia(context.Background(), nil, store, "3EB0AAAA", chat)
	if !ok || err != nil || mediaType != "document" || filename != "x.plist" || path != want || !filepath.IsAbs(path) {
		t.Errorf("download: %v %q %q %q %v", ok, mediaType, filename, path, err)
	}
	if !strings.HasPrefix(path, store.dir+string(filepath.Separator)) {
		t.Errorf("path %q is not inside the store %q", path, store.dir)
	}

	for _, id := range []string{"3EB0BBBB", "3EB0CCCC"} {
		if ok, _, _, _, err := downloadMedia(context.Background(), nil, store, id, chat); ok || err == nil || err.Error() != "invalid file name" {
			t.Errorf("%s: got %v, %v; want invalid file name", id, ok, err)
		}
	}
	for _, jid := range []string{"../x@s.whatsapp.net", "a/b@s.whatsapp.net", "a\\b@s.whatsapp.net", "x@g.us/.."} {
		if ok, _, _, _, err := downloadMedia(context.Background(), nil, store, "3EB0AAAA", jid); ok || err == nil || err.Error() != "invalid chat JID" {
			t.Errorf("%q: got %v, %v; want invalid chat JID", jid, ok, err)
		}
	}
	if ok, _, _, _, err := downloadMedia(context.Background(), nil, store, "../3EB0AAAA", chat); ok || err == nil {
		t.Errorf("a message ID with a path was accepted")
	}

	// The same through the API, as the desktop app asks for it.
	handler := protect(newRESTHandler(nil, store), testToken, 8741)
	r := httptest.NewRequest(http.MethodPost, "/api/download", strings.NewReader(`{"message_id":"3EB0AAAA","chat_jid":"`+chat+`"}`))
	r.Host = "127.0.0.1:8741"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Bridge-Token", testToken)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	var answer DownloadMediaResponse
	if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil || w.Code != 200 || !answer.Success || answer.Path != want {
		t.Errorf("API download: %d %q", w.Code, w.Body.String())
	}
}
