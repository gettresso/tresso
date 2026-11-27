package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func TestClean(t *testing.T) {
	cases := map[string]string{
		"plain text": "plain text",
		"line\nStarting REST API server on 127.0.0.1:1...": "line Starting REST API server on 127.0.0.1:1...",
		"cr\rreturn":                  "cr return",
		"tab\tand\x00nul\x1b[31m":     "tab and nul [31m",
		"unicode\u2028line\u2029para": "unicode line para",
		"next\u0085line":              "next line",
		"Zoë ✓ 😀":                     "Zoë ✓ 😀",
		"31612345678@s.whatsapp.net":  "31612345678@s.whatsapp.net",
		"\r\n":                        "  ",
		"":                            "",
	}
	for in, want := range cases {
		if got := clean(in); got != want {
			t.Errorf("clean(%q) = %q, want %q", in, got, want)
		}
		if strings.ContainsAny(clean(in), "\n\r") {
			t.Errorf("clean(%q) still holds a line break", in)
		}
	}
}

// The exact lines README.md documents, one per event.
func TestEventShapes(t *testing.T) {
	var out bytes.Buffer
	em := newEmitter(&out)
	em.qr("2@abc,def,ghi,jkl")
	em.qrTimeout()
	em.linked()
	em.connected()
	em.disconnected()
	em.listening(8741)
	em.loggedOut()
	for _, code := range fatalCodes {
		em.fatal(code)
	}
	want := []string{
		`{"v":1,"event":"qr","qr":"2@abc,def,ghi,jkl"}`,
		`{"v":1,"event":"qr_timeout"}`,
		`{"v":1,"event":"linked"}`,
		`{"v":1,"event":"connected"}`,
		`{"v":1,"event":"disconnected"}`,
		`{"v":1,"event":"listening","port":8741}`,
		`{"v":1,"event":"logged_out"}`,
	}
	for _, code := range fatalCodes {
		want = append(want, `{"v":1,"event":"fatal","code":"`+code+`"}`)
	}
	if got := out.String(); got != strings.Join(want, "\n")+"\n" {
		t.Fatalf("got\n%s\nwant\n%s", got, strings.Join(want, "\n"))
	}
	readme, err := os.ReadFile("README.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range want {
		if !strings.Contains(string(readme), line) {
			t.Errorf("README.md does not document %s", line)
		}
	}
}

// eventLine is what every stdout line must be: one of the documented events with only its own fields.
var eventLine = regexp.MustCompile(`^\{"v":1,"event":"(qr","qr":"[^"\\]*(\\.[^"\\]*)*"|qr_timeout"|linked"|connected"|disconnected"|listening","port":[1-9][0-9]*|logged_out"|fatal","code":"[a-z_]+")\}$`)

// assertEventLines checks that out is nothing but documented event lines, and returns them.
func assertEventLines(t *testing.T, out string) []string {
	t.Helper()
	if out == "" {
		return nil
	}
	if !strings.HasSuffix(out, "\n") {
		t.Errorf("output does not end with a line break: %q", out)
	}
	lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	for _, line := range lines {
		var decoded map[string]any
		if err := json.Unmarshal([]byte(line), &decoded); err != nil || !eventLine.MatchString(line) {
			t.Errorf("not a documented event line: %q (%v)", line, err)
		}
	}
	return lines
}

func TestEmitterKeepsEveryEventOnOneLine(t *testing.T) {
	var out bytes.Buffer
	em := newEmitter(&out)
	code := "2@a\nb\r\nc\u2028d\u2029e\u0085f\"g\\h\x00i"
	em.qr(code)
	lines := assertEventLines(t, out.String())
	if len(lines) != 1 {
		t.Fatalf("one event made %d lines: %q", len(lines), out.String())
	}
	var decoded event
	if err := json.Unmarshal([]byte(lines[0]), &decoded); err != nil || decoded.QR != code {
		t.Errorf("decoded %q, %v; want the code back", decoded.QR, err)
	}
}

