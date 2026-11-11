// Package api is the sync worker's client for the internal API.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/clientcredentials"
)

// Scopes the sync worker requests. The API grants nothing else to this client.
var Scopes = []string{"sync:lease", "sync:ingest", "sync:credentials"}

type Account struct {
	ID             string    `json:"id"`
	EmailAddress   string    `json:"emailAddress"`
	Provider       string    `json:"provider"`
	LeaseExpiresAt time.Time `json:"leaseExpiresAt"`
	// Fresh is set when this worker did not hold the account before this heartbeat, also when the API ended the
	// lease (after the user changed the account's sign-in): a syncer still running for it starts over.
	Fresh bool `json:"fresh"`
}

type LeaseResponse struct {
	LeaseSeconds int       `json:"leaseSeconds"`
	Accounts     []Account `json:"accounts"`
	// Leased accounts with mail to send or calendar changes to write now.
	Outbox []string `json:"outbox"`
}

// ServerSettings is where an IMAP or SMTP server lives.
type ServerSettings struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Security string `json:"security"` // "tls", "starttls" or "none"
}

// Connection holds the non-secret settings of an account.
type Connection struct {
	IMAP     ServerSettings `json:"imap"`
	SMTP     ServerSettings `json:"smtp"`
	Username string         `json:"username"`
	// CalDAV is the address of the account's calendars, set by the user or found earlier; empty to discover it.
	CalDAV string `json:"caldav"`
}

// Credentials are the decrypted secrets of one leased account. Keep them in memory only.
type Credentials struct {
	AccountID    string `json:"accountId"`
	EmailAddress string `json:"emailAddress"`
	Provider     string `json:"provider"`
	// Connection is null for Gmail and Microsoft accounts, which leaves it empty here.
	Connection Connection        `json:"connection"`
	Secrets    map[string]string `json:"credentials"`
}

// ErrReauthorize means the provider refused to renew the account's access: the user has to sign in with the provider
// again. The API has already marked the account as auth_failed.
var ErrReauthorize = errors.New("account must be authorized again")

// ErrNotGranted means the user has not allowed the feature (calendars) at the provider yet. The API has already set
// the account's calendar status, which tells the user how to allow it.
var ErrNotGranted = errors.New("the user has not allowed this feature at the provider")

// AccessToken returns the provider access token of an OAuth account and when it expires. Workers never see the
// refresh token: the API renews access tokens itself.
func (c Credentials) AccessToken() (token string, expiresAt time.Time, err error) {
	if c.Secrets["type"] != "oauth2" || c.Secrets["accessToken"] == "" {
		return "", time.Time{}, fmt.Errorf("account %s has no OAuth credentials", c.AccountID)
	}
	expiresAt, err = time.Parse(time.RFC3339, c.Secrets["expiresAt"])
	if err != nil {
		return "", time.Time{}, fmt.Errorf("account %s: unreadable access token expiry: %w", c.AccountID, err)
	}
	return c.Secrets["accessToken"], expiresAt, nil
}

// Password returns the password for password-based accounts.
func (c Credentials) Password() (string, error) {
	if c.Secrets["type"] != "password" || c.Secrets["password"] == "" {
		return "", fmt.Errorf("account %s has no password credentials", c.AccountID)
	}
	return c.Secrets["password"], nil
}

type Client struct {
	baseURL string
	http    *http.Client
	tokens  *resettableTokens
}

// New returns a client that authenticates with the OAuth2 client credentials grant. Tokens are cached until they
// expire; a 401 drops the cached token and retries once, so a revoked token (key rotation, revocation, a restored
// database) never blocks the worker until expiry.
func New(ctx context.Context, baseURL, tokenURL, clientID, clientSecret string) *Client {
	// The token request runs inside the API request's RoundTrip, where the API client's own Timeout cannot interrupt
	// it, and every other request waits for it: it needs a timeout of its own.
	tokenCtx := context.WithValue(ctx, oauth2.HTTPClient, &http.Client{Timeout: tokenTimeout})
	tokens := &resettableTokens{ctx: tokenCtx, config: &clientcredentials.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		TokenURL:     tokenURL,
		Scopes:       Scopes,
	}}
	tokens.Reset()

	// oauth2.Transport directly: oauth2.NewClient would add a second token cache that Reset cannot clear.
	httpClient := &http.Client{Transport: &oauth2.Transport{Source: tokens, Base: http.DefaultTransport}, Timeout: 15 * time.Second}

	return &Client{baseURL: strings.TrimRight(baseURL, "/"), http: httpClient, tokens: tokens}
}

// tokenTimeout bounds one token request.
var tokenTimeout = 15 * time.Second

