package main

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"syscall"
	"time"

	_ "modernc.org/sqlite"
)

// The files in the store folder. The layout is the one whatsapp-mcp's bridge has always used inside its `store`
// folder: the desktop app reads it so.
const (
	sessionDatabase  = "whatsapp.db"
	messagesDatabase = "messages.db"
)

// storeDatabases are the SQLite files in the store, with the journal files SQLite keeps next to them.
var storeDatabases = []string{
	"whatsapp.db", "whatsapp.db-journal", "whatsapp.db-wal", "whatsapp.db-shm",
	"messages.db", "messages.db-journal", "messages.db-wal", "messages.db-shm",
}

// sqliteDriver is the pure Go SQLite driver (modernc.org/sqlite). whatsmeow's sqlstore takes any dialect name that
// starts with "sqlite".
const sqliteDriver = "sqlite"

// sqliteBusyTimeout is how long a statement waits for a lock another connection holds, as mattn/go-sqlite3 waited by
// default (5 seconds) before the bridge changed drivers.
const sqliteBusyTimeout = 5 * time.Second

var (
	errStoreNotFolder   = errors.New("the store is not a folder")
	errStoreLink        = errors.New("the store or a database in it is a symbolic link")
	errStoreOwner       = errors.New("the store folder belongs to another user")
	errStoreWritable    = errors.New("others may write the store folder")
	errStoreNotUsable   = errors.New("the store folder cannot be made or used")
	errDatabaseNotAFile = errors.New("a database in the store is not a file")
)

