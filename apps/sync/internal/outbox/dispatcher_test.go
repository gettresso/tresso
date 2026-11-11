package outbox

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"

	"tresso/sync/internal/api"
	"tresso/sync/internal/blobcrypt"
	"tresso/sync/internal/fakeapi"
	"tresso/sync/internal/imapsync"
	"tresso/sync/internal/providerhttp"
	"tresso/sync/internal/providersend"
	"tresso/sync/internal/smtpsend"
	"tresso/sync/internal/storage/storagetest"
)

type report struct {
	id, outcome, text string
	copied            bool
}

type mailboxReport struct {
	id, outcome, text, remoteUID string
}

type unsubscribeReport struct {
	id, outcome, text string
}

type fakeAPI struct {
	mu       sync.Mutex
	provider string // "imap" unless a test says otherwise
	smtpHost string
	queue    [][]api.OutgoingMessage
	reports  []report
	claims   int
	active   int
	overlap  bool
	gate     chan struct{}
	drafts   api.DraftWork
	filed    []string
	removed  []string
	changes  []api.MailboxChange
	changed  []mailboxReport
	// unsubscribes are claimed once; reportErr answers every unsubscribe report.
	unsubscribes []api.UnsubscribeRequest
	unsubscribed []unsubscribeReport
	reportErr    error
	// reportErrs answer the next outcome reports, one each; reportCalls counts every outcome report.
	reportErrs  []error
	reportCalls int
}

func (f *fakeAPI) ClaimUnsubscribes(context.Context, string, string) ([]api.UnsubscribeRequest, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	claimed := f.unsubscribes
	f.unsubscribes = nil
	return claimed, nil
}

func (f *fakeAPI) ReportUnsubscribe(_ context.Context, _, requestID, _, outcome, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.unsubscribed = append(f.unsubscribed, unsubscribeReport{requestID, outcome, text})
	return f.reportErr
}

// fakeUnsubscriber records the addresses it posts to and answers with the outcome queued for each.
type fakeUnsubscriber struct {
	posted   []string
	outcomes map[string][2]string
	// before runs at the start of every post: a test looks at what happened first, or lets time pass.
	before func()
}

func (u *fakeUnsubscriber) Post(_ context.Context, url string) (outcome, text string) {
	if u.before != nil {
		u.before()
	}
	u.posted = append(u.posted, url)
	if answer, ok := u.outcomes[url]; ok {
		return answer[0], answer[1]
	}
	return api.UnsubscribeDone, ""
}

func (f *fakeAPI) ClaimMailbox(context.Context, string, string) ([]api.MailboxChange, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	claimed := f.changes
	f.changes = nil
	return claimed, nil
}

func (f *fakeAPI) ReportMailbox(_ context.Context, _, changeID, _, outcome, text, remoteUID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.changed = append(f.changed, mailboxReport{changeID, outcome, text, remoteUID})
	return nil
}

func (f *fakeAPI) ClaimDrafts(context.Context, string, string) (api.DraftWork, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	work := f.drafts
	f.drafts = api.DraftWork{}
	return work, nil
}

func (f *fakeAPI) ReportDraftFiled(_ context.Context, _, draftID, _ string, version int, messageID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.filed = append(f.filed, fmt.Sprintf("%s v%d %s", draftID, version, messageID))
	return nil
}

func (f *fakeAPI) ReportDraftRemoved(_ context.Context, _, removalID, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed = append(f.removed, removalID)
	return nil
}

