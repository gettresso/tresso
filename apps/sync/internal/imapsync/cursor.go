package imapsync

import (
	"encoding/json"
	"fmt"

	"tresso/sync/internal/isolate"
)

// Cursor is a folder's sync position, stored by the API as an opaque string.
//
// New mail is fetched from UIDNext upwards; history is backfilled newest first, downwards from BackfillBelow until
// it reaches 1; flag changes are fetched since HighestModSeq (CONDSTORE).
type Cursor struct {
	Version       int    `json:"v"`
	UIDValidity   uint32 `json:"uidValidity"`
	UIDNext       uint32 `json:"uidNext"`
	BackfillBelow uint32 `json:"backfillBelow"`
	HighestModSeq uint64 `json:"highestModSeq"`
	// Pending are the folder's placeholders whose message is tried again (see package isolate).
	Pending isolate.PendingList `json:"pending,omitempty"`
}

const cursorVersion = 1

func (c Cursor) Encode() string {
	c.Version = cursorVersion
	data, _ := json.Marshal(c)
	return string(data)
}

func (c Cursor) BackfillDone() bool {
	return c.BackfillBelow <= 1
}

// DecodeCursor returns nil for an empty cursor or one from an older format, which restarts the folder.
func DecodeCursor(raw *string) (*Cursor, error) {
	if raw == nil || *raw == "" {
		return nil, nil
	}
	var c Cursor
	if err := json.Unmarshal([]byte(*raw), &c); err != nil {
		return nil, fmt.Errorf("decode cursor: %w", err)
	}
	if c.Version != cursorVersion {
		return nil, nil
	}
	return &c, nil
}
