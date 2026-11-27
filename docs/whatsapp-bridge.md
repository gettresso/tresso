# The WhatsApp bridge in Tresso for Mac

Tresso for Mac reads and answers WhatsApp chats through its own bridge: a small Go program in
[apps/whatsapp-bridge](../apps/whatsapp-bridge) that links to WhatsApp as a device of the user's phone, keeps chats and
messages in SQLite and serves a REST API on 127.0.0.1. Its contract (the environment it needs, the JSON events on
stdout, its store, stdin, exit status and the REST API) is
[apps/whatsapp-bridge/README.md](../apps/whatsapp-bridge/README.md). This page says how the desktop app ships, starts
and stops it (`apps/desktop/src-tauri/src/whatsapp.rs`). WhatsApp stays off on a Mac until it is switched on there
(`defaults write app.tresso.desktop EnableWhatsApp -bool YES`).

## Shipped with the app

The bridge is a Tauri sidecar of the macOS build only (`bundle > externalBin` in `tauri.macos.conf.json`; Windows and
Linux read no such config and carry nothing). It is one universal binary (arm64 and x86_64), pure Go built with
`CGO_ENABLED=0` and joined with `lipo` by `apps/desktop/scripts/build-whatsapp-bridge.mjs`, which `tauri dev` and
`tauri build` run first (`beforeDevCommand`, `beforeBuildCommand`). Tauri's build script wants the sidecar at compile
time, so on a Mac run that script once before `cargo check`, `clippy` or `test` (it needs Go, see `go.mod`); it writes
`src-tauri/binaries/whatsapp-bridge-<target>` for `aarch64-apple-darwin`, `x86_64-apple-darwin` and
`universal-apple-darwin`, and skips a build when nothing changed.