func (f *fakeAPI) Credentials(context.Context, string, string) (api.Credentials, error) {
	if f.provider != "imap" {
		// Gmail and Microsoft accounts have no connection and no password, only an access token.
		return api.Credentials{
			AccountID: "a1",
			Provider:  f.provider,
			Secrets:   map[string]string{"type": "oauth2", "accessToken": "ya29.token", "expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339)},
		}, nil
	}
	return api.Credentials{
		AccountID:  "a1",
		Provider:   "imap",
		Connection: api.Connection{SMTP: api.ServerSettings{Host: f.smtpHost, Port: 465, Security: "tls"}, Username: "kim@company.example"},
		Secrets:    map[string]string{"type": "password", "password": "secret"},
	}, nil
}

func (f *fakeAPI) ClaimOutbox(context.Context, string, string) ([]api.OutgoingMessage, error) {
	f.mu.Lock()
	f.claims++
	f.active++
	if f.active > 1 {
		f.overlap = true
	}
	gate := f.gate
	var next []api.OutgoingMessage
	if len(f.queue) > 0 {
		next, f.queue = f.queue[0], f.queue[1:]
	}
	f.mu.Unlock()
	if gate != nil {
		<-gate
	}
	f.mu.Lock()
	f.active--
	f.mu.Unlock()
	return next, nil
}

func (f *fakeAPI) ReportOutbox(_ context.Context, _, messageID, _, outcome, text string, copied bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reportCalls++
	if len(f.reportErrs) > 0 {
		err := f.reportErrs[0]
		f.reportErrs = f.reportErrs[1:]
		return err
	}
	f.reports = append(f.reports, report{messageID, outcome, text, copied})
	return nil
}

type fakeSent struct {
	contains    map[string]bool
	containsErr error
	appended    [][]byte
	openErr     error
}

func (s *fakeSent) Contains(id string) (bool, error) { return s.contains[id], s.containsErr }
func (s *fakeSent) Append(raw []byte, _ time.Time) error {
	s.appended = append(s.appended, raw)
	return nil
}
func (s *fakeSent) Close() {}

type fakeDrafts struct {
	log        []string
	failAppend bool
}

func (s *fakeDrafts) AppendDraft(raw []byte, _ time.Time) error {
	if s.failAppend {
		return errors.New("append refused")
	}
	s.log = append(s.log, "append "+string(raw))
	return nil
}
func (s *fakeDrafts) Remove(messageID string) error {
	s.log = append(s.log, "remove "+messageID)
	return nil
}
func (s *fakeDrafts) Close() {}

// fakeMailbox records what it is asked to do and answers with the error queued for that change, if any.
type fakeMailbox struct {
	log    []string
	errors map[string]error
}

func (m *fakeMailbox) SetFlags(location api.MailboxLocation, seen, flagged *bool) error {
	m.log = append(m.log, fmt.Sprintf("flags %s/%s seen=%v flagged=%v", location.Folder, location.RemoteUID, show(seen), show(flagged)))
	return m.errors["flags "+location.Folder+"/"+location.RemoteUID]
}

func (m *fakeMailbox) Move(source api.MailboxLocation, target, _ string) (string, error) {
	m.log = append(m.log, fmt.Sprintf("move %s/%s to %s", source.Folder, source.RemoteUID, target))
	if err := m.errors["move "+source.Folder+"/"+source.RemoteUID]; err != nil {
		return "", err
	}
	return "77", nil
}

func (m *fakeMailbox) Close() {}

func show(flag *bool) string {
	if flag == nil {
		return "-"
	}
	return fmt.Sprint(*flag)
}

type harness struct {
	api     *fakeAPI
	sent    *fakeSent
	drafts  *fakeDrafts
	mailbox *fakeMailbox
	unsub   *fakeUnsubscriber
	finder  *fakeFinder
	store   *storagetest.Vault
	sends   []smtpsend.Envelope
	// via lists the transport of every send, and opened the transport of every Sent folder that was opened.
	via    []string
	opened []string
	fail   error
	mu     sync.Mutex
	d      *Dispatcher
}

// hello is the outgoing message every harness has stored.
var hello = []byte("Subject: Hi\r\n\r\nHello\r\n")

func newHarness(messages ...api.OutgoingMessage) *harness {
	h := &harness{api: &fakeAPI{provider: "imap", smtpHost: "smtp.company.example", queue: [][]api.OutgoingMessage{messages}}, sent: &fakeSent{contains: map[string]bool{}}, drafts: &fakeDrafts{}, mailbox: &fakeMailbox{errors: map[string]error{}}, unsub: &fakeUnsubscriber{outcomes: map[string][2]string{}}, store: storagetest.New()}
	h.store.PutAsAPI(blobcrypt.KindOutgoing, hello)
	password := func(c api.Credentials) error { _, err := c.Password(); return err }
	token := func(c api.Credentials) error { _, _, err := c.AccessToken(); return err }
	transports := map[string]Transport{"imap": &fakeTransport{h, "imap", password}, "gmail": &fakeTransport{h, "gmail", token}, "microsoft": &fakeTransport{h, "microsoft", token}}
	h.d = NewDispatcher(h.api, h.store, transports, h.unsub, "w1", slog.New(slog.NewTextHandler(io.Discard, nil)))
	return h
}

// fakeTransport records which provider's path a message took.
type fakeTransport struct {
	h     *harness
	name  string
	check func(api.Credentials) error
}

func (t *fakeTransport) Open(credentials api.Credentials) (Sender, error) {
	if err := t.check(credentials); err != nil {
		return nil, err
	}
	return t, nil
}

func (t *fakeTransport) Send(_ context.Context, message api.OutgoingMessage, _ []byte) error {
	envelope := smtpsend.Envelope{From: message.EnvelopeFrom, Recipients: message.Recipients}
	h := t.h
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sends = append(h.sends, envelope)
	h.via = append(h.via, t.name)
	return h.fail
}

func (t *fakeTransport) OpenSent(context.Context) (SentStore, error) {
	h := t.h
	h.mu.Lock()
	h.opened = append(h.opened, t.name)
	h.mu.Unlock()
	if h.sent.openErr != nil {
		return nil, h.sent.openErr
	}
	if h.finder != nil && t.name != "imap" {
		return h.finder, nil
	}
	return h.sent, nil
}

// fakeFinder is a provider's Sent lookup that finds earlier attempts by the outbox id.
type fakeFinder struct {
	*fakeSent
	sentBefore map[string]bool
	err        error
	since      time.Time
}

func (f *fakeFinder) SentBefore(message api.OutgoingMessage, _ []byte, since time.Time) (bool, error) {
	f.since = since
	return f.sentBefore[message.ID], f.err
}

func (t *fakeTransport) OpenDrafts(context.Context) (DraftsStore, error) {
	h := t.h
	h.mu.Lock()
	defer h.mu.Unlock()
	h.opened = append(h.opened, t.name+" drafts")
	return h.drafts, nil
}

func (t *fakeTransport) OpenMailbox(context.Context) (MailboxStore, error) {
	h := t.h
	h.mu.Lock()
	defer h.mu.Unlock()
	h.opened = append(h.opened, t.name+" mailbox")
	return h.mailbox, nil
}

func (h *harness) run() {
	h.d.Trigger(context.Background(), "a1")
	h.d.Wait()
}

func message(id string, attempt int) api.OutgoingMessage {
	return api.OutgoingMessage{ID: id, RawObjectKey: storagetest.KeyOf(blobcrypt.KindOutgoing, hello), EnvelopeFrom: "kim@company.example", Recipients: []string{"anna@finance.example", "archive@company.example"}, MessageID: id + "@company.example", Attempt: attempt}
}

func TestSendsAndFilesACopy(t *testing.T) {
	h := newHarness(message("m1", 1))

	h.run()

	if len(h.sends) != 1 || !slices.Equal(h.sends[0].Recipients, []string{"anna@finance.example", "archive@company.example"}) || h.sends[0].From != "kim@company.example" {
		t.Fatalf("sends = %+v", h.sends)
	}
	if len(h.sent.appended) != 1 {
		t.Errorf("copies in Sent = %d", len(h.sent.appended))
	}
	if !slices.Equal(h.api.reports, []report{{"m1", api.OutcomeSent, "", true}}) {
		t.Errorf("reports = %+v", h.api.reports)
	}
}

func TestNeverSendsTwiceAfterAnUnreportedAttempt(t *testing.T) {
	h := newHarness(message("m1", 2))
	h.sent.contains["m1@company.example"] = true

	h.run()

	if len(h.sends) != 0 || len(h.sent.appended) != 0 {
		t.Fatalf("sent again: sends %d, copies %d", len(h.sends), len(h.sent.appended))
	}
	if !slices.Equal(h.api.reports, []report{{"m1", api.OutcomeSent, "", true}}) {
		t.Errorf("reports = %+v", h.api.reports)
	}
}

func TestPermanentRefusalFails(t *testing.T) {
	h := newHarness(message("m1", 1))
	h.fail = &smtpsend.Error{Permanent: true, Message: "The outgoing mail server refused the recipient anna@finance.example.", Err: errors.New("550")}

	h.run()

	if !slices.Equal(h.api.reports, []report{{"m1", api.OutcomeFailed, "The outgoing mail server refused the recipient anna@finance.example.", false}}) {
		t.Errorf("reports = %+v", h.api.reports)
	}
}

func TestTemporaryProblemsAreRetried(t *testing.T) {
	h := newHarness(message("m1", 1))
	h.fail = &smtpsend.Error{Permanent: false, Message: "Could not connect to the outgoing mail server.", Err: errors.New("dial")}

	h.run()

	if !slices.Equal(h.api.reports, []report{{"m1", api.OutcomeRetry, "Could not connect to the outgoing mail server.", false}}) {
		t.Errorf("reports = %+v", h.api.reports)
	}
}

func TestMissingMessageFails(t *testing.T) {
	h := newHarness(api.OutgoingMessage{ID: "m1", RawObjectKey: storagetest.KeyOf(blobcrypt.KindOutgoing, []byte("never stored")), Attempt: 1})

	h.run()

	if len(h.sends) != 0 || len(h.api.reports) != 1 || h.api.reports[0].outcome != api.OutcomeFailed {
		t.Errorf("sends %d, reports %+v", len(h.sends), h.api.reports)
	}
}

func TestProvidersThatFileSentMailGetNoSecondCopy(t *testing.T) {
	h := newHarness(message("m1", 1))
	h.api.smtpHost = "smtp.gmail.com"

	h.run()

	if len(h.sent.appended) != 0 {
		t.Errorf("copies in Sent = %d", len(h.sent.appended))
	}
	if !slices.Equal(h.api.reports, []report{{"m1", api.OutcomeSent, "", true}}) {
		t.Errorf("reports = %+v", h.api.reports)
	}
}

func TestSentWithoutCopyWhenTheSentFolderIsMissing(t *testing.T) {
	h := newHarness(message("m1", 1))
	h.sent.openErr = errors.New("no sent folder")

	h.run()

	if !slices.Equal(h.api.reports, []report{{"m1", api.OutcomeSent, "", false}}) {
		t.Errorf("reports = %+v", h.api.reports)
	}
}

func TestTriggersDuringARunNeverOverlap(t *testing.T) {
	h := newHarness(message("m1", 1))
	h.api.queue = append(h.api.queue, []api.OutgoingMessage{message("m2", 1)})
	h.api.gate = make(chan struct{})

	h.d.Trigger(context.Background(), "a1")
	// Wait until the first pass is busy claiming, then trigger while it runs.
	for {
		h.api.mu.Lock()
		busy := h.api.active == 1
		h.api.mu.Unlock()
		if busy {
			break
		}
		time.Sleep(time.Millisecond)
	}
	h.d.Trigger(context.Background(), "a1")
	h.d.Trigger(context.Background(), "a1")
	close(h.api.gate)
	h.d.Wait()

	if h.api.overlap {
		t.Fatal("two runs for one account overlapped")
	}
	if h.api.claims != 2 {
		t.Errorf("claims = %d, want the running pass plus one more for the triggers it missed", h.api.claims)
	}
	if len(h.api.reports) != 2 {
		t.Errorf("reports = %+v", h.api.reports)
	}
}

func TestProviderAccountsSendThroughTheirAPIWithoutPasswordOrSentCopy(t *testing.T) {
	for _, provider := range []string{"gmail", "microsoft"} {
		t.Run(provider, func(t *testing.T) {
			h := newHarness(message("m1", 1))
			h.api.provider = provider

			h.run()

			if !slices.Equal(h.via, []string{provider}) {
				t.Fatalf("sent via %v, want %s", h.via, provider)
			}
			if !slices.Equal(h.sends[0].Recipients, []string{"anna@finance.example", "archive@company.example"}) {
				t.Errorf("envelope = %+v", h.sends[0])
			}
			if len(h.opened) != 0 || len(h.sent.appended) != 0 {
				t.Errorf("Sent folder opened %v, copies %d; the provider files the copy itself", h.opened, len(h.sent.appended))
			}
			if !slices.Equal(h.api.reports, []report{{"m1", api.OutcomeSent, "", true}}) {
				t.Errorf("reports = %+v", h.api.reports)
			}
		})
	}
}

func TestProviderRetryChecksTheProviderForAnEarlierSend(t *testing.T) {
	h := newHarness(message("m1", 2))
	h.api.provider = "gmail"
	h.sent.contains["m1@company.example"] = true

	h.run()

	if len(h.sends) != 0 || !slices.Equal(h.opened, []string{"gmail"}) {
		t.Fatalf("sends %d, opened %v", len(h.sends), h.opened)
	}
	if !slices.Equal(h.api.reports, []report{{"m1", api.OutcomeSent, "", true}}) {
		t.Errorf("reports = %+v", h.api.reports)
	}
}

func TestProviderErrorsMapToOutcomes(t *testing.T) {
	cases := []struct {
		err     error
		outcome string
		text    string
	}{
		{&providersend.Error{Permanent: true, Message: "Gmail refused the message.", Err: errors.New("400")}, api.OutcomeFailed, "Gmail refused the message."},
		{&providersend.Error{Permanent: false, Message: "Outlook could not send the message right now.", Err: errors.New("503")}, api.OutcomeRetry, "Outlook could not send the message right now."},
		{errors.New("something unexpected"), api.OutcomeRetry, "Sending failed; trying again later."},
	}
	for _, c := range cases {
		h := newHarness(message("m1", 1))
		h.api.provider = "microsoft"
		h.fail = c.err

		h.run()

		if !slices.Equal(h.api.reports, []report{{"m1", c.outcome, c.text, false}}) {
			t.Errorf("%v: reports = %+v", c.err, h.api.reports)
		}
	}
}

func TestUnknownProviderClaimsNothing(t *testing.T) {
	h := newHarness(message("m1", 1))
	h.api.provider = "exchange"

	h.run()

	if h.api.claims != 0 || len(h.sends) != 0 {
		t.Errorf("claims %d, sends %d", h.api.claims, len(h.sends))
	}
}

func TestAutoSavesSent(t *testing.T) {
	imapAt := func(host string) api.Credentials {
		return api.Credentials{Provider: "imap", Connection: api.Connection{SMTP: api.ServerSettings{Host: host}}}
	}
	if !AutoSavesSent(api.Credentials{Provider: "gmail"}) || !AutoSavesSent(api.Credentials{Provider: "microsoft"}) {
		t.Error("provider accounts file sent mail themselves")
	}
	if !AutoSavesSent(imapAt("SMTP.Gmail.com.")) || AutoSavesSent(imapAt("smtp.company.example")) {
		t.Error("SMTP host detection is wrong")
	}
}

func TestFilesTheNewDraftCopyBeforeRemovingTheOldOne(t *testing.T) {
	h := newHarness()
	v2 := h.store.PutAsAPI(blobcrypt.KindDrafts, []byte("draft v2"))
	previous := "d1.1@company.example"
	h.api.drafts = api.DraftWork{
		Files:    []api.DraftFile{{DraftID: "d1", Version: 2, RawObjectKey: v2, MessageID: "d1.2@company.example", PreviousMessageID: &previous}},
		Removals: []api.DraftRemoval{{ID: "r1", MessageID: "d9.4@company.example"}},
	}

	h.run()

	if !slices.Equal(h.drafts.log, []string{"append draft v2", "remove d1.1@company.example", "remove d9.4@company.example"}) {
		t.Errorf("drafts folder = %v", h.drafts.log)
	}
	if !slices.Equal(h.api.filed, []string{"d1 v2 d1.2@company.example"}) || !slices.Equal(h.api.removed, []string{"r1"}) {
		t.Errorf("filed %v, removed %v", h.api.filed, h.api.removed)
	}
}

func TestAFailedDraftCopyIsNotReported(t *testing.T) {
	h := newHarness()
	v1 := h.store.PutAsAPI(blobcrypt.KindDrafts, []byte("draft v1"))
	h.drafts.failAppend = true
	h.api.drafts = api.DraftWork{Files: []api.DraftFile{{DraftID: "d1", Version: 1, RawObjectKey: v1, MessageID: "d1.1@company.example"}}}

	h.run()

	if len(h.api.filed) != 0 {
		t.Errorf("filed = %v; the claim must expire so the work comes back", h.api.filed)
	}
}

func location(folder, uid string) api.MailboxLocation {
	validity := uint32(1)
	return api.MailboxLocation{Folder: folder, UIDValidity: &validity, RemoteUID: uid}
}

func TestMakesTheUsersChangesInOrderAndReportsThem(t *testing.T) {
	h := newHarness()
	yes := true
	inbox := location("INBOX", "1")
	h.api.changes = []api.MailboxChange{
		{ID: "c1", MessageID: "m1", Kind: api.MailboxFlags, Seen: &yes, Locations: []api.MailboxLocation{inbox, location("Projects", "4")}},
		{ID: "c2", MessageID: "m1", Kind: api.MailboxMove, Source: &inbox, Target: &api.MailboxTarget{Folder: "Archive"}},
	}

	h.run()

	wantLog := []string{"flags INBOX/1 seen=true flagged=-", "flags Projects/4 seen=true flagged=-", "move INBOX/1 to Archive"}
	if !slices.Equal(h.mailbox.log, wantLog) {
		t.Errorf("log = %q, want %q", h.mailbox.log, wantLog)
	}
	want := []mailboxReport{{"c1", api.MailboxDone, "", ""}, {"c2", api.MailboxDone, "", "77"}}
	if !slices.Equal(h.api.changed, want) {
		t.Errorf("reports = %+v, want %+v", h.api.changed, want)
	}
}

func TestReportsWhatTheServerRefusesOrPutsOff(t *testing.T) {
	h := newHarness()
	yes := true
	inbox, trash, gone := location("INBOX", "1"), location("Trash", "2"), location("INBOX", "3")
	h.api.changes = []api.MailboxChange{
		{ID: "refused", MessageID: "m1", Kind: api.MailboxMove, Source: &inbox, Target: &api.MailboxTarget{Folder: "Nowhere"}},
		{ID: "busy", MessageID: "m2", Kind: api.MailboxFlags, Seen: &yes, Locations: []api.MailboxLocation{trash}},
		{ID: "gone", MessageID: "m3", Kind: api.MailboxMove, Source: &gone, Target: &api.MailboxTarget{Folder: "Archive"}},
		{ID: "reset-flags", MessageID: "m4", Kind: api.MailboxFlags, Seen: &yes, Locations: []api.MailboxLocation{location("Old", "5")}},
		{ID: "reset-move", MessageID: "m5", Kind: api.MailboxMove, Source: ptr(location("Old", "6")), Target: &api.MailboxTarget{Folder: "Archive"}},
	}
	h.mailbox.errors["move INBOX/1"] = &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeTryCreate, Text: "Mailbox does not exist"}
	h.mailbox.errors["flags Trash/2"] = &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeUnavailable, Text: "Try later"}
	h.mailbox.errors["move INBOX/3"] = imapsync.ErrMessageGone
	h.mailbox.errors["flags Old/5"] = imapsync.ErrFolderReset
	h.mailbox.errors["move Old/6"] = imapsync.ErrFolderReset

	h.run()

	outcomes := map[string]string{}
	for _, r := range h.api.changed {
		outcomes[r.id] = r.outcome
	}
	want := map[string]string{"refused": api.OutcomeFailed, "busy": api.OutcomeRetry, "gone": api.MailboxGone, "reset-flags": api.OutcomeRetry, "reset-move": api.OutcomeFailed}
	if fmt.Sprint(outcomes) != fmt.Sprint(want) {
		t.Errorf("outcomes = %v, want %v", outcomes, want)
	}
	if h.api.changed[0].text == "" {
		t.Error("a refusal carries the reason")
	}
}

