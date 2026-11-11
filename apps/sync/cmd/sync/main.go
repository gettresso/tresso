// Command sync runs a sync worker: it leases mail accounts from the API and keeps them in sync.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/caldavsync"
	"tresso/sync/internal/calsync"
	"tresso/sync/internal/config"
	"tresso/sync/internal/gmailsync"
	"tresso/sync/internal/googlecal"
	"tresso/sync/internal/graphcal"
	"tresso/sync/internal/graphsync"
	"tresso/sync/internal/imapsync"
	"tresso/sync/internal/lease"
	"tresso/sync/internal/netguard"
	"tresso/sync/internal/outbox"
	"tresso/sync/internal/realtime"
	"tresso/sync/internal/storage"
	"tresso/sync/internal/unsubscribe"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	if err := run(logger); err != nil {
		logger.Error("sync worker stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	client := api.New(ctx, cfg.APIURL, cfg.TokenURL, cfg.ClientID, cfg.ClientSecret)

	objects, err := storage.NewS3(cfg.S3Endpoint, cfg.S3AccessKey, cfg.S3SecretKey, cfg.S3Bucket, cfg.S3Region)
	if err != nil {
		return fmt.Errorf("object storage: %w", err)
	}
	if err := objects.EnsureBucket(ctx); err != nil {
		return fmt.Errorf("object storage: %w", err)
	}
	// Content is encrypted with each account owner's key, which the API hands out per leased account.
	store := storage.NewVault(objects, storageKeys{client: client, workerID: cfg.WorkerID})
	if cfg.AllowUnsafeServers {
		logger.Warn("MAIL_ALLOW_UNSAFE_SERVERS is on: private mail server addresses are allowed (local testing only)")
	}

	dialer := netguard.New(cfg.AllowUnsafeServers)
	workerLogger := logger.With("worker", cfg.WorkerID)
	imapSyncer := imapsync.New(client, store, dialer, cfg.WorkerID, imapsync.DefaultOptions(), workerLogger)
	gmailSyncer := gmailsync.New(client, store, cfg.WorkerID, gmailsync.DefaultOptions(), workerLogger)
	graphSyncer := graphsync.New(client, store, cfg.WorkerID, graphsync.DefaultOptions(), workerLogger)
	calendarOptions := caldavsync.DefaultOptions()
	calendarOptions.AllowHTTP = cfg.AllowUnsafeServers
	calendarSyncer := caldavsync.New(client, dialer, cfg.WorkerID, calendarOptions, workerLogger)
	providerCalendarOptions := calsync.DefaultOptions()
	googleCalendarSyncer := calsync.New(client, googlecal.NewProvider(googlecal.DefaultClientOptions()), dialer, cfg.WorkerID, providerCalendarOptions, workerLogger)
	graphCalendarSyncer := calsync.New(client, graphcal.NewProvider(graphcal.DefaultClientOptions()), dialer, cfg.WorkerID, providerCalendarOptions, workerLogger)
	triggerCalendars := func(accountID string) {
		calendarSyncer.Trigger(accountID)
		googleCalendarSyncer.Trigger(accountID)
		graphCalendarSyncer.Trigger(accountID)
	}
	syncerFor := func(provider string) (lease.Syncer, error) {
		switch provider {
		case "imap":
			return lease.WithCompanion(imapSyncer, calendarSyncer), nil
		case "gmail":
			return lease.WithCompanion(gmailSyncer, googleCalendarSyncer), nil
		case "microsoft":
			return lease.WithCompanion(graphSyncer, graphCalendarSyncer), nil
		default:
			return nil, fmt.Errorf("%w: %s", lease.ErrUnsupportedProvider, provider)
		}
	}

	manager := lease.NewManager(client, syncerFor, cfg.WorkerID, cfg.Capacity, cfg.HeartbeatInterval, workerLogger)

	// Outgoing mail, drafts, changes to messages, calendar changes and unsubscribe requests: the hub says which account
	// has work right away; every heartbeat repeats it.
	transports := map[string]outbox.Transport{
		"imap":      outbox.IMAPTransport(dialer),
		"gmail":     outbox.GmailTransport(client, cfg.WorkerID, gmailsync.DefaultClientOptions()),
		"microsoft": outbox.GraphTransport(client, cfg.WorkerID, graphOutboxOptions(workerLogger)),
	}
	unsubscriber := newUnsubscriber(cfg)
	dispatcher := outbox.NewDispatcher(client, store, transports, unsubscriber, cfg.WorkerID, workerLogger)
	manager.OnOutbox(func(ctx context.Context, accountIDs []string) {
		for _, id := range accountIDs {
			dispatcher.Trigger(ctx, id)
			triggerCalendars(id)
		}
	})
	subscriber := realtime.NewSubscriber(client, &http.Client{}, func(accountID string) {
		if manager.Holds(accountID) {
			dispatcher.Trigger(ctx, accountID)
			triggerCalendars(accountID)
		}
	}, logger.With("worker", cfg.WorkerID))
	go subscriber.Run(ctx)

	server := &http.Server{Addr: cfg.HealthAddr, Handler: healthHandler(manager), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("health server failed", "error", err)
			stop()
		}
	}()

	logger.Info("sync worker started", "worker", cfg.WorkerID, "capacity", cfg.Capacity)
	manager.Run(ctx)
	dispatcher.Wait()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return server.Shutdown(shutdownCtx)
}

// health is what the health endpoint reads from the lease manager.
type health interface {
	Status() (accounts int, lastBeat time.Time, lastError error)
	Healthy(now time.Time) bool
}

// healthHandler answers 503 until the first heartbeat and whenever the last successful one is too old: the worker
// then has no contact with the API and holds no accounts, and should be restarted or replaced.
func healthHandler(manager health) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		accounts, lastBeat, lastErr := manager.Status()
		status := http.StatusOK
		body := map[string]any{"accounts": accounts, "lastHeartbeat": lastBeat}
		if lastErr != nil {
			body["lastError"] = lastErr.Error()
		}
		if !manager.Healthy(time.Now()) {
			status = http.StatusServiceUnavailable
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	})
	return mux
}

// graphOutboxOptions are the Graph client options of the outbox, logging through the worker's logger.
func graphOutboxOptions(logger *slog.Logger) graphsync.ClientOptions {
	opts := graphsync.DefaultClientOptions()
	opts.Logger = logger
	return opts
}

// newUnsubscriber posts one-click unsubscribe requests. Their addresses come from whoever sent a message, so its dialer
// never allows private addresses, whatever MAIL_ALLOW_UNSAFE_SERVERS (cfg.AllowUnsafeServers) says for the user's own
// mail servers.
func newUnsubscriber(_ config.Config) *unsubscribe.Sender {
	return unsubscribe.New(netguard.New(false), unsubscribe.DefaultOptions())
}

// storageKeys asks the API for an account's storage keys as this worker, which must lease the account.
type storageKeys struct {
	client   *api.Client
	workerID string
}

func (k storageKeys) StorageKeys(ctx context.Context, accountID string) (api.StorageKeys, error) {
	return k.client.StorageKeys(ctx, accountID, k.workerID)
}