In the bundle it is `Tresso.app/Contents/MacOS/whatsapp-bridge`. The release signs it with the app, inside out, with
the same identity and the hardened runtime (Tauri's bundler signs every sidecar before the app), and checks afterwards
that it is there for both architectures and signed with the hardened runtime. The bridge needs no entitlement of its
own (no JIT, no library loading, no sandbox exception), and the app is not sandboxed, so it may start it.

It carries the app's entitlements all the same, `com.apple.security.cs.disable-library-validation` included, which a
static Go binary does not need: Tauri 2 has one `bundle > macOS > entitlements` file for the bundle, and its bundler
(`tauri-bundler`, `bundle/macos/sign.rs`) passes that file for every target it signs, sidecars included; there is no
option to sign a sidecar with other entitlements or to leave it to the release. Giving the bridge none would mean
signing it again after `tauri bundle` and then signing the app again over it, outside Tauri's flow. The release does not
do that today; the entitlement only relaxes which libraries the process may load, and the bridge loads none. Notarization follows the app's: today the release is signed ad hoc and not notarized, so both go through
Apple's notary service together once the app is.

Its third-party notices ship next to it: `Tresso.app/Contents/Resources/licenses/whatsapp-bridge-third-party-notices.txt`
(from `apps/whatsapp-bridge/THIRD-PARTY-NOTICES.txt`), with every module the binary links and its license texts:
go.mau.fi/libsignal under GPL-3.0, whatsmeow and go.mau.fi/util under MPL-2.0, the rest under BSD, MIT, ISC and
Apache-2.0, and the Go runtime and standard library (BSD-3-Clause, named by the Go release that built it). The source of the bridge and of every module is this repository at the release's tag, with `go.mod` and
`go.sum` pinning each version. `apps/desktop/scripts/whatsapp-bridge-notices.mjs --write <binary>` writes the file again
from `go version -m` and the Go module cache; the build script fails when it no longer lists the binary's modules. The
About panel says where the file is.

## Started and stopped by Tresso

- **Which binary.** Only the one next to Tresso's own executable, found from the running executable: never from PATH,
  an environment variable or anything the web view names. A dev build finds the copy Tauri's build script puts next to
  its executable in `src-tauri/target/<profile>/`; a release cannot be pointed elsewhere.
- **How.** Without a shell or arguments, with an environment of `HOME` and `TMPDIR` only plus `WHATSAPP_BRIDGE_PORT` (a
  free port the OS hands out for each start), `WHATSAPP_BRIDGE_TOKEN` (32 random bytes in hex, new for each process,
  kept in memory only and never sent to the web view, a file, an event or the log) and `WHATSAPP_BRIDGE_STORE`.
- **Running.** Its stdin is a pipe Tresso holds open; its stdout is read as events; its stderr is discarded unread (a
  crash inside whatsmeow can print message data there). Only a line that is a JSON object with `"v":1`, a known
  `event` and exactly that event's fields is taken, and a line longer than 4096 bytes is dropped. The QR code is drawn
  by Tresso from the `qr` event's string. The port is used only after it refused a request without the token and took
  one with it.
- **Stopping.** Closing stdin stops the bridge cleanly; SIGTERM follows after 3 seconds, SIGKILL 3 seconds later. It
  stops when Tresso quits (and, as the pipe closes, when Tresso crashes), at sign-out and at Disconnect (after the log
  out, below).
- **When it starts.** In the connect dialog, after the risk was confirmed (`Show QR code`, and its `Try again`, `Link
  again` and `Show a new code`). At launch, and from Settings' or a chat's `Try again`, only when the user's store holds
  a linked session: a connection whose store has none (an earlier version's, or one the phone ended) waits for the user
  to choose `Link again`, which opens the dialog. Nothing shows a QR code the user did not ask for.
- **When it stops by itself.** A `qr_timeout` waits for the user (`Show a new code`). A `logged_out` (the phone
  removed the Mac) waits for the user too (`Link again`). A fatal code that starting again cannot fix (`bad_store`,
  `store_failed`, `pair_failed`, `client_outdated`, `stream_replaced`, `temporary_ban`) stops with its own failure;
  the others, and an exit without an event, start it again after 5, 10, 20 seconds and so on, until it stopped three
  times within a minute. The web client says each failure in a plain sentence.

## Where the data lives

One store per Tresso user: `~/Library/Application Support/app.tresso.desktop/whatsapp/<user id>/`, the path built by
the shell from a checked user id. Tresso makes it, and the `whatsapp` folder around it, readable by the user only
(0700) before the bridge starts, and gives a folder of its own its rights back when they changed; a link in its place
is refused. Downloads are copied out of it into Tresso's own download folder, checked against the hash the store holds.

**Disconnect WhatsApp unlinks.** In this order: when the store holds a session, the device is logged out on
WhatsApp's side through the bridge's `POST /api/logout` (the running bridge, or one Tresso starts for this only, which
gets 15 seconds to come up and 25 for WhatsApp's confirmation), so the phone no longer lists Tresso under Linked
devices; then the bridge stops; then the config and the store go, so connecting again shows a new code. When WhatsApp
cannot be reached in time the config and the store go all the same, and only then Tresso tells the user that the phone
may still list Tresso and how to remove it there (WhatsApp, Settings, Linked devices, Tresso, Log out). A Mac whose
WhatsApp was removed from the Tresso server on another device does the same when it learns of it.

Closing the connect dialog after the phone linked but before WhatsApp was connected undoes that link the same way, and
says so.

**After a new link.** The new store has another store id than the one the relay read, and its history sync brings the
last weeks again, plus chats Tresso never saw. The relay takes it up with the rule of the first import after
connecting: rows sent before the moment the phone linked are history, and a chat that is new or had nothing unread at
the change is read through that moment, while a chat with real unread messages keeps them; rows sent after the moment
are live. The re-read ends as that first import does: once the relay caught up with the new store and it stayed quiet
for a minute, so history that keeps arriving after the link still counts as history. "Only this Mac" reads the new store
from its start as a first import with that line; "All my devices" reads it from its start too, the server answers
`known` for what it holds, and the history is marked read by chat state changes. Before that the Mac closes the
server's own history import with an empty live batch when it is still open (no live batch went since connecting), so
messages that arrive during the re-read are live there too; and the list of chats that had unread messages is kept with
the re-read from its start, so a restart halfway does not make it again after history landed. Chats left out stay left out and are never marked. A mark the server refuses (a chat it no longer has, its removal
not in the copy yet) is tried again for that chat only after a backoff of 30 seconds that doubles up to 10 minutes, and
not at all once the re-read ended; at most 20 marks go per round. Until
the store's id could be read (the history sync can keep it busy), the relay does not start, and tries again with a
growing wait. Messages that arrived between the update and the new link count as history too: in a chat that had
nothing unread they arrive read.

**Signing out of Tresso does not unlink.** It stops the bridge and removes the config, as it did when the bridge lived
in the whatsapp-mcp folder: the store, with its link to the phone, stays for the next connect, so no device is left
orphaned on the phone and nothing is unlinked without the user asking. Once the server confirmed who is signed in,
other users' configs go; their stores stay for the same reason.

## From whatsapp-mcp

Versions before this one started the bridge of [whatsapp-mcp](https://github.com/gettresso/whatsapp-mcp) from a folder
the user built it in. That is gone. A config that names such a folder is moved at the first load: the folder's path is
dropped and the config waits for the phone to be linked again, so Settings says `Link again` (`WhatsApp now runs inside
Tresso. Link your phone again.`); the mode, the import date and the chats left out stay, and the relay reads the new
store from its start without storing a chat or a message twice. Tresso never opens, reads, changes or deletes anything
in the old folder, and forgets the list of folders it kept. The user may delete that folder, and stop a whatsapp-mcp
bridge or MCP server that still runs from it, whenever they like.
