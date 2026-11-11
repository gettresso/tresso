// Package mimeparse turns a raw RFC 5322 message into the metadata Tresso stores: headers, a text snippet, the body
// text for search and the attachments. It is lenient: real-world mail breaks every rule, and a message must never be
// lost because of that.
package mimeparse

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/mail"
	"net/url"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/emersion/go-message"
	_ "github.com/emersion/go-message/charset" // registers the non-UTF-8 charsets real mail uses
	gomail "github.com/emersion/go-message/mail"
)

const (
	snippetLength = 300
	// The body text for search is cut to this many characters; the API refuses longer text.
	bodyTextLength = 32768
	// Text parts are read up to this size for the snippet and the search text; the rest is never needed.
	maxTextRead = 256 << 10
	// UnknownSender is used when a message has no usable From, Sender or Return-Path.
	UnknownSender = "unknown@unknown.invalid"
	// The API takes signal header values up to this many characters, Authentication-Results up to
	// authResultsLength: the receiving provider's header is long (several DKIM results, ARC) and only meaningful whole.
	signalLength      = 1000
	authResultsLength = 8000
	// Calendar parts larger than this are no invitation anyone writes; they stay plain attachments.
	maxCalendarPart = 256 << 10
)

// signalHeaders tell automated, bulk and junk mail apart; the API classifies mail with them, and does not take an
// automatic reply (X-Autoreply and X-Autorespond besides Auto-Submitted) for the answer to a hand-over.
var signalHeaders = []string{
	"List-Unsubscribe", "List-Unsubscribe-Post", "List-Id", "Precedence", "Auto-Submitted", "Feedback-Id",
	"X-Spam-Flag", "X-Spam-Status", "Authentication-Results", "X-Autoreply", "X-Autorespond",
	// How Exchange Online took the message in (Internal: sent inside the tenant). Anyone can write it, so it is only
	// passed on for Microsoft accounts (see ingestmsg.BuildFromExchange).
	ExchangeAuthAs,
}

// ExchangeAuthAs is the header Exchange Online writes with how it took a message in; it strips the
// X-MS-Exchange-Organization-* headers of mail arriving from outside.
const ExchangeAuthAs = "X-MS-Exchange-Organization-AuthAs"

type Address struct {
	Address string
	Name    string
}

type Attachment struct {
	Filename    string
	ContentType string
	ContentID   string
	Inline      bool
	Size        int64
	Data        []byte
}

// CalendarPart is a text/calendar part (iMIP, RFC 6047): an invitation, update, cancellation or reply.
type CalendarPart struct {
	// Method is the METHOD parameter of the part's Content-Type, empty when it had none.
	Method string
	Data   string
}

type Message struct {
	MessageID   string
	InReplyTo   string
	References  []string
	Subject     string
	From        Address
	To          []Address
	Cc          []Address
	Bcc         []Address
	ReplyTo     []Address
	Date        *time.Time
	Snippet     string
	BodyText    string
	Attachments []Attachment
	// Signals holds the signal headers the message has, by lower-cased name. For a header that occurs more than
	// once it is the first (topmost) one: for Authentication-Results that is the one the receiving server added.
	Signals       map[string]string
	CalendarParts []CalendarPart
	// Problems describes what could not be read as it should (unknown encodings, broken parts), for the log.
	Problems []string
}

// Parse never fails on malformed input: headers it cannot read stay empty. It only returns an error when the input
// is not a message at all.
//
// A part with a transfer encoding or charset go-message does not know is kept as it is (undecoded), an attachment
// whose body breaks off keeps the bytes read before, and a broken MIME structure ends the walk with what was read so
// far. Each of these is noted in Problems.
func Parse(raw []byte) (*Message, error) {
	entity, err := message.Read(bytes.NewReader(raw))
	if err != nil && !message.IsUnknownCharset(err) && !message.IsUnknownEncoding(err) {
		return parseHeadersOnly(raw)
	}

	msg := headersFrom(gomail.Header{Header: entity.Header})
	var plain, html string
	part := 0
	read := func(e *message.Entity, err error) {
		part++
		if err != nil {
			msg.Problems = append(msg.Problems, fmt.Sprintf("part %d: %v; kept as it is", part, err))
		}
		msg.readPart(e, part, &plain, &html)
	}

	if mr := entity.MultipartReader(); mr == nil {
		read(entity, err)
	} else {
		readers := []message.MultipartReader{mr}
		for len(readers) > 0 {
			p, err := readers[len(readers)-1].NextPart()
			if errors.Is(err, io.EOF) {
				readers = readers[:len(readers)-1]
				continue
			}
			if p == nil {
				// A broken MIME structure: everything collected so far is kept.
				msg.Problems = append(msg.Problems, fmt.Sprintf("after part %d: %v; the rest of the message was not read", part, err))
				break
			}
			if nested := p.MultipartReader(); nested != nil {
				readers = append(readers, nested)
				continue
			}
			read(p, err)
		}
	}

	markReferencedInline(msg.Attachments, html)

	text := plain
	if strings.TrimSpace(plain) == "" && html != "" {
		text = HTMLToText(html)
	}
	msg.Snippet = Snippet(text)
	msg.BodyText = BodyText(text)

	return msg, nil
}

