package lease

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	"tresso/sync/internal/api"
)

type fakeLeaser struct {
	mu       sync.Mutex
	accounts []api.Account
	outbox   []string
	err      error
	released bool
}

func (f *fakeLeaser) Lease(context.Context, string, int) (api.LeaseResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return api.LeaseResponse{}, f.err
	}
	return api.LeaseResponse{LeaseSeconds: 90, Accounts: slices.Clone(f.accounts), Outbox: slices.Clone(f.outbox)}, nil
}

func (f *fakeLeaser) Release(context.Context, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.released = true
	return nil
}

type blockingSyncer struct{ stopped chan string }

func (s blockingSyncer) Run(ctx context.Context, account api.Account) error {
	<-ctx.Done()
	s.stopped <- account.ID
	return ctx.Err()
}

func newTestManager(leaser Leaser, stopped chan string) *Manager {
	factory := func(provider string) (Syncer, error) {
		if provider != "imap" {
			return nil, ErrUnsupportedProvider
		}
		return blockingSyncer{stopped: stopped}, nil
	}
	return NewManager(leaser, factory, "w1", 10, time.Hour, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func sorted(ids []string) []string {
	slices.Sort(ids)
	return ids
}

func TestHeartbeatStartsAndStopsSyncers(t *testing.T) {
	stopped := make(chan string, 10)
	leaser := &fakeLeaser{accounts: []api.Account{{ID: "a", Provider: "imap"}, {ID: "b", Provider: "imap"}, {ID: "c", Provider: "pop3"}}}
	m := newTestManager(leaser, stopped)
	ctx := context.Background()

	m.Heartbeat(ctx)
	if got := sorted(m.Running()); !slices.Equal(got, []string{"a", "b"}) {
		t.Fatalf("running after first heartbeat = %v, want [a b] (unsupported provider skipped)", got)
	}

	leaser.accounts = []api.Account{{ID: "b", Provider: "imap"}}
	m.Heartbeat(ctx)
	if got := m.Running(); !slices.Equal(got, []string{"b"}) {
		t.Fatalf("running after lease loss = %v, want [b]", got)
	}
	if id := <-stopped; id != "a" {
		t.Fatalf("stopped %q, want a", id)
	}
}

func TestFailedHeartbeatKeepsSyncersUntilLeaseTimeout(t *testing.T) {
	stopped := make(chan string, 10)
	leaser := &fakeLeaser{accounts: []api.Account{{ID: "a", Provider: "imap"}}}
	m := newTestManager(leaser, stopped)
	ctx := context.Background()

	m.Heartbeat(ctx)
	leaser.err = errors.New("api down")

	m.Heartbeat(ctx)
	if got := m.Running(); !slices.Equal(got, []string{"a"}) {
		t.Fatalf("running after one failed heartbeat = %v, want [a]", got)
	}

	// Pretend the last successful heartbeat was longer ago than the lease timeout.
	m.mu.Lock()
	m.lastBeat = time.Now().Add(-2 * time.Minute)
	m.mu.Unlock()

	m.Heartbeat(ctx)
	if got := m.Running(); len(got) != 0 {
		t.Fatalf("running after lease timeout = %v, want none", got)
	}
	if _, _, err := m.Status(); err == nil {
		t.Fatal("status should report the last heartbeat error")
	}
}

func TestRunReleasesLeasesOnShutdown(t *testing.T) {
	stopped := make(chan string, 10)
	leaser := &fakeLeaser{accounts: []api.Account{{ID: "a", Provider: "imap"}}}
	m := newTestManager(leaser, stopped)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		m.Run(ctx)
		close(done)
	}()

	deadline := time.After(2 * time.Second)
	for len(m.Running()) == 0 {
		select {
		case <-deadline:
			t.Fatal("syncer never started")
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}
	cancel()
	<-done

	if !leaser.released {
		t.Fatal("leases were not released on shutdown")
	}
	if id := <-stopped; id != "a" {
		t.Fatalf("stopped %q, want a", id)
	}
}

// givingUpSyncer ends its first run on its own, as the IMAP syncer does after a refused login, and blocks on later
// runs.
type givingUpSyncer struct {
	mu   *sync.Mutex
	runs *int
	gave chan struct{}
}

func (s givingUpSyncer) Run(ctx context.Context, _ api.Account) error {
	s.mu.Lock()
	*s.runs++
	run := *s.runs
	s.mu.Unlock()
	if run == 1 {
		close(s.gave)
		return nil
	}
	<-ctx.Done()
	return ctx.Err()
}

func TestAccountThatGaveUpStartsAgainWhenLeasedAgain(t *testing.T) {
	var mu sync.Mutex
	runs := 0
	gave := make(chan struct{})
	syncer := givingUpSyncer{mu: &mu, runs: &runs, gave: gave}
	leaser := &fakeLeaser{accounts: []api.Account{{ID: "a1", Provider: "imap"}}}
	manager := NewManager(leaser, func(string) (Syncer, error) { return syncer, nil }, "w1", 10, time.Hour, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	manager.Heartbeat(ctx)
	<-gave

	// The password was fixed before the next heartbeat, so the API keeps leasing the account to this worker.
	deadline := time.Now().Add(2 * time.Second)
	for {
		manager.Heartbeat(ctx)
		mu.Lock()
		current := runs
		mu.Unlock()
		if current == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("runs = %d, want the account started again", current)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if got := manager.Running(); !slices.Equal(got, []string{"a1"}) {
		t.Errorf("running = %v", got)
	}
}

func TestHeartbeatHandsAccountsWithMailToSendToTheOutbox(t *testing.T) {
	leaser := &fakeLeaser{accounts: []api.Account{{ID: "a1", Provider: "imap"}}}
	leaser.outbox = []string{"a1"}
	stopped := make(chan string, 1)
	manager := newTestManager(leaser, stopped)
	var got []string
	manager.OnOutbox(func(_ context.Context, ids []string) {
		got = ids
		if !manager.Holds("a1") {
			t.Error("the account is not held while its outbox is handled")
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer func() {
		cancel()
		manager.shutdown()
	}()

	manager.Heartbeat(ctx)

	if !slices.Equal(got, []string{"a1"}) {
		t.Errorf("outbox = %v", got)
	}
}

func TestTheWorkerIsHealthyOnlyWhileItsHeartbeatsGoThrough(t *testing.T) {
	leaser := &fakeLeaser{}
	m := NewManager(leaser, func(string) (Syncer, error) { return nil, ErrUnsupportedProvider }, "w1", 10, 10*time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if m.Healthy(time.Now()) {
		t.Error("healthy before the first heartbeat")
	}

	m.Heartbeat(context.Background())
	now := time.Now()
	if !m.Healthy(now) {
		t.Error("not healthy right after a heartbeat")
	}
	// Lease of 90 s: the lease timeout (60 s) is longer than two heartbeat intervals.
	if !m.Healthy(now.Add(55*time.Second)) || m.Healthy(now.Add(61*time.Second)) {
		t.Error("health does not follow the age of the last heartbeat")
	}
}
