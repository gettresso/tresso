package main

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Errorf("%s: mode %o, want %o", filepath.Base(path), got, want)
	}
}

func TestPrepareStore(t *testing.T) {
	// A new store, with a parent that does not exist yet either.
	dir := filepath.Join(t.TempDir(), "app", "store")
	if err := prepareStore(dir); err != nil {
		t.Fatal(err)
	}
	assertMode(t, dir, 0o700)
	assertMode(t, filepath.Dir(dir), 0o700)
	assertMode(t, filepath.Join(dir, "whatsapp.db"), 0o600)
	assertMode(t, filepath.Join(dir, "messages.db"), 0o600)

	// An existing store that others could read is made private.
	chat := filepath.Join(dir, "31612345678@s.whatsapp.net")
	if err := os.Mkdir(chat, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"whatsapp.db", "messages.db", "messages.db-wal"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(filepath.Join(dir, name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(chat, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := prepareStore(dir); err != nil {
		t.Fatal(err)
	}
	assertMode(t, dir, 0o700)
	assertMode(t, chat, 0o700)
	assertMode(t, filepath.Join(dir, "whatsapp.db"), 0o600)
	assertMode(t, filepath.Join(dir, "messages.db"), 0o600)
	assertMode(t, filepath.Join(dir, "messages.db-wal"), 0o600)
	if data, _ := os.ReadFile(filepath.Join(dir, "messages.db")); string(data) != "x" {
		t.Error("prepareStore changed an existing database")
	}
}

func TestPrepareStoreRefuses(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T) string
		want  error
	}{
		{"group writable", func(t *testing.T) string { return folderWithMode(t, 0o770) }, errStoreWritable},
		{"world writable", func(t *testing.T) string { return folderWithMode(t, 0o702) }, errStoreWritable},
		{"writable by all", func(t *testing.T) string { return folderWithMode(t, 0o777) }, errStoreWritable},
		{"a file", func(t *testing.T) string {
			path := filepath.Join(t.TempDir(), "store")
			if err := os.WriteFile(path, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			return path
		}, errStoreNotFolder},
		{"a link to a folder", func(t *testing.T) string {
			base := t.TempDir()
			real := filepath.Join(base, "real")
			if err := os.Mkdir(real, 0o700); err != nil {
				t.Fatal(err)
			}
			link := filepath.Join(base, "store")
			if err := os.Symlink(real, link); err != nil {
				t.Fatal(err)
			}
			return link
		}, errStoreLink},
		{"a database that is a link", func(t *testing.T) string {
			dir := folderWithMode(t, 0o700)
			target := filepath.Join(t.TempDir(), "elsewhere.db")
			if err := os.WriteFile(target, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, filepath.Join(dir, "messages.db")); err != nil {
				t.Fatal(err)
			}
			return dir
		}, errStoreLink},
		{"a database that is a folder", func(t *testing.T) string {
			dir := folderWithMode(t, 0o700)
			if err := os.Mkdir(filepath.Join(dir, "whatsapp.db"), 0o700); err != nil {
				t.Fatal(err)
			}
			return dir
		}, errDatabaseNotAFile},
		{"a relative path", func(t *testing.T) string { return "store" }, errStoreNotUsable},
		{"under a file", func(t *testing.T) string {
			file := filepath.Join(t.TempDir(), "file")
			if err := os.WriteFile(file, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			return filepath.Join(file, "store")
		}, errStoreNotUsable},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := tc.setup(t)
			err := prepareStore(path)
			if !errors.Is(err, tc.want) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
			if reason := storeReason(err); reason != tc.want.Error() {
				t.Errorf("reason %q, want %q", reason, tc.want.Error())
			}
		})
	}
}

// folderWithMode makes a folder with exactly mode (chmod after mkdir, so the umask does not change it).
func folderWithMode(t *testing.T, mode os.FileMode) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "store")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, mode); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	return dir
}

