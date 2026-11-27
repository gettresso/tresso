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
the same identity, the hardened runtime and the app's entitlements (Tauri's bundler signs every sidecar before the app),
and checks afterwards that it is there for both architectures and signed with the hardened runtime. The bridge needs
no entitlement of its own (no JIT, no library loading, no sandbox exception), and the app is not sandboxed, so it may
start it. Notarization follows the app's: today the release is signed ad hoc and not notarized, so both go through
Apple's notary service together once the app is.

Its third-party notices ship next to it: `Tresso.app/Contents/Resources/licenses/whatsapp-bridge-third-party-notices.txt`
(from `apps/whatsapp-bridge/THIRD-PARTY-NOTICES.txt`), with every module the binary links and its license texts:
go.mau.fi/libsignal under GPL-3.0, whatsmeow and go.mau.fi/util under MPL-2.0, and the rest under BSD, MIT, ISC and
Apache-2.0. The source of the bridge and of every module is this repository at the release's tag, with `go.mod` and
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
  stops when Tresso quits (and, as the pipe closes, when Tresso crashes), at sign-out and at Disconnect.
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

At Disconnect and at sign-out the user's store goes with the config: the linked session and the messages the bridge
kept, so connecting again shows a new code. The phone keeps listing the Mac under Linked devices until the user removes
it there. Once the server confirmed who is signed in, other users' configs and stores on the Mac go too.

## From whatsapp-mcp

Versions before this one started the bridge of [whatsapp-mcp](https://github.com/gettresso/whatsapp-mcp) from a folder
the user built it in. That is gone. A config that names such a folder is moved at the first load: the folder's path is
dropped and the config waits for the phone to be linked again, so Settings says `Link again` (`WhatsApp now runs inside
Tresso. Link your phone again.`); the mode, the import date and the chats left out stay, and the relay reads the new
store from its start without storing a chat or a message twice. Tresso never opens, reads, changes or deletes anything
in the old folder, and forgets the list of folders it kept. The user may delete that folder, and stop a whatsapp-mcp
bridge or MCP server that still runs from it, whenever they like.