func TestAConnectionFailureLeavesTheRestForLater(t *testing.T) {
	h := newHarness()
	yes := true
	h.api.changes = []api.MailboxChange{
		{ID: "c1", MessageID: "m1", Kind: api.MailboxFlags, Seen: &yes, Locations: []api.MailboxLocation{location("INBOX", "1")}},
		{ID: "c2", MessageID: "m2", Kind: api.MailboxFlags, Seen: &yes, Locations: []api.MailboxLocation{location("INBOX", "2")}},
		{ID: "c3", MessageID: "m3", Kind: api.MailboxFlags, Seen: &yes, Locations: []api.MailboxLocation{location("INBOX", "3")}},
	}
	h.mailbox.errors["flags INBOX/2"] = io.ErrUnexpectedEOF

	h.run()

	want := []mailboxReport{{"c1", api.MailboxDone, "", ""}}
	if !slices.Equal(h.api.changed, want) {
		t.Errorf("reports = %+v, want %+v: the claims of the rest expire and come back", h.api.changed, want)
	}
}

func ptr[T any](value T) *T { return &value }

func TestAMessagesLaterChangesWaitWhenOneIsNotDone(t *testing.T) {
	h := newHarness()
	yes, no := true, false
	h.api.changes = []api.MailboxChange{
		{ID: "read", MessageID: "m1", Kind: api.MailboxFlags, Seen: &yes, Locations: []api.MailboxLocation{location("INBOX", "1")}},
		{ID: "unread", MessageID: "m1", Kind: api.MailboxFlags, Seen: &no, Locations: []api.MailboxLocation{location("INBOX", "1")}},
		{ID: "other", MessageID: "m2", Kind: api.MailboxFlags, Seen: &yes, Locations: []api.MailboxLocation{location("INBOX", "2")}},
	}
	h.mailbox.errors["flags INBOX/1"] = &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeInUse, Text: "Busy"}

	h.run()

	want := []mailboxReport{{"read", api.OutcomeRetry, "imap: NO [INUSE] Busy", ""}, {"other", api.MailboxDone, "", ""}}
	if !slices.Equal(h.api.changed, want) {
		t.Errorf("reports = %+v, want %+v: the unread waits for the read to go first", h.api.changed, want)
	}
}

