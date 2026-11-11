package mimeparse

import (
	"strings"
	"testing"
)

func crlf(s string) []byte {
	return []byte(strings.ReplaceAll(strings.TrimLeft(s, "\n"), "\n", "\r\n"))
}

func TestParsesMultipartWithAttachmentAndInlineImage(t *testing.T) {
	raw := crlf(`
From: "Anna de Vries" <Anna@Finance.example>
To: Kim Visser <kim@company.example>, pieter@company.example
Cc: lisa@company.example
Subject: =?UTF-8?Q?Q4_budget,_revised_=E2=9C=93?=
Message-ID: <budget-2@finance.example>
In-Reply-To: <budget-1@finance.example>
References: <root@finance.example> <budget-1@finance.example>
Date: Mon, 19 Oct 2026 09:12:00 +0200
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="outer"

--outer
Content-Type: multipart/related; boundary="rel"

--rel
Content-Type: multipart/alternative; boundary="alt"

--alt
Content-Type: text/plain; charset=utf-8

Hi Kim,

Could you approve the revised numbers before Friday?

> On Friday you wrote:
> old quoted text
--alt
Content-Type: text/html; charset=utf-8

<p>Hi Kim,</p><p>Could you approve?</p>
--alt--
--rel
Content-Type: image/png; name="logo.png"
Content-ID: <logo@finance>
Content-Disposition: inline
Content-Transfer-Encoding: base64

iVBORw0KGgo=
--rel--
--outer
Content-Type: application/vnd.ms-excel; name="budget.xlsx"
Content-Disposition: attachment; filename="budget-q4.xlsx"
Content-Transfer-Encoding: base64

SGVsbG8gd29ybGQ=
--outer--
`)

	msg, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}

	if msg.Subject != "Q4 budget, revised ✓" {
		t.Errorf("subject = %q", msg.Subject)
	}
	if msg.MessageID != "budget-2@finance.example" || msg.InReplyTo != "budget-1@finance.example" {
		t.Errorf("ids = %q / %q", msg.MessageID, msg.InReplyTo)
	}
	if len(msg.References) != 2 || msg.References[0] != "root@finance.example" {
		t.Errorf("references = %v", msg.References)
	}
	if msg.From.Address != "anna@finance.example" || msg.From.Name != "Anna de Vries" {
		t.Errorf("from = %+v", msg.From)
	}
	if len(msg.To) != 2 || msg.To[0].Name != "Kim Visser" || msg.To[1].Address != "pieter@company.example" {
		t.Errorf("to = %+v", msg.To)
	}
	if len(msg.Cc) != 1 {
		t.Errorf("cc = %+v", msg.Cc)
	}
	if msg.Date == nil || msg.Date.UTC().Hour() != 7 {
		t.Errorf("date = %v", msg.Date)
	}
	if msg.Snippet != "Hi Kim, Could you approve the revised numbers before Friday?" {
		t.Errorf("snippet = %q (quoted lines must be dropped, plain text preferred)", msg.Snippet)
	}
	if msg.BodyText != "Hi Kim, Could you approve the revised numbers before Friday?" {
		t.Errorf("body text = %q (quoted lines must be dropped, plain text preferred)", msg.BodyText)
	}

	if len(msg.Attachments) != 2 {
		t.Fatalf("attachments = %d", len(msg.Attachments))
	}
	logo, sheet := msg.Attachments[0], msg.Attachments[1]
	if !logo.Inline || logo.ContentID != "logo@finance" || logo.ContentType != "image/png" || logo.Filename != "logo.png" {
		t.Errorf("inline image = %+v", logo)
	}
	if sheet.Inline || sheet.Filename != "budget-q4.xlsx" || sheet.Size != 11 || string(sheet.Data) != "Hello world" {
		t.Errorf("attachment = %+v", sheet)
	}
}