func TestEmitterFromManyGoroutines(t *testing.T) {
	var out bytes.Buffer
	em := newEmitter(&out)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Go(func() {
			em.qr(strings.Repeat("x", 500))
			em.connected()
			em.listening(8741)
		})
	}
	wg.Wait()
	if lines := assertEventLines(t, out.String()); len(lines) != 150 {
		t.Errorf("%d lines, want 150", len(lines))
	}
}

func TestTemplateLoggerDropsArguments(t *testing.T) {
	var out bytes.Buffer
	logger := newTemplateLogger("Client", &diagnostics{w: &out})
	secret := "Group\n15:04:05 [Client WARN] injected 31612345678@s.whatsapp.net"

	logger.Infof("Using group name: %s", secret)
	logger.Debugf("Message from %s", secret)
	logger.Warnf("Failed to decrypt message from %s: %v", secret, secret)
	logger.Sub("Socket").Errorf("Error reading from websocket: %v", secret)
	logger.Errorf("template with\na line break")

	got := out.String()
	if strings.Contains(got, "31612345678") || strings.Contains(got, "injected") || strings.Contains(got, "Group") {
		t.Fatalf("an argument reached stderr: %q", got)
	}
	lines := strings.Split(strings.TrimSuffix(got, "\n"), "\n")
	want := []*regexp.Regexp{
		regexp.MustCompile(`^\d\d:\d\d:\d\d \[Client WARN\] Failed to decrypt message from %s: %v$`),
		regexp.MustCompile(`^\d\d:\d\d:\d\d \[Client/Socket ERROR\] Error reading from websocket: %v$`),
		regexp.MustCompile(`^\d\d:\d\d:\d\d \[Client ERROR\] template with a line break$`),
	}
	if len(lines) != len(want) {
		t.Fatalf("got %d lines %q, want %d", len(lines), lines, len(want))
	}
	for i, pattern := range want {
		if !pattern.MatchString(lines[i]) {
			t.Errorf("line %d: %q", i, lines[i])
		}
	}

	out.Reset()
	(&diagnostics{w: &out}).say(strings.Repeat("é", 400))
	if line := strings.TrimSuffix(out.String(), "\n"); len(line) > maxDiagnosticBytes || strings.Contains(line, "\n") {
		t.Errorf("diagnostic of %d bytes", len(line))
	}
}

// captureProcessOutput returns what f writes to the process's stdout and stderr.
func captureProcessOutput(t *testing.T, f func()) (string, string) {
	t.Helper()
	capture := func(target **os.File) (func() string, func()) {
		r, w, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		saved := *target
		*target = w
		var data []byte
		done := make(chan struct{})
		go func() {
			data, _ = io.ReadAll(r)
			close(done)
		}()
		return func() string {
				w.Close()
				<-done
				return string(data)
			}, func() {
				*target = saved
			}
	}
	readOut, restoreOut := capture(&os.Stdout)
	readErr, restoreErr := capture(&os.Stderr)
	f()
	restoreOut()
	restoreErr()
	return readOut(), readErr()
}