func TestAFlagChangeIsDoneWhenAnyCopyTookIt(t *testing.T) {
	h := newHarness()
	yes := true
	h.api.changes = []api.MailboxChange{
		{ID: "c1", MessageID: "m1", Kind: api.MailboxFlags, Seen: &yes, Locations: []api.MailboxLocation{location("Gone", "1"), location("INBOX", "2")}},
	}
	h.mailbox.errors["flags Gone/1"] = &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeNonExistent, Text: "No such folder"}

	h.run()

	if want := []mailboxReport{{"c1", api.MailboxDone, "", ""}}; !slices.Equal(h.api.changed, want) {
		t.Errorf("reports = %+v, want %+v", h.api.changed, want)
	}
}

// Fails without the fix: the duplicate check only asked for the Message-ID, which Gmail and Graph may replace, and
// took a failed check as "not sent", so a retry could send twice.
func TestPostsClaimedUnsubscribesAndReportsTheOutcome(t *testing.T) {
	h := newHarness()
	h.api.unsubscribes = []api.UnsubscribeRequest{{ID: "u1", URL: "https://news.example/u1"}, {ID: "u2", URL: "https://shop.example/u2"}, {ID: "u3", URL: "https://busy.example/u3"}}
	h.unsub.outcomes["https://shop.example/u2"] = [2]string{api.OutcomeFailed, "The sender's server refused the request (HTTP 404)."}
	h.unsub.outcomes["https://busy.example/u3"] = [2]string{api.OutcomeRetry, "The sender's server is busy (HTTP 503); Tresso will try again."}

	h.run()

	if !slices.Equal(h.unsub.posted, []string{"https://news.example/u1", "https://shop.example/u2", "https://busy.example/u3"}) {
		t.Errorf("posted = %v", h.unsub.posted)
	}
	want := []unsubscribeReport{
		{"u1", api.UnsubscribeDone, ""},
		{"u2", api.OutcomeFailed, "The sender's server refused the request (HTTP 404)."},
		{"u3", api.OutcomeRetry, "The sender's server is busy (HTTP 503); Tresso will try again."},
	}
	if !slices.Equal(h.api.unsubscribed, want) {
		t.Errorf("reports = %+v", h.api.unsubscribed)
	}
}

