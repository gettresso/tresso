package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLeaseSendsWorkerAndDecodesAccounts(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/internal/sync/leases" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["workerId"] != "w1" || body["capacity"] != float64(5) {
			t.Errorf("unexpected body %v", body)
		}
		_, _ = w.Write([]byte(`{"leaseSeconds":90,"accounts":[{"id":"x","emailAddress":"a@b.c","provider":"imap","leaseExpiresAt":"2026-10-18T21:36:09+00:00"}]}`))
	}))
	defer srv.Close()

	resp, err := NewWithHTTPClient(srv.URL+"/", srv.Client()).Lease(context.Background(), "w1", 5)
	if err != nil {
		t.Fatal(err)
	}
	if resp.LeaseSeconds != 90 || len(resp.Accounts) != 1 || resp.Accounts[0].Provider != "imap" {
		t.Fatalf("unexpected response %+v", resp)
	}
}

func TestErrorStatusIsReported(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusForbidden)
	}))
	defer srv.Close()

	err := NewWithHTTPClient(srv.URL, srv.Client()).Release(context.Background(), "w1")
	if err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("expected a 403 error, got %v", err)
	}
}

func TestCredentialsSendsWorkerAndDecodes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/internal/sync/accounts/acc-1/credentials" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if r.URL.Query().Get("workerId") != "w 1" {
			t.Errorf("workerId not sent: %q", r.URL.RawQuery)
		}
		if r.Header.Get("Content-Type") != "" {
			t.Errorf("GET must not send a body content type")
		}
		_, _ = w.Write([]byte(`{"accountId":"acc-1","emailAddress":"kim@example.test","provider":"imap",` +
			`"connection":{"imap":{"host":"imap.example.test","port":993,"security":"tls"},"smtp":{"host":"smtp.example.test","port":465,"security":"tls"},"username":"kim"},` +
			`"credentials":{"type":"password","password":"s3cret"}}`))
	}))
	defer srv.Close()

	creds, err := NewWithHTTPClient(srv.URL, srv.Client()).Credentials(context.Background(), "acc-1", "w 1")
	if err != nil {
		t.Fatal(err)
	}
	if creds.Connection.IMAP.Port != 993 || creds.Connection.Username != "kim" || creds.Provider != "imap" {
		t.Fatalf("unexpected credentials %+v", creds)
	}
	password, err := creds.Password()
	if err != nil || password != "s3cret" {
		t.Fatalf("password = %q, %v", password, err)
	}
}

func TestPasswordRequiresPasswordCredentials(t *testing.T) {
	_, err := Credentials{AccountID: "a", Secrets: map[string]string{"type": "oauth"}}.Password()
	if err == nil {
		t.Fatal("expected an error for non-password credentials")
	}
}

func TestCredentialsNotLeasedIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "not leased", http.StatusNotFound)
	}))
	defer srv.Close()

	_, err := NewWithHTTPClient(srv.URL, srv.Client()).Credentials(context.Background(), "acc-1", "w1")
	if err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("expected a 404 error, got %v", err)
	}
}

func TestIngestCallsSendArraysNotNull(t *testing.T) {
	var bodies []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(b))
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	c := NewWithHTTPClient(srv.URL, srv.Client())

	_, _ = c.Messages(context.Background(), "a", MessageBatch{WorkerID: "w", Folder: "INBOX", Messages: []Message{{RemoteUID: "1"}}})
	_, _ = c.Changes(context.Background(), "a", ChangeBatch{WorkerID: "w", Folder: "INBOX", Presence: []PresenceRange{{FromUID: 1, ToUID: 2}}})

	for _, body := range bodies {
		if strings.Contains(body, "null") && !strings.Contains(body, `"cursor":null`) {
			t.Errorf("body contains null: %s", body)
		}
	}
	if !strings.Contains(bodies[0], `"references":[]`) || !strings.Contains(bodies[1], `"uids":[]`) || !strings.Contains(bodies[1], `"vanished":[]`) {
		t.Errorf("empty arrays missing: %v", bodies)
	}
}

