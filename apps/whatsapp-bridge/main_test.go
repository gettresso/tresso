package main

import (
	"bytes"
	"database/sql"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
)

// noConnect stands in for the connection to WhatsApp in every test that runs the bridge: nothing reaches WhatsApp.
func noConnect(t *testing.T) {
	t.Helper()
	saved := connect
	connect = func(*whatsmeow.Client) error { return nil }
	t.Cleanup(func() { connect = saved })
}

// stopWatch reports whether stop was called within the time limit.
func stopWatch() (func(), func(time.Duration) bool) {
	stopped := make(chan struct{})
	var once bool
	return func() {
			if !once {
				once = true
				close(stopped)
			}
		}, func(limit time.Duration) bool {
			select {
			case <-stopped:
				return true
			case <-time.After(limit):
				return false
			}
		}
}

func TestStdinEOFStops(t *testing.T) {
	r, w := io.Pipe()
	stop, stoppedWithin := stopWatch()
	go watchStdin(r, stop)

	// What the parent writes is read and dropped; the bridge keeps running.
	if _, err := w.Write([]byte("anything\n")); err != nil {
		t.Fatal(err)
	}
	if stoppedWithin(100 * time.Millisecond) {
		t.Fatal("stopped while stdin was still open")
	}
	w.Close()
	if !stoppedWithin(2 * time.Second) {
		t.Fatal("did not stop when stdin ended")
	}
}

func TestStdinErrorStops(t *testing.T) {
	r, w := io.Pipe()
	stop, stoppedWithin := stopWatch()
	go watchStdin(r, stop)
	w.CloseWithError(errors.New("broken"))
	if !stoppedWithin(2 * time.Second) {
		t.Fatal("did not stop when reading stdin failed")
	}
}

func TestSignalStops(t *testing.T) {
	for _, signal := range []os.Signal{syscall.SIGTERM, syscall.SIGINT} {
		signals := make(chan os.Signal, 1)
		stop, stoppedWithin := stopWatch()
		go watchSignals(t.Context(), signals, stop)
		signals <- signal
		if !stoppedWithin(2 * time.Second) {
			t.Fatalf("did not stop at %v", signal)
		}
	}
}

func TestDeviceName(t *testing.T) {
	saved := store.DeviceProps.GetOs()
	t.Cleanup(func() { store.DeviceProps.Os = &saved })
	setDeviceName()
	if got := store.DeviceProps.GetOs(); got != "Tresso" {
		t.Fatalf("device name %q, want Tresso", got)
	}
}

// runBridge runs the bridge with env and stdin, and returns its exit status, stdout and stderr.
func runBridge(t *testing.T, values map[string]string, stdin io.Reader, signals chan os.Signal) (int, string, string) {
	t.Helper()
	if signals == nil {
		signals = make(chan os.Signal, 1)
	}
	var out, diag bytes.Buffer
	status := run(env(values), stdin, signals, newEmitter(&out), &diagnostics{w: &diag})
	return status, out.String(), diag.String()
}

func TestRunRefusesWithoutItsSettings(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "store")
	good := map[string]string{envStore: dir, envPort: "8741", envToken: testToken}
	cases := []struct {
		name   string
		change func(map[string]string)
		code   string
	}{
		{"no token", func(v map[string]string) { delete(v, envToken) }, "bad_token"},
		{"empty token", func(v map[string]string) { v[envToken] = "" }, "bad_token"},
		{"no port", func(v map[string]string) { delete(v, envPort) }, "bad_port"},
		{"no store", func(v map[string]string) { delete(v, envStore) }, "bad_store"},
		{"relative store", func(v map[string]string) { v[envStore] = "store" }, "bad_store"},
		{"group writable store", func(v map[string]string) { v[envStore] = folderWithMode(t, 0o775) }, "bad_store"},
		{"world writable store", func(v map[string]string) { v[envStore] = folderWithMode(t, 0o757) }, "bad_store"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			values := map[string]string{}
			for k, v := range good {
				values[k] = v
			}
			tc.change(values)
			status, out, diag := runBridge(t, values, strings.NewReader(""), nil)
			if status != 1 {
				t.Errorf("exit status %d, want 1", status)
			}
			if want := `{"v":1,"event":"fatal","code":"` + tc.code + `"}` + "\n"; out != want {
				t.Errorf("stdout %q, want %q", out, want)
			}
			if strings.Count(diag, "\n") != 1 || strings.Contains(diag, testToken) || (values[envStore] != "" && strings.Contains(diag, values[envStore])) {
				t.Errorf("stderr %q", diag)
			}
			// Nothing was created for a bridge that did not start.
			if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
				t.Errorf("the store was created: %v", err)
			}
		})
	}
}