func TestAFailedUnsubscribeReportDoesNotStopTheRest(t *testing.T) {
	h := newHarness()
	h.api.unsubscribes = []api.UnsubscribeRequest{{ID: "u1", URL: "https://news.example/u1"}, {ID: "u2", URL: "https://shop.example/u2"}}
	h.api.reportErr = errors.Join(api.ErrClaimLost, errors.New("409"))

	h.run()

	if len(h.unsub.posted) != 2 || len(h.api.unsubscribed) != 2 {
		t.Errorf("posted %v, reported %+v", h.unsub.posted, h.api.unsubscribed)
	}
}

func TestNoUnsubscribeClaimedPostsNothing(t *testing.T) {
	h := newHarness(message("m1", 1))

	h.run()

	if len(h.unsub.posted) != 0 || len(h.api.unsubscribed) != 0 {
		t.Errorf("posted %v, reported %+v", h.unsub.posted, h.api.unsubscribed)
	}
}

func TestProviderRetryFindsAnEarlierSendByItsOutboxID(t *testing.T) {
	h := newHarness(message("m1", 2))
	h.api.provider = "gmail"
	h.finder = &fakeFinder{fakeSent: h.sent, sentBefore: map[string]bool{"m1": true}}

	h.run()

	if len(h.sends) != 0 || !slices.Equal(h.api.reports, []report{{"m1", api.OutcomeSent, "", true}}) {
		t.Errorf("sends %d, reports %+v", len(h.sends), h.api.reports)
	}
	if age := time.Since(h.finder.since); age < retrySpan || age > retrySpan+time.Minute {
		t.Errorf("looked back %v; an id that is no UUIDv7 says nothing, so the retry span applies", age)
	}
}

