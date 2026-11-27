package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
)

// The REST API: POST /api/send and POST /api/download on 127.0.0.1 only, behind protect.

// protect lets a request through only when it names this computer as its host, carries the bridge's token and has a
// JSON body. The API has no other check, and anything on this computer reaches 127.0.0.1: another program, and a web
// page in a browser through a no-cors POST (which can send neither this header nor a JSON content type) or through a
// name of its own that resolves to 127.0.0.1 (DNS rebinding, which the host check stops). An empty token lets
// nothing through: readConfig never gives one, and protect does not fall back to an open API if it ever got one.
func protect(next http.Handler, token string, port int) http.Handler {
	hosts := map[string]bool{
		fmt.Sprintf("127.0.0.1:%d", port): true,
		fmt.Sprintf("localhost:%d", port): true,
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !hosts[strings.ToLower(r.Host)] {
			http.Error(w, "Forbidden host", http.StatusForbidden)
			return
		}
		if token == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Bridge-Token")), []byte(token)) != 1 {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		if mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mediaType != "application/json" {
			http.Error(w, "Content-Type must be application/json", http.StatusUnsupportedMediaType)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// maxRequestBody is the largest request body the REST API reads: both requests are a few short JSON fields.
const maxRequestBody = 1 << 20

// decodeRequest reads a JSON body of at most maxRequestBody bytes into v and answers the client itself when it cannot.
func decodeRequest(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, "Request body too large", http.StatusRequestEntityTooLarge)
			return false
		}
		http.Error(w, "Invalid request format", http.StatusBadRequest)
		return false
	}
	return true
}

// newRESTHandler returns the REST API's routes. Every check that needs no WhatsApp connection runs before the client
// or the store is used.
func newRESTHandler(client *whatsmeow.Client, messageStore *MessageStore) *http.ServeMux {
	mux := http.NewServeMux()

	// Handler for sending messages
	mux.HandleFunc("/api/send", func(w http.ResponseWriter, r *http.Request) {
		// Only allow POST requests
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Parse the request body
		var req SendMessageRequest
		if !decodeRequest(w, r, &req) {
			return
		}

		// A media path that is not absolute is refused before anything else: the bridge never reads a path relative to
		// wherever it happens to run.
		if req.MediaPath != "" && !filepath.IsAbs(req.MediaPath) {
			http.Error(w, "Media path must be absolute", http.StatusBadRequest)
			return
		}

		// Validate request
		if req.Recipient == "" {
			http.Error(w, "Recipient is required", http.StatusBadRequest)
			return
		}

		if req.Message == "" && req.MediaPath == "" {
			http.Error(w, "Message or media path is required", http.StatusBadRequest)
			return
		}

		if _, err := recipientJID(req.Recipient); err != nil {
			http.Error(w, "Recipient is not valid", http.StatusBadRequest)
			return
		}

		if req.MediaPath != "" {
			if err := checkMedia(req.MediaPath); err != nil {
				http.Error(w, mediaRefusal(err), http.StatusBadRequest)
				return
			}
		}

		// Send the message
		success, message := sendWhatsAppMessage(client, req.Recipient, req.Message, req.MediaPath)
		// Set response headers
		w.Header().Set("Content-Type", "application/json")

		// Set appropriate status code
		if !success {
			w.WriteHeader(http.StatusInternalServerError)
		}

		// Send response
		_ = json.NewEncoder(w).Encode(SendMessageResponse{
			Success: success,
			Message: message,
		})
	})

	// Handler for downloading media
	mux.HandleFunc("/api/download", func(w http.ResponseWriter, r *http.Request) {
		// Only allow POST requests
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Parse the request body
		var req DownloadMediaRequest
		if !decodeRequest(w, r, &req) {
			return
		}

		// Validate request
		if req.MessageID == "" || req.ChatJID == "" {
			http.Error(w, "Message ID and Chat JID are required", http.StatusBadRequest)
			return
		}

		// Download the media; a client that goes away stops the wait for the phone.
		success, mediaType, filename, path, err := downloadMedia(r.Context(), client, messageStore, req.MessageID, req.ChatJID)

		// Set response headers
		w.Header().Set("Content-Type", "application/json")

		// Handle download result
		if !success || err != nil {
			errMsg := "Unknown error"
			if err != nil {
				errMsg = err.Error()
			}

			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(DownloadMediaResponse{
				Success: false,
				Message: fmt.Sprintf("Failed to download media: %s", errMsg),
			})
			return
		}

		// Send successful response
		_ = json.NewEncoder(w).Encode(DownloadMediaResponse{
			Success:  true,
			Message:  fmt.Sprintf("Successfully downloaded %s media", mediaType),
			Filename: filename,
			Path:     path,
		})
	})

	return mux
}

// mediaRefusal is the answer for a media path checkMedia refused.
func mediaRefusal(err error) string {
	switch {
	case errors.Is(err, errMediaNotFile):
		return "Media path is not a regular file"
	case errors.Is(err, errMediaTooLarge):
		return "Media file is larger than 100 MB"
	case errors.Is(err, errMediaNotAbsolute):
		return "Media path must be absolute"
	default:
		return "Media file cannot be read"
	}
}

// listenREST binds the REST API to 127.0.0.1:port. It only binds: serve starts answering. The bridge says it listens
// only after the bind worked.
func listenREST(port int) (net.Listener, error) {
	return net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
}

// The REST server's limits. A client may not hold a connection open without sending its request (headers within 10
// seconds, the whole request within 30: the body is JSON of at most maxRequestBody, 1 MiB, and files go by path, so
// that is ample even for the largest request on 127.0.0.1), nor keep an idle connection for more than a minute.
// There is no write timeout: a download may wait up to mediaRetryTimeout (60 seconds) for the phone.
const (
	readHeaderTimeout = 10 * time.Second
	readTimeout       = 30 * time.Second
	idleTimeout       = 60 * time.Second
	maxHeaderBytes    = 16 << 10
)

// newRESTServer is the HTTP server of the API. net/http's own error log (bad requests, broken connections, a
// recovered handler panic with its value) is dropped: it names remote addresses and request details, and stderr
// carries only the bridge's own short lines.
func newRESTServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
		ErrorLog:          log.New(io.Discard, "", 0),
	}
}