func TestHTMLOnlyMessageUsesVisibleText(t *testing.T) {
	raw := crlf(`
From: news@shop.example
Subject: Offers
Content-Type: text/html; charset=utf-8

<html><head><title>x</title><style>p{color:red}</style></head><body><script>alert(1)</script><p>Big &amp; small</p><p>offers</p></body></html>
`)
	msg, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if msg.Snippet != "Big & small offers" {
		t.Errorf("snippet = %q", msg.Snippet)
	}
	if msg.BodyText != "Big & small offers" {
		t.Errorf("body text = %q", msg.BodyText)
	}
}

func TestDecodesLegacyCharsetsAndEncodedHeaders(t *testing.T) {
	raw := crlf(`
From: =?ISO-8859-1?Q?J=F6rg_M=FCller?= <joerg@example.de>
Subject: =?ISO-8859-1?Q?=DCberweisung_M=E4rz?=
Content-Type: text/plain; charset=ISO-8859-1
Content-Transfer-Encoding: quoted-printable

Gr=FC=DFe aus M=FCnchen
`)
	msg, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if msg.Subject != "Überweisung März" || msg.From.Name != "Jörg Müller" {
		t.Errorf("subject %q, from %+v", msg.Subject, msg.From)
	}
	if msg.Snippet != "Grüße aus München" {
		t.Errorf("snippet = %q", msg.Snippet)
	}
}

func TestMissingFromFallsBackToSenderThenUnknown(t *testing.T) {
	withSender, _ := Parse(crlf("Sender: list@lists.example\nSubject: x\n\nbody\n"))
	if withSender.From.Address != "list@lists.example" {
		t.Errorf("from = %+v", withSender.From)
	}
	none, _ := Parse(crlf("Subject: x\n\nbody\n"))
	if none.From.Address != UnknownSender {
		t.Errorf("from = %+v", none.From)
	}
}

func TestUnknownCharsetDoesNotLoseTheMessage(t *testing.T) {
	raw := crlf(`
From: a@example.test
Subject: Weird
Message-ID: <weird@x>
Content-Type: text/plain; charset=x-made-up

hello
`)
	msg, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if msg.MessageID != "weird@x" || msg.Subject != "Weird" {
		t.Errorf("headers lost: %+v", msg)
	}
}

func TestAttachmentFilenameIsSanitised(t *testing.T) {
	raw := crlf(`
From: a@example.test
Content-Type: multipart/mixed; boundary="b"

--b
Content-Type: text/plain

hi
--b
Content-Type: application/pdf
Content-Disposition: attachment; filename="..\..\evil\invoice.pdf"

%PDF
--b
Content-Type: application/pdf
Content-Disposition: attachment

%PDF
--b--
`)
	msg, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(msg.Attachments) != 2 || msg.Attachments[0].Filename != "invoice.pdf" || msg.Attachments[1].Filename != "attachment.pdf" {
		t.Fatalf("attachments = %+v", msg.Attachments)
	}
}

func TestSnippetIsShortenedAtAWordBoundary(t *testing.T) {
	snippet := Snippet(strings.Repeat("word ", 200))
	if !strings.HasSuffix(snippet, "word…") || len([]rune(snippet)) > snippetLength+1 {
		t.Errorf("snippet = %q", snippet)
	}
}

func TestBodyTextKeepsTheWholeTextUpToTheLimit(t *testing.T) {
	long := strings.Repeat("budget ", 2000)
	if text := BodyText(long); text != strings.TrimSpace(long) {
		t.Errorf("body text was cut below the limit: %d characters", len([]rune(text)))
	}

	tooLong := strings.Repeat("überweisung ", 4000)
	text := BodyText(tooLong)
	if n := len([]rune(text)); n > bodyTextLength || n < bodyTextLength-len("überweisung ") {
		t.Errorf("body text has %d characters, want at most %d", n, bodyTextLength)
	}
	if !strings.HasSuffix(text, "überweisung") {
		t.Errorf("body text is not cut at a word boundary: %q", text[len(text)-20:])
	}
}

