// Command whatsapp-bridge links to WhatsApp as a device of the user's phone, stores chats and messages in SQLite and
// serves a small REST API on 127.0.0.1 to send messages and download media. Tresso's desktop app starts it, reads its
// store and calls its API; see README.md for the environment, the stdout events and the API.
package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

// deviceName is the name the phone shows for this device under Linked devices.
const deviceName = "Tresso"

// settleTime is how long the bridge gives a new connection before it checks that it holds.
const settleTime = 2 * time.Second

// shutdownTimeout is how long requests that are still running get when the bridge stops.
const shutdownTimeout = 5 * time.Second

// connect opens the connection to WhatsApp. Tests replace it, so they never reach WhatsApp.
var connect = (*whatsmeow.Client).Connect

func main() {
	stdout := os.Stdout
	// Only the emitter writes to stdout. Anything else that prints there (a library, a forgotten print) goes nowhere.
	if devNull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0); err == nil {
		os.Stdout = devNull
	}
	// A write to a stdout nobody reads any more would end the program on the spot (Go exits at SIGPIPE on fd 1 and 2),
	// before the databases close. Ignored, the write fails instead, and the end of stdin stops the bridge cleanly.
	signal.Ignore(syscall.SIGPIPE)
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	os.Exit(run(os.LookupEnv, os.Stdin, signals, newEmitter(stdout), &diagnostics{w: os.Stderr}))
}

// outcome is how the bridge ends: the exit status, and whether a fatal event went out already. The first fatal wins.
type outcome struct {
	mu     sync.Mutex
	failed bool
}

// fail reports err (a *fatalError) once and asks the bridge to stop.
func (o *outcome) fail(em *emitter, diag *diagnostics, err *fatalError, stop func()) {
	o.mu.Lock()
	first := !o.failed
	o.failed = true
	o.mu.Unlock()
	if first {
		em.fatal(err.code)
		diag.say(err.reason)
	}
	stop()
}

func (o *outcome) status() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.failed {
		return 1
	}
	return 0
}

// run is the whole bridge. It returns the exit status: 0 after a stop that was asked for (stdin closed, SIGTERM or
// SIGINT) or a log out, 1 after a fatal event or a QR code nobody scanned.
func run(lookup func(string) (string, bool), stdin io.Reader, signals <-chan os.Signal, em *emitter, diag *diagnostics) int {
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	var end outcome
	failWith := func(err *fatalError) int {
		end.fail(em, diag, err, stop)
		return end.status()
	}

	cfg, err := readConfig(lookup)
	if err != nil {
		var fe *fatalError
		if errors.As(err, &fe) {
			return failWith(fe)
		}
		return failWith(fatal("bad_store", "the configuration is not valid", err))
	}
	// Nothing the bridge starts needs the token: it stays in this process only.
	_ = os.Unsetenv(envToken)

	go watchStdin(stdin, stop)
	go watchSignals(ctx, signals, stop)

	setDeviceName()

	if err := prepareStore(cfg.store); err != nil {
		return failWith(fatal("bad_store", "the store folder is refused: "+storeReason(err), err))
	}

	container, err := sqlstore.New(ctx, sqliteDriver, sqliteDSN(filepath.Join(cfg.store, sessionDatabase)), newTemplateLogger("Database", diag))
	if err != nil {
		if ctx.Err() != nil {
			return end.status()
		}
		return failWith(fatal("store_failed", "the session database cannot be opened", err))
	}
	defer container.Close()

	deviceStore, err := container.GetFirstDevice(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return end.status()
		}
		return failWith(fatal("store_failed", "the session database cannot be read", err))
	}

	messageStore, err := NewMessageStore(cfg.store)
	if err != nil {
		return failWith(fatal("store_failed", "the message database cannot be opened", err))
	}
	defer messageStore.Close()

	logger := newTemplateLogger("Client", diag)
	client := whatsmeow.NewClient(deviceStore, logger)
	// Disconnect before the databases close (the defers above run after this one).
	defer client.Disconnect()

	client.AddEventHandler(func(evt any) {
		switch v := evt.(type) {
		case *events.Message:
			handleMessage(client, messageStore, v, logger)
		case *events.HistorySync:
			handleHistorySync(client, messageStore, v, ownUserOf(client), logger)
		case *events.MediaRetry:
			handleMediaRetry(v)
		case *events.PairSuccess:
			em.linked()
		case *events.Connected:
			em.connected()
		case *events.Disconnected:
			em.disconnected()
		case *events.LoggedOut:
			// whatsmeow removed the session from the store; a new link needs a new start.
			em.loggedOut()
			stop()
		case *events.ClientOutdated:
			end.fail(em, diag, fatal("client_outdated", "WhatsApp refuses this version of whatsmeow", nil), stop)
		case *events.StreamReplaced:
			end.fail(em, diag, fatal("stream_replaced", "another program connected with this session", nil), stop)
		case *events.TemporaryBan:
			end.fail(em, diag, fatal("temporary_ban", "WhatsApp banned this account for a while", nil), stop)
		}
	})

	// A bridge asked to stop while it opened its store does not connect at all.
	if ctx.Err() != nil {
		return end.status()
	}
	if client.Store.ID == nil {
		// Not linked: show QR codes until the phone scans one.
		qrChan, err := client.GetQRChannel(ctx)
		if err != nil {
			return failWith(fatal("pair_failed", "the QR codes cannot be made", err))
		}
		if err := connect(client); err != nil {
			return failWith(fatal("connect_failed", "connecting to WhatsApp failed", err))
		}
		switch result := awaitPairing(ctx, qrChan, em); result {
		case pairingDone:
		case pairingStopped:
			return end.status()
		case pairingTimedOut:
			em.qrTimeout()
			stop()
			return 1
		default:
			return failWith(fatal(string(result), "linking the device failed", nil))
		}
	} else if err := connect(client); err != nil {
		return failWith(fatal("connect_failed", "connecting to WhatsApp failed", err))
	}

	// Give the connection a moment before checking that it holds.
	select {
	case <-ctx.Done():
		return end.status()
	case <-time.After(settleTime):
	}
	if !client.IsConnected() {
		return failWith(fatal("not_connected", "the connection to WhatsApp did not hold", nil))
	}

	listener, err := listenREST(cfg.port)
	if err != nil {
		return failWith(fatal("listen_failed", "the REST API cannot listen on its port", err))
	}
	server := newRESTServer(protect(newRESTHandler(client, messageStore), cfg.token, cfg.port))
	go func() {
		if err := server.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
			end.fail(em, diag, fatal("server_failed", "the REST API stopped", err), stop)
		}
	}()
	em.listening(cfg.port)

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
	return end.status()
}

