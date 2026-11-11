// Package providersync is what the Gmail and Microsoft Graph syncers share: the run loop with its backoff and status
// reports, and the ingest steps that keep the API's view of a folder in line with the provider's.
//
// Both providers identify a message by an id that stays the same in every folder, so a folder is synced as: flag
// changes first (the API answers which ids it does not know in that folder), the raw MIME only for those, and
// removals last. Within one round every folder's additions go before any folder's removals: the API deletes a message
// with its last location, and a message moving between folders must be linked to its new folder before it leaves the
// old one.
package providersync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"time"

	"tresso/sync/internal/api"
	"tresso/sync/internal/providerauth"
	"tresso/sync/internal/providerhttp"
)

// API is the part of the internal API the provider syncers use.
type API interface {
	providerauth.CredentialsAPI
	Folders(ctx context.Context, accountID, workerID string, folders []api.Folder) ([]api.FolderState, error)
	Messages(ctx context.Context, accountID string, batch api.MessageBatch) (api.MessageBatchResult, error)
	Changes(ctx context.Context, accountID string, batch api.ChangeBatch) (api.ChangeBatchResult, error)
	RemoteUIDs(ctx context.Context, accountID, workerID, folder, after string, limit int) (api.RemoteUIDPage, error)
	Status(ctx context.Context, accountID, workerID, status, detail string) error
}

// ErrAccessDenied means the provider accepted the token but refuses mail access: the user did not grant it when
// signing in. Syncers wrap provider errors with it.
var ErrAccessDenied = errors.New("mail access not granted")

type RunOptions struct {
	MinBackoff, MaxBackoff time.Duration
	FailuresBeforeError    int // consecutive failed sessions before the user sees an error
}

// Session syncs an account until an error. healthy reports whether its initial pass completed, so a later failure
// does not count towards the error threshold.
type Session func(ctx context.Context) (healthy bool, err error)

// Run keeps starting sessions until ctx ends (the lease was lost or the worker stops). provider is the name users
// know the account by ("Google", "Microsoft"), for status messages.
//
// Lost access ends the run, as the account stops being leased until the user signs in again: a refused renewal
// (api.ErrReauthorize, which the API already reported), a refused fresh token or refused mail access (reported here).
func Run(ctx context.Context, client API, account api.Account, workerID, provider string, opts RunOptions, logger *slog.Logger, session Session) error {
	backoff := opts.MinBackoff
	failures := 0
	reported := false // whether the API took the error status of the current run of failures

	for {
		healthy, err := session(ctx)
		if ctx.Err() != nil {
			return nil
		}
		switch {
		case errors.Is(err, api.ErrReauthorize):
			logger.Warn("provider refused to renew the access, account needs a new sign-in")
			return nil
		case errors.Is(err, providerhttp.ErrUnauthorized), errors.Is(err, ErrAccessDenied):
			logger.Warn("provider refused access, account needs a new sign-in", "error", err)
			Report(ctx, client, account.ID, workerID, api.StatusAuthFailed, UserFacingDetail(err, provider), logger)
			return nil
		}
		if healthy {
			failures, backoff, reported = 0, opts.MinBackoff, false
		}
		failures++
		logger.Warn("sync session ended", "error", err, "retryIn", backoff)
		// Reported until the API took it: a lost report would leave the account looking fine while it fails.
		if failures >= opts.FailuresBeforeError && !reported {
			reported = Report(ctx, client, account.ID, workerID, api.StatusError, UserFacingDetail(err, provider), logger) == nil
		}

		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, opts.MaxBackoff)
	}
}

// Report sends an account status; a failure is logged and returned, so the caller can send it again.
func Report(ctx context.Context, client API, accountID, workerID, status, detail string, logger *slog.Logger) error {
	err := client.Status(ctx, accountID, workerID, status, detail)
	if err != nil && ctx.Err() == nil {
		logger.Warn("reporting account status failed", "status", status, "error", err)
	}
	return err
}

// UserFacingDetail turns an error into a short message the user can act on. Never provider output or secrets.
func UserFacingDetail(err error, provider string) string {
	var netErr net.Error
	switch {
	case errors.Is(err, api.ErrReauthorize), errors.Is(err, providerhttp.ErrUnauthorized):
		return fmt.Sprintf("%s no longer accepts Tresso's access to this account. Sign in with %s again.", provider, provider)
	case errors.Is(err, ErrAccessDenied):
		return fmt.Sprintf("Tresso is not allowed to read this mailbox. Sign in with %s again and allow access to your mail.", provider)
	case errors.As(err, &netErr):
		return fmt.Sprintf("Could not connect to %s.", provider)
	default:
		return "Syncing failed. Tresso keeps retrying."
	}
}

// EncodeCursor turns a cursor into the string the API stores. It fails instead of letting the API refuse (or cut) a
// cursor that is too long.
func EncodeCursor(cursor any) (string, error) {
	data, err := json.Marshal(cursor)
	if err != nil {
		return "", fmt.Errorf("encode cursor: %w", err)
	}
	if len(data) > api.MaxCursorLength {
		return "", fmt.Errorf("encoded cursor is %d bytes, the API stores at most %d", len(data), api.MaxCursorLength)
	}
	return string(data), nil
}
