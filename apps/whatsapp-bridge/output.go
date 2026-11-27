package main

import (
	"encoding/json"
	"io"
	"strings"
	"sync"
	"time"
	"unicode"

	waLog "go.mau.fi/whatsmeow/util/log"
)

// eventVersion is the version of the stdout event shapes. It changes only when a shape changes in a way an older
// reader would misread.
const eventVersion = 1

// event is one line on stdout. Only the fields an event names are set; see README.md for every shape.
type event struct {
	V     int    `json:"v"`
	Event string `json:"event"`
	// QR is the string to encode as a QR code (event "qr").
	QR string `json:"qr,omitempty"`
	// Port is the port the REST API listens on (event "listening").
	Port int `json:"port,omitempty"`
	// Code says why the bridge stops (event "fatal").
	Code string `json:"code,omitempty"`
}

// emitter writes events to stdout, one JSON object per line and nothing else. It has no way to write a message, a
// sender, a chat name, a file name or the token: each method takes only what its event carries.
type emitter struct {
	mu sync.Mutex
	w  io.Writer
}

func newEmitter(w io.Writer) *emitter {
	return &emitter{w: w}
}

// emit writes one event. encoding/json escapes every control character and U+2028/U+2029, so a value can never
// make a second line.
func (e *emitter) emit(ev event) {
	ev.V = eventVersion
	line, err := json.Marshal(ev)
	if err != nil {
		return
	}
	line = append(line, '\n')
	e.mu.Lock()
	defer e.mu.Unlock()
	// A reader that went away is the parent that quit: stdin's end stops the bridge, nothing to do here.
	_, _ = e.w.Write(line)
}

// qr asks the reader to show code as a QR code for the phone to scan.
func (e *emitter) qr(code string) { e.emit(event{Event: "qr", QR: code}) }

// qrTimeout says the phone did not scan any of the codes in time. The bridge stops after it.
func (e *emitter) qrTimeout() { e.emit(event{Event: "qr_timeout"}) }

// linked says a phone scanned the code and this device is now linked.
func (e *emitter) linked() { e.emit(event{Event: "linked"}) }

// connected says the bridge is connected to WhatsApp (after a start, a link or a reconnect).
func (e *emitter) connected() { e.emit(event{Event: "connected"}) }

// disconnected says WhatsApp closed the connection; whatsmeow reconnects by itself.
func (e *emitter) disconnected() { e.emit(event{Event: "disconnected"}) }

// listening says the REST API accepts requests on 127.0.0.1:port.
func (e *emitter) listening(port int) { e.emit(event{Event: "listening", Port: port}) }

// loggedOut says the phone removed this device. The bridge stops after it.
func (e *emitter) loggedOut() { e.emit(event{Event: "logged_out"}) }

// fatal says the bridge stops because of code (one of fatalCodes).
func (e *emitter) fatal(code string) { e.emit(event{Event: "fatal", Code: code}) }

// fatalCodes are every code a fatal event carries.
var fatalCodes = []string{
	"bad_port", "bad_token", "bad_store", "store_failed", "connect_failed", "not_connected", "pair_failed",
	"client_outdated", "stream_replaced", "temporary_ban", "listen_failed", "server_failed", "panic",
}

// diagnostics writes short lines to stderr. Every line is a fixed text from this program, or a log format string of
// whatsmeow without its arguments: never a value that came from WhatsApp, a request or the environment.
type diagnostics struct {
	mu sync.Mutex
	w  io.Writer
}

// maxDiagnosticBytes cuts a diagnostic line, so stderr stays short lines.
const maxDiagnosticBytes = 300

func (d *diagnostics) line(module, level, text string) {
	line := clean(time.Now().Format("15:04:05") + " [" + module + " " + level + "] " + text)
	if len(line) > maxDiagnosticBytes {
		line = cutAtRune(line, maxDiagnosticBytes)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	_, _ = io.WriteString(d.w, line+"\n")
}

// say writes a fixed text of this program.
func (d *diagnostics) say(text string) { d.line("Bridge", "INFO", text) }

// templateLogger is the logger whatsmeow gets. It prints warnings and errors as their format string only: the
// arguments hold JIDs, names, message ids and error texts with any of those, so they are dropped. Every whatsmeow log
// call passes a literal format string, so the template itself holds nothing from outside.
type templateLogger struct {
	module string
	out    *diagnostics
}

func newTemplateLogger(module string, out *diagnostics) waLog.Logger {
	return &templateLogger{module: module, out: out}
}

func (l *templateLogger) Errorf(msg string, _ ...any) { l.out.line(l.module, "ERROR", msg) }
func (l *templateLogger) Warnf(msg string, _ ...any)  { l.out.line(l.module, "WARN", msg) }
func (l *templateLogger) Infof(string, ...any)        {}
func (l *templateLogger) Debugf(string, ...any)       {}
func (l *templateLogger) Sub(module string) waLog.Logger {
	return &templateLogger{module: l.module + "/" + module, out: l.out}
}

// clean makes a text safe to print on one line: every control character, line breaks and tabs included, and the
// Unicode line and paragraph separators become a space.
func clean(value string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '\u2028' || r == '\u2029' || r == '\u0085' {
			return ' '
		}
		return r
	}, value)
}
