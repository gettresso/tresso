package imapsync

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"strconv"
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
			_ = conn.Close()
			return nil, fmt.Errorf("tls handshake: %w", err)
		}
		client = imapclient.New(tlsConn, options)
	case "starttls":
		client, err = imapclient.NewStartTLS(conn, options)
		if err != nil {
			_ = conn.Close()
			return nil, fmt.Errorf("starttls: %w", err)
		}
	case "none":
		client = imapclient.New(conn, options)
	default:
		_ = conn.Close()
		return nil, fmt.Errorf("unknown connection security %q", server.Security)
	}

	// Close the connection when the context ends, so a lost lease interrupts blocking commands.
	stop := context.AfterFunc(ctx, func() { _ = client.Close() })

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

// loginError tells a refused password from a refusal that may pass. Only the response codes of RFC 5530 that are
// about the credentials themselves are final; UNAVAILABLE, INUSE, LIMIT, SERVERBUG, CONTACTADMIN, ALERT and the like
// are ordinary session errors, retried with backoff. A NO without a code is errLoginRefused: the syncer decides once
// it repeats.
func loginError(err error) error {
	var imapErr *imap.Error
	if !errors.As(err, &imapErr) {
		return fmt.Errorf("login: %w", err)
	}
	switch imapErr.Code {
	case imap.ResponseCodeAuthenticationFailed, imap.ResponseCodeAuthorizationFailed, imap.ResponseCodeExpired:
		return fmt.Errorf("%w: %s", ErrAuth, imapErr.Text)
	case imap.ResponseCodePrivacyRequired:
		return fmt.Errorf("%w: %s", errLoginDisabled, imapErr.Text)
	case "":
		if imapErr.Type == imap.StatusResponseTypeNo {
			return fmt.Errorf("%w: %s", errLoginRefused, imapErr.Text)
		}
	}
	return fmt.Errorf("login: %w", err)
}

// userFacingDetail turns an error into a short message the user can act on. Never server output or secrets.
func userFacingDetail(err error) string {
	var netErr net.Error
	switch {
	case errors.Is(err, ErrAuth):
		return "The mail server rejected the username or password."
	case errors.Is(err, errLoginRefused):
		return "The mail server refused the sign-in. Tresso keeps trying."
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
