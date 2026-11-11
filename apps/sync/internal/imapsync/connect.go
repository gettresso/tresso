package imapsync

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"

	"tresso/sync/internal/api"
	"tresso/sync/internal/netguard"
)

// ErrAuth means the server refused the credentials; retrying will not help until the user changes them.
var ErrAuth = errors.New("authentication failed")

// errLoginRefused is a NO to LOGIN without a response code. Most servers answer a wrong password like that, but so
// do some for a temporary problem (their authentication backend is down), so the syncer only treats it as ErrAuth
// once it repeats.
var errLoginRefused = errors.New("login refused")

// errLoginDisabled means the server does not accept a plain LOGIN on this connection (LOGINDISABLED, or the
// PRIVACYREQUIRED response code): the connection security setting is wrong, not the password.
var errLoginDisabled = errors.New("login not allowed on an unencrypted connection")

// Dialer opens connections; the netguard dialer refuses private addresses.
type Dialer interface {
	DialContext(ctx context.Context, address string) (net.Conn, error)
}

// connection is a logged-in client that is closed when the context it was opened with ends. Close also drops that
// hook: the context often lives as long as the worker, and the hook would keep every closed client reachable.
type connection struct {
	*imapclient.Client
	stop func() bool
}

// Close closes the connection and forgets the context hook.
func (c *connection) Close() error {
	c.stop()
	return c.Client.Close()
}

// serverEvents is what the server reports unasked. updates receives a signal for anything (new mail, expunges, flag
// changes); expunged is set when a message was expunged, which with CONDSTORE only a full check of the folder finds.
type serverEvents struct {
	updates  chan struct{}
	expunged atomic.Bool
}

func newServerEvents() *serverEvents {
	return &serverEvents{updates: make(chan struct{}, 1)}
}

// connect dials through the guarded dialer, sets up TLS or STARTTLS, waits for the greeting and logs in. events
// records what the server reports unasked.
func connect(ctx context.Context, d Dialer, server api.ServerSettings, username, password string, events *serverEvents) (*connection, error) {
	conn, err := d.DialContext(ctx, net.JoinHostPort(server.Host, strconv.Itoa(server.Port)))
	if err != nil {
		return nil, err
	}
	// Close the connection when the context ends, so a lost lease interrupts everything that waits on the server:
	// the STARTTLS exchange and the greeting as well as the commands of the session.
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })

	notify := func() {
		select {
		case events.updates <- struct{}{}:
		default:
		}
	}
	options := &imapclient.Options{
		TLSConfig: &tls.Config{ServerName: server.Host, MinVersion: tls.VersionTLS12},
		UnilateralDataHandler: &imapclient.UnilateralDataHandler{
			Mailbox: func(data *imapclient.UnilateralDataMailbox) {
				if data.NumMessages != nil {
					notify()
				}
			},
			Expunge: func(uint32) {
				events.expunged.Store(true)
				notify()
			},
			Fetch: func(msg *imapclient.FetchMessageData) {
				// The data must be read completely, or the connection stalls.
				_, _ = msg.Collect()
				notify()
			},
		},
	}

	var client *imapclient.Client
	switch server.Security {
	case "tls":
		tlsConn := tls.Client(conn, options.TLSConfig)
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			stop()
			_ = conn.Close()
			return nil, fmt.Errorf("tls handshake: %w", err)
		}
		client = imapclient.New(tlsConn, options)
	case "starttls":
		client, err = imapclient.NewStartTLS(conn, options)
		if err != nil {
			stop()
			_ = conn.Close()
			return nil, fmt.Errorf("starttls: %w", err)
		}
	case "none":
		client = imapclient.New(conn, options)
	default:
		stop()
		_ = conn.Close()
		return nil, fmt.Errorf("unknown connection security %q", server.Security)
	}

	if err := client.WaitGreeting(); err != nil {
		stop()
		_ = client.Close()
		return nil, fmt.Errorf("greeting: %w", err)
	}
	if client.Caps().Has(imap.CapLoginDisabled) {
		stop()
		_ = client.Close()
		return nil, errLoginDisabled
	}
	if err := client.Login(username, password).Wait(); err != nil {
		stop()
		_ = client.Close()
		return nil, loginError(err)
	}
	return &connection{Client: client, stop: stop}, nil
}

