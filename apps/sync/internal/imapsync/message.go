package imapsync

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"

	"tresso/sync/internal/api"
	"tresso/sync/internal/ingestmsg"
	"tresso/sync/internal/storage"
)

// buildMessage stores the raw message and its attachments, then describes it for the ingest API.
func buildMessage(ctx context.Context, store storage.Blobs, accountID string, buf *imapclient.FetchMessageBuffer, condStore bool, logger *slog.Logger) (api.Message, error) {
	raw := buf.FindBodySection(&imap.FetchItemBodySection{Peek: true})
	if raw == nil {
		return api.Message{}, fmt.Errorf("uid %d: server returned no body", buf.UID)
	}

	msg, err := ingestmsg.Build(ctx, store, accountID, raw, strconv.FormatUint(uint64(buf.UID), 10), buf.InternalDate, flagsOf(buf.Flags), logger)
	if err != nil {
		return api.Message{}, err
	}
	msg.Junk = isJunk(buf.Flags)
	if condStore && buf.ModSeq > 0 {
		modSeq := buf.ModSeq
		msg.ModSeq = &modSeq
	}
	return msg, nil
}

func flagsOf(flags []imap.Flag) api.Flags {
	var f api.Flags
	for _, flag := range flags {
		switch strings.ToLower(string(flag)) {
		case strings.ToLower(string(imap.FlagSeen)):
			f.Seen = true
		case strings.ToLower(string(imap.FlagFlagged)):
			f.Flagged = true
		case strings.ToLower(string(imap.FlagAnswered)):
			f.Answered = true
		case strings.ToLower(string(imap.FlagDraft)):
			f.Draft = true
		}
	}
	return f
}

// isJunk reads the junk keywords of RFC 5788 (and their older names without the dollar sign). An explicit "not junk"
// wins: the user or a filter took the message out of junk.
func isJunk(flags []imap.Flag) bool {
	junk := false
	for _, flag := range flags {
		switch strings.ToLower(string(flag)) {
		case "$junk", "junk":
			junk = true
		case "$notjunk", "notjunk", "nonjunk":
			return false
		}
	}
	return junk
}
