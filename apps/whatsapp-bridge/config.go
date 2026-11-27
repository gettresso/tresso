package main

import (
	"path/filepath"
	"strconv"
)

// The environment the bridge reads, and nothing else: no flags, no working directory, no defaults.
const (
	envStore = "WHATSAPP_BRIDGE_STORE"
	envPort  = "WHATSAPP_BRIDGE_PORT"
	envToken = "WHATSAPP_BRIDGE_TOKEN"
)

// minTokenLength is the shortest token the bridge accepts. Tresso gives 64 hex characters; anything much shorter is a
// mistake, not a secret.
const minTokenLength = 32

// maxTokenLength keeps a token to something a header carries.
const maxTokenLength = 512

// config is what the bridge runs with. Every field is required.
type config struct {
	// store is the absolute, clean path of the store folder: whatsapp.db, messages.db and downloaded media.
	store string
	// port is the port of the REST API on 127.0.0.1.
	port int
	// token is the value every request must carry in X-Bridge-Token.
	token string
}

// fatalError is an error that stops the bridge. code goes to stdout in the fatal event, reason to stderr. Both are
// fixed strings written in this program: never a value that came from WhatsApp, a request or the environment.
type fatalError struct {
	code   string
	reason string
	// cause is kept for tests and errors.Is; it is never printed, since it can hold paths with chat ids.
	cause error
}

func (e *fatalError) Error() string { return e.reason }
func (e *fatalError) Unwrap() error { return e.cause }

func fatal(code, reason string, cause error) *fatalError {
	return &fatalError{code: code, reason: reason, cause: cause}
}

// readConfig reads the environment through lookup (os.LookupEnv in the program). The port, the token and the store
// are all required: there is no default port and no mode without a token.
func readConfig(lookup func(string) (string, bool)) (config, error) {
	portValue, _ := lookup(envPort)
	port, err := parseBridgePort(portValue)
	if err != nil {
		return config{}, fatal("bad_port", envPort+" is missing or not a port from 1 to 65535", err)
	}
	token, _ := lookup(envToken)
	if !validToken(token) {
		return config{}, fatal("bad_token", envToken+" is missing or not a token of 32 to 512 printable ASCII characters", nil)
	}
	storeValue, _ := lookup(envStore)
	if storeValue == "" || !filepath.IsAbs(storeValue) {
		return config{}, fatal("bad_store", envStore+" is missing or not an absolute path", nil)
	}
	return config{store: filepath.Clean(storeValue), port: port, token: token}, nil
}

// parseBridgePort reads the value of WHATSAPP_BRIDGE_PORT: anything but a port from 1 to 65535 is an error, an empty
// value as well.
func parseBridgePort(value string) (int, error) {
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > 65535 || strconv.Itoa(port) != value {
		return 0, strconv.ErrSyntax
	}
	return port, nil
}

// validToken accepts a token a header can carry unchanged: printable ASCII without spaces, of a length that makes it
// a secret.
func validToken(token string) bool {
	if len(token) < minTokenLength || len(token) > maxTokenLength {
		return false
	}
	for i := 0; i < len(token); i++ {
		if token[i] < 0x21 || token[i] > 0x7e {
			return false
		}
	}
	return true
}