// readPart takes one leaf part: the first plain and HTML text, calendar objects and attachments. It decides inline
// or attachment the way go-message's mail reader does.
func (msg *Message) readPart(e *message.Entity, part int, plain, html *string) {
	t, _, _ := e.Header.ContentType()
	disposition, _, _ := e.Header.ContentDisposition()
	if disposition == "inline" || (disposition != "attachment" && strings.HasPrefix(t, "text/")) {
		header := gomail.InlineHeader{Header: e.Header}
		contentType, params, _ := header.ContentType()
		contentID := strings.Trim(header.Get("Content-Id"), "<> ")
		switch {
		case contentType == "text/plain" && *plain == "":
			*plain = readText(e.Body)
		case contentType == "text/html" && *html == "":
			*html = readText(e.Body)
		case isCalendar(contentType):
			data, err := io.ReadAll(io.LimitReader(e.Body, maxCalendarPart+1))
			_, _ = io.Copy(io.Discard, e.Body)
			if err == nil {
				msg.addCalendarPart(params["method"], data)
			}
		case strings.HasPrefix(contentType, "text/"):
			// Other text parts (vcard and the like) carry no snippet text.
			_, _ = io.Copy(io.Discard, e.Body)
		default:
			// Inline non-text parts are embedded images and similar, referenced by Content-ID.
			msg.addAttachment(e.Body, part, filenameFrom(params["name"], contentType), contentType, contentID, true)
		}
		return
	}
	header := gomail.AttachmentHeader{Header: e.Header}
	contentType, params, _ := header.ContentType()
	filename, _ := header.Filename()
	contentID := strings.Trim(header.Get("Content-Id"), "<> ")
	inline := disposition == "inline" && contentID != ""
	if attachment, ok := msg.addAttachment(e.Body, part, filenameFrom(filename, contentType), contentType, contentID, inline); ok {
		if isCalendar(contentType) || strings.HasSuffix(strings.ToLower(filename), ".ics") {
			msg.addCalendarPart(params["method"], attachment.Data)
		}
	}
}

// addAttachment reads an attachment. One whose body breaks off is kept with the bytes read before, and noted.
func (msg *Message) addAttachment(body io.Reader, part int, filename, contentType, contentID string, inline bool) (Attachment, bool) {
	attachment, err := readAttachment(body, filename, contentType, contentID, inline)
	if err != nil {
		msg.Problems = append(msg.Problems, fmt.Sprintf("part %d (%s): %v; kept the first %d bytes", part, filename, err, attachment.Size))
	}
	if err != nil && attachment.Size == 0 {
		return Attachment{}, false
	}
	msg.Attachments = append(msg.Attachments, attachment)
	return attachment, true
}

func headersFrom(h gomail.Header) *Message {
	msg := &Message{}

	msg.Subject, _ = h.Subject()
	msg.MessageID, _ = h.MessageID()
	if ids, err := h.MsgIDList("In-Reply-To"); err == nil && len(ids) > 0 {
		msg.InReplyTo = ids[0]
	}
	msg.References, _ = h.MsgIDList("References")
	if date, err := h.Date(); err == nil && !date.IsZero() {
		msg.Date = &date
	}

	msg.To = addressList(h, "To")
	msg.Cc = addressList(h, "Cc")
	msg.Bcc = addressList(h, "Bcc")
	msg.ReplyTo = addressList(h, "Reply-To")
	msg.From = firstAddress(h, "From", "Sender", "Return-Path")
	msg.Signals = signals(h.Get)

	return msg
}

func signals(get func(string) string) map[string]string {
	var out map[string]string
	for _, name := range signalHeaders {
		value := strings.Join(strings.Fields(get(name)), " ")
		if value == "" {
			continue
		}
		if out == nil {
			out = make(map[string]string)
		}
		if strings.EqualFold(name, "Authentication-Results") {
			if value = cutAtSemicolon(value, authResultsLength); value == "" {
				continue
			}
			out[strings.ToLower(name)] = value
			continue
		}
		out[strings.ToLower(name)] = truncate(value, signalLength)
	}
	return out
}

// cutAtSemicolon cuts a header longer than max characters at its last ";" before the limit that is outside comments
// and quoted strings (RFC 5322), so it ends with a whole result, never inside text that could hold anything; "" when
// there is no such ";".
func cutAtSemicolon(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	cut, depth, quoted, escaped := -1, 0, false, false
	for i, r := range runes[:max] {
		switch {
		case escaped:
			escaped = false
		case r == '\\' && (quoted || depth > 0):
			escaped = true
		case quoted:
			quoted = r != '"'
		case r == '"' && depth == 0:
			quoted = true
		case r == '(':
			depth++
		case r == ')' && depth > 0:
			depth--
		case r == ';' && depth == 0:
			cut = i
		}
	}
	if cut <= 0 {
		return ""
	}
	return strings.TrimSpace(string(runes[:cut]))
}

