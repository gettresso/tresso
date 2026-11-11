package providersync

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"strconv"
	"strings"
	"testing"

	"tresso/sync/internal/api"
	"tresso/sync/internal/fakeapi"
	"tresso/sync/internal/providerhttp"
)

var discard = slog.New(slog.NewTextHandler(io.Discard, nil))

func TestApplyFlagsIngestsOnlyUnknownMessagesInChunks(t *testing.T) {
	f := fakeapi.New()
	in := &Ingest{API: f, AccountID: "acc", WorkerID: "w1", FetchBatch: 2, Logger: discard}
	ctx := context.Background()
	if err := in.Messages(ctx, "INBOX", []api.Message{{RemoteUID: "known", RawObjectKey: "raw/aa/known"}}, nil); err != nil {
		t.Fatal(err)
	}

	changes := make([]api.FlagChange, 0, api.MaxFlagChanges+3)
	changes = append(changes, api.FlagChange{RemoteUID: "known", Flags: api.Flags{Seen: true}})
	for i := range api.MaxFlagChanges + 2 {
		changes = append(changes, api.FlagChange{RemoteUID: "new-" + strconv.Itoa(i)})
	}
	var fetched []string
	fetch := func(_ context.Context, ids []string) ([]api.Message, error) {
		if len(ids) > 2 {
			t.Errorf("fetched %d at once", len(ids))
		}
		fetched = append(fetched, ids...)
		out := make([]api.Message, 0, len(ids))
		for _, id := range ids {
			out = append(out, api.Message{RemoteUID: id, RawObjectKey: "raw/aa/" + id})
		}
		return out, nil
	}
	if err := in.ApplyFlags(ctx, "INBOX", changes, fetch); err != nil {
		t.Fatal(err)
	}
	if len(fetched) != api.MaxFlagChanges+2 || len(f.UIDs("INBOX")) != api.MaxFlagChanges+3 {
		t.Errorf("fetched %d, folder holds %d", len(fetched), len(f.UIDs("INBOX")))
	}
	if flags, _ := f.Flags("INBOX", "known"); !flags.Seen {
		t.Error("known message flags not updated")
	}

	cursor := "c1"
	missing, err := in.Missing(ctx, "INBOX", map[string]bool{"known": true})
	if err != nil || len(missing) != api.MaxFlagChanges+2 {
		t.Fatalf("missing %d, %v", len(missing), err)
	}
	if err := in.Vanish(ctx, "INBOX", missing, &cursor); err != nil {
		t.Fatal(err)
	}
	if got := f.UIDs("INBOX"); len(got) != 1 || f.Cursor("INBOX") != "c1" {
		t.Errorf("after vanish %v, cursor %q", got, f.Cursor("INBOX"))
	}
}

func TestRunEndsOnLostAccess(t *testing.T) {
	cases := map[string]struct {
		err      error
		statuses string
	}{
		"reauthorize":  {fmt.Errorf("%w: 409", api.ErrReauthorize), ""},
		"unauthorized": {fmt.Errorf("%w: 401", providerhttp.ErrUnauthorized), "auth_failed: Google no longer accepts Tresso's access to this account. Sign in with Google again."},
		"denied":       {fmt.Errorf("%w: 403", ErrAccessDenied), "auth_failed: Tresso is not allowed to read this mailbox. Sign in with Google again and allow access to your mail."},
	}
	for name, c := range cases {
		f := fakeapi.New()
		calls := 0
		err := Run(context.Background(), f, api.Account{ID: "acc"}, "w1", "Google", RunOptions{FailuresBeforeError: 3}, discard, func(context.Context) (bool, error) {
			calls++
			return false, c.err
		})
		if err != nil || calls != 1 || f.StatusLog() != c.statuses {
			t.Errorf("%s: err %v, calls %d, statuses %q", name, err, calls, f.StatusLog())
		}
	}
}

