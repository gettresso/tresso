package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
)

// fakeLogout replaces whatsmeow's Logout for one test: it answers with answer(ctx) and counts its calls.
func fakeLogout(t *testing.T, answer func(ctx context.Context) error) *atomic.Int32 {
	t.Helper()
	saved := logout
	var calls atomic.Int32
	logout = func(_ *whatsmeow.Client, ctx context.Context) error {
		calls.Add(1)
		return answer(ctx)
	}
	t.Cleanup(func() { logout = saved })
	return &calls
}

func logoutRequest(host, token, contentType, body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/logout", strings.NewReader(body))
	r.Host = host
	if token != "" {
		r.Header.Set("X-Bridge-Token", token)
	}
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	return r
}

// The log out route keeps the rules of every route: host first, then the token, then the content type, and nothing
// reaches whatsmeow before all three held.
func TestLogoutRouteRules(t *testing.T) {
	calls := fakeLogout(t, func(context.Context) error { return nil })
	var ended atomic.Int32
	handler := protect(newRESTHandler(nil, nil, func() { ended.Add(1) }), testToken, 8741)
	cases := []struct {
		name                     string
		host, token, contentType string
		method, body             string
		want                     int
	}{
		{"another host", "evil.example:8741", testToken, "application/json", http.MethodPost, "{}", 403},
		{"no token", "127.0.0.1:8741", "", "application/json", http.MethodPost, "{}", 401},
		{"wrong token", "127.0.0.1:8741", strings.Repeat("f", 64), "application/json", http.MethodPost, "{}", 401},
		{"not JSON", "127.0.0.1:8741", testToken, "text/plain", http.MethodPost, "{}", 415},
		{"GET", "127.0.0.1:8741", testToken, "application/json", http.MethodGet, "", 405},
		{"no body", "127.0.0.1:8741", testToken, "application/json", http.MethodPost, "", 400},
		{"not an object", "127.0.0.1:8741", testToken, "application/json", http.MethodPost, "[]", 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := logoutRequest(tc.host, tc.token, tc.contentType, tc.body)
			r.Method = tc.method
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Errorf("got %d %q, want %d", w.Code, w.Body.String(), tc.want)
			}
		})
	}
	if calls.Load() != 0 || ended.Load() != 0 {
		t.Errorf("a refused request reached whatsmeow (%d) or ended the bridge (%d)", calls.Load(), ended.Load())
	}
}

func TestLogoutConfirmed(t *testing.T) {
	var deadline time.Time
	calls := fakeLogout(t, func(ctx context.Context) error {
		deadline, _ = ctx.Deadline()
		return nil
	})
	var ended atomic.Int32
	handler := protect(newRESTHandler(nil, nil, func() { ended.Add(1) }), testToken, 8741)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, logoutRequest("127.0.0.1:8741", testToken, "application/json", "{}"))
	after := time.Now()
	if w.Code != http.StatusOK {
		t.Fatalf("got %d %q, want 200", w.Code, w.Body.String())
	}
	var answer LogoutResponse
	if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil || !answer.Success {
		t.Errorf("answer %q (%v)", w.Body.String(), err)
	}
	if calls.Load() != 1 || ended.Load() != 1 {
		t.Errorf("logout called %d times, the bridge ended %d times; want 1 and 1", calls.Load(), ended.Load())
	}
	if left := deadline.Sub(after); left <= 0 || left > logoutTimeout {
		t.Errorf("the log out had %v to finish, want at most %v", left, logoutTimeout)
	}
}

// After WhatsApp confirmed, a session the store could not delete is still a log out: the desktop app removes the
// whole store anyway.
func TestLogoutConfirmedWhenOnlyTheLocalDeleteFails(t *testing.T) {
	fakeLogout(t, func(context.Context) error {
		return fmt.Errorf("%s: %w", storeDeleteError, errors.New("disk I/O error"))
	})
	var ended atomic.Int32
	handler := protect(newRESTHandler(nil, nil, func() { ended.Add(1) }), testToken, 8741)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, logoutRequest("127.0.0.1:8741", testToken, "application/json", "{}"))
	if w.Code != http.StatusOK || ended.Load() != 1 {
		t.Errorf("got %d %q, ended %d; want 200 and an end", w.Code, w.Body.String(), ended.Load())
	}
}

// Every failure before WhatsApp's confirmation keeps the bridge running and answers with a fixed text, never with
// whatsmeow's own (it can hold the device's JID).
func TestLogoutFailures(t *testing.T) {
	cases := []struct {
		name    string
		err     error
		status  int
		message string
	}{
		{"not linked", whatsmeow.ErrNotLoggedIn, 409, "Not linked"},
		{"not connected", fmt.Errorf("error sending logout request: %w", whatsmeow.ErrNotConnected), 503, "Not connected to WhatsApp"},
		{"no answer", fmt.Errorf("error sending logout request: %w", whatsmeow.ErrIQTimedOut), 504, "WhatsApp did not confirm the log out in time"},
		{"refused", fmt.Errorf("error sending logout request: %w", &whatsmeow.IQError{Code: 401, Text: "not-authorized"}), 502, "WhatsApp refused the log out"},
		{"other", errors.New("error sending logout request: 12345:6@s.whatsapp.net went away"), 502, "The log out could not be sent to WhatsApp"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fakeLogout(t, func(context.Context) error { return tc.err })
			var ended atomic.Int32
			handler := protect(newRESTHandler(nil, nil, func() { ended.Add(1) }), testToken, 8741)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, logoutRequest("127.0.0.1:8741", testToken, "application/json", "{}"))
			var answer LogoutResponse
			_ = json.Unmarshal(w.Body.Bytes(), &answer)
			if w.Code != tc.status || answer.Success || answer.Message != tc.message {
				t.Errorf("got %d %q, want %d %q", w.Code, w.Body.String(), tc.status, tc.message)
			}
			if bytes.Contains(w.Body.Bytes(), []byte("s.whatsapp.net")) {
				t.Errorf("the answer quotes whatsmeow: %q", w.Body.String())
			}
			if ended.Load() != 0 {
				t.Errorf("a failed log out ended the bridge")
			}
		})
	}
}

// A WhatsApp that never answers: the request ends with 504 once the log out's own deadline passed.
func TestLogoutTimeout(t *testing.T) {
	fakeLogout(t, func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	})
	var ended atomic.Int32
	handler := protect(newRESTHandler(nil, nil, func() { ended.Add(1) }), testToken, 8741)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(w, logoutRequest("127.0.0.1:8741", testToken, "application/json", "{}").WithContext(ctx))
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the log out did not end with its deadline")
	}
	if w.Code != http.StatusGatewayTimeout || ended.Load() != 0 {
		t.Errorf("got %d %q, ended %d; want 504 and no end", w.Code, w.Body.String(), ended.Load())
	}
}

// The phone's log out and the route's end the bridge once: one logged_out event.
func TestLoggedOutOnce(t *testing.T) {
	var out bytes.Buffer
	em := newEmitter(&out)
	var stops atomic.Int32
	end := onceLoggedOut(em, func() { stops.Add(1) })
	end()
	end()
	if got := out.String(); got != "{\"v\":1,\"event\":\"logged_out\"}\n" || stops.Load() != 1 {
		t.Errorf("events %q, stops %d", got, stops.Load())
	}
}
