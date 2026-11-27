package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	signallog "go.mau.fi/libsignal/logger"
)

func TestRESTServerLimits(t *testing.T) {
	server := newRESTServer(http.NotFoundHandler())
	if server.ReadHeaderTimeout != 10*time.Second || server.ReadTimeout != 30*time.Second || server.IdleTimeout != 60*time.Second || server.MaxHeaderBytes != 16<<10 {
		t.Errorf("limits: header %v, read %v, idle %v, header bytes %d", server.ReadHeaderTimeout, server.ReadTimeout, server.IdleTimeout, server.MaxHeaderBytes)
	}
	if server.WriteTimeout != 0 {
		t.Errorf("write timeout %v: a download waits up to %v for the phone", server.WriteTimeout, mediaRetryTimeout)
	}
	if server.ReadTimeout <= server.ReadHeaderTimeout {
		t.Error("the read timeout leaves no time for the body")
	}
	if mediaRetryTimeout > idleTimeout {
		t.Error("the idle timeout is shorter than the wait for the phone")
	}
}

// sendRequest posts body to /api/send with the token, as the desktop app does.
func sendRequest(t *testing.T, body string) (int, string) {
	t.Helper()
	handler := protect(newRESTHandler(nil, nil), testToken, 8741)
	r := httptest.NewRequest(http.MethodPost, "/api/send", strings.NewReader(body))
	r.Host = "127.0.0.1:8741"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Bridge-Token", testToken)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w.Code, w.Body.String()
}

func TestSendRefusesMediaPaths(t *testing.T) {
	dir := t.TempDir()
	fifo := filepath.Join(dir, "pipe")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	large := filepath.Join(dir, "large.bin")
	file, err := os.Create(large)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(maxSendBytes + 1); err != nil {
		t.Fatal(err)
	}
	file.Close()
	cases := []struct {
		name, path, want string
	}{
		{"relative", "photo.jpg", "Media path must be absolute\n"},
		{"relative with dots", "../../etc/passwd", "Media path must be absolute\n"},
		{"a folder", dir, "Media path is not a regular file\n"},
		{"a FIFO", fifo, "Media path is not a regular file\n"},
		{"a device", "/dev/zero", "Media path is not a regular file\n"},
		{"too large", large, "Media file is larger than 100 MB\n"},
		{"missing", filepath.Join(dir, "missing.jpg"), "Media file cannot be read\n"},
	}
	for _, tc := range cases {
		body := fmt.Sprintf(`{"recipient":"31612345678","message":"hi","media_path":%q}`, tc.path)
		done := make(chan struct{})
		var status int
		var answer string
		go func() {
			status, answer = sendRequest(t, body)
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: the request blocked", tc.name)
		}
		if status != 400 || answer != tc.want {
			t.Errorf("%s: got %d %q, want 400 %q", tc.name, status, answer, tc.want)
		}
	}

	// The absolute-path check comes before everything else, even before a missing recipient.
	if status, answer := sendRequest(t, `{"media_path":"x.jpg"}`); status != 400 || answer != "Media path must be absolute\n" {
		t.Errorf("relative path without recipient: %d %q", status, answer)
	}
	// The probe still answers as the desktop app expects.
	if status, answer := sendRequest(t, `{}`); status != 400 || answer != "Recipient is required\n" {
		t.Errorf("probe: %d %q", status, answer)
	}
}

func TestReadMedia(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "photo.jpg")
	if err := os.WriteFile(path, []byte("jpeg"), 0o600); err != nil {
		t.Fatal(err)
	}
	if data, err := readMedia(path); err != nil || string(data) != "jpeg" {
		t.Errorf("a regular file: %q, %v", data, err)
	}
	// A link to a regular file is followed, as the desktop's canonical path would be.
	link := filepath.Join(dir, "link.jpg")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if data, err := readMedia(link); err != nil || string(data) != "jpeg" {
		t.Errorf("a link to a regular file: %q, %v", data, err)
	}
	exact := filepath.Join(dir, "exact.bin")
	file, err := os.Create(exact)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(maxSendBytes); err != nil {
		t.Fatal(err)
	}
	file.Close()
	if data, err := readMedia(exact); err != nil || len(data) != maxSendBytes {
		t.Errorf("a file of exactly 100 MB: %d bytes, %v", len(data), err)
	}
	fifo := filepath.Join(dir, "pipe")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]error{fifo: errMediaNotFile, "/dev/zero": errMediaNotFile, "relative.jpg": errMediaNotAbsolute} {
		if _, err := readMedia(path); !errors.Is(err, want) {
			t.Errorf("%s: got %v, want %v", path, err, want)
		}
	}
}