// storeReason is the fixed text for why the store was refused. The error itself can hold paths, and paths in the store
// hold chat ids.
func storeReason(err error) string {
	for _, known := range []error{errStoreNotFolder, errStoreLink, errStoreOwner, errStoreWritable, errDatabaseNotAFile} {
		if errors.Is(err, known) {
			return known.Error()
		}
	}
	return errStoreNotUsable.Error()
}

// watchStdin stops the bridge when stdin ends: the parent that started it holds the other end and closes it when it
// quits, crashes or wants the bridge gone. What arrives on stdin is read and dropped.
func watchStdin(stdin io.Reader, stop func()) {
	_, _ = io.Copy(io.Discard, stdin)
	stop()
}

// watchSignals stops the bridge at SIGTERM or SIGINT.
func watchSignals(ctx context.Context, signals <-chan os.Signal, stop func()) {
	select {
	case <-signals:
		stop()
	case <-ctx.Done():
	}
}

// setDeviceName makes the phone list this device as Tresso under Linked devices. whatsmeow sends DeviceProps when the
// device links, so it holds for a device linked after this change; one linked before keeps the name it got then.
func setDeviceName() {
	store.DeviceProps.Os = proto.String(deviceName)
}

// pairingResult is how waiting for a scan ended: done, stopped, timed out, or the fatal code it failed with.
type pairingResult string

const (
	pairingDone     pairingResult = "done"
	pairingStopped  pairingResult = "stopped"
	pairingTimedOut pairingResult = "timeout"
	pairingFailed   pairingResult = "pair_failed"
	pairingOutdated pairingResult = "client_outdated"
)

// awaitPairing shows every QR code whatsmeow makes until the phone scans one, the codes run out, pairing fails, or
// the bridge is asked to stop.
func awaitPairing(ctx context.Context, items <-chan whatsmeow.QRChannelItem, em *emitter) pairingResult {
	for {
		select {
		case <-ctx.Done():
			return pairingStopped
		case item, ok := <-items:
			if !ok {
				return pairingFailed
			}
			switch item.Event {
			case whatsmeow.QRChannelEventCode:
				em.qr(item.Code)
			case whatsmeow.QRChannelSuccess.Event:
				return pairingDone
			case whatsmeow.QRChannelTimeout.Event:
				return pairingTimedOut
			case whatsmeow.QRChannelClientOutdated.Event:
				return pairingOutdated
			case whatsmeow.QRChannelEventError, whatsmeow.QRChannelErrUnexpectedEvent.Event:
				return pairingFailed
			}
			// Anything else (a scan by a phone without multi-device, a passkey step) is not an end: the codes go on.
		}
	}
}