// With a valid environment the bridge prepares its store, opens both databases and waits for a scan; when stdin
// ends it stops cleanly with status 0 and nothing but events on stdout. (connect is replaced: no QR code comes.)
func TestRunStopsCleanlyWhenStdinEnds(t *testing.T) {
	noConnect(t)
	dir := filepath.Join(t.TempDir(), "Application Support", "store")
	values := map[string]string{envStore: dir, envPort: "8741", envToken: testToken}
	r, w := io.Pipe()
	result := make(chan [3]any, 1)
	go func() {
		status, out, diag := runBridge(t, values, r, nil)
		result <- [3]any{status, out, diag}
	}()

	// The bridge keeps running while stdin is open.
	select {
	case got := <-result:
		t.Fatalf("stopped with stdin open: %v", got)
	case <-time.After(500 * time.Millisecond):
	}
	w.Close()
	var got [3]any
	select {
	case got = <-result:
	case <-time.After(10 * time.Second):
		t.Fatal("did not stop after stdin ended")
	}
	if status := got[0].(int); status != 0 {
		t.Errorf("exit status %d, want 0", status)
	}
	if out := got[1].(string); out != "" {
		t.Errorf("stdout %q, want nothing (no event happened)", out)
	}
	if diag := got[2].(string); diag != "" {
		t.Errorf("stderr %q", diag)
	}

	assertMode(t, dir, 0o700)
	assertMode(t, filepath.Join(dir, "whatsapp.db"), 0o600)
	assertMode(t, filepath.Join(dir, "messages.db"), 0o600)
	for _, name := range []string{"whatsapp.db-wal", "whatsapp.db-journal", "messages.db-wal", "messages.db-journal"} {
		if info, err := os.Stat(filepath.Join(dir, name)); err == nil && info.Mode().Perm() != 0o600 {
			t.Errorf("%s: mode %o", name, info.Mode().Perm())
		}
	}

	// whatsmeow made its tables with the pure Go driver, with the columns the desktop app reads.
	db, err := sql.Open(sqliteDriver, sqliteDSN(filepath.Join(dir, "whatsapp.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for table, columns := range map[string][]string{
		"whatsmeow_device":   {"jid", "push_name"},
		"whatsmeow_contacts": {"their_jid", "full_name", "push_name", "business_name"},
		"whatsmeow_lid_map":  {"lid", "pn"},
	} {
		for _, column := range columns {
			var found int
			if err := db.QueryRow("SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?", table, column).Scan(&found); err != nil || found != 1 {
				t.Errorf("%s.%s: %d, %v", table, column, found, err)
			}
		}
	}
}

func TestRunStopsAtSIGTERM(t *testing.T) {
	noConnect(t)
	values := map[string]string{envStore: filepath.Join(t.TempDir(), "store"), envPort: "8741", envToken: testToken}
	r, w := io.Pipe()
	defer w.Close()
	signals := make(chan os.Signal, 1)
	result := make(chan int, 1)
	go func() {
		status, _, _ := runBridge(t, values, r, signals)
		result <- status
	}()
	time.Sleep(300 * time.Millisecond)
	signals <- syscall.SIGTERM
	select {
	case status := <-result:
		if status != 0 {
			t.Errorf("exit status %d, want 0", status)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("did not stop at SIGTERM")
	}
}