// The recipients the desktop app sends (valid_recipient and valid_jid in whatsapp.rs) pass; nothing else does.
func TestRecipients(t *testing.T) {
	valid := map[string]string{
		"31612345678":                   "31612345678@s.whatsapp.net",
		"1":                             "1@s.whatsapp.net",
		strings.Repeat("9", 32):         strings.Repeat("9", 32) + "@s.whatsapp.net",
		"31612345678@s.whatsapp.net":    "31612345678@s.whatsapp.net",
		"120363012345678901@g.us":       "120363012345678901@g.us",
		"123456789012345@lid":           "123456789012345@lid",
		"31612345678:12@s.whatsapp.net": "31612345678:12@s.whatsapp.net",
	}
	for recipient, want := range valid {
		jid, err := recipientJID(recipient)
		if err != nil || jid.String() != want {
			t.Errorf("recipientJID(%q) = %q, %v; want %q", recipient, jid.String(), err, want)
		}
	}
	for _, recipient := range []string{
		"", strings.Repeat("9", 33), "+31612345678", "0031 612345678", "status@broadcast", "31612345678@broadcast",
		"120363012345678901@newsletter", "31612345678@example.com", "@s.whatsapp.net", "a b@s.whatsapp.net",
		"a/b@s.whatsapp.net", "x@g.us@g.us", strings.Repeat("a", 129) + "@g.us", "Mom", "31612345678@S.WHATSAPP.NET",
	} {
		if jid, err := recipientJID(recipient); err == nil {
			t.Errorf("recipientJID(%q) = %q, want an error", recipient, jid.String())
		}
	}
	for _, recipient := range []string{"status@broadcast", "120363012345678901@newsletter", "Mom"} {
		if status, answer := sendRequest(t, fmt.Sprintf(`{"recipient":%q,"message":"hi"}`, recipient)); status != 400 || answer != "Recipient is not valid\n" {
			t.Errorf("%q through the API: %d %q", recipient, status, answer)
		}
	}
}

// oggPage builds one Ogg page holding payload, with the granule position and page number given.
func oggPage(granule uint64, sequence uint32, payload []byte) []byte {
	var page bytes.Buffer
	page.WriteString("OggS")
	page.Write([]byte{0, 0})
	binary.Write(&page, binary.LittleEndian, granule)
	page.Write(make([]byte, 4))
	binary.Write(&page, binary.LittleEndian, sequence)
	page.Write(make([]byte, 4))
	var segments []byte
	rest := len(payload)
	for rest >= 255 {
		segments = append(segments, 255)
		rest -= 255
	}
	segments = append(segments, byte(rest))
	page.WriteByte(byte(len(segments)))
	page.Write(segments)
	page.Write(payload)
	return page.Bytes()
}

func opusHead(preSkip uint16, inputRate uint32) []byte {
	head := []byte("OpusHead")
	head = append(head, 1, 1)
	head = binary.LittleEndian.AppendUint16(head, preSkip)
	head = binary.LittleEndian.AppendUint32(head, inputRate)
	return append(head, 0, 0, 0)
}

