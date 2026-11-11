package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/config"
)

// The unsubscribe dialer stays strict when the user's own mail servers may be private (local testing): an address
// from a stranger's message never reaches this machine or its network.
func TestTheUnsubscriberRefusesPrivateAddressesWhateverTheConfig(t *testing.T) {
	for _, allowUnsafe := range []bool{false, true} {
		sender := newUnsubscriber(config.Config{AllowUnsafeServers: allowUnsafe})

		outcome, text := sender.Post(context.Background(), "https://127.0.0.1/unsubscribe")

		// Refused before connecting (failed); a dialer that allowed it would find nothing listening and retry.
		if outcome != api.OutcomeFailed || text != "The unsubscribe address is not public." {
			t.Errorf("AllowUnsafeServers=%v: outcome = %q %q, want failed: not public", allowUnsafe, outcome, text)
		}
	}
}

type fakeHealth struct {
	lastBeat time.Time
	healthy  bool
}

func (f fakeHealth) Status() (int, time.Time, error) {
	return 0, f.lastBeat, errors.New("lease heartbeat failed")
}

func (f fakeHealth) Healthy(time.Time) bool { return f.healthy }

// Fails without the fix: /healthz answered 200 for ever once a first heartbeat had gone through.
func TestHealthzFailsWhenTheLastHeartbeatIsTooOld(t *testing.T) {
	for _, c := range []struct {
		health fakeHealth
		want   int
	}{
		{fakeHealth{}, http.StatusServiceUnavailable},
		{fakeHealth{lastBeat: time.Now().Add(-time.Hour), healthy: false}, http.StatusServiceUnavailable},
		{fakeHealth{lastBeat: time.Now(), healthy: true}, http.StatusOK},
	} {
		recorder := httptest.NewRecorder()
		healthHandler(c.health).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/healthz", nil))
		if recorder.Code != c.want {
			t.Errorf("%+v: status %d, want %d", c.health, recorder.Code, c.want)
		}
	}
}