func TestRevokedTokenIsReplacedAndTheRequestRetried(t *testing.T) {
	var issued, rejected int
	mux := http.NewServeMux()
	mux.HandleFunc("POST /oauth/token", func(w http.ResponseWriter, _ *http.Request) {
		issued++
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"access_token":"token-%d","token_type":"Bearer","expires_in":3600}`, issued)
	})
	mux.HandleFunc("POST /internal/sync/leases", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Header.Get("Authorization") == "Bearer token-1" {
			rejected++
			http.Error(w, "revoked", http.StatusUnauthorized)
			return
		}
		if !strings.Contains(string(body), `"workerId":"w1"`) {
			t.Errorf("retried request lost its body: %s", body)
		}
		_, _ = w.Write([]byte(`{"leaseSeconds":90,"accounts":[]}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := New(context.Background(), srv.URL, srv.URL+"/oauth/token", "sync-worker", "secret")
	if _, err := client.Lease(context.Background(), "w1", 10); err != nil {
		t.Fatal(err)
	}
	if issued != 2 || rejected != 1 {
		t.Errorf("issued %d tokens, %d rejected; want a fresh token after one rejection", issued, rejected)
	}

	// A second rejection with the fresh token is reported, not retried forever.
	mux2 := http.NewServeMux()
	mux2.HandleFunc("POST /oauth/token", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"x","token_type":"Bearer","expires_in":3600}`))
	})
	mux2.HandleFunc("POST /internal/sync/leases", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no", http.StatusUnauthorized)
	})
	srv2 := httptest.NewServer(mux2)
	defer srv2.Close()
	if _, err := New(context.Background(), srv2.URL, srv2.URL+"/oauth/token", "a", "b").Lease(context.Background(), "w1", 1); err == nil || !strings.Contains(err.Error(), "401") {
		t.Errorf("expected a 401 error, got %v", err)
	}
}

func TestOAuthCredentialsAndRefresh(t *testing.T) {
	var queries []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries = append(queries, r.URL.RawQuery)
		_, _ = w.Write([]byte(`{"accountId":"acc-1","emailAddress":"kim@example.test","provider":"gmail","connection":null,` +
			`"credentials":{"type":"oauth2","accessToken":"ya29.x","expiresAt":"2026-10-19T12:00:00+00:00"}}`))
	}))
	defer srv.Close()
	c := NewWithHTTPClient(srv.URL, srv.Client())

	creds, err := c.Credentials(context.Background(), "acc-1", "w1")
	if err != nil {
		t.Fatal(err)
	}
	token, expiresAt, err := creds.AccessToken()
	if err != nil || token != "ya29.x" || !expiresAt.Equal(time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("AccessToken = %q, %v, %v", token, expiresAt, err)
	}
	if creds.Connection != (Connection{}) {
		t.Errorf("null connection decoded as %+v", creds.Connection)
	}
	if _, err := creds.Password(); err == nil {
		t.Error("OAuth credentials have no password")
	}
	if _, err := c.RefreshCredentials(context.Background(), "acc-1", "w1"); err != nil {
		t.Fatal(err)
	}
	if queries[0] != "workerId=w1" || queries[1] != "workerId=w1&rejected=1" {
		t.Errorf("queries = %v", queries)
	}
	if _, _, err := (Credentials{Secrets: map[string]string{"type": "password", "password": "x"}}).AccessToken(); err == nil {
		t.Error("password credentials have no access token")
	}
}

func TestConflictOnCredentialsMeansReauthorize(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"detail":"The provider refused to renew access."}`))
	}))
	defer srv.Close()
	c := NewWithHTTPClient(srv.URL, srv.Client())

	_, err := c.RefreshCredentials(context.Background(), "acc-1", "w1")
	var httpErr *HTTPError
	if !errors.Is(err, ErrReauthorize) || !errors.As(err, &httpErr) || httpErr.Status != http.StatusConflict {
		t.Fatalf("err = %v", err)
	}
}

func TestRemoteUIDsAndUnknownUIDs(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/internal/sync/accounts/acc-1/folders/remote-uids":
			q := r.URL.Query()
			if q.Get("workerId") != "w1" || q.Get("folder") != "Label_1" || q.Get("after") != "m5" || q.Get("limit") != "5000" {
				t.Errorf("query = %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"remoteUids":["m6","m7"],"next":null}`))
		case "/internal/sync/accounts/acc-1/changes":
			_, _ = w.Write([]byte(`{"updated":1,"removed":0,"unknown":1,"deleted":0,"unknownUids":["m9"]}`))
		}
	}))
	defer srv.Close()
	c := NewWithHTTPClient(srv.URL, srv.Client())

	page, err := c.RemoteUIDs(context.Background(), "acc-1", "w1", "Label_1", "m5", MaxRemoteUIDPage)
	if err != nil || len(page.RemoteUIDs) != 2 || page.Next != nil {
		t.Fatalf("page = %+v, %v", page, err)
	}
	result, err := c.Changes(context.Background(), "acc-1", ChangeBatch{WorkerID: "w1", Folder: "INBOX"})
	if err != nil || len(result.UnknownUIDs) != 1 || result.UnknownUIDs[0] != "m9" {
		t.Fatalf("result = %+v, %v", result, err)
	}
}