func TestAnalyzeOggOpus(t *testing.T) {
	// Five seconds after the pre-skip; the input rate in the head (44.1 kHz) does not change the granule's 48 kHz.
	file := append(oggPage(0, 0, opusHead(312, 44100)), oggPage(0, 1, []byte("OpusTags"))...)
	file = append(file, oggPage(312+5*48000, 2, make([]byte, 100))...)
	if seconds, waveform, err := analyzeOggOpus(file); err != nil || seconds != 5 || len(waveform) != 64 {
		t.Errorf("a valid file: %d seconds, %d bytes of waveform, %v; want 5, 64", seconds, len(waveform), err)
	}
	// Long recordings are capped.
	long := append(oggPage(0, 0, opusHead(0, 48000)), oggPage(48000*1000, 1, nil)...)
	if seconds, _, _ := analyzeOggOpus(long); seconds != 300 {
		t.Errorf("a long file: %d seconds, want 300", seconds)
	}
	// The same file cut short anywhere never panics and always gives a duration of 1 to 300 seconds.
	for cut := 0; cut <= len(file); cut++ {
		seconds, _, err := analyzeOggOpus(file[:cut])
		if err == nil && (seconds < 1 || seconds > 300) {
			t.Errorf("cut at %d: %d seconds", cut, seconds)
		}
	}
}

// A page with granule position -1 ends no packet: the last real position counts, not -1 (which would give 300 s).
func TestAnalyzeOggOpusSkipsGranuleMinusOne(t *testing.T) {
	file := append(oggPage(0, 0, opusHead(0, 48000)), oggPage(3*48000, 1, make([]byte, 10))...)
	file = append(file, oggPage(math.MaxUint64, 2, make([]byte, 10))...)
	if seconds, _, err := analyzeOggOpus(file); err != nil || seconds != 3 {
		t.Errorf("got %d seconds, %v; want 3", seconds, err)
	}
}

func TestAnalyzeOggOpusMalformed(t *testing.T) {
	shortHead := oggPage(0, 0, []byte("OpusHead\x01\x01\x38")) // the head ends inside the pre-skip
	pageTooLong := oggPage(0, 0, opusHead(0, 48000))
	pageTooLong[27] = 255 // the segment table claims more than the file has
	inputs := map[string][]byte{
		"empty":                    nil,
		"magic only":               []byte("OggS"),
		"header cut":               []byte("OggS\x00\x00\x01\x02\x03"),
		"header without segments":  append([]byte("OggS"), make([]byte, 23)...),
		"segment count past end":   append(append([]byte("OggS"), make([]byte, 22)...), 200),
		"short OpusHead page":      shortHead,
		"OpusHead at the page end": oggPage(0, 0, []byte("OpusHead")),
		"page longer than file":    pageTooLong,
		"granule below pre-skip":   append(oggPage(0, 0, opusHead(65535, 48000)), oggPage(100, 1, nil)...),
		"many magics":              bytes.Repeat([]byte("OggS"), 1000),
		"all 0xff after magic":     append([]byte("OggS"), bytes.Repeat([]byte{0xff}, 300)...),
	}
	for name, input := range inputs {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("%s: panic", name)
				}
			}()
			seconds, _, err := analyzeOggOpus(input)
			if err == nil && (seconds < 1 || seconds > 300) {
				t.Errorf("%s: %d seconds", name, seconds)
			}
		}()
	}
}

func FuzzAnalyzeOggOpus(f *testing.F) {
	f.Add([]byte("OggS"))
	f.Add(oggPage(0, 0, opusHead(312, 48000)))
	f.Add(oggPage(0, 0, []byte("OpusHead\x01")))
	f.Fuzz(func(t *testing.T, data []byte) {
		seconds, _, err := analyzeOggOpus(data)
		if err == nil && (seconds < 1 || seconds > 300) {
			t.Errorf("%d seconds", seconds)
		}
	})
}

func TestIsolateStdout(t *testing.T) {
	real := os.Stdout
	t.Cleanup(func() { os.Stdout = real })
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w

	// /dev/null cannot be opened: os.Stdout becomes nil, and printing to it neither panics nor reaches the real stdout.
	got := isolateStdout(func() (*os.File, error) { return nil, errors.New("no /dev/null") })
	if got != w {
		t.Fatal("the emitter did not get the real stdout")
	}
	if os.Stdout != nil {
		t.Fatalf("os.Stdout is %v, want nil", os.Stdout)
	}
	fmt.Println("a stray print")
	if _, err := os.Stdout.Write([]byte("x")); !errors.Is(err, os.ErrInvalid) {
		t.Errorf("a write to the nil stdout: %v", err)
	}

	// With /dev/null, stray prints go there.
	os.Stdout = w
	null, err := os.CreateTemp(t.TempDir(), "null")
	if err != nil {
		t.Fatal(err)
	}
	if got := isolateStdout(func() (*os.File, error) { return null, nil }); got != w || os.Stdout != null {
		t.Fatal("stdout not isolated")
	}
	fmt.Println("another stray print")

	newEmitter(got).connected()
	w.Close()
	out, _ := io.ReadAll(r)
	if string(out) != `{"v":1,"event":"connected"}`+"\n" {
		t.Errorf("the real stdout got %q", out)
	}
}