// A check the provider refuses for good (a 4xx) fails the message at once with the clear text. Anything else that
// leaves the question open (429 and 5xx after providerhttp's retries, connection, timeout, not decided yet) is a Retry:
// with a neutral text while attempts remain, so nobody sends the message again meanwhile, and with the text that ends
// the message on the last attempt, which tells "may still be delivered" apart from "could not check". Fails on the
// earlier code, which showed the final text on every retry and failed at once on a 502.
func TestUndecidedChecksReportWhatTheUserCanActOn(t *testing.T) {
	statusErr := func(code int) error { return &providerhttp.StatusError{StatusCode: code} }
	maySend := fmt.Errorf("%w (draft d1)", providersend.ErrMaybeSending)
	cases := []struct {
		name    string
		err     error
		last    bool
		outcome string
		text    string
	}{
		{"refused", statusErr(400), false, api.OutcomeFailed, undecidedText},
		{"throttled", statusErr(429), false, api.OutcomeRetry, checkingText},
		{"provider error", statusErr(502), false, api.OutcomeRetry, checkingText},
		{"provider error, last", statusErr(503), true, api.OutcomeRetry, undecidedText},
		{"connection", &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection reset by peer")}, false, api.OutcomeRetry, checkingText},
		{"timeout, last", fmt.Errorf("GET /me/messages: %w", context.DeadlineExceeded), true, api.OutcomeRetry, undecidedText},
		{"leftover not deleted", fmt.Errorf("%w: deleting the leftover draft: %w", providersend.ErrNotDecided, statusErr(400)), false, api.OutcomeRetry, checkingText},
		{"may still send", maySend, false, api.OutcomeRetry, checkingText},
		{"may still send, last", maySend, true, api.OutcomeRetry, maySendText},
	}
	for _, c := range cases {
		m := message("m1", 2)
		m.LastAttempt = c.last
		h := newHarness(m)
		h.api.provider = "microsoft"
		h.finder = &fakeFinder{fakeSent: h.sent, err: c.err}

		h.run()

		if len(h.sends) != 0 {
			t.Fatalf("%s: sent %d times although the check could not decide", c.name, len(h.sends))
		}
		if !slices.Equal(h.api.reports, []report{{"m1", c.outcome, c.text, false}}) {
			t.Errorf("%s: reports = %+v", c.name, h.api.reports)
		}
	}
}

func TestProviderRetryWaitsWhenAccessIsLostDuringTheCheck(t *testing.T) {
	h := newHarness(message("m1", 2))
	h.api.provider = "gmail"
	h.finder = &fakeFinder{fakeSent: h.sent, err: fmt.Errorf("%w: 401", providerhttp.ErrUnauthorized)}

	h.run()

	if len(h.sends) != 0 || len(h.api.reports) != 1 || h.api.reports[0].outcome != api.OutcomeRetry {
		t.Errorf("sends %d, reports %+v", len(h.sends), h.api.reports)
	}
}

// Fails on the earlier code, which always looked back 48 hours: the window now starts when the message was written.
func TestEarliestAttemptStartsWhenTheMessageWasWritten(t *testing.T) {
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	written := now.Add(-3 * time.Hour)
	if got := earliestAttempt(api.OutgoingMessage{ID: fakeapi.UUIDv7(written, 1)}, now); !got.Equal(written.Add(-clockSkew)) {
		t.Errorf("earliestAttempt = %v, want %v", got, written.Add(-clockSkew))
	}
	if got := earliestAttempt(api.OutgoingMessage{ID: "m1"}, now); !got.Equal(now.Add(-retrySpan)) {
		t.Errorf("earliestAttempt without a UUIDv7 = %v", got)
	}
}

func TestUnsubscribesGoOutAlsoWhenTheAccountCannotSend(t *testing.T) {
	h := newHarness()
	h.api.provider = "unknown" // no transport: nothing else of the run happens
	h.api.unsubscribes = []api.UnsubscribeRequest{{ID: "u1", URL: "https://news.example/u1"}}

	h.run()

	if !slices.Equal(h.unsub.posted, []string{"https://news.example/u1"}) || len(h.api.unsubscribed) != 1 {
		t.Errorf("posted %v, reported %+v", h.unsub.posted, h.api.unsubscribed)
	}
}

func TestASlowUnsubscribeNeverHoldsUpMail(t *testing.T) {
	h := newHarness(message("m1", 1))
	h.api.unsubscribes = []api.UnsubscribeRequest{{ID: "u1", URL: "https://slow.example/u1"}}
	posting := make(chan struct{})
	release := make(chan struct{})
	h.unsub.before = func() {
		close(posting)
		<-release // the sender's server takes its time
	}
	sent := func(want int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			h.api.mu.Lock()
			reports := len(h.api.reports)
			h.api.mu.Unlock()
			if reports == want {
				return
			}
			if time.Now().After(deadline) {
				close(release)
				t.Fatalf("%d messages sent while the unsubscribe request waited, want %d", reports, want)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}

	h.d.Trigger(context.Background(), "a1")
	<-posting
	sent(1)
	// Mail queued while the request still waits goes out now, not after it.
	h.api.mu.Lock()
	h.api.queue = append(h.api.queue, []api.OutgoingMessage{message("m2", 1)})
	h.api.mu.Unlock()
	h.d.Trigger(context.Background(), "a1")
	sent(2)
	close(release)
	h.d.Wait()

	if len(h.api.unsubscribed) != 1 {
		t.Errorf("unsubscribe reports = %+v", h.api.unsubscribed)
	}
}

func TestSlowUnsubscribesStopBeforeTheirClaimRunsOut(t *testing.T) {
	h := newHarness()
	h.api.unsubscribes = []api.UnsubscribeRequest{{ID: "u1", URL: "https://a.example/u"}, {ID: "u2", URL: "https://b.example/u"}, {ID: "u3", URL: "https://c.example/u"}, {ID: "u4", URL: "https://d.example/u"}}
	clock := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	h.d.now = func() time.Time { return clock }
	// Every sender's server takes 90 seconds: after three the four-minute budget is spent.
	h.unsub.before = func() { clock = clock.Add(90 * time.Second) }

	h.run()

	if !slices.Equal(h.unsub.posted, []string{"https://a.example/u", "https://b.example/u", "https://c.example/u"}) {
		t.Errorf("posted = %v", h.unsub.posted)
	}
	if len(h.api.unsubscribed) != 3 {
		t.Errorf("reported %+v; the fourth is left for the next claim", h.api.unsubscribed)
	}
}

// Fails without the fix: an IMAP account whose Sent folder could not be searched fell through and sent again.
func TestAnIMAPRetryThatCannotCheckSentDoesNotSend(t *testing.T) {
	cases := map[string]func(h *harness){
		"search fails":     func(h *harness) { h.sent.containsErr = errors.New("connection reset") },
		"Sent cannot open": func(h *harness) { h.sent.openErr = errors.New("login: NO [UNAVAILABLE]") },
		"login refused":    func(h *harness) { h.sent.openErr = imapsync.ErrAuth },
	}
	for name, setup := range cases {
		h := newHarness(message("m1", 2))
		setup(h)

		h.run()

		if len(h.sends) != 0 {
			t.Errorf("%s: sent again although Sent could not be checked", name)
		}
		if !slices.Equal(h.api.reports, []report{{"m1", api.OutcomeRetry, checkingText, false}}) {
			t.Errorf("%s: reports = %+v", name, h.api.reports)
		}
	}

	last := message("m1", 6)
	last.LastAttempt = true
	h := newHarness(last)
	h.sent.containsErr = errors.New("connection reset")
	h.run()
	if len(h.sends) != 0 || !slices.Equal(h.api.reports, []report{{"m1", api.OutcomeRetry, undecidedText, false}}) {
		t.Errorf("last attempt: sends %d, reports %+v", len(h.sends), h.api.reports)
	}
}

func TestAnIMAPRetryWithoutASentFolderSends(t *testing.T) {
	h := newHarness(message("m1", 2))
	h.sent.openErr = imapsync.ErrNoSentFolder

	h.run()

	if len(h.sends) != 1 || !slices.Equal(h.api.reports, []report{{"m1", api.OutcomeSent, "", false}}) {
		t.Errorf("sends %d, reports %+v", len(h.sends), h.api.reports)
	}
}

func TestALostOutcomeReportIsSentAgain(t *testing.T) {
	defer func(previous time.Duration) { reportBackoff = previous }(reportBackoff)
	reportBackoff = time.Millisecond
	h := newHarness(message("m1", 1))
	h.api.reportErrs = []error{errors.New("connection reset"), &api.HTTPError{Status: http.StatusServiceUnavailable}}

	h.run()

	if h.api.reportCalls != 3 || !slices.Equal(h.api.reports, []report{{"m1", api.OutcomeSent, "", true}}) {
		t.Errorf("%d report calls, reports %+v", h.api.reportCalls, h.api.reports)
	}

	h = newHarness(message("m2", 1))
	h.api.reportErrs = []error{&api.HTTPError{Status: http.StatusUnprocessableEntity}}
	h.run()
	if h.api.reportCalls != 1 {
		t.Errorf("a refused report was sent %d times", h.api.reportCalls)
	}
}
