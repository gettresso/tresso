package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
)

// logoutTimeout is how long POST /api/logout waits for WhatsApp to confirm. whatsmeow's own limit for an info query
// is longer (75 seconds); Disconnect in the desktop app should not hang that long.
const logoutTimeout = 20 * time.Second

// logout removes this device from the account on WhatsApp's side (the phone stops listing it under Linked devices),
// disconnects and deletes the session from whatsapp.db. Tests replace it, so they never reach WhatsApp.
var logout = (*whatsmeow.Client).Logout

// LogoutResponse is the answer of POST /api/logout.
type LogoutResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

// logoutFailure is how a failed log out is answered: the status and a fixed text. The error itself is never sent or
// printed: whatsmeow's texts can hold the device's JID.
type logoutFailure struct {
	status  int
	message string
}

// whatsmeow's Logout (client.go) fails in these ways, in this order: no device in the store (ErrNotLoggedIn), the
// request could not go out (ErrNotConnected and other send errors), no answer in time (ErrIQTimedOut, or the
// request's context ending), WhatsApp answered with an error (*IQError), or, after WhatsApp confirmed and the client
// disconnected, the session could not be deleted from the store. Only the last one comes after the confirmation.
const storeDeleteError = "error deleting data from store"

// classifyLogout says whether WhatsApp confirmed the log out, and how a failure is answered.
func classifyLogout(err error) (confirmed bool, failure *logoutFailure) {
	switch {
	case err == nil:
		return true, nil
	case strings.HasPrefix(err.Error(), storeDeleteError):
		// WhatsApp removed the device; only the local copy of the session is left, and the desktop app removes the
		// whole store after this answer.
		return true, nil
	case errors.Is(err, whatsmeow.ErrNotLoggedIn):
		return false, &logoutFailure{http.StatusConflict, "Not linked"}
	case errors.Is(err, whatsmeow.ErrNotConnected):
		return false, &logoutFailure{http.StatusServiceUnavailable, "Not connected to WhatsApp"}
	case errors.Is(err, whatsmeow.ErrIQTimedOut), errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		return false, &logoutFailure{http.StatusGatewayTimeout, "WhatsApp did not confirm the log out in time"}
	default:
		var iq *whatsmeow.IQError
		if errors.As(err, &iq) {
			return false, &logoutFailure{http.StatusBadGateway, "WhatsApp refused the log out"}
		}
		return false, &logoutFailure{http.StatusBadGateway, "The log out could not be sent to WhatsApp"}
	}
}

// handleLogout is POST /api/logout with the body {}. Once WhatsApp confirmed, it answers 200 and then calls loggedOut,
// which ends the bridge as a log out from the phone does (the event logged_out, status 0).
func handleLogout(client *whatsmeow.Client, loggedOut func()) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct{}
		if !decodeRequest(w, r, &req) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), logoutTimeout)
		defer cancel()
		confirmed, failure := classifyLogout(logout(client, ctx))
		w.Header().Set("Content-Type", "application/json")
		if !confirmed {
			w.WriteHeader(failure.status)
			_ = json.NewEncoder(w).Encode(LogoutResponse{Success: false, Message: failure.message})
			return
		}
		_ = json.NewEncoder(w).Encode(LogoutResponse{Success: true, Message: "Logged out"})
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		loggedOut()
	}
}

// onceLoggedOut makes the end of a log out happen once, whether the phone or POST /api/logout caused it.
func onceLoggedOut(em *emitter, stop func()) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			em.loggedOut()
			stop()
		})
	}
}
