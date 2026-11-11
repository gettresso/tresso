package providerhttp

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeTokens struct {
	mu          sync.Mutex
	token       string
	renewed     string
	invalidated []string
}

func (f *fakeTokens) Token(context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.token, nil
}

func (f *fakeTokens) Invalidate(_ context.Context, rejected string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.invalidated = append(f.invalidated, rejected)
	f.token = f.renewed
	return nil
}

func testOptions() Options {
	opts := DefaultOptions()
	opts.UnitsPerSecond = 0
	opts.MinBackoff, opts.MaxBackoff = time.Millisecond, 2*time.Millisecond
	opts.MaxAttempts = 3
	return opts
}

func TestRefusedTokenIsRenewedOnceThenReported(t *testing.T) {
	accepted := "fresh"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+accepted {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	tokens := &fakeTokens{token: "stale", renewed: "fresh"}
	c := New(srv.Client(), tokens, testOptions())
	var out struct{ OK bool }
	if err := c.JSON(context.Background(), Request{Method: http.MethodGet, URL: srv.URL}, &out); err != nil || !out.OK {
		t.Fatalf("JSON = %v, %+v", err, out)
	}
	if len(tokens.invalidated) != 1 || tokens.invalidated[0] != "stale" {
		t.Errorf("invalidated %v", tokens.invalidated)
	}

	accepted = "never"
	err := c.JSON(context.Background(), Request{Method: http.MethodGet, URL: srv.URL}, nil)
	if !errors.Is(err, ErrUnauthorized) || len(tokens.invalidated) != 2 {
		t.Errorf("err = %v, invalidated %v; want one renewal, then ErrUnauthorized", err, tokens.invalidated)
	}
}

func TestThrottledAndFailedRequestsAreRetried(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		switch calls {
		case 1:
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusTooManyRequests)
		case 2:
			w.WriteHeader(http.StatusBadGateway)
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer srv.Close()

	c := New(srv.Client(), &fakeTokens{token: "t"}, testOptions())
	if err := c.JSON(context.Background(), Request{Method: http.MethodGet, URL: srv.URL}, nil); err != nil || calls != 3 {
		t.Fatalf("err = %v after %d calls", err, calls)
	}
}

func TestPostIsNotRetriedOnServerErrors(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"code":"InternalError","message":"boom"}}`))
	}))
	defer srv.Close()

	c := New(srv.Client(), &fakeTokens{token: "t"}, testOptions())
	_, err := c.Do(context.Background(), Request{Method: http.MethodPost, URL: srv.URL + "/send?secret=x", Body: []byte("x")})
	var statusErr *StatusError
	if !errors.As(err, &statusErr) || statusErr.StatusCode != 500 || calls != 1 || !statusErr.HasReason("internalerror") || statusErr.Message != "boom" {
		t.Fatalf("err = %v after %d calls", err, calls)
	}
	if strings.Contains(err.Error(), "secret") {
		t.Errorf("error leaks the query string: %v", err)
	}
}

func TestGmailErrorReasonsAreRead(t *testing.T) {
	e := newStatusError(Request{Method: http.MethodGet, URL: "u"}, 403, []byte(`{"error":{"code":403,"status":"PERMISSION_DENIED","errors":[{"reason":"insufficientPermissions"}],"details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}`))
	for _, reason := range []string{"PERMISSION_DENIED", "insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"} {
		if !e.HasReason(reason) {
			t.Errorf("reason %s missing from %v", reason, e.Reasons)
		}
	}
}

func TestRetryAfter(t *testing.T) {
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	if d, ok := retryAfter("3", now); !ok || d != 3*time.Second {
		t.Errorf("seconds: %v %v", d, ok)
	}
	if d, ok := retryAfter("Mon, 19 Oct 2026 12:00:10 GMT", now); !ok || d != 10*time.Second {
		t.Errorf("date: %v %v", d, ok)
	}
	if _, ok := retryAfter("soon", now); ok {
		t.Error("garbage accepted")
	}
}

func TestLimiterSpacesRequests(t *testing.T) {
	l := NewLimiter(100, 2)
	started := time.Now()
	for range 4 {
		if err := l.Wait(context.Background(), 1); err != nil {
			t.Fatal(err)
		}
	}
	// Two from the burst, two more at 100 per second.
	if elapsed := time.Since(started); elapsed < 15*time.Millisecond {
		t.Errorf("4 units took %v", elapsed)
	}
	if NewLimiter(0, 1) != nil {
		t.Error("a rate of 0 means no limit")
	}
}

// dropFirst closes the connection of the first request without answering, as a reset or a dropped HTTP/2 stream does,
// and answers 200 afterwards.
func dropFirst(t *testing.T) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			_ = conn.Close()
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func TestABrokenConnectionIsRetriedForIdempotentRequests(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		srv, calls := dropFirst(t)
		c := New(srv.Client(), &fakeTokens{token: "t"}, testOptions())
		if _, err := c.Do(context.Background(), Request{Method: method, URL: srv.URL}); err != nil || calls.Load() != 2 {
			t.Errorf("%s: err %v after %d calls; want success on the second", method, err, calls.Load())
		}
	}
}

func TestABrokenConnectionIsNotRetriedForAPost(t *testing.T) {
	srv, calls := dropFirst(t)
	c := New(srv.Client(), &fakeTokens{token: "t"}, testOptions())
	if _, err := c.Do(context.Background(), Request{Method: http.MethodPost, URL: srv.URL, Body: []byte("x")}); err == nil || calls.Load() != 1 {
		t.Errorf("err %v after %d calls; a POST may have taken effect and must not be sent again", err, calls.Load())
	}
}

func TestATimedOutAttemptIsRetriedButACancelledCallIsNot(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			<-r.Context().Done()
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	opts := testOptions()
	opts.Timeout = 50 * time.Millisecond
	c := New(srv.Client(), &fakeTokens{token: "t"}, opts)
	if _, err := c.Do(context.Background(), Request{Method: http.MethodGet, URL: srv.URL}); err != nil || calls.Load() != 2 {
		t.Errorf("err %v after %d calls; a timed-out attempt must be retried", err, calls.Load())
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	before := calls.Load()
	if _, err := c.Do(ctx, Request{Method: http.MethodGet, URL: srv.URL}); !errors.Is(err, context.Canceled) || calls.Load() != before {
		t.Errorf("err %v after %d more calls; a cancelled call must end at once", err, calls.Load()-before)
	}
}