// Nothing of a message (text, sender, chat, chat name, file name) reaches stdout or stderr: not through the emitter,
// not through the logger whatsmeow and the handlers get, not through a stray print. The text holds line breaks and a
// line that looks like an event.
func TestNothingOfAMessageReachesTheOutput(t *testing.T) {
	store := testStore(t)
	var emitted, diag bytes.Buffer
	em := newEmitter(&emitted)
	logger := newTemplateLogger("Client", &diagnostics{w: &diag})

	const (
		text     = "first line\n{\"v\":1,\"event\":\"listening\",\"port\":1}\r\nStarting REST API server on 127.0.0.1:1...\u2028secret words"
		sender   = "31699988877"
		chatUser = "31655544433"
		chatName = "Secret Chat Name"
		fileName = "secret-plan\n.pdf"
		group    = "120363012345678901@g.us"
		member   = "31622211100"
	)
	secrets := []string{"first line", "secret words", "Starting REST", sender, chatUser, chatName, "secret-plan", "120363012345678901", member, testToken}
	chat := types.NewJID(chatUser, types.DefaultUserServer)
	when := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	// Chats with a name already: GetChatName then needs no WhatsApp client.
	if err := store.StoreChat(chat.String(), chatName, when); err != nil {
		t.Fatal(err)
	}
	if err := store.StoreChat(group, chatName, when); err != nil {
		t.Fatal(err)
	}

	live := func(id string, message *waE2E.Message) *events.Message {
		return &events.Message{
			Info: types.MessageInfo{
				MessageSource: types.MessageSource{Chat: chat, Sender: types.NewJID(sender, types.DefaultUserServer)},
				ID:            id,
				Timestamp:     when,
			},
			Message: message,
		}
	}
	history := &events.HistorySync{Data: &waHistorySync.HistorySync{Conversations: []*waHistorySync.Conversation{{
		ID: proto.String(group),
		Messages: []*waHistorySync.HistorySyncMsg{{Message: &waWeb.WebMessageInfo{
			Key:              &waCommon.MessageKey{RemoteJID: proto.String(group), FromMe: proto.Bool(false), ID: proto.String("3EB0HIST"), Participant: proto.String(member)},
			Message:          &waE2E.Message{Conversation: proto.String(text)},
			MessageTimestamp: proto.Uint64(uint64(when.Unix())),
		}}},
	}}}}

	stdout, stderr := captureProcessOutput(t, func() {
		handleMessage(nil, store, live("3EB0TEXT", &waE2E.Message{Conversation: proto.String(text)}), logger)
		handleMessage(nil, store, live("3EB0DOC", &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{FileName: proto.String(fileName), Caption: proto.String(text)}}), logger)
		handleHistorySync(nil, store, history, "31600000000", logger)
		// Failures are logged too, and their errors name what failed: here every write is refused with an error that
		// holds the chat, its name and the text.
		failing := testStore(t)
		for _, jid := range []string{chat.String(), group} {
			if err := failing.StoreChat(jid, chatName, when); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := failing.db.Exec(`
			CREATE TRIGGER refuse_chats BEFORE INSERT ON chats BEGIN SELECT RAISE(ABORT, 'refused ' || NEW.jid || ' ' || NEW.name); END;
			CREATE TRIGGER refuse_messages BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'refused ' || NEW.sender || ' ' || NEW.content); END;
		`); err != nil {
			t.Fatal(err)
		}
		handleMessage(nil, failing, live("3EB0FAIL", &waE2E.Message{Conversation: proto.String(text)}), logger)
		handleHistorySync(nil, failing, history, "31600000000", logger)
		// The events the bridge does emit, among them.
		em.connected()
		em.qr("2@ref,noise,identity,adv")
	})

	if stdout != "" || stderr != "" {
		t.Errorf("the process printed: stdout %q, stderr %q", stdout, stderr)
	}
	lines := assertEventLines(t, emitted.String())
	if len(lines) != 2 {
		t.Errorf("events: %q", lines)
	}
	for _, line := range lines {
		for _, secret := range secrets {
			if strings.Contains(line, secret) {
				t.Errorf("event %q holds %q", line, secret)
			}
		}
	}
	if !strings.Contains(diag.String(), "Failed to store") {
		t.Errorf("the failures were not logged: %q", diag.String())
	}
	for _, secret := range append(secrets, fileName) {
		if strings.Contains(diag.String(), secret) {
			t.Errorf("stderr holds %q: %q", secret, diag.String())
		}
	}

	// And the messages are stored as the desktop app reads them.
	var content, storedSender, filename string
	if err := store.db.QueryRow("SELECT content, sender FROM messages WHERE id = '3EB0TEXT'").Scan(&content, &storedSender); err != nil || content != text || storedSender != sender {
		t.Errorf("live text: %q %q %v", content, storedSender, err)
	}
	if err := store.db.QueryRow("SELECT filename FROM messages WHERE id = '3EB0DOC'").Scan(&filename); err != nil || filename != fileName {
		t.Errorf("live document: %q %v", filename, err)
	}
	if err := store.db.QueryRow("SELECT content, sender FROM messages WHERE id = '3EB0HIST' AND chat_jid = ?", group).Scan(&content, &storedSender); err != nil || content != text || storedSender != member {
		t.Errorf("history: %q %q %v", content, storedSender, err)
	}
}