func TestMailboxChangesAreClaimedAndReported(t *testing.T) {
	var reported map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/internal/sync/accounts/acc-1/mailbox-changes/claim":
			_, _ = w.Write([]byte(`{"changes":[` +
				`{"id":"c1","kind":"flags","seen":true,"flagged":null,"locations":[{"folder":"INBOX","uidValidity":4294967295,"remoteUid":"7"}],"source":null,"target":null},` +
				`{"id":"c2","kind":"move","seen":null,"flagged":null,"locations":[],"source":{"folder":"INBOX","uidValidity":1,"remoteUid":"7"},"target":{"folder":"Archive"}}]}`))
		case "/internal/sync/accounts/acc-1/mailbox-changes/c2/report":
			_ = json.NewDecoder(r.Body).Decode(&reported)
			_, _ = w.Write([]byte(`{"accepted":true}`))
		case "/internal/sync/accounts/acc-1/mailbox-changes/c3/report":
			http.Error(w, `{"detail":"claim lost"}`, http.StatusConflict)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	client := NewWithHTTPClient(srv.URL, srv.Client())

	changes, err := client.ClaimMailbox(context.Background(), "acc-1", "w1")
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 2 || changes[0].Kind != MailboxFlags || *changes[0].Seen != true || changes[0].Flagged != nil || *changes[0].Locations[0].UIDValidity != 4294967295 {
		t.Fatalf("flag change = %+v", changes[0])
	}
	if changes[1].Source == nil || changes[1].Source.RemoteUID != "7" || changes[1].Target.Folder != "Archive" {
		t.Fatalf("move = %+v", changes[1])
	}

	if err := client.ReportMailbox(context.Background(), "acc-1", "c2", "w1", MailboxDone, "", "12"); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(reported) != "map[outcome:done remoteUid:12 workerId:w1]" {
		t.Errorf("report body = %v", reported)
	}
	if err := client.ReportMailbox(context.Background(), "acc-1", "c3", "w1", OutcomeFailed, "NO", ""); !errors.Is(err, ErrClaimLost) {
		t.Errorf("a lost claim is reported as such, got %v", err)
	}
}

func TestUnsubscribesAreClaimedAndReported(t *testing.T) {
	var claimed, reported map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/internal/sync/accounts/acc-1/unsubscribes/claim":
			_ = json.NewDecoder(r.Body).Decode(&claimed)
			_, _ = w.Write([]byte(`{"requests":[{"id":"u1","url":"https://news.example/unsub?u=1"}]}`))
		case "/internal/sync/accounts/acc-1/unsubscribes/u1/report":
			_ = json.NewDecoder(r.Body).Decode(&reported)
			_, _ = w.Write([]byte(`{"accepted":true}`))
		case "/internal/sync/accounts/acc-1/unsubscribes/u2/report":
			http.Error(w, `{"detail":"claim lost"}`, http.StatusConflict)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	client := NewWithHTTPClient(srv.URL, srv.Client())

	requests, err := client.ClaimUnsubscribes(context.Background(), "acc-1", "w1")
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(claimed) != "map[workerId:w1]" {
		t.Errorf("claim body = %v", claimed)
	}
	if len(requests) != 1 || requests[0].ID != "u1" || requests[0].URL != "https://news.example/unsub?u=1" {
		t.Fatalf("requests = %+v", requests)
	}

	if err := client.ReportUnsubscribe(context.Background(), "acc-1", "u1", "w1", OutcomeFailed, "Refused (HTTP 404)."); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(reported) != "map[error:Refused (HTTP 404). outcome:failed workerId:w1]" {
		t.Errorf("report body = %v", reported)
	}
	if err := client.ReportUnsubscribe(context.Background(), "acc-1", "u2", "w1", UnsubscribeDone, ""); !errors.Is(err, ErrClaimLost) {
		t.Errorf("a lost claim is reported as such, got %v", err)
	}
}

// Fails without the LastAttempt field: the API's lastAttempt flag decides which text ends an undecided message.
func TestClaimedOutgoingMessagesSayWhetherItIsTheLastAttempt(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"messages":[{"id":"o1","rawObjectKey":"outgoing/aa/1","envelopeFrom":"kim@example.test","recipients":["sam@example.test"],"messageId":"o1@example.test","attempt":6,"lastAttempt":true}]}`))
	}))
	defer srv.Close()

	messages, err := NewWithHTTPClient(srv.URL, srv.Client()).ClaimOutbox(context.Background(), "acc-1", "w1")
	if err != nil || len(messages) != 1 || messages[0].Attempt != 6 || !messages[0].LastAttempt {
		t.Fatalf("messages = %+v, %v", messages, err)
	}
}

// Fails without the fix: the token request had no timeout, so a token endpoint that accepted the connection and never
// answered blocked every API call, the heartbeat included.
func TestATokenEndpointThatNeverAnswersFailsTheCallInTime(t *testing.T) {
	defer func(previous time.Duration) { tokenTimeout = previous }(tokenTimeout)
	tokenTimeout = 100 * time.Millisecond
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/oauth/token" {
			select {
			case <-release:
			case <-r.Context().Done():
			}
			return
		}
		_, _ = w.Write([]byte(`{"leaseSeconds":90,"accounts":[]}`))
	}))
	defer srv.Close()
	defer close(release)

	start := time.Now()
	_, err := New(context.Background(), srv.URL, srv.URL+"/oauth/token", "sync-worker", "secret").Lease(context.Background(), "w1", 1)
	if err == nil || time.Since(start) > 5*time.Second {
		t.Errorf("Lease = %v after %v; want an error within the token timeout", err, time.Since(start))
	}
}