func TestBodyTextOfAMessageWithoutTextIsEmpty(t *testing.T) {
	raw := crlf(`
From: kim@company.example
Subject: Scan
Content-Type: application/pdf; name="scan.pdf"
Content-Disposition: attachment; filename="scan.pdf"
Content-Transfer-Encoding: base64

SGVsbG8gd29ybGQ=
`)
	msg, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if msg.BodyText != "" || msg.Snippet != "" {
		t.Errorf("body text %q, snippet %q", msg.BodyText, msg.Snippet)
	}
}

func TestNotAMessageIsAnError(t *testing.T) {
	if _, err := Parse([]byte("\x00\x01 not mail")); err == nil {
		t.Error("expected an error")
	}
}

func TestReferencedImageSentAsAttachmentIsInline(t *testing.T) {
	raw := crlf(`
From: billing@finance.example
Subject: Invoice
MIME-Version: 1.0
Content-Type: multipart/related; boundary="rel"

--rel
Content-Type: text/html; charset=utf-8

<p><img src="cid:Logo@Finance"> Invoice</p>
--rel
Content-Type: image/png
Content-ID: <Logo@Finance>
Content-Disposition: attachment; filename="logo.png"
Content-Transfer-Encoding: base64

aW1hZ2U=
--rel
Content-Type: image/png
Content-ID: <unused@finance>
Content-Disposition: attachment; filename="photo.png"
Content-Transfer-Encoding: base64

cGhvdG8=
--rel--
`)

	msg, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(msg.Attachments) != 2 {
		t.Fatalf("attachments = %d", len(msg.Attachments))
	}
	if logo := msg.Attachments[0]; !logo.Inline || logo.ContentID != "Logo@Finance" {
		t.Errorf("referenced image = %+v, want inline", logo)
	}
	if photo := msg.Attachments[1]; photo.Inline || photo.ContentID != "unused@finance" {
		t.Errorf("unreferenced image = %+v, want a regular attachment that keeps its Content-ID", photo)
	}
}

func TestKeepsTheSignalHeaders(t *testing.T) {
	raw := crlf(`Authentication-Results: mx.example; dmarc=fail (p=REJECT)
	header.from=bank.example
Authentication-Results: relay.example; dmarc=pass
From: Shop <deals@news.shop.example>
List-Unsubscribe: <https://shop.example/u>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
Precedence: bulk
X-Mailer: Something
Subject: Deals

body
`)
	msg, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"authentication-results": "mx.example; dmarc=fail (p=REJECT) header.from=bank.example",
		"list-unsubscribe":       "<https://shop.example/u>",
		"list-unsubscribe-post":  "List-Unsubscribe=One-Click",
		"precedence":             "bulk",
	}
	if len(msg.Signals) != len(want) {
		t.Fatalf("signals = %v", msg.Signals)
	}
	for name, value := range want {
		if msg.Signals[name] != value {
			t.Errorf("%s = %q, want %q", name, msg.Signals[name], value)
		}
	}
}

func TestKeepsTheAutoReplyMarkers(t *testing.T) {
	raw := crlf(`From: Lisa <lisa@company.example>
Auto-Submitted: auto-replied
X-Autoreply: yes
X-Autorespond: Out of office
Subject: Out of office

body
`)
	msg, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"auto-submitted": "auto-replied", "x-autoreply": "yes", "x-autorespond": "Out of office"}
	if len(msg.Signals) != len(want) {
		t.Fatalf("signals = %v", msg.Signals)
	}
	for name, value := range want {
		if msg.Signals[name] != value {
			t.Errorf("%s = %q, want %q", name, msg.Signals[name], value)
		}
	}
}

func TestMessageWithoutSignalsHasNone(t *testing.T) {
	msg, _ := Parse(crlf("From: anna@example.test\nSubject: Hi\n\nbody\n"))
	if msg.Signals != nil {
		t.Errorf("signals = %v", msg.Signals)
	}
}