type resettableTokens struct {
	ctx    context.Context
	config *clientcredentials.Config
	mu     sync.Mutex
	source oauth2.TokenSource
}

func (r *resettableTokens) Token() (*oauth2.Token, error) {
	r.mu.Lock()
	source := r.source
	r.mu.Unlock()
	return source.Token()
}

// Reset forgets the cached token; the next request fetches a new one.
func (r *resettableTokens) Reset() {
	r.mu.Lock()
	r.source = r.config.TokenSource(r.ctx)
	r.mu.Unlock()
}

func (c *Client) send(ctx context.Context, method, path string, payload []byte) (*http.Response, error) {
	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return nil, err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s %s: %w", method, path, err)
	}
	return resp, nil
}

// NewWithHTTPClient is used in tests and when the caller manages authentication.
func NewWithHTTPClient(baseURL string, httpClient *http.Client) *Client {
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), http: httpClient}
}

// Lease renews the leases this worker holds and claims new accounts up to capacity.
func (c *Client) Lease(ctx context.Context, workerID string, capacity int) (LeaseResponse, error) {
	var out LeaseResponse
	err := c.post(ctx, "/internal/sync/leases", map[string]any{"workerId": workerID, "capacity": capacity}, &out)
	return out, err
}

// Release gives every account held by this worker back, so other workers take over without waiting for expiry.
func (c *Client) Release(ctx context.Context, workerID string) error {
	return c.post(ctx, "/internal/sync/leases/release", map[string]any{"workerId": workerID}, nil)
}

// Credentials fetches the decrypted credentials of an account this worker currently leases. For OAuth accounts it
// returns ErrReauthorize (wrapped) when the user has to sign in with the provider again.
func (c *Client) Credentials(ctx context.Context, accountID, workerID string) (Credentials, error) {
	return c.credentials(ctx, accountID, workerID, false)
}

// RefreshCredentials is Credentials after the provider refused the access token it returned: the API renews the
// token at the provider before answering.
func (c *Client) RefreshCredentials(ctx context.Context, accountID, workerID string) (Credentials, error) {
	return c.credentials(ctx, accountID, workerID, true)
}

// CalendarCredentials is Credentials for the account's calendars: the access token must also carry the calendar
// scopes. It returns ErrNotGranted (wrapped) while the user has not allowed calendar access; mail goes on meanwhile.
func (c *Client) CalendarCredentials(ctx context.Context, accountID, workerID string) (Credentials, error) {
	return c.credentialsFor(ctx, accountID, workerID, false, "calendar")
}

// RefreshCalendarCredentials is CalendarCredentials after the provider refused the access token.
func (c *Client) RefreshCalendarCredentials(ctx context.Context, accountID, workerID string) (Credentials, error) {
	return c.credentialsFor(ctx, accountID, workerID, true, "calendar")
}

func (c *Client) credentials(ctx context.Context, accountID, workerID string, rejected bool) (Credentials, error) {
	return c.credentialsFor(ctx, accountID, workerID, rejected, "")
}

func (c *Client) credentialsFor(ctx context.Context, accountID, workerID string, rejected bool, feature string) (Credentials, error) {
	var out Credentials
	path := "/internal/sync/accounts/" + url.PathEscape(accountID) + "/credentials?workerId=" + url.QueryEscape(workerID)
	if rejected {
		path += "&rejected=1"
	}
	if feature != "" {
		path += "&feature=" + url.QueryEscape(feature)
	}
	err := c.do(ctx, http.MethodGet, path, nil, &out)
	var httpErr *HTTPError
	if errors.As(err, &httpErr) && httpErr.Status == http.StatusConflict {
		return out, fmt.Errorf("%w: %w", ErrReauthorize, err)
	}
	if errors.As(err, &httpErr) && httpErr.Status == http.StatusForbidden && feature != "" {
		return out, fmt.Errorf("%w: %w", ErrNotGranted, err)
	}
	return out, err
}

// HTTPError is an API response outside 2xx.
type HTTPError struct {
	Method, Path string
	Status       int
	Body         string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("%s %s: unexpected status %d: %s", e.Method, e.Path, e.Status, e.Body)
}

func (c *Client) post(ctx context.Context, path string, body any, out any) error {
	return c.do(ctx, http.MethodPost, path, body, out)
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
	}

	resp, err := c.send(ctx, method, path, payload)
	if err != nil {
		return err
	}
	if resp.StatusCode == http.StatusUnauthorized && c.tokens != nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		c.tokens.Reset()
		if resp, err = c.send(ctx, method, path, payload); err != nil {
			return err
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return &HTTPError{Method: method, Path: path, Status: resp.StatusCode, Body: string(bytes.TrimSpace(snippet))}
	}

	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("%s %s: decode response: %w", method, path, err)
	}
	return nil
}