func addressList(h gomail.Header, key string) []Address {
	list, err := h.AddressList(key)
	if err != nil {
		return nil
	}
	out := make([]Address, 0, len(list))
	for _, a := range list {
		if a.Address == "" {
			continue
		}
		out = append(out, Address{Address: strings.ToLower(a.Address), Name: a.Name})
	}
	return out
}

func firstAddress(h gomail.Header, keys ...string) Address {
	for _, key := range keys {
		if list := addressList(h, key); len(list) > 0 {
			return list[0]
		}
	}
	return Address{Address: UnknownSender}
}

// parseHeadersOnly is the fallback for messages go-message refuses: net/mail is more forgiving with headers.
func parseHeadersOnly(raw []byte) (*Message, error) {
	parsed, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("not a mail message: %w", err)
	}
	decoder := new(mime.WordDecoder)
	decode := func(s string) string {
		if out, err := decoder.DecodeHeader(s); err == nil {
			return out
		}
		return s
	}

	msg := &Message{
		Subject:   decode(parsed.Header.Get("Subject")),
		MessageID: strings.Trim(parsed.Header.Get("Message-Id"), "<> "),
		InReplyTo: strings.Trim(parsed.Header.Get("In-Reply-To"), "<> "),
		From:      Address{Address: UnknownSender},
		Signals:   signals(parsed.Header.Get),
	}
	for _, field := range strings.Fields(parsed.Header.Get("References")) {
		msg.References = append(msg.References, strings.Trim(field, "<> "))
	}
	if date, err := parsed.Header.Date(); err == nil {
		msg.Date = &date
	}
	if from, err := parsed.Header.AddressList("From"); err == nil && len(from) > 0 {
		msg.From = Address{Address: strings.ToLower(from[0].Address), Name: from[0].Name}
	}
	if to, err := parsed.Header.AddressList("To"); err == nil {
		for _, a := range to {
			msg.To = append(msg.To, Address{Address: strings.ToLower(a.Address), Name: a.Name})
		}
	}
	return msg, nil
}

func isCalendar(contentType string) bool {
	return contentType == "text/calendar" || contentType == "application/ics"
}

// addCalendarPart keeps a calendar object once: clients often send the same object as an alternative part and as an
// .ics attachment.
func (m *Message) addCalendarPart(method string, data []byte) {
	if len(data) == 0 || len(data) > maxCalendarPart {
		return
	}
	if !utf8.Valid(data) {
		data = bytes.ToValidUTF8(data, []byte("\uFFFD"))
	}
	text := string(data)
	if !strings.Contains(strings.ToUpper(text), "BEGIN:VCALENDAR") {
		return
	}
	for _, existing := range m.CalendarParts {
		if existing.Data == text {
			return
		}
	}
	m.CalendarParts = append(m.CalendarParts, CalendarPart{Method: strings.ToUpper(strings.TrimSpace(method)), Data: text})
}

func readText(body io.Reader) string {
	data, _ := io.ReadAll(io.LimitReader(body, maxTextRead))
	_, _ = io.Copy(io.Discard, body)
	if !utf8.Valid(data) {
		data = bytes.ToValidUTF8(data, []byte("�"))
	}
	return string(data)
}

// readAttachment reads an attachment's body. On a read error (damaged base64, a cut-off message) it returns what was
// read before together with the error.
func readAttachment(body io.Reader, filename, contentType, contentID string, inline bool) (Attachment, error) {
	data, err := io.ReadAll(body)
	return Attachment{
		Filename:    filename,
		ContentType: contentType,
		ContentID:   contentID,
		Inline:      inline,
		Size:        int64(len(data)),
		Data:        data,
	}, err
}

func filenameFrom(name, contentType string) string {
	name = strings.TrimSpace(path.Base(strings.ReplaceAll(name, "\\", "/")))
	if name != "" && name != "." && name != "/" {
		return truncate(name, 255)
	}
	extension := ""
	if exts, _ := mime.ExtensionsByType(contentType); len(exts) > 0 {
		extension = exts[0]
	}
	return "attachment" + extension
}

func truncate(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max])
}

// markReferencedInline marks every part the HTML body shows through a cid: reference as inline. Mail clients disagree
// on the disposition of embedded images (some send them as attachments), so the reference is what counts.
func markReferencedInline(attachments []Attachment, html string) {
	if html == "" {
		return
	}
	lower := strings.ToLower(html)
	for i := range attachments {
		contentID := strings.ToLower(attachments[i].ContentID)
		if contentID == "" || attachments[i].Inline {
			continue
		}
		if strings.Contains(lower, "cid:"+contentID) || strings.Contains(lower, "cid:"+strings.ToLower(url.PathEscape(attachments[i].ContentID))) {
			attachments[i].Inline = true
		}
	}
}