// testStore is a prepared store folder with a message store, under a path with a space and characters a file: URI
// must escape, as "Application Support" has.
func testStore(t *testing.T) *MessageStore {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "Application Support", "odd ?#% name", "whatsapp")
	if err := prepareStore(dir); err != nil {
		t.Fatal(err)
	}
	messages, err := NewMessageStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { messages.Close() })
	return messages
}

func TestMessageStoreOpensTheFileInTheStore(t *testing.T) {
	store := testStore(t)
	// The driver wrote into the file prepareStore made, not into one with a garbled name somewhere else.
	info, err := os.Stat(filepath.Join(store.dir, "messages.db"))
	if err != nil || info.Size() == 0 {
		t.Fatalf("messages.db in the store: %v, %v", info, err)
	}
	entries, err := os.ReadDir(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	for _, name := range names {
		if !strings.HasPrefix(name, "messages.db") && !strings.HasPrefix(name, "whatsapp.db") {
			t.Errorf("unexpected file in the store: %q", name)
		}
	}
	assertMode(t, filepath.Join(store.dir, "messages.db"), 0o600)
}

func TestSQLiteSettings(t *testing.T) {
	store := testStore(t)
	// Every connection of the pool gets them, not only the first one.
	store.db.SetMaxOpenConns(3)
	var held []interface{ Close() error }
	for i := 0; i < 3; i++ {
		conn, err := store.db.Conn(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		held = append(held, conn)
		var foreignKeys, busyTimeout int
		if err := conn.QueryRowContext(t.Context(), "PRAGMA foreign_keys").Scan(&foreignKeys); err != nil {
			t.Fatal(err)
		}
		if err := conn.QueryRowContext(t.Context(), "PRAGMA busy_timeout").Scan(&busyTimeout); err != nil {
			t.Fatal(err)
		}
		if foreignKeys != 1 || busyTimeout != 5000 {
			t.Errorf("connection %d: foreign_keys %d, busy_timeout %d; want 1 and 5000", i, foreignKeys, busyTimeout)
		}
	}

	for _, conn := range held {
		conn.Close()
	}

	// Foreign keys hold: a message needs its chat.
	err := store.StoreMessage("3EB0AAAA", "31600000000@s.whatsapp.net", "31600000000", "hi", time.Now(), false, "", "", "", nil, nil, nil, 0)
	if err == nil {
		t.Error("a message without its chat was stored")
	}
}

// The desktop app reads these tables and columns (apps/desktop/src-tauri/src/whatsapp.rs: read_rows, names,
// media_of); the schema must stay as it was.
func TestMessageSchema(t *testing.T) {
	store := testStore(t)
	want := map[string]string{
		"chats":    "jid TEXT pk1, name TEXT, last_message_time TIMESTAMP",
		"messages": "id TEXT pk1, chat_jid TEXT pk2, sender TEXT, content TEXT, timestamp TIMESTAMP, is_from_me BOOLEAN, media_type TEXT, filename TEXT, url TEXT, media_key BLOB, file_sha256 BLOB, file_enc_sha256 BLOB, file_length INTEGER",
	}
	for table, columns := range want {
		rows, err := store.db.Query("SELECT name, type, pk FROM pragma_table_info(?) ORDER BY cid", table)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for rows.Next() {
			var name, kind string
			var pk int
			if err := rows.Scan(&name, &kind, &pk); err != nil {
				t.Fatal(err)
			}
			column := name + " " + kind
			if pk > 0 {
				column += " pk" + string(rune('0'+pk))
			}
			got = append(got, column)
		}
		rows.Close()
		if strings.Join(got, ", ") != columns {
			t.Errorf("%s: got %q, want %q", table, strings.Join(got, ", "), columns)
		}
	}
	var foreignKey string
	if err := store.db.QueryRow("SELECT \"from\" || '->' || \"table\" || '.' || \"to\" FROM pragma_foreign_key_list('messages')").Scan(&foreignKey); err != nil || foreignKey != "chat_jid->chats.jid" {
		t.Errorf("foreign key %q, %v", foreignKey, err)
	}
}

// desktopTimestamp is the text form the desktop app parses (parse_timestamp): what mattn/go-sqlite3 wrote.
var desktopTimestamp = regexp.MustCompile(`^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(\.\d{1,9})?([+-]\d\d:\d\d|Z)$`)

func TestStoredValuesAsTheDesktopReadsThem(t *testing.T) {
	store := testStore(t)
	zone := time.FixedZone("CET", 3600)
	when := time.Date(2026, 11, 27, 13, 10, 5, 123456789, zone)
	chat := "31612345678@s.whatsapp.net"
	if err := store.StoreChat(chat, "Zoë", when); err != nil {
		t.Fatal(err)
	}
	sum := make([]byte, 32)
	if err := store.StoreMessage("3EB0AAAA", chat, "31612345678", "", when, true, "document", "report.pdf", "https://mmg.whatsapp.net/x", []byte{1}, sum, sum, 42); err != nil {
		t.Fatal(err)
	}
	if err := store.StoreMessage("3EB0BBBB", chat, "31612345678", "hello", when, false, "", "", "", nil, nil, nil, 0); err != nil {
		t.Fatal(err)
	}

	// "|| ''" reads the text as stored: the driver turns a TIMESTAMP column into a time.Time on its own.
	var kind, text string
	if err := store.db.QueryRow("SELECT typeof(timestamp), timestamp || '' FROM messages WHERE id = '3EB0AAAA'").Scan(&kind, &text); err != nil {
		t.Fatal(err)
	}
	if kind != "text" || text != "2026-11-27 13:10:05.123456789+01:00" || !desktopTimestamp.MatchString(text) {
		t.Errorf("timestamp stored as %s %q", kind, text)
	}
	if err := store.db.QueryRow("SELECT typeof(last_message_time), last_message_time || '' FROM chats").Scan(&kind, &text); err != nil {
		t.Fatal(err)
	}
	if kind != "text" || !desktopTimestamp.MatchString(text) {
		t.Errorf("last_message_time stored as %s %q", kind, text)
	}

	var fromMe, length int64
	var fromMeKind, shaKind, lengthKind string
	if err := store.db.QueryRow("SELECT typeof(is_from_me), is_from_me, typeof(file_sha256), typeof(file_length), file_length FROM messages WHERE id = '3EB0AAAA'").Scan(&fromMeKind, &fromMe, &shaKind, &lengthKind, &length); err != nil {
		t.Fatal(err)
	}
	if fromMeKind != "integer" || fromMe != 1 || shaKind != "blob" || lengthKind != "integer" || length != 42 {
		t.Errorf("is_from_me %s %d, file_sha256 %s, file_length %s %d", fromMeKind, fromMe, shaKind, lengthKind, length)
	}
	if err := store.db.QueryRow("SELECT typeof(is_from_me), is_from_me, typeof(media_key) FROM messages WHERE id = '3EB0BBBB'").Scan(&fromMeKind, &fromMe, &shaKind); err != nil {
		t.Fatal(err)
	}
	if fromMeKind != "integer" || fromMe != 0 || shaKind != "null" {
		t.Errorf("text message: is_from_me %s %d, media_key %s", fromMeKind, fromMe, shaKind)
	}

	mediaType, filename, url, mediaKey, fileSHA256, _, fileLength, err := store.GetMediaInfo("3EB0AAAA", chat)
	if err != nil || mediaType != "document" || filename != "report.pdf" || url == "" || len(mediaKey) != 1 || len(fileSHA256) != 32 || fileLength != 42 {
		t.Errorf("GetMediaInfo: %q %q %q %v %v %d %v", mediaType, filename, url, mediaKey, fileSHA256, fileLength, err)
	}
}
