// Package providerhttp calls the REST APIs of mail providers (Gmail, Microsoft Graph) for one account: it adds the
// account's access token, keeps to the provider's rate limits, retries throttled and failed requests, and replaces an
// access token the provider refused.
package providerhttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Tokens hands out the account's access token. Invalidate reports that the provider refused rejected; the next Token
// returns a renewed one.
type Tokens interface {
	Token(ctx context.Context) (string, error)
	Invalidate(ctx context.Context, rejected string) error
}

// ErrUnauthorized means the provider refused a freshly renewed access token too: the account's access was revoked.
var ErrUnauthorized = errors.New("provider refused the access token")

// StatusError is a provider response outside the 2xx range that was not retried (or ran out of retries).
type StatusError struct {
	Method     string
	URL        string
	StatusCode int
	// Reasons are the machine-readable error codes of the body: Graph's error.code, Gmail's error.status and the
	// reasons in error.errors and error.details.
	Reasons []string
	// Message is the provider's human-readable error message, if any.
	Message string
}

func (e *StatusError) Error() string {
	text := fmt.Sprintf("%s %s: status %d", e.Method, e.URL, e.StatusCode)
	if len(e.Reasons) > 0 {
		text += " (" + strings.Join(e.Reasons, ", ") + ")"
	}
	if e.Message != "" {
		text += ": " + e.Message
	}
	return text
}

// HasReason reports whether the provider gave reason (case-insensitive) as one of the error codes.
func (e *StatusError) HasReason(reason string) bool {
	for _, r := range e.Reasons {
		if strings.EqualFold(r, reason) {
			return true
		}
	}
	return false
}

// IsStatus reports whether err is a StatusError with the given status code.
func IsStatus(err error, code int) bool {
	var statusErr *StatusError
	return errors.As(err, &statusErr) && statusErr.StatusCode == code
}

type Options struct {
	// Rate limit in cost units per second (requests, when every request costs 1) and the burst allowed.
	UnitsPerSecond float64
	Burst          int
	// MaxAttempts is how often a throttled or failed request is sent in total.
	MaxAttempts            int
	MinBackoff, MaxBackoff time.Duration // used when the provider sends no Retry-After
	Timeout                time.Duration // per attempt, including reading the body
	Header                 http.Header   // sent with every request
	// Throttled reports provider-specific throttling responses outside 429 (Gmail answers 403 rateLimitExceeded);
	// they are retried like 429.
	Throttled func(*StatusError) bool
}

func DefaultOptions() Options {
	return Options{
		UnitsPerSecond: 10,
		Burst:          10,
		MaxAttempts:    6,
		MinBackoff:     time.Second,
		MaxBackoff:     time.Minute,
		Timeout:        2 * time.Minute,
	}
}

type Client struct {
	http    *http.Client
	tokens  Tokens
	limiter *Limiter
	opts    Options
}

// New returns a client for one account. httpClient may be nil for http.DefaultClient's transport.
func New(httpClient *http.Client, tokens Tokens, opts Options) *Client {
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	return &Client{http: httpClient, tokens: tokens, limiter: NewLimiter(opts.UnitsPerSecond, opts.Burst), opts: opts}
}

type Request struct {
	Method      string
	URL         string
	Body        []byte
	ContentType string
	Header      http.Header
	// Cost in rate limit units; 0 counts as 1.
	Cost int
}

// maxResponseBytes bounds what is read from a provider. Gmail and Graph refuse messages over 35 MB (150 MB for
// Graph's MIME uploads); base64 in JSON adds a third.
const maxResponseBytes = 256 << 20

// Do sends the request and returns the body of a 2xx response.
//
// 429 is retried for every request, other 5xx responses only for idempotent methods (GET, PUT, DELETE): a POST that
// failed on the provider's side may still have taken effect (a sent message), so the caller decides. The same holds
// for a broken connection (reset, refused, DNS, the per-attempt timeout): idempotent requests are sent again, a POST
// returns the error. A 401 renews the access token once.
func (c *Client) Do(ctx context.Context, req Request) ([]byte, error) {
	renewed := false
	backoff := c.opts.MinBackoff

	for attempt := 1; ; attempt++ {
		if err := c.limiter.Wait(ctx, max(req.Cost, 1)); err != nil {
			return nil, err
		}
		token, err := c.tokens.Token(ctx)
		if err != nil {
			return nil, err
		}

		status, header, body, err := c.send(ctx, req, token)
		var broken *connectionError
		if err != nil && errors.As(err, &broken) && ctx.Err() == nil && idempotent(req.Method) && attempt < c.opts.MaxAttempts {
			wait := backoff
			backoff = min(backoff*2, c.opts.MaxBackoff)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(wait):
			}
			continue
		}
		if err != nil {
			return nil, err
		}
		if status >= 200 && status <= 299 {
			return body, nil
		}

		statusErr := newStatusError(req, status, body)
		switch {
		case status == http.StatusUnauthorized && !renewed:
			if err := c.tokens.Invalidate(ctx, token); err != nil {
				return nil, err
			}
			renewed = true
			attempt-- // the token was the problem, not the provider
			continue
		case status == http.StatusUnauthorized:
			return nil, fmt.Errorf("%w: %w", ErrUnauthorized, statusErr)
		case status == http.StatusTooManyRequests, status >= 500 && idempotent(req.Method), c.opts.Throttled != nil && c.opts.Throttled(statusErr):
			if attempt >= c.opts.MaxAttempts {
				return nil, statusErr
			}
			wait, ok := retryAfter(header.Get("Retry-After"), time.Now())
			if !ok {
				wait = backoff
				backoff = min(backoff*2, c.opts.MaxBackoff)
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(wait):
			}
		default:
			return nil, statusErr
		}
	}
}

