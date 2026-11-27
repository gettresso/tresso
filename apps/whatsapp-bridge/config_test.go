package main

import (
	"errors"
	"strings"
	"testing"
)

const testToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func env(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

func TestParseBridgePort(t *testing.T) {
	valid := map[string]int{"1": 1, "8741": 8741, "9000": 9000, "65535": 65535}
	for value, want := range valid {
		got, err := parseBridgePort(value)
		if err != nil || got != want {
			t.Errorf("parseBridgePort(%q) = %d, %v; want %d", value, got, err, want)
		}
	}
	// There is no default port any more: an empty value is an error as well.
	for _, value := range []string{"", "0", "65536", "-1", "abc", "80a", " 8741", "8741 ", "1e3", "+8741", "08741", "99999999999999999999"} {
		if got, err := parseBridgePort(value); err == nil {
			t.Errorf("parseBridgePort(%q) = %d, want an error", value, got)
		}
	}
}

func TestReadConfig(t *testing.T) {
	good := map[string]string{envStore: "/Users/someone/Library/Application Support/app/whatsapp", envPort: "8741", envToken: testToken}
	cfg, err := readConfig(env(good))
	if err != nil {
		t.Fatalf("valid environment refused: %v", err)
	}
	if cfg.store != good[envStore] || cfg.port != 8741 || cfg.token != testToken {
		t.Fatalf("got %+v", cfg)
	}

	// The store path is used cleaned.
	cleaned := map[string]string{envStore: "/tmp/a/../b/./store/", envPort: "8741", envToken: testToken}
	if cfg, err := readConfig(env(cleaned)); err != nil || cfg.store != "/tmp/b/store" {
		t.Errorf("cleaned store: got %q, %v", cfg.store, err)
	}

	with := func(key, value string, remove bool) map[string]string {
		values := map[string]string{}
		for k, v := range good {
			values[k] = v
		}
		if remove {
			delete(values, key)
		} else {
			values[key] = value
		}
		return values
	}
	cases := []struct {
		name   string
		values map[string]string
		code   string
	}{
		{"store missing", with(envStore, "", true), "bad_store"},
		{"store empty", with(envStore, "", false), "bad_store"},
		{"store relative", with(envStore, "store", false), "bad_store"},
		{"store relative with dot", with(envStore, "./store", false), "bad_store"},
		{"store relative with parent", with(envStore, "../store", false), "bad_store"},
		{"token missing", with(envToken, "", true), "bad_token"},
		{"token empty", with(envToken, "", false), "bad_token"},
		{"token too short", with(envToken, testToken[:31], false), "bad_token"},
		{"token with a space", with(envToken, testToken[:40]+" "+testToken[:10], false), "bad_token"},
		{"token with a line break", with(envToken, testToken+"\n", false), "bad_token"},
		{"token too long", with(envToken, strings.Repeat("a", maxTokenLength+1), false), "bad_token"},
		{"port missing", with(envPort, "", true), "bad_port"},
		{"port empty", with(envPort, "", false), "bad_port"},
		{"port zero", with(envPort, "0", false), "bad_port"},
		{"port too large", with(envPort, "70000", false), "bad_port"},
	}
	for _, tc := range cases {
		_, err := readConfig(env(tc.values))
		var fe *fatalError
		if !errors.As(err, &fe) || fe.code != tc.code {
			t.Errorf("%s: got %v, want fatal %s", tc.name, err, tc.code)
			continue
		}
		// The reason is a fixed text: it never repeats the value it refused.
		for _, value := range tc.values {
			if value != "" && strings.Contains(fe.reason, value) {
				t.Errorf("%s: reason %q holds a value from the environment", tc.name, fe.reason)
			}
		}
	}
}