// prepareStore makes the store folder ready, or refuses it. A folder that is missing is created 0700 (its missing
// parents as well). An existing one must be a real folder (not a link) of this user that nobody else may write; one
// that others may only read is made 0700. The databases are created empty 0600 when missing (so SQLite does not create
// them readable by others), and every database and journal file is made 0600; the chat folders directly in the store
// 0700. Downloaded files deeper down are not walked: the 0700 folders above them already keep other users out.
func prepareStore(dir string) error {
	if !filepath.IsAbs(dir) {
		return errStoreNotUsable
	}
	info, err := os.Lstat(dir)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return errors.Join(errStoreNotUsable, err)
		}
		info, err = os.Lstat(dir)
	}
	if err != nil {
		return errors.Join(errStoreNotUsable, err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errStoreLink
	}
	if !info.IsDir() {
		return errStoreNotFolder
	}
	if !ownedByMe(info) {
		return errStoreOwner
	}
	if info.Mode().Perm()&0o022 != 0 {
		return errStoreWritable
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return errors.Join(errStoreNotUsable, err)
	}
	for _, name := range storeDatabases {
		path := filepath.Join(dir, name)
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			if name != sessionDatabase && name != messagesDatabase {
				continue
			}
			file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
			if err != nil {
				return errors.Join(errStoreNotUsable, err)
			}
			if err := file.Close(); err != nil {
				return errors.Join(errStoreNotUsable, err)
			}
			info, err = os.Lstat(path)
			if err != nil {
				return errors.Join(errStoreNotUsable, err)
			}
		} else if err != nil {
			return errors.Join(errStoreNotUsable, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errStoreLink
		}
		if !info.Mode().IsRegular() {
			return errDatabaseNotAFile
		}
		if err := os.Chmod(path, 0o600); err != nil {
			return errors.Join(errStoreNotUsable, err)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return errors.Join(errStoreNotUsable, err)
	}
	for _, entry := range entries {
		// A link is not a folder to ReadDir, so only real folders are changed.
		if entry.IsDir() {
			if err := os.Chmod(filepath.Join(dir, entry.Name()), 0o700); err != nil {
				return errors.Join(errStoreNotUsable, err)
			}
		}
	}
	return nil
}

// ownedByMe reports whether the file belongs to the user the bridge runs as.
func ownedByMe(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(stat.Uid) == os.Geteuid()
}

// sqliteDSN is the address of a database file for the driver: a file: URI with the path escaped (the store usually
// sits under "Application Support"), foreign keys on and the busy timeout of every connection, and times written as
// mattn/go-sqlite3 wrote them ("2006-01-02 15:04:05.999999999-07:00"), which the desktop app parses.
func sqliteDSN(path string) string {
	query := url.Values{}
	query.Set("_foreign_keys", "1")
	query.Set("_busy_timeout", fmt.Sprint(sqliteBusyTimeout.Milliseconds()))
	query.Set("_time_format", "sqlite")
	return (&url.URL{Scheme: "file", Path: path, RawQuery: query.Encode()}).String()
}

// openSQLite opens a database file in the store and checks that it answers.
func openSQLite(path string) (*sql.DB, error) {
	db, err := sql.Open(sqliteDriver, sqliteDSN(path))
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// MessageStore is the message database (messages.db) and the folder downloads go to.
type MessageStore struct {
	db  *sql.DB
	dir string
}

// NewMessageStore opens messages.db in the store folder dir (prepared by prepareStore) and creates its tables when
// they are missing. The schema is the one the desktop app reads.
func NewMessageStore(dir string) (*MessageStore, error) {
	db, err := openSQLite(filepath.Join(dir, messagesDatabase))
	if err != nil {
		return nil, fmt.Errorf("failed to open message database: %w", err)
	}

	// Create tables if they don't exist
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS chats (
			jid TEXT PRIMARY KEY,
			name TEXT,
			last_message_time TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS messages (
			id TEXT,
			chat_jid TEXT,
			sender TEXT,
			content TEXT,
			timestamp TIMESTAMP,
			is_from_me BOOLEAN,
			media_type TEXT,
			filename TEXT,
			url TEXT,
			media_key BLOB,
			file_sha256 BLOB,
			file_enc_sha256 BLOB,
			file_length INTEGER,
			PRIMARY KEY (id, chat_jid),
			FOREIGN KEY (chat_jid) REFERENCES chats(jid)
		);
	`)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("failed to create tables: %w", err)
	}

	return &MessageStore{db: db, dir: dir}, nil
}

// Close the database connection
func (store *MessageStore) Close() error {
	return store.db.Close()
}

// Store a chat in the database
func (store *MessageStore) StoreChat(jid, name string, lastMessageTime time.Time) error {
	_, err := store.db.Exec(
		"INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)",
		jid, name, lastMessageTime,
	)
	return err
}

// Store a message in the database
func (store *MessageStore) StoreMessage(id, chatJID, sender, content string, timestamp time.Time, isFromMe bool,
	mediaType, filename, url string, mediaKey, fileSHA256, fileEncSHA256 []byte, fileLength uint64) error {
	// Only store if there's actual content or media
	if content == "" && mediaType == "" {
		return nil
	}

	_, err := store.db.Exec(
		`INSERT OR REPLACE INTO messages
		(id, chat_jid, sender, content, timestamp, is_from_me, media_type, filename, url, media_key, file_sha256, file_enc_sha256, file_length)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, chatJID, sender, content, timestamp, isFromMe, mediaType, filename, url, mediaKey, fileSHA256, fileEncSHA256, fileLength,
	)
	return err
}

// Get media info from the database
func (store *MessageStore) GetMediaInfo(id, chatJID string) (string, string, string, []byte, []byte, []byte, uint64, error) {
	var mediaType, filename, url string
	var mediaKey, fileSHA256, fileEncSHA256 []byte
	var fileLength uint64

	err := store.db.QueryRow(
		"SELECT media_type, filename, url, media_key, file_sha256, file_enc_sha256, file_length FROM messages WHERE id = ? AND chat_jid = ?",
		id, chatJID,
	).Scan(&mediaType, &filename, &url, &mediaKey, &fileSHA256, &fileEncSHA256, &fileLength)

	return mediaType, filename, url, mediaKey, fileSHA256, fileEncSHA256, fileLength, err
}
