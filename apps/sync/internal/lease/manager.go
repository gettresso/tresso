// Package lease keeps the set of running account syncers in line with the leases the API hands out.
package lease

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"tresso/sync/internal/api"
)

// Leaser is the part of the API client the manager needs.
type Leaser interface {
	Lease(ctx context.Context, workerID string, capacity int) (api.LeaseResponse, error)
	Release(ctx context.Context, workerID string) error
}

// Syncer keeps one mail account in sync until ctx is cancelled. Implementations are per provider.
type Syncer interface {
	Run(ctx context.Context, account api.Account) error
}

// ErrUnsupportedProvider is returned by a SyncerFactory for providers that have no implementation.
var ErrUnsupportedProvider = errors.New("unsupported provider")

// SyncerFactory returns the Syncer for an account's provider.
type SyncerFactory func(provider string) (Syncer, error)

type running struct {
	cancel context.CancelFunc
	done   chan struct{}
}

type Manager struct {
	leaser    Leaser
	factory   SyncerFactory
	workerID  string
	capacity  int
	interval  time.Duration
	logger    *slog.Logger
	mu        sync.Mutex
	accounts  map[string]*running
	lastBeat  time.Time
	lastError error
	// Lease duration reported by the API on the last successful heartbeat.
	leaseDuration time.Duration
	// Called after each heartbeat with the leased accounts that have mail to send.
	onOutbox func(ctx context.Context, accountIDs []string)
}

// OnOutbox sets what happens with accounts that have mail to send; call before Run.
func (m *Manager) OnOutbox(handle func(ctx context.Context, accountIDs []string)) {
	m.onOutbox = handle
}

// Holds reports whether this worker currently syncs the account.
func (m *Manager) Holds(accountID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.accounts[accountID]
	return ok
}

func NewManager(leaser Leaser, factory SyncerFactory, workerID string, capacity int, interval time.Duration, logger *slog.Logger) *Manager {
	return &Manager{
		leaser:   leaser,
		factory:  factory,
		workerID: workerID,
		capacity: capacity,
		interval: interval,
		logger:   logger,
		accounts: map[string]*running{},
	}
}

// Run sends heartbeats until ctx is cancelled, then stops all syncers and releases the leases.
func (m *Manager) Run(ctx context.Context) {
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()

	m.Heartbeat(ctx)
	for {
		select {
		case <-ctx.Done():
			m.shutdown()
			return
		case <-ticker.C:
			m.Heartbeat(ctx)
		}
	}
}

// Heartbeat renews leases and reconciles running syncers with the leased accounts, then hands the accounts with mail
// to send to the outbox handler.
func (m *Manager) Heartbeat(ctx context.Context) {
	resp, err := m.leaser.Lease(ctx, m.workerID, m.capacity)
	outbox := m.applyLease(ctx, resp, err)
	if m.onOutbox != nil && len(outbox) > 0 {
		m.onOutbox(ctx, outbox)
	}
}

func (m *Manager) applyLease(ctx context.Context, resp api.LeaseResponse, err error) []string {
	m.mu.Lock()
	defer m.mu.Unlock()

	if err != nil {
		// Keep running syncers: their leases stay valid until expiry. If the API stays unreachable past the lease
		// period the leases expire and the syncers are stopped below to avoid two workers syncing one account.
		m.lastError = err
		m.logger.Warn("lease heartbeat failed", "error", err)
		if !m.lastBeat.IsZero() && time.Since(m.lastBeat) > m.leaseTimeout() {
			m.logger.Error("leases expired without a successful heartbeat; stopping all syncers")
			m.stopAllLocked()
		}
		return nil
	}

	m.lastBeat = time.Now()
	m.lastError = nil
	m.leaseDuration = time.Duration(resp.LeaseSeconds) * time.Second
	m.reconcileLocked(ctx, resp.Accounts)
	return resp.Outbox
}

func (m *Manager) reconcileLocked(ctx context.Context, accounts []api.Account) {
	leased := make(map[string]api.Account, len(accounts))
	for _, account := range accounts {
		leased[account.ID] = account
	}

	for id, r := range m.accounts {
		// A syncer that ended on its own gave the account up (its login was refused). Forget it, so the account starts
		// again once it is leased again: after the user fixed the password, the very next heartbeat may return it.
		select {
		case <-r.done:
			delete(m.accounts, id)
			continue
		default:
		}
		account, ok := leased[id]
		switch {
		case !ok:
			m.logger.Info("lease lost, stopping account", "account", id)
		case account.Fresh:
			// The API ended the lease and this worker got the account back: start over, with the new sign-in and
			// fresh counters.
			m.logger.Info("lease started again, restarting account", "account", id)
		default:
			continue
		}
		r.cancel()
		<-r.done
		delete(m.accounts, id)
	}

	for id, account := range leased {
		if _, ok := m.accounts[id]; ok {
			continue
		}
		syncer, err := m.factory(account.Provider)
		if err != nil {
			m.logger.Warn("cannot sync account", "account", id, "provider", account.Provider, "error", err)
			continue
		}
		m.start(ctx, account, syncer)
	}
}

func (m *Manager) start(parent context.Context, account api.Account, syncer Syncer) {
	ctx, cancel := context.WithCancel(parent)
	r := &running{cancel: cancel, done: make(chan struct{})}
	m.accounts[account.ID] = r

	m.logger.Info("starting account", "account", account.ID, "provider", account.Provider)
	go func() {
		defer close(r.done)
		if err := syncer.Run(ctx, account); err != nil && !errors.Is(err, context.Canceled) {
			m.logger.Error("account syncer stopped", "account", account.ID, "error", err)
		}
	}()
}

func (m *Manager) stopAllLocked() {
	for id, r := range m.accounts {
		r.cancel()
		<-r.done
		delete(m.accounts, id)
	}
}

func (m *Manager) shutdown() {
	m.mu.Lock()
	m.stopAllLocked()
	m.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.leaser.Release(ctx, m.workerID); err != nil {
		m.logger.Warn("releasing leases failed; they will expire on their own", "error", err)
		return
	}
	m.logger.Info("released all leases")
}

// leaseTimeout is how long syncers keep running without a successful heartbeat. It stays well below the lease
// duration so a worker that lost contact stops before another worker can claim its accounts.
func (m *Manager) leaseTimeout() time.Duration {
	return m.leaseDuration * 2 / 3
}

// Status reports health for the HTTP health endpoint.
func (m *Manager) Status() (accounts int, lastBeat time.Time, lastError error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.accounts), m.lastBeat, m.lastError
}

// Healthy reports whether the worker is in contact with the API: its last successful heartbeat is no older than two
// heartbeat intervals (or the lease timeout, when that is longer). A worker that lost the API stops its syncers and
// holds no accounts, so it must not look healthy for ever after its first heartbeat.
func (m *Manager) Healthy(now time.Time) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.lastBeat.IsZero() {
		return false
	}
	return now.Sub(m.lastBeat) <= max(2*m.interval, m.leaseTimeout())
}

// Running returns the ids of the accounts that currently have a syncer.
func (m *Manager) Running() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	ids := make([]string, 0, len(m.accounts))
	for id := range m.accounts {
		ids = append(ids, id)
	}
	return ids
}