func TestRunReportsAnErrorAfterRepeatedFailures(t *testing.T) {
	f := fakeapi.New()
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	_ = Run(ctx, f, api.Account{ID: "acc"}, "w1", "Microsoft", RunOptions{FailuresBeforeError: 2}, discard, func(context.Context) (bool, error) {
		calls++
		if calls == 3 {
			cancel()
		}
		return false, errors.New("internal detail")
	})
	if f.StatusLog() != "error: Syncing failed. Tresso keeps retrying." {
		t.Errorf("statuses = %q", f.StatusLog())
	}
}

func TestTooLongRemoteUIDIsAnError(t *testing.T) {
	f := fakeapi.New()
	in := &Ingest{API: f, AccountID: "acc", WorkerID: "w1", FetchBatch: 2, Logger: discard}
	long := strings.Repeat("x", MaxRemoteUIDLength+1)
	ctx := context.Background()
	if err := in.ApplyFlags(ctx, "INBOX", []api.FlagChange{{RemoteUID: long}}, nil); err == nil {
		t.Error("ApplyFlags accepted a remote uid longer than 255")
	}
	if err := in.Messages(ctx, "INBOX", []api.Message{{RemoteUID: long}}, nil); err == nil {
		t.Error("Messages accepted a remote uid longer than 255")
	}
	if err := in.Vanish(ctx, "INBOX", []string{long}, nil); err == nil {
		t.Error("Vanish accepted a remote uid longer than 255")
	}
	if err := in.Vanish(ctx, "INBOX", []string{strings.Repeat("x", MaxRemoteUIDLength)}, nil); err != nil {
		t.Errorf("255 bytes must be accepted: %v", err)
	}
}

func TestMessageCacheDropsTheOldest(t *testing.T) {
	c := NewMessageCache(2)
	for _, id := range []string{"a", "b", "c"} {
		c.Put(id, api.Message{RemoteUID: id})
	}
	if _, ok := c.Get("a"); ok || c.Len() != 2 {
		t.Errorf("len %d, oldest kept %v", c.Len(), ok)
	}
	if m, ok := c.Get("c"); !ok || m.RemoteUID != "c" {
		t.Error("newest missing")
	}
}

// Fails without the guard: Missing listed every uid the API had that the provider lacks, placeholders included.
func TestPendingMovePlaceholdersAreNeverMissing(t *testing.T) {
	f := fakeapi.New()
	in := &Ingest{API: f, AccountID: "acc", WorkerID: "w1", FetchBatch: 2, Logger: discard}
	ctx := context.Background()
	messages := []api.Message{{RemoteUID: "m1", RawObjectKey: "raw/aa/1"}, {RemoteUID: "m2", RawObjectKey: "raw/aa/2"}, {RemoteUID: "pending:c7", RawObjectKey: "raw/aa/3"}}
	if err := in.Messages(ctx, "INBOX", messages, nil); err != nil {
		t.Fatal(err)
	}

	missing, err := in.Missing(ctx, "INBOX", map[string]bool{"m1": true})
	if err != nil || !slices.Equal(missing, []string{"m2"}) {
		t.Errorf("Missing = %v, %v; want only m2", missing, err)
	}
}

// Fails without the fix: the error status was sent only at exactly the third failure, and a lost report was never
// repeated.
func TestALostErrorReportIsSentAgainAfterTheNextFailure(t *testing.T) {
	f := fakeapi.New()
	f.StatusFailures = 1
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	_ = Run(ctx, f, api.Account{ID: "acc"}, "w1", "Microsoft", RunOptions{FailuresBeforeError: 2}, discard, func(context.Context) (bool, error) {
		calls++
		if calls == 5 {
			cancel()
		}
		return false, errors.New("internal detail")
	})
	if f.StatusLog() != "error: Syncing failed. Tresso keeps retrying." {
		t.Errorf("statuses = %q; want the error once, after the lost report", f.StatusLog())
	}
}