func idempotent(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPut, http.MethodDelete:
		return true
	}
	return false
}

// JSON sends the request and decodes a 2xx response into out (when not nil).
func (c *Client) JSON(ctx context.Context, req Request, out any) error {
	if req.Header == nil {
		req.Header = http.Header{}
	}
	req.Header.Set("Accept", "application/json")
	body, err := c.Do(ctx, req)
	if err != nil || out == nil {
		return err
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("%s %s: decode response: %w", req.Method, redact(req.URL), err)
	}
	return nil
}

func (c *Client) send(ctx context.Context, req Request, token string) (int, http.Header, []byte, error) {
	if c.opts.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, c.opts.Timeout)
		defer cancel()
	}
	var reader io.Reader
	if req.Body != nil {
		reader = bytes.NewReader(req.Body)
	}
	httpReq, err := http.NewRequestWithContext(ctx, req.Method, req.URL, reader)
	if err != nil {
		return 0, nil, nil, err
	}
	for name, values := range c.opts.Header {
		httpReq.Header[name] = values
	}
	for name, values := range req.Header {
		httpReq.Header[name] = values
	}
	if req.ContentType != "" {
		httpReq.Header.Set("Content-Type", req.ContentType)
	}
	httpReq.Header.Set("Authorization", "Bearer "+token)

	resp, err := c.http.Do(httpReq)
	if err != nil {
		// The URL may carry a page token, never a secret; the access token is only in the header.
		return 0, nil, nil, fmt.Errorf("%s %s: %w", req.Method, redact(req.URL), &connectionError{err})
	}
	defer resp.Body.Close()

	limit := int64(maxResponseBytes)
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		limit = 16 << 10 // error bodies are small; only the error codes are needed
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return 0, nil, nil, fmt.Errorf("%s %s: read response: %w", req.Method, redact(req.URL), &connectionError{err})
	}
	if int64(len(body)) > limit && resp.StatusCode >= 200 && resp.StatusCode <= 299 {
		return 0, nil, nil, fmt.Errorf("%s %s: response larger than %d bytes", req.Method, redact(req.URL), limit)
	}
	return resp.StatusCode, resp.Header, body, nil
}

// connectionError is a request that got no complete answer: the connection failed, broke or timed out (the attempt's
// own timeout; the caller's context is checked apart).
type connectionError struct{ err error }

func (e *connectionError) Error() string { return e.err.Error() }
func (e *connectionError) Unwrap() error { return e.err }

func newStatusError(req Request, status int, body []byte) *StatusError {
	out := &StatusError{Method: req.Method, URL: redact(req.URL), StatusCode: status}

	// Both providers wrap errors in {"error": {...}}; Graph's code is a string, Gmail's a number next to a status.
	var envelope struct {
		Error struct {
			Code    json.RawMessage `json:"code"`
			Status  string          `json:"status"`
			Message string          `json:"message"`
			Errors  []struct {
				Reason string `json:"reason"`
			} `json:"errors"`
			Details []struct {
				Reason string `json:"reason"`
			} `json:"details"`
			InnerError struct {
				Code string `json:"code"`
			} `json:"innerError"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &envelope) != nil {
		return out
	}
	e := envelope.Error
	var code string
	if json.Unmarshal(e.Code, &code) == nil && code != "" {
		out.Reasons = append(out.Reasons, code)
	}
	if e.InnerError.Code != "" {
		out.Reasons = append(out.Reasons, e.InnerError.Code)
	}
	if e.Status != "" {
		out.Reasons = append(out.Reasons, e.Status)
	}
	for _, item := range e.Errors {
		if item.Reason != "" {
			out.Reasons = append(out.Reasons, item.Reason)
		}
	}
	for _, item := range e.Details {
		if item.Reason != "" {
			out.Reasons = append(out.Reasons, item.Reason)
		}
	}
	out.Message = e.Message
	return out
}

// retryAfter reads a Retry-After header: seconds or an HTTP date.
func retryAfter(value string, now time.Time) (time.Duration, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, false
	}
	if seconds, err := strconv.ParseFloat(value, 64); err == nil && seconds >= 0 {
		return time.Duration(seconds * float64(time.Second)), true
	}
	if at, err := http.ParseTime(value); err == nil {
		return max(at.Sub(now), 0), true
	}
	return 0, false
}

// redact drops the query string, which can be long (Graph delta tokens) and is never needed in logs.
func redact(rawURL string) string {
	if i := strings.IndexByte(rawURL, '?'); i >= 0 {
		return rawURL[:i]
	}
	return rawURL
}
