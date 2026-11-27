# WhatsApp bridge

Tresso's own WhatsApp bridge: a small Go program that links to WhatsApp as a device of the user's phone (through
[whatsmeow](https://github.com/tulir/whatsmeow)), keeps chats and messages in SQLite, and serves a REST API on
127.0.0.1 to send messages and download media. The desktop app starts it, reads its store and calls its API.

It comes from the `whatsapp-bridge` folder of Tresso's fork [gettresso/whatsapp-mcp](https://github.com/gettresso/whatsapp-mcp)
at commit `7f0abf77daf3b7c61d3e878ee0d1b14dbf21131b`, itself a fork of
[lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp). That code is MIT licensed, copyright (c) 2025 Luke
Harries; its license is kept in [NOTICE](NOTICE) and covers the code that came from it. Tresso as a whole is
AGPL-3.0-only.

The binary links whatsmeow and go.mau.fi/util (MPL-2.0), go.mau.fi/libsignal (GPL-3.0), and modules under BSD-3-Clause,
MIT, ISC and Apache-2.0 (Go's own x/ modules, protobuf, the modernc.org SQLite modules, zerolog and others; see
`go.mod`). All of them may be combined into an AGPL-3.0 program; a bundle that ships the binary ships their notices.

macOS and Linux only (it checks file owners and modes the Unix way).

## Running it

The bridge takes no arguments and does not depend on its working directory. It reads three environment variables and
refuses to start without any of them:

| Variable | Value |
|---|---|
| `WHATSAPP_BRIDGE_STORE` | Absolute path of the store folder. Created 0700 (with its missing parents, also 0700) when it does not exist. An existing one must be a folder (not a symbolic link) of the user the bridge runs as that nobody else may read or write (0700 or stricter); the bridge refuses anything else instead of changing its rights, and never changes the rights of a folder it did not create. The root folder and the home folder (`$HOME`, also through a link) are always refused. |
| `WHATSAPP_BRIDGE_PORT` | Port of the REST API, 1 to 65535. There is no default. |
| `WHATSAPP_BRIDGE_TOKEN` | The token every request must carry: 32 to 512 printable ASCII characters without spaces (Tresso gives 64 hex characters, new for every start). There is no mode without a token. The bridge removes it from its own environment once read and never writes it anywhere. |

The store holds the same files, under the same names, as the `store` folder of whatsapp-mcp's bridge:

- `whatsapp.db`: whatsmeow's session store (`whatsmeow_device`, `whatsmeow_contacts`, `whatsmeow_lid_map` and the rest).
- `messages.db`: the tables `chats` (`jid`, `name`, `last_message_time`) and `messages` (`id`, `chat_jid`, `sender`,
  `content`, `timestamp`, `is_from_me`, `media_type`, `filename`, `url`, `media_key`, `file_sha256`,
  `file_enc_sha256`, `file_length`), with `messages.chat_jid` a foreign key to `chats.jid`.
- `<chat jid>/<message id>_<name>`: downloaded media (`:` in the chat JID becomes `_`).

The databases and their journal files are made 0600. A chat folder is created 0700 by the first download into it;
folders already in the store are left as they are. Downloaded files are 0600.

The bridge stops cleanly (stops the API, disconnects from WhatsApp, closes both databases) when its **stdin ends**,
at SIGTERM and at SIGINT. The parent keeps stdin open as long as it wants the bridge to run; when the parent quits or
crashes, the pipe closes and the bridge goes with it. Started with stdin at `/dev/null`, it stops right away. A stdout
nobody reads any more does not stop it (SIGPIPE is ignored); the end of stdin does.

Exit status: 0 after a stop that was asked for, or after a log out; 1 after a `fatal` event or a `qr_timeout`. A
panic in the bridge's own code (its main goroutine, the stdin and signal watchers, the HTTP server loop) becomes the
`fatal` event `panic`; the panic value, which can hold message data, is never printed. A run sends at most one
`fatal` event.

For the program that starts the bridge: never log or store the bridge's stderr, because a crash inside whatsmeow's own
goroutines makes the Go runtime print a panic value there. And an existing store folder must be mode 0700 or stricter:
a folder made with default rights is refused with `bad_store`.

## Output

**stdout** carries only events: one JSON object per line, nothing else. `v` is the version of these shapes; it changes
only when a shape changes in a way an older reader would misread. No event ever holds the text of a message, a sender,
a chat, a chat name, a file name or the token.

```
{"v":1,"event":"qr","qr":"2@abc,def,ghi,jkl"}
{"v":1,"event":"qr_timeout"}
{"v":1,"event":"linked"}
{"v":1,"event":"connected"}
{"v":1,"event":"disconnected"}
{"v":1,"event":"listening","port":8741}
{"v":1,"event":"logged_out"}
{"v":1,"event":"fatal","code":"bad_store"}
```

| Event | Meaning |
|---|---|
| `qr` | Not linked yet: show `qr` as a QR code for the phone to scan (WhatsApp, Settings, Linked devices). A new code follows each time the last one expires. |
| `qr_timeout` | No code was scanned in time. The bridge stops (status 1); start it again for new codes. |
| `linked` | A phone scanned the code: this device is linked. The linked account's number and name are in `whatsapp.db` (`whatsmeow_device`). |
| `connected` | Connected to WhatsApp: after a start, after linking and after every reconnect. |
| `disconnected` | WhatsApp closed the connection; whatsmeow reconnects by itself. |
| `listening` | The REST API accepts requests on `127.0.0.1:<port>`. Sent once, after the connection held for 2 seconds. |
| `logged_out` | The phone removed this device. whatsmeow deletes the session from `whatsapp.db`; the bridge stops (status 0). |
| `fatal` | The bridge stops (status 1). `code` says why (below). |

The `fatal` codes:

```
{"v":1,"event":"fatal","code":"bad_port"}
{"v":1,"event":"fatal","code":"bad_token"}
{"v":1,"event":"fatal","code":"bad_store"}
{"v":1,"event":"fatal","code":"store_failed"}
{"v":1,"event":"fatal","code":"connect_failed"}
{"v":1,"event":"fatal","code":"not_connected"}
{"v":1,"event":"fatal","code":"pair_failed"}
{"v":1,"event":"fatal","code":"client_outdated"}
{"v":1,"event":"fatal","code":"stream_replaced"}
{"v":1,"event":"fatal","code":"temporary_ban"}
{"v":1,"event":"fatal","code":"listen_failed"}
{"v":1,"event":"fatal","code":"server_failed"}
{"v":1,"event":"fatal","code":"panic"}
```

| Code | Meaning |
|---|---|
| `bad_port`, `bad_token`, `bad_store` | The variable is missing or not valid; for the store, also a folder the bridge refuses (see above). |
| `store_failed` | A database in the store cannot be opened or read. |
| `connect_failed` | Connecting to WhatsApp failed. |
| `not_connected` | The connection did not hold for 2 seconds after it opened. |
| `pair_failed` | Linking failed (the phone or WhatsApp refused it). |
| `client_outdated` | WhatsApp refuses this version of whatsmeow: the bridge needs a newer one. |
| `stream_replaced` | Another program connected with the same session (two bridges on one store). |
| `temporary_ban` | WhatsApp banned the account for a while. |
| `listen_failed` | The port is taken or cannot be bound. |
| `server_failed` | The REST API stopped on its own. |
| `panic` | An internal error. |

**stderr** carries short diagnostics for a human: fixed texts of this program and whatsmeow's warnings and errors as
their format string only (`Failed to decrypt message from %s: %v`), never with the values. Nothing should parse it.

Nothing else reaches either stream. `os.Stdout`, which libraries print to, points at `/dev/null` (or at nothing, so
every write fails, when `/dev/null` cannot be opened); only the event writer holds the real stdout. libsignal's
logger, which would print to stdout, is replaced by a silent one, Go's standard logger is discarded, and net/http's
error log is dropped.

## REST API

On `127.0.0.1:<WHATSAPP_BRIDGE_PORT>` only. Every request goes through these checks, in this order:

1. The `Host` header is `127.0.0.1:<port>` or `localhost:<port>`, else `403`.
2. The header `X-Bridge-Token` equals the token (compared in constant time), else `401`.
3. `Content-Type` is `application/json` (parameters such as `charset` are fine), else `415`.

The probe `POST /api/send` with the body `{}` answers `401` without the token and `400 Recipient is required` with
it.

`POST /api/send` with `{"recipient": "<number or JID>", "message": "<text>", "media_path": "<absolute path>"}`
(`media_path` optional) sends a text, or a file with the text as its caption. Before anything is sent:

- A `media_path` that is not absolute gets `400 Media path must be absolute`, before every other check.
- `recipient` must be what the desktop app sends (its `valid_recipient`): a phone number of 1 to 32 digits, or a JID
  whose user is 1 to 128 of `[0-9A-Za-z.:_-]` and whose server is `s.whatsapp.net`, `g.us` or `lid`. Anything else
  (`status@broadcast`, a channel, a name) gets `400 Recipient is not valid`.
- `media_path` must name a regular file once links are followed (not a folder, FIFO or device) of at most 100 MB, the
  desktop app's `MAX_SEND_BYTES`; else `400` with `Media path is not a regular file`, `Media file is larger than 100
  MB` or `Media file cannot be read`. The file is opened without blocking and checked again before it is read.

It answers `{"success": true, "message": "..."}`, or `500` with `success` false and the reason in `message` (`Not
connected to WhatsApp` while not connected).

`POST /api/download` with `{"message_id": "<id>", "chat_jid": "<jid>"}` downloads the media of a stored message to
`<store>/<chat>/<message id>_<name>` and answers `{"success": true, "message": "...", "filename": "<name>", "path":
"<absolute path>"}`. The name is the last part of the stored file name (`filepath.Base`); `.`, `..` and `/` are
refused, as is a chat JID with `/`, `\` or a server other than a person, group or channel, and a message ID other than
letters, digits, `-` and `_`. A file downloaded before is handed back again only while its SHA-256 is the one the
message names. When WhatsApp no longer serves the file, the bridge asks the phone to upload it again (up to 60
seconds).

A request body is at most 1 MiB (`413` beyond), and headers at most 16 KiB. A client has 10 seconds to send its
headers and 30 for the whole request (ample for 1 MiB of JSON on 127.0.0.1: files go by path, never in the body), and
an idle connection is closed after 60 seconds. There is no write timeout, since a download may wait up to 60 seconds
for the phone.

## The linked device's name

The phone lists the device as **Tresso** under Linked devices: the bridge sets whatsmeow's `store.DeviceProps.Os`,
which whatsmeow sends when a device links. A device linked before keeps the name it got then.

## SQLite driver

The bridge uses [modernc.org/sqlite](https://gitlab.com/cznic/sqlite), a pure Go SQLite, instead of the fork's
mattn/go-sqlite3 (cgo). whatsmeow's `sqlstore` works with any `database/sql` SQLite driver (it takes every dialect name
that starts with `sqlite` and only checks that `PRAGMA foreign_keys` is on), so nothing in whatsmeow depends on cgo.
Without cgo, both macOS architectures build with `CGO_ENABLED=0` from one machine and need no C toolchain; `lipo`
joins them into one universal binary.

What stays as it was with mattn/go-sqlite3:

- The schema and every SQL statement, and the SQLite file format.
- Foreign keys on for every connection (`_foreign_keys=1`), which whatsmeow requires.
- A busy timeout of 5 seconds on every connection (`_busy_timeout=5000`), mattn's default.
- Times written as text in mattn's format, `2006-01-02 15:04:05.999999999-07:00` (`_time_format=sqlite`), which the
  desktop app parses. Booleans are stored as integers 0 and 1, hashes and keys as blobs.

## Changes from the fork

- The store comes from `WHATSAPP_BRIDGE_STORE` instead of `store` in the working directory.
- A token and a port are required; the bridge never runs without a token, and refuses a short one.
- stdout carries JSON events instead of log lines; the QR code is no longer drawn in the terminal (qrterminal is gone);
  the REST API says it listens only after it bound the port.
- whatsmeow's log goes to stderr as format strings only.
- The bridge stops when stdin ends, and stops after a log out instead of running on without a session.
- The device is named Tresso.
- Pure Go SQLite (above).
- Unused code of the fork is gone (`requestHistorySync` and the message store's read methods nothing called).
- A voice message's placeholder waveform is again the same for the same duration (`rand.Seed` does nothing since Go
  1.24).
- A voice message's duration is read correctly: the fork read the pre-skip at the wrong offset of the Opus head and
  divided by the input sample rate, while an Opus granule always counts at 48 kHz. The Ogg reader no longer reads
  past the end of a cut or malformed file.
- Sending checks the recipient and the media path (above), and the REST server has read and idle timeouts.
- An existing store folder is refused, not repaired, when others may read or write it.

## Development

```sh
go vet ./...
go test ./...
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -o whatsapp-bridge-arm64 .
CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -trimpath -o whatsapp-bridge-amd64 .
lipo -create -output whatsapp-bridge whatsapp-bridge-arm64 whatsapp-bridge-amd64
```

The tests never connect to WhatsApp.