func TestSignalLogIsSilent(t *testing.T) {
	saved := signallog.Logger
	t.Cleanup(func() { signallog.Logger = saved })
	silenceSignalLog()
	if _, ok := signallog.Logger.(silentSignalLogger); !ok {
		t.Fatalf("libsignal logs with %T", signallog.Logger)
	}
	stdout, stderr := captureProcessOutput(t, func() {
		signallog.Logger.Info("Session.go", "message from 31612345678")
		signallog.Logger.Warning("Session.go", "secret")
		signallog.Logger.Error("Session.go", "secret")
	})
	if stdout != "" || stderr != "" {
		t.Errorf("libsignal printed: %q %q", stdout, stderr)
	}
}

const panicSecret = "a message text 31612345678"

func TestPanicInTheMainGoroutine(t *testing.T) {
	var out, diag bytes.Buffer
	status := runProtected(&outcome{}, newEmitter(&out), &diagnostics{w: &diag}, func() int { panic(panicSecret) })
	if status != 1 || out.String() != `{"v":1,"event":"fatal","code":"panic"}`+"\n" {
		t.Errorf("status %d, stdout %q", status, out.String())
	}
	if strings.Contains(diag.String(), "31612345678") || !strings.Contains(diag.String(), panicReason) {
		t.Errorf("stderr %q", diag.String())
	}
	if status := runProtected(&outcome{}, newEmitter(&out), &diagnostics{w: &diag}, func() int { return 0 }); status != 0 {
		t.Errorf("no panic: status %d", status)
	}
}

// A panic after another fatal event already went out adds no second fatal line.
func TestOneFatalEventPerRun(t *testing.T) {
	var out, diag bytes.Buffer
	var end outcome
	em, d := newEmitter(&out), &diagnostics{w: &diag}
	status := runProtected(&end, em, d, func() int {
		end.fail(em, d, fatal("listen_failed", "the REST API cannot listen on its port", nil), func() {})
		panic(panicSecret)
	})
	if status != 1 || out.String() != `{"v":1,"event":"fatal","code":"listen_failed"}`+"\n" {
		t.Errorf("status %d, stdout %q", status, out.String())
	}
	if strings.Count(diag.String(), "\n") != 1 {
		t.Errorf("stderr %q", diag.String())
	}

	// And the other way round: after a panic in a goroutine, a panic of the main goroutine adds nothing.
	out.Reset()
	var second outcome
	second.guard(em, d, func() {}, func() { panic(panicSecret) })
	status = runProtected(&second, em, d, func() int { panic(panicSecret) })
	if status != 1 || out.String() != `{"v":1,"event":"fatal","code":"panic"}`+"\n" {
		t.Errorf("status %d, stdout %q", status, out.String())
	}
}

func TestPanicInAGoroutine(t *testing.T) {
	var out, diag bytes.Buffer
	var end outcome
	stopped := make(chan struct{})
	done := make(chan struct{})
	go func() {
		end.guard(newEmitter(&out), &diagnostics{w: &diag}, func() { close(stopped) }, func() { panic(errors.New(panicSecret)) })
		close(done)
	}()
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("a panic did not stop the bridge")
	}
	<-done
	if end.status() != 1 || out.String() != `{"v":1,"event":"fatal","code":"panic"}`+"\n" {
		t.Errorf("status %d, stdout %q", end.status(), out.String())
	}
	if strings.Contains(diag.String(), "31612345678") {
		t.Errorf("stderr %q", diag.String())
	}
}