// loginRefusal is a NO to LOGIN that is no known passing problem (see loginError). It is errLoginRefused; alert holds
// the text of an ALERT response code, which RFC 3501 says the user must see.
type loginRefusal struct {
	text  string
	alert string
}

func (e *loginRefusal) Error() string { return errLoginRefused.Error() + ": " + e.text }

func (e *loginRefusal) Is(target error) bool { return target == errLoginRefused }

// temporaryLoginCodes are the RFC 5530 response codes that say a refused LOGIN may pass.
var temporaryLoginCodes = map[imap.ResponseCode]bool{
	imap.ResponseCodeUnavailable:  true,
	imap.ResponseCodeInUse:        true,
	imap.ResponseCodeLimit:        true,
	imap.ResponseCodeServerBug:    true,
	imap.ResponseCodeContactAdmin: true,
}

// loginError tells a refused password from a refusal that may pass. The response codes of RFC 5530 about the
// credentials themselves are final at once. UNAVAILABLE, INUSE, LIMIT, SERVERBUG and CONTACTADMIN are ordinary
// session errors, retried with backoff. Any other NO (without a code, with ALERT, which servers use for "use an
// app password", or with a code Tresso does not know) is errLoginRefused: the syncer takes it for a wrong password
// once it repeats.
func loginError(err error) error {
	var imapErr *imap.Error
	if !errors.As(err, &imapErr) {
		return fmt.Errorf("login: %w", err)
	}
	switch {
	case imapErr.Code == imap.ResponseCodeAuthenticationFailed, imapErr.Code == imap.ResponseCodeAuthorizationFailed, imapErr.Code == imap.ResponseCodeExpired:
		return fmt.Errorf("%w: %s", ErrAuth, imapErr.Text)
	case imapErr.Code == imap.ResponseCodePrivacyRequired:
		return fmt.Errorf("%w: %s", errLoginDisabled, imapErr.Text)
	case imapErr.Type != imap.StatusResponseTypeNo, temporaryLoginCodes[imapErr.Code]:
		return fmt.Errorf("login: %w", err)
	}
	refusal := &loginRefusal{text: imapErr.Text}
	if imapErr.Code == imap.ResponseCodeAlert {
		refusal.alert = serverText(imapErr.Text, 300)
	}
	return refusal
}

// serverText makes text from the server fit for the user's status detail: printable, at most max characters.
func serverText(text string, max int) string {
	text = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, strings.ToValidUTF8(text, ""))
	text = strings.Join(strings.Fields(text), " ")
	if runes := []rune(text); len(runes) > max {
		text = string(runes[:max])
	}
	return text
}

// userFacingDetail turns an error into a short message the user can act on. Never server output or secrets, except
// the text of an ALERT the server sent with a refused login, which is meant for the user.
func userFacingDetail(err error) string {
	var netErr net.Error
	var refusal *loginRefusal
	switch {
	case errors.As(err, &refusal) && refusal.alert != "":
		return "The mail server refused the sign-in: " + refusal.alert
	case errors.Is(err, ErrAuth):
		return "The mail server rejected the username or password."
	case errors.Is(err, errLoginRefused):
		return "The mail server refused the sign-in. Tresso keeps trying."
	case errors.Is(err, errFolderUnavailable):
		return "The mail server refused to open the inbox. Tresso keeps trying."
	case errors.Is(err, errLoginDisabled):
		return "The mail server only allows signing in over an encrypted connection. Choose TLS or STARTTLS."
	case errors.Is(err, netguard.ErrBlockedAddress):
		return "The mail server address is not allowed."
	case errors.As(err, &netErr):
		return "Could not connect to the mail server."
	default:
		var tlsErr *tls.CertificateVerificationError
		if errors.As(err, &tlsErr) {
			return "The mail server's security certificate could not be verified."
		}
		return "Syncing failed. Tresso keeps retrying."
	}
}