// Fails without the fix: a part with an encoding go-message does not know was skipped, and a damaged base64 body
// dropped the whole attachment, without a trace.
func TestAttachmentsWithAnUnknownEncodingOrADamagedBodyAreKept(t *testing.T) {
	raw := "From: anna@finance.example\r\nSubject: Files\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n" +
		"--b\r\nContent-Type: text/plain\r\n\r\nTwo files.\r\n" +
		"--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=old.bin\r\nContent-Transfer-Encoding: x-uuencode\r\n\r\nbegin 644 old.bin\r\n#86)C\r\n`\r\nend\r\n" +
		"--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=cut.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK!!!!\r\n" +
		"--b\r\nContent-Type: image/png\r\nContent-Disposition: attachment; filename=after.png\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0K\r\n" +
		"--b--\r\n"

	msg, err := Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, a := range msg.Attachments {
		names = append(names, a.Filename)
	}
	if strings.Join(names, ",") != "old.bin,cut.pdf,after.png" {
		t.Fatalf("attachments = %v", names)
	}
	if !strings.Contains(string(msg.Attachments[0].Data), "begin 644 old.bin") {
		t.Errorf("the uuencoded part is not kept as it is: %q", msg.Attachments[0].Data)
	}
	if !strings.HasPrefix(string(msg.Attachments[1].Data), "%PDF") {
		t.Errorf("the damaged part lost what was read before the damage: %q", msg.Attachments[1].Data)
	}
	if len(msg.Problems) != 2 || msg.Snippet != "Two files." {
		t.Errorf("problems %v, snippet %q", msg.Problems, msg.Snippet)
	}
}

// Fails without the fix: a single-part message with an unknown transfer encoding made the reader nil, and Parse
// panicked.
func TestASinglePartMessageWithAnUnknownEncodingIsRead(t *testing.T) {
	raw := "From: anna@finance.example\r\nSubject: Old client\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: 8-bit\r\n\r\nPlain words.\r\n"

	msg, err := Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if msg.Subject != "Old client" || msg.Snippet != "Plain words." || len(msg.Problems) != 1 {
		t.Errorf("subject %q, snippet %q, problems %v", msg.Subject, msg.Snippet, msg.Problems)
	}
}

// Fails without the fix: the receiving provider's Authentication-Results was cut at 1000 characters, in the middle of
// a comment whose text then read as results of its own.
func TestAuthenticationResultsIsSentWholeOrCutAtASemicolon(t *testing.T) {
	long := "mx.google.com; " + strings.Repeat("dkim=pass header.i=@example.com header.s=s1 header.b=abcdefgh; ", 60) + "spf=pass (google.com: domain of a@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=a@example.com; dmarc=pass (p=NONE) header.from=example.com"
	msg, err := Parse([]byte("From: a@example.com\r\nAuthentication-Results: " + long + "\r\nSubject: Hi\r\n\r\nBody\r\n"))
	if err != nil {
		t.Fatal(err)
	}
	if got := msg.Signals["authentication-results"]; got != long {
		t.Errorf("a header of %d characters was not sent whole: %d", len(long), len(got))
	}

	tooLong := "mx.google.com; " + strings.Repeat("dkim=pass header.i=@example.com header.s=s1 header.b=abcdefgh; ", 150) + "x=1"
	msg, _ = Parse([]byte("From: a@example.com\r\nAuthentication-Results: " + tooLong + "\r\n\r\nBody\r\n"))
	got := msg.Signals["authentication-results"]
	if len(got) > 8000 || !strings.HasSuffix(got, "header.b=abcdefgh") || !strings.HasPrefix(got, "mx.google.com; ") {
		t.Errorf("cut header ends %q (%d characters); want it cut after a whole result", got[max(0, len(got)-30):], len(got))
	}

	if cutAtSemicolon(strings.Repeat("x", 9000), 8000) != "" {
		t.Error("a header without a ; to cut at must be left out")
	}
}
