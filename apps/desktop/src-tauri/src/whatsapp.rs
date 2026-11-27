//! WhatsApp on macOS, through Tresso's own bridge (apps/whatsapp-bridge), which ships inside the app. Tresso starts and
//! stops the bridge by itself, keeps its store in the app's own data folder, reads that store read only and calls the
//! bridge's REST API on 127.0.0.1. No MCP client and no Python: the relay logic lives in the web client
//! (packages/core/src/chat), these commands only start, watch and stop the process, read, send and download. The
//! bridge's contract (environment, the JSON events on stdout, the store, stdin, exit status, the REST API) is in
//! apps/whatsapp-bridge/README.md.
//!
//! The rules this module keeps, each with a test at the bottom:
//! - The bridge is the binary the app bundle carries next to Tresso's own executable (`Contents/MacOS/whatsapp-bridge`,
//!   a Tauri sidecar; a dev build finds the copy Tauri's build script puts next to its executable in `target/`). It is
//!   found from the running executable only: never from PATH, an environment variable or anything the web view names.
//!   It starts without a shell and without arguments, with an environment of HOME and TMPDIR only plus the port, a
//!   fresh token and the store (`WHATSAPP_BRIDGE_PORT`, `WHATSAPP_BRIDGE_TOKEN`, `WHATSAPP_BRIDGE_STORE`).
//! - Its stdin is a pipe Tresso holds open while the bridge should run: closing it stops the bridge cleanly, and when
//!   Tresso quits or crashes the pipe closes and the bridge goes with it. SIGTERM and then SIGKILL follow when it does
//!   not stop in time. Its stdout is read as events; its stderr is never read, logged or stored (a crash can print
//!   message data there).
//! - Only a line of stdout that is a JSON object with `"v":1`, a known `event` and only the fields that event has is
//!   taken; anything else, and any line longer than `MAX_EVENT_BYTES`, is dropped unread.
//! - The token is 32 random bytes from the OS, new for every process, and goes only into that process's environment
//!   and the requests to it: never to the web view, a file, an event or the log. The port is one the OS hands out for
//!   each start, and it is used only after it answered as this bridge (refused without the token, taken with it).
//! - HTTP goes to 127.0.0.1 only, never through a proxy and never following a redirect.
//! - One store per Tresso user: `<app data>/whatsapp/<user id>/`, made by Tresso only this user may open (0700) before
//!   the bridge starts. The path is built here from a checked user id; the web view never names a path to a store.
//! - Disconnect unlinks: when the store holds a session, the bridge (started for this only, when it does not run) logs
//!   the device out on WhatsApp's side (`POST /api/logout`) before it stops and the store is removed, so the phone no
//!   longer lists Tresso and a later connect shows a new code. When WhatsApp cannot be reached in time the store goes
//!   anyway and the web client tells the user how to remove Tresso on the phone. A sign-out, and another user signing
//!   in, remove only the config, as before this bridge: the store, and with it the link, stays for the next connect,
//!   so no device is left orphaned on a phone.
//! - The store is opened read only with `query_only` on: no write, no journal, no WAL file reaches it from Tresso.
//! - A download is asked for only when the stored file name is one plain name. It is copied into the app's own folder
//!   (0700) under a name Tresso makes, marked as downloaded from the internet (quarantine), and kept only when its
//!   SHA-256 matches the one the store holds; a file that differs is removed and refused. The bridge's path is used
//!   only after it proved to be a file inside the store folder.
//! - A file is sent only when the user picked it in the file dialog, or when it is one the relay staged (a file a reply
//!   written on another device carries, fetched from the server: `whatsapp_stage_file`), and only Tresso's own
//!   downloads open. A staged file lives in a folder of its own (0700) inside the app's outbox, under one plain name, is
//!   removed once it was sent (`whatsapp_discard_file`), and every staged file goes at sign-out and at the next launch.
//! - The relay reads back only Tresso's own downloads (`whatsapp_file`), of at most 100 MB, to hand a file the user
//!   asked for on another device to the server.
//! - The bridge stops when the app quits, at sign-out and when WhatsApp is disconnected.
//! - Earlier versions started the bridge of whatsapp-mcp from a folder the user picked. A config that names such a
//!   folder becomes one that waits for the phone to be linked again (`moved`), and the folder is forgotten: Tresso never
//!   opens, reads, changes or deletes anything in it.
//! - Every command answers `unsupported` outside macOS and while WhatsApp is not turned on (below);
//!   `whatsapp_available` says false then. Only the main window may call them (capabilities/whatsapp.json).
//!
//! WhatsApp stays off until it is turned on, while it waits for a hand-check with a real phone: `defaults write
//! app.tresso.desktop EnableWhatsApp -bool YES` (or the app started with `TRESSO_ENABLE_WHATSAPP=1`), and `defaults
//! delete app.tresso.desktop EnableWhatsApp` turns it off again. The switch is read once, when the app starts
//! (`setup`), so quit and open Tresso after changing it. Off, every command refuses, so nothing in the window can load
//! a config, start a bridge, read or send, also for a WhatsApp connected before.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// The event every change of the bridge's state is sent on, with the state as payload.
pub const EVENT: &str = "whatsapp";
const PORT_VARIABLE: &str = "WHATSAPP_BRIDGE_PORT";
const TOKEN_VARIABLE: &str = "WHATSAPP_BRIDGE_TOKEN";
const STORE_VARIABLE: &str = "WHATSAPP_BRIDGE_STORE";
/// The sidecar's name next to Tresso's executable (`bundle > externalBin` in tauri.macos.conf.json).
const BINARY: &str = "whatsapp-bridge";
/// In the app's data folder: one store per Tresso user below it.
const STORES_DIR: &str = "whatsapp";
const MESSAGES_DB: &str = "messages.db";
const SESSION_DB: &str = "whatsapp.db";
/// Files of earlier versions in the app's data folder: the whatsapp-mcp folders the user picked, and the pid of the
/// bridge started from one. Removed at launch; nothing they name is touched.
const LEGACY_FILES: [&str; 2] = ["whatsapp.folders.json", "whatsapp.bridge.pid"];
const MEDIA_DIR: &str = "whatsapp-media";
/// Files a reply written on another device carries, staged for the bridge until they are sent.
const OUTBOX_DIR: &str = "whatsapp-outbox";
/// The header the web client names a staged file in (percent-encoded UTF-8).
const FILE_NAME_HEADER: &str = "x-file-name";
const MAX_ROWS: u32 = 500;
const MAX_IDS: usize = 500;
const MAX_TEXT_BYTES: usize = 65_536;
const MAX_LEFT_OUT: usize = 10_000;
const MAX_DOWNLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// The largest file Attach sends: the bridge refuses a larger one too (apps/whatsapp-bridge/README.md), and it reads a
/// file whole into memory before it uploads it. Raise it only together with the bridge, after measuring large files.
const MAX_SEND_BYTES: u64 = 100 * 1024 * 1024;
const MAX_ANSWER_BYTES: u64 = 1024 * 1024;
/// A longer line of the bridge's stdout is dropped unread: the longest event, a QR code, is a few hundred bytes.
const MAX_EVENT_BYTES: usize = 4096;
/// The longest QR string taken from an event (a WhatsApp pairing code is about 240 characters).
const MAX_QR_CHARS: usize = 1024;
/// The version of the event shapes this reader knows (apps/whatsapp-bridge/README.md, Output).
const EVENT_VERSION: u64 = 1;
/// Text and file names longer than this are cut when read (WhatsApp's own limit for a text is 65536 characters).
const MAX_FIELD_CHARS: u32 = 65_536;
const TOKEN_HEADER: &str = "X-Bridge-Token";
/// The only variables the bridge gets besides the port, the token and the store: no PATH, no proxy, no library paths.
const PASSED_VARIABLES: [&str; 2] = ["HOME", "TMPDIR"];
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const BUSY_TIMEOUT: Duration = Duration::from_secs(2);
/// How long a bridge has to answer as itself after it said it listens.
const LISTEN_WAIT: Duration = Duration::from_secs(5);
/// How long the end of a run waits for the rest of its events.
const READ_TO_END: Duration = Duration::from_secs(1);
/// The light modules around a QR code on every side, as the standard asks.
const QUIET_ZONE: usize = 4;
const UNSUPPORTED: &str = "unsupported";
/// Extensions a downloaded file keeps; anything else is saved as `.bin`, so opening a received file never runs code:
/// pictures, sound, video, PDF, plain text and documents whose apps run no code (Office's macro formats, archives,
/// web pages, SVG, disk images, installers, apps and scripts are not here).
const SAFE_EXTENSIONS: [&str; 32] = [
  "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "mp4", "mov", "m4v", "3gp", "ogg", "oga", "opus", "mp3", "m4a", "aac", "wav",
  "pdf", "txt", "csv", "rtf", "docx", "xlsx", "pptx", "odt", "ods", "odp", "pages", "numbers", "key", "vcf",
];

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn code(text: &str) -> String {
  text.to_string()
}

// ----------------------------------------------------------------------------------------------------------------
// The state the web client sees.

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Process {
  /// Tresso started it and reads its events.
  Owned,
  Stopped,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Link {
  Linked,
  Unlinked,
  WaitingForScan,
  Unknown,
}

/// Why the bridge does not run, for the web client to say in a plain sentence (whatsappTexts.ts).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
  /// The bridge is not in the app, or cannot be started (an app that was changed or is damaged).
  Missing,
  /// Its store cannot be made, opened or read (`bad_store`, `store_failed`).
  Store,
  /// WhatsApp could not be reached, three times within the crash window (`connect_failed`, `not_connected`).
  Offline,
  /// The phone or WhatsApp refused the link (`pair_failed`).
  PairFailed,
  /// WhatsApp no longer takes this version of the bridge (`client_outdated`): the app needs an update.
  Outdated,
  /// Another program connected with the same session (`stream_replaced`).
  Replaced,
  /// WhatsApp banned the account for a while (`temporary_ban`).
  Banned,
  /// The phone removed this device under Linked devices (`logged_out`): linking again shows a new code.
  LoggedOut,
  /// It stopped three times within the crash window for another reason; Tresso no longer starts it by itself.
  Exited,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
  pub process: Process,
  pub port: Option<u16>,
  /// Whether the REST API listens on 127.0.0.1 only; null while unknown.
  pub loopback_only: Option<bool>,
  pub link: Link,
  /// The QR code to scan, a string of `0` (light) and `1` (dark) per row, quiet zone included.
  pub qr: Option<Vec<String>>,
  pub error: Option<Failure>,
}

impl Snapshot {
  fn stopped(error: Option<Failure>) -> Self {
    Snapshot { process: Process::Stopped, port: None, loopback_only: None, link: Link::Unknown, qr: None, error }
  }
}

// ----------------------------------------------------------------------------------------------------------------
// Reading the bridge's events.

/// Why a bridge stopped, as its `fatal` event says (apps/whatsapp-bridge/README.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fatal {
  BadPort,
  BadToken,
  BadStore,
  StoreFailed,
  ConnectFailed,
  NotConnected,
  PairFailed,
  ClientOutdated,
  StreamReplaced,
  TemporaryBan,
  ListenFailed,
  ServerFailed,
  Panic,
  /// A code this version does not know yet.
  Other,
}

impl Fatal {
  fn of(code: &str) -> Fatal {
    match code {
      "bad_port" => Fatal::BadPort,
      "bad_token" => Fatal::BadToken,
      "bad_store" => Fatal::BadStore,
      "store_failed" => Fatal::StoreFailed,
      "connect_failed" => Fatal::ConnectFailed,
      "not_connected" => Fatal::NotConnected,
      "pair_failed" => Fatal::PairFailed,
      "client_outdated" => Fatal::ClientOutdated,
      "stream_replaced" => Fatal::StreamReplaced,
      "temporary_ban" => Fatal::TemporaryBan,
      "listen_failed" => Fatal::ListenFailed,
      "server_failed" => Fatal::ServerFailed,
      "panic" => Fatal::Panic,
      _ => Fatal::Other,
    }
  }

  /// What the user is told once the bridge stays stopped because of it.
  fn failure(self) -> Failure {
    match self {
      Fatal::BadStore | Fatal::StoreFailed => Failure::Store,
      Fatal::ConnectFailed | Fatal::NotConnected => Failure::Offline,
      Fatal::PairFailed => Failure::PairFailed,
      Fatal::ClientOutdated => Failure::Outdated,
      Fatal::StreamReplaced => Failure::Replaced,
      Fatal::TemporaryBan => Failure::Banned,
      Fatal::BadPort | Fatal::BadToken | Fatal::ListenFailed | Fatal::ServerFailed | Fatal::Panic | Fatal::Other => Failure::Exited,
    }
  }

  /// Whether starting again can help: a network that comes back, a port taken by chance, an internal error. The rest
  /// would fail the same way again (or, for a ban or a session used elsewhere, make it worse), so the user decides.
  fn passing(self) -> bool {
    matches!(self, Fatal::BadPort | Fatal::BadToken | Fatal::ConnectFailed | Fatal::NotConnected | Fatal::ListenFailed | Fatal::ServerFailed | Fatal::Panic | Fatal::Other)
  }
}

/// One event of the bridge's stdout.
#[derive(Debug, PartialEq, Eq)]
enum Event {
  /// Not linked: the string to show as a QR code.
  Qr(String),
  /// Nobody scanned in time; the bridge stops.
  QrTimeout,
  Linked,
  Connected,
  Disconnected,
  /// The REST API accepts requests on 127.0.0.1 and this port.
  Listening(u16),
  /// The phone removed this device; the bridge stops.
  LoggedOut,
  Fatal(Fatal),
}

/// Whether the object has no fields but `v`, `event` and the ones named.
fn only_fields(object: &Map<String, Value>, fields: &[&str]) -> bool {
  object.keys().all(|key| key == "v" || key == "event" || fields.contains(&key.as_str()))
}

/// Reads one line of the bridge's stdout: a JSON object of version 1 with a known event and exactly its fields, or
/// nothing. Nothing of a line that is not taken is kept or logged.
fn parse_event(line: &str) -> Option<Event> {
  let value: Value = serde_json::from_str(line).ok()?;
  let object = value.as_object()?;
  if object.get("v")?.as_u64()? != EVENT_VERSION {
    return None;
  }
  let event = match object.get("event")?.as_str()? {
    "qr" if only_fields(object, &["qr"]) => {
      let qr = object.get("qr")?.as_str()?;
      if qr.is_empty() || qr.chars().count() > MAX_QR_CHARS || qr.chars().any(char::is_control) {
        return None;
      }
      Event::Qr(qr.to_string())
    }
    "qr_timeout" if only_fields(object, &[]) => Event::QrTimeout,
    "linked" if only_fields(object, &[]) => Event::Linked,
    "connected" if only_fields(object, &[]) => Event::Connected,
    "disconnected" if only_fields(object, &[]) => Event::Disconnected,
    "listening" if only_fields(object, &["port"]) => Event::Listening(object.get("port")?.as_u64().and_then(|port| u16::try_from(port).ok()).filter(|port| *port != 0)?),
    "logged_out" if only_fields(object, &[]) => Event::LoggedOut,
    "fatal" if only_fields(object, &["code"]) => {
      let code = object.get("code")?.as_str()?;
      if code.is_empty() || code.len() > 64 || !code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
        return None;
      }
      Event::Fatal(Fatal::of(code))
    }
    _ => return None,
  };
  Some(event)
}

/// The rows of the QR code for `text`, `1` for a dark module, with the quiet zone on every side.
fn qr_rows(text: &str) -> Option<Vec<String>> {
  let code = qrcode::QrCode::new(text.as_bytes()).ok()?;
  let width = code.width();
  let colors = code.to_colors();
  let full = width + 2 * QUIET_ZONE;
  let light = "0".repeat(full);
  let mut rows = vec![light.clone(); QUIET_ZONE];
  for y in 0..width {
    let mut row = "0".repeat(QUIET_ZONE);
    row.extend(colors[y * width..(y + 1) * width].iter().map(|color| if *color == qrcode::Color::Dark { '1' } else { '0' }));
    row.push_str(&"0".repeat(QUIET_ZONE));
    rows.push(row);
  }
  rows.extend(std::iter::repeat_n(light, QUIET_ZONE));
  Some(rows)
}

// ----------------------------------------------------------------------------------------------------------------
// The process.

#[derive(Clone)]
struct Settings {
  /// How long a bridge has after its stdin closed, and again after SIGTERM, before the next step.
  grace: Duration,
  poll: Duration,
  first_backoff: Duration,
  max_backoff: Duration,
  /// Three unexpected exits within this time stop the restarts.
  crash_window: Duration,
  /// How long Disconnect waits for a bridge it started only to log out to answer on its port.
  unlink_wait: Duration,
  /// How long Disconnect waits for the bridge to confirm the log out (the bridge's own limit is 20 seconds).
  logout_timeout: Duration,
}

impl Default for Settings {
  fn default() -> Self {
    Settings {
      grace: Duration::from_secs(3),
      poll: Duration::from_millis(100),
      first_backoff: Duration::from_secs(5),
      max_backoff: Duration::from_secs(300),
      crash_window: Duration::from_secs(60),
      unlink_wait: Duration::from_secs(15),
      logout_timeout: Duration::from_secs(25),
    }
  }
}

type Emit = Arc<dyn Fn(&Snapshot) + Send + Sync>;

/// The bridge Tresso started, managed as Tauri state.
pub struct Bridge(Arc<Shared>);

struct Shared {
  settings: Settings,
  inner: Mutex<Inner>,
  /// Notified when a run ends.
  ended: Condvar,
  /// Held by start and stop, so they never interleave.
  control: Mutex<()>,
  emit: Mutex<Option<Emit>>,
  data_dir: Mutex<Option<PathBuf>>,
  /// The bridge binary, found next to Tresso's own executable at launch (`setup`); None when it is not there.
  binary: Mutex<Option<PathBuf>>,
  /// The user whose store the bridge was last started on: the store the read commands read. None after sign-out.
  user: Mutex<Option<String>>,
  /// The files the user picked in the file dialog since the last sign-out: the only ones a message may carry.
  chosen_files: Mutex<HashSet<PathBuf>>,
  /// The files the relay staged to send (`whatsapp_stage_file`) and not discarded yet: the only others a message may
  /// carry.
  staged_files: Mutex<HashSet<PathBuf>>,
  /// Whether WhatsApp is turned on, read once at launch (`setup`); off until then.
  switched_on: std::sync::OnceLock<bool>,
}

/// A fresh token. Without random bytes from the OS nothing here can be made safe, so that stops the app.
fn new_token() -> String {
  let mut bytes = [0u8; 32];
  getrandom::fill(&mut bytes).expect("the operating system gave no random bytes");
  hex(&bytes)
}

/// A port nothing listens on now, from the OS. Another program may take it before the bridge binds it: the bridge then
/// stops with `listen_failed`, and the next start gets another port.
fn free_port() -> io::Result<u16> {
  Ok(TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?.local_addr()?.port())
}

struct Inner {
  snapshot: Snapshot,
  /// Grows with every start and stop, so a restart planned before either does not happen.
  generation: u64,
  run: Option<Run>,
  /// The user a restart starts the bridge for again.
  launch: Option<String>,
  exits: VecDeque<Instant>,
  backoff: Duration,
}

struct Run {
  generation: u64,
  child: Arc<Mutex<Child>>,
  /// The write end of the bridge's stdin: held while it should run, dropped to stop it.
  stdin: Option<ChildStdin>,
  /// 32 random bytes from the OS, in hex, made for this process only: its environment and the requests to it carry
  /// it, and it is gone when the process ends.
  token: String,
  /// The port this process was given.
  port: u16,
  /// The port is being checked, or was.
  listening: bool,
  stopping: bool,
  qr_timeout: bool,
  logged_out: bool,
  /// The last `fatal` event.
  fatal: Option<Fatal>,
  /// It did not answer as this bridge on its port: stopped and counted as a crash.
  unconfirmed: bool,
}

impl Default for Bridge {
  fn default() -> Self {
    Bridge::new(Settings::default())
  }
}

impl Bridge {
  fn new(settings: Settings) -> Self {
    let backoff = settings.first_backoff;
    Bridge(Arc::new(Shared {
      settings,
      inner: Mutex::new(Inner { snapshot: Snapshot::stopped(None), generation: 0, run: None, launch: None, exits: VecDeque::new(), backoff }),
      ended: Condvar::new(),
      control: Mutex::new(()),
      emit: Mutex::new(None),
      data_dir: Mutex::new(None),
      binary: Mutex::new(None),
      user: Mutex::new(None),
      chosen_files: Mutex::new(HashSet::new()),
      staged_files: Mutex::new(HashSet::new()),
      switched_on: std::sync::OnceLock::new(),
    }))
  }

  /// macOS, and WhatsApp turned on; every command checks this first.
  fn enabled(&self) -> Result<(), String> {
    enabled_with(supported().is_ok(), self.0.switched_on.get().copied().unwrap_or(false))
  }

  fn connect(&self, data_dir: PathBuf, binary: Option<PathBuf>, emit: Emit) {
    *lock(&self.0.data_dir) = Some(data_dir);
    *lock(&self.0.binary) = binary;
    *lock(&self.0.emit) = Some(emit);
  }

  fn snapshot(&self) -> Snapshot {
    lock(&self.0.inner).snapshot.clone()
  }

  /// Where to reach the running bridge: its confirmed port and the token of this run.
  fn endpoint(&self) -> Option<(u16, String)> {
    let inner = lock(&self.0.inner);
    Some((inner.snapshot.port?, inner.run.as_ref()?.token.clone()))
  }

  /// The store of the user the bridge was last started for; `no_store` when none was.
  fn store(&self) -> Result<PathBuf, String> {
    let data_dir = lock(&self.0.data_dir).clone().ok_or_else(|| code("no_store"))?;
    let user = lock(&self.0.user).clone().ok_or_else(|| code("no_store"))?;
    store_dir(&data_dir, &user)
  }

  /// The user the bridge was last started for.
  fn user(&self) -> Option<String> {
    lock(&self.0.user).clone()
  }

  /// Starts the bridge on `user_id`'s store; a bridge that runs for that user already is kept, one for another user
  /// stops first.
  fn start(&self, user_id: &str) -> Snapshot {
    let _control = lock(&self.0.control);
    {
      let inner = lock(&self.0.inner);
      if inner.run.is_some() && inner.launch.as_deref() == Some(user_id) {
        return inner.snapshot.clone();
      }
    }
    self.stop_now();
    *lock(&self.0.user) = Some(user_id.to_string());
    let mut inner = lock(&self.0.inner);
    inner.exits.clear();
    inner.backoff = self.0.settings.first_backoff;
    if let Err(failure) = Shared::spawn(&self.0, &mut inner, user_id) {
      inner.snapshot = Snapshot::stopped(Some(failure));
    }
    self.0.publish(inner)
  }

  /// Stops the bridge Tresso started: its stdin closes, then SIGTERM, then SIGKILL, each after the grace time.
  fn stop(&self) -> Snapshot {
    let _control = lock(&self.0.control);
    self.stop_now()
  }

  fn stop_now(&self) -> Snapshot {
    let shared = &self.0;
    let mut inner = lock(&shared.inner);
    inner.generation += 1;
    inner.launch = None;
    let Some(target) = inner.run.as_mut().map(|run| {
      run.stopping = true;
      // The end of stdin stops the bridge cleanly (it disconnects and closes its databases).
      drop(run.stdin.take());
      run.generation
    }) else {
      if inner.snapshot != Snapshot::stopped(None) {
        inner.snapshot = Snapshot::stopped(None);
        return shared.publish(inner);
      }
      return inner.snapshot.clone();
    };
    let running = |inner: &mut Inner| inner.run.as_ref().is_some_and(|run| run.generation == target);
    inner = shared.ended.wait_timeout_while(inner, shared.settings.grace, running).unwrap_or_else(PoisonError::into_inner).0;
    if let Some(child) = inner.run.as_ref().filter(|run| run.generation == target).map(|run| Arc::clone(&run.child)) {
      log::warn!("The WhatsApp bridge did not stop when its input closed; sending SIGTERM");
      terminate(&child);
      inner = shared.ended.wait_timeout_while(inner, shared.settings.grace, running).unwrap_or_else(PoisonError::into_inner).0;
    }
    if let Some(child) = inner.run.as_ref().filter(|run| run.generation == target).map(|run| Arc::clone(&run.child)) {
      log::warn!("The WhatsApp bridge did not stop within {:?} of SIGTERM; killing it", shared.settings.grace);
      // std's kill sends SIGKILL, and nothing once the child was reaped.
      let _ = lock(&child).kill();
      inner = shared.ended.wait_timeout_while(inner, shared.settings.grace, running).unwrap_or_else(PoisonError::into_inner).0;
    }
    if running(&mut inner) {
      log::error!("The WhatsApp bridge is still running after SIGKILL");
    }
    inner.snapshot.clone()
  }

  /// Stops the bridge when it runs (or waits to restart) for `user_id`; true when it did.
  fn stop_for(&self, user_id: &str) -> bool {
    if self.user().as_deref() != Some(user_id) {
      return false;
    }
    self.stop();
    true
  }

  /// Disconnect WhatsApp for `user_id`, in this order: when the store holds a session, log the device out on WhatsApp's
  /// side (through the running bridge, or one started for this only); then stop the bridge; then remove the config
  /// and the store. When WhatsApp cannot be reached within `unlink_wait` and `logout_timeout`, the config and the store
  /// go all the same and `unlinked` is false.
  fn disconnect(&self, user_id: &str) -> Result<Disconnected, String> {
    let data_dir = lock(&self.0.data_dir).clone().ok_or_else(|| code("no_store"))?;
    let store = store_dir(&data_dir, user_id)?;
    let unlinked = !has_session(&store) || self.log_out(user_id);
    if self.user().as_deref() == Some(user_id) {
      self.stop();
      *lock(&self.0.user) = None;
    }
    clear_config(&data_dir, user_id)?;
    remove_store(&data_dir, user_id)?;
    Ok(Disconnected { unlinked })
  }

  /// Logs the linked device out through the bridge: the running one for this user, else one started for it. True once
  /// the bridge said WhatsApp confirmed.
  fn log_out(&self, user_id: &str) -> bool {
    if self.user().as_deref() != Some(user_id) || self.endpoint().is_none() {
      self.start(user_id);
    }
    let deadline = Instant::now() + self.0.settings.unlink_wait;
    let endpoint = loop {
      if let Some(endpoint) = self.endpoint() {
        break Some(endpoint);
      }
      let snapshot = self.snapshot();
      // Stopped, or asking for a code (no session after all): there is no bridge to log out through.
      if snapshot.process == Process::Stopped || snapshot.link == Link::WaitingForScan || Instant::now() >= deadline {
        break None;
      }
      thread::sleep(self.0.settings.poll);
    };
    let Some((port, token)) = endpoint else {
      log::warn!("The WhatsApp bridge did not come up to log out; removing its store without it");
      return false;
    };
    logout(port, &token, self.0.settings.logout_timeout)
  }

  /// The sign-in ended: the bridge stops, its store is no longer the one read, and the files picked for the user who
  /// left can no longer be sent.
  fn signed_out(&self) {
    lock(&self.0.chosen_files).clear();
    lock(&self.0.staged_files).clear();
    if let Some(data_dir) = lock(&self.0.data_dir).clone() {
      let _ = fs::remove_dir_all(data_dir.join(OUTBOX_DIR));
    }
    self.stop();
    *lock(&self.0.user) = None;
  }

  #[cfg(test)]
  fn wait_until(&self, done: impl Fn(&Snapshot) -> bool) -> Snapshot {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
      let snapshot = self.snapshot();
      if done(&snapshot) {
        return snapshot;
      }
      assert!(Instant::now() < deadline, "the bridge never reached the state; last: {snapshot:?}");
      thread::sleep(Duration::from_millis(10));
    }
  }
}

/// SIGTERM to a child that has not exited; never a signal to a pid already reaped.
fn terminate(child: &Mutex<Child>) {
  let mut child = lock(child);
  if let Ok(None) = child.try_wait() {
    #[cfg(unix)]
    if let Ok(pid) = libc::pid_t::try_from(child.id()) {
      // SAFETY: kill only sends a signal; the pid is our own child, not reaped yet (checked above, under the lock
      // every reap goes through).
      unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    #[cfg(not(unix))]
    let _ = child.kill();
  }
}

impl Shared {
  fn publish(&self, inner: MutexGuard<'_, Inner>) -> Snapshot {
    let snapshot = inner.snapshot.clone();
    drop(inner);
    let emit = lock(&self.emit).clone();
    if let Some(emit) = emit {
      emit(&snapshot);
    }
    snapshot
  }

  fn spawn(shared: &Arc<Shared>, inner: &mut Inner, user_id: &str) -> Result<(), Failure> {
    let binary = lock(&shared.binary).clone().filter(|binary| executable(binary)).ok_or_else(|| {
      log::error!("The WhatsApp bridge is not next to Tresso's executable");
      Failure::Missing
    })?;
    let data_dir = lock(&shared.data_dir).clone().ok_or(Failure::Store)?;
    let store = prepare_store(&data_dir, user_id).map_err(|error| {
      log::error!("Making the WhatsApp store failed: {error}");
      Failure::Store
    })?;
    let port = free_port().map_err(|error| {
      log::error!("No port for the WhatsApp bridge: {error}");
      Failure::Exited
    })?;
    let token = new_token();
    let mut command = Command::new(&binary);
    command.current_dir(&store).env_clear();
    for name in PASSED_VARIABLES {
      if let Some(value) = std::env::var_os(name) {
        command.env(name, value);
      }
    }
    command
      .env(PORT_VARIABLE, port.to_string())
      .env(TOKEN_VARIABLE, &token)
      .env(STORE_VARIABLE, &store)
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      // Never read: a crash inside whatsmeow prints a panic value there, which can hold message data.
      .stderr(Stdio::null());
    let mut child = command.spawn().map_err(|error| {
      log::error!("Starting the WhatsApp bridge failed: {error}");
      match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied => Failure::Missing,
        _ => Failure::Exited,
      }
    })?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    inner.generation += 1;
    let generation = inner.generation;
    let child = Arc::new(Mutex::new(child));
    inner.run = Some(Run {
      generation,
      child: Arc::clone(&child),
      stdin,
      token,
      port,
      listening: false,
      stopping: false,
      qr_timeout: false,
      logged_out: false,
      fatal: None,
      unconfirmed: false,
    });
    inner.snapshot = Snapshot { process: Process::Owned, port: None, loopback_only: None, link: Link::Unknown, qr: None, error: None };
    inner.launch = Some(user_id.to_string());

    let (finished, read_to_end) = std::sync::mpsc::channel::<()>();
    let reading = stdout.is_some();
    if let Some(stdout) = stdout {
      let shared = Arc::clone(shared);
      thread::spawn(move || {
        read_lines(stdout, MAX_EVENT_BYTES, |line| {
          if let Some(event) = parse_event(line) {
            Shared::on_event(&shared, generation, event);
          }
        });
        let _ = finished.send(());
      });
    }
    let shared = Arc::clone(shared);
    thread::spawn(move || {
      // The exit decides, not the end of the output: a process the bridge started can keep its stdout open.
      loop {
        // Not held while sleeping: a stop takes the same lock to signal the child.
        let status = lock(&child).try_wait();
        if !matches!(status, Ok(None)) {
          break;
        }
        thread::sleep(shared.settings.poll);
      }
      // The last events (a fatal code, a log out) say why it ended: a moment for the reader to get to them.
      if reading {
        let _ = read_to_end.recv_timeout(READ_TO_END);
      }
      Shared::ended(&shared, generation);
    });
    Ok(())
  }

  fn on_event(shared: &Arc<Shared>, generation: u64, event: Event) {
    let mut inner = lock(&shared.inner);
    let Some(run) = inner.run.as_mut().filter(|run| run.generation == generation) else {
      return;
    };
    match event {
      Event::Qr(text) => {
        let Some(rows) = qr_rows(&text) else {
          log::warn!("A WhatsApp QR code could not be drawn");
          return;
        };
        inner.snapshot.link = Link::WaitingForScan;
        inner.snapshot.qr = Some(rows);
        shared.publish(inner);
      }
      Event::Linked | Event::Connected => {
        inner.snapshot.link = Link::Linked;
        inner.snapshot.qr = None;
        inner.backoff = shared.settings.first_backoff;
        shared.publish(inner);
      }
      // whatsmeow connects again by itself; the link stays as it is (sending says `not_linked` meanwhile).
      Event::Disconnected => {}
      Event::Listening(port) if !run.listening && port == run.port => {
        run.listening = true;
        let token = run.token.clone();
        let shared = Arc::clone(shared);
        thread::spawn(move || Shared::confirm_port(&shared, generation, port, token));
      }
      Event::Listening(_) => {}
      Event::QrTimeout => run.qr_timeout = true,
      Event::LoggedOut => {
        run.logged_out = true;
        inner.snapshot.link = Link::Unlinked;
        inner.snapshot.qr = None;
        shared.publish(inner);
      }
      Event::Fatal(fatal) => run.fatal = Some(fatal),
    }
  }

  /// Takes the port once it answers as this bridge: a request without the token is refused, one with it is taken. A
  /// process that answers otherwise is not used: it is stopped, and that counts as a crash.
  fn confirm_port(shared: &Arc<Shared>, generation: u64, port: u16, token: String) {
    let deadline = Instant::now() + LISTEN_WAIT;
    loop {
      match probe(port, Some(&token)) {
        Probe::Ours => break,
        Probe::Unprotected => {
          log::error!("The WhatsApp bridge answers without Tresso's token; stopping it");
          Shared::unconfirmed(shared, generation);
          return;
        }
        Probe::Nothing | Probe::Taken => {}
      }
      if !shared.runs(generation) {
        return;
      }
      if Instant::now() >= deadline {
        log::warn!("The WhatsApp bridge does not answer as itself on its port; stopping it");
        Shared::unconfirmed(shared, generation);
        return;
      }
      thread::sleep(shared.settings.poll);
    }
    // Asking the network says it for sure; the bridge binds 127.0.0.1 only, which is the answer when the Mac has no
    // network address.
    let loopback = loopback_only(port).unwrap_or(true);
    let mut inner = lock(&shared.inner);
    if inner.run.as_ref().is_some_and(|run| run.generation == generation) {
      inner.snapshot.port = Some(port);
      inner.snapshot.loopback_only = Some(loopback);
      shared.publish(inner);
    }
  }

  fn unconfirmed(shared: &Arc<Shared>, generation: u64) {
    let mut inner = lock(&shared.inner);
    if let Some(run) = inner.run.as_mut().filter(|run| run.generation == generation && !run.stopping) {
      run.unconfirmed = true;
      terminate(&run.child);
    }
  }

  fn runs(&self, generation: u64) -> bool {
    lock(&self.inner).run.as_ref().is_some_and(|run| run.generation == generation)
  }

  fn ended(shared: &Arc<Shared>, generation: u64) {
    let mut inner = lock(&shared.inner);
    if !inner.run.as_ref().is_some_and(|run| run.generation == generation) {
      return;
    }
    let Some(run) = inner.run.take() else {
      return;
    };
    let lasting = run.fatal.filter(|fatal| !fatal.passing());
    if run.stopping {
      inner.snapshot = Snapshot::stopped(None);
    } else if run.logged_out {
      // The phone removed this device: linking again is the user's step ("Link again").
      inner.launch = None;
      inner.snapshot = Snapshot { link: Link::Unlinked, ..Snapshot::stopped(Some(Failure::LoggedOut)) };
    } else if let Some(fatal) = lasting {
      inner.launch = None;
      inner.snapshot = Snapshot::stopped(Some(fatal.failure()));
    } else if run.qr_timeout {
      // Nobody scanned for three minutes: the next code waits for the user (`Show a new code`).
      inner.launch = None;
      inner.snapshot = Snapshot { link: Link::Unlinked, ..Snapshot::stopped(None) };
    } else {
      let now = Instant::now();
      let window = shared.settings.crash_window;
      inner.exits.push_back(now);
      while inner.exits.front().is_some_and(|exit| now.duration_since(*exit) > window) {
        inner.exits.pop_front();
      }
      if inner.exits.len() >= 3 {
        log::error!("The WhatsApp bridge stopped three times within {window:?}; not starting it again");
        inner.exits.clear();
        inner.launch = None;
        inner.backoff = shared.settings.first_backoff;
        inner.snapshot = Snapshot::stopped(Some(run.fatal.map_or(Failure::Exited, Fatal::failure)));
      } else {
        let delay = inner.backoff;
        inner.backoff = (delay * 2).min(shared.settings.max_backoff);
        inner.snapshot = Snapshot::stopped(None);
        let planned = inner.generation;
        let shared = Arc::clone(shared);
        thread::spawn(move || {
          thread::sleep(delay);
          Shared::restart(&shared, planned);
        });
      }
    }
    shared.ended.notify_all();
    shared.publish(inner);
  }

  fn restart(shared: &Arc<Shared>, planned: u64) {
    let mut inner = lock(&shared.inner);
    if inner.generation != planned || inner.run.is_some() {
      return;
    }
    let Some(user_id) = inner.launch.clone() else {
      return;
    };
    if let Err(failure) = Shared::spawn(shared, &mut inner, &user_id) {
      inner.launch = None;
      inner.snapshot = Snapshot::stopped(Some(failure));
    }
    shared.publish(inner);
  }
}

/// Calls `line` with each line of `source`, without its line break. A line longer than `max` bytes is dropped whole,
/// without holding more than `max` bytes of it.
fn read_lines(source: impl Read, max: usize, mut line: impl FnMut(&str)) {
  let mut reader = BufReader::new(source);
  let mut buffer = Vec::new();
  let limit = max as u64 + 1;
  loop {
    buffer.clear();
    match (&mut reader).take(limit).read_until(b'\n', &mut buffer) {
      Ok(0) | Err(_) => return,
      Ok(_) => {}
    }
    if buffer.last() != Some(&b'\n') && buffer.len() > max {
      log::warn!("Dropped a line of the WhatsApp bridge's output longer than {max} bytes");
      loop {
        buffer.clear();
        match (&mut reader).take(limit).read_until(b'\n', &mut buffer) {
          Ok(0) | Err(_) => return,
          Ok(_) if buffer.last() == Some(&b'\n') => break,
          Ok(_) => {}
        }
      }
      continue;
    }
    if buffer.last() == Some(&b'\n') {
      buffer.pop();
      if buffer.last() == Some(&b'\r') {
        buffer.pop();
      }
    }
    line(&String::from_utf8_lossy(&buffer));
  }
}

// ----------------------------------------------------------------------------------------------------------------
// HTTP to the bridge: 127.0.0.1 only.

enum Answer {
  Reply { status: u16, body: String },
  /// Nothing listens: the request never reached a bridge.
  NotConnected,
  /// The request went out, no whole answer came back: whether the bridge acted is not known.
  Lost,
}

/// A POST to the bridge on 127.0.0.1, with the token when one is given.
fn post(port: u16, token: Option<&str>, path: &'static str, body: &Value, timeout: Duration) -> Answer {
  let agent: ureq::Agent = ureq::Agent::config_builder()
    // ureq reads HTTP_PROXY and the like by default; a message must never go anywhere but the bridge.
    .proxy(None)
    .max_redirects(0)
    .http_status_as_error(false)
    .timeout_connect(Some(timeout.min(PROBE_TIMEOUT)))
    .timeout_global(Some(timeout))
    .build()
    .into();
  let url = format!("http://{}{path}", SocketAddr::from((Ipv4Addr::LOCALHOST, port)));
  let text = body.to_string();
  let mut request = agent.post(&url).content_type("application/json");
  if let Some(token) = token {
    request = request.header(TOKEN_HEADER, token);
  }
  match request.send(text.as_str()) {
    Ok(mut response) => {
      let status = response.status().as_u16();
      match response.body_mut().with_config().limit(MAX_ANSWER_BYTES).read_to_string() {
        Ok(body) => Answer::Reply { status, body },
        Err(_) => Answer::Lost,
      }
    }
    Err(ureq::Error::ConnectionFailed | ureq::Error::Timeout(ureq::Timeout::Connect)) => Answer::NotConnected,
    Err(ureq::Error::Io(error)) if matches!(error.kind(), io::ErrorKind::ConnectionRefused | io::ErrorKind::AddrNotAvailable) => {
      Answer::NotConnected
    }
    Err(_) => Answer::Lost,
  }
}

/// What answers on a port. A bridge answers an empty send with exactly `Recipient is required` (400) and sends
/// nothing; anything else is not one, and gets no message text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Probe {
  /// Nothing listens.
  Nothing,
  /// A bridge that answers without a token: anything on the Mac can use it.
  Unprotected,
  /// A bridge that refuses a request without the token and takes this run's.
  Ours,
  /// Something else answers (or, asked with a token, refuses it).
  Taken,
}

fn is_bridge_answer(answer: &Answer) -> bool {
  matches!(answer, Answer::Reply { status: 400, body } if body.trim_end() == "Recipient is required")
}

/// Asks without a token first. Only the process Tresso just started gets `token`, and only once it refused the bare
/// request (401).
fn probe(port: u16, token: Option<&str>) -> Probe {
  let empty = json!({});
  let bare = post(port, None, "/api/send", &empty, PROBE_TIMEOUT);
  if is_bridge_answer(&bare) {
    return Probe::Unprotected;
  }
  match (bare, token) {
    (Answer::NotConnected, _) => Probe::Nothing,
    (Answer::Reply { status: 401, .. }, Some(token)) => {
      if is_bridge_answer(&post(port, Some(token), "/api/send", &empty, PROBE_TIMEOUT)) {
        Probe::Ours
      } else {
        Probe::Taken
      }
    }
    _ => Probe::Taken,
  }
}

/// Whether the port is closed to the network: asked by connecting to it on the Mac's own network address. None when
/// the Mac has no network address. The UDP socket only picks the address; it sends nothing.
fn loopback_only(port: u16) -> Option<bool> {
  let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
  socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).ok()?;
  let address = socket.local_addr().ok()?.ip();
  if address.is_unspecified() || address.is_loopback() {
    return None;
  }
  Some(TcpStream::connect_timeout(&SocketAddr::new(address, port), Duration::from_millis(500)).is_err())
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Sent {
  ok: bool,
  /// `sent`, or why not: `bridge_stopped`, `not_linked`, `refused`, `unconfirmed`.
  message: String,
}

fn sent(ok: bool, message: &str) -> Sent {
  Sent { ok, message: message.to_string() }
}

fn send(port: u16, token: &str, recipient: &str, text: &str, media: Option<&Path>, timeout: Duration) -> Sent {
  let media_path = media.map(|path| path.display().to_string()).unwrap_or_default();
  let body = json!({ "recipient": recipient, "message": text, "media_path": media_path });
  match post(port, Some(token), "/api/send", &body, timeout) {
    Answer::NotConnected => sent(false, "bridge_stopped"),
    // It may have gone out: the user checks WhatsApp before trying again, Tresso never sends it twice by itself.
    Answer::Lost => sent(false, "unconfirmed"),
    Answer::Reply { status, body } => {
      let answer: Option<Value> = serde_json::from_str(&body).ok();
      if status == 200 && answer.as_ref().and_then(|answer| answer["success"].as_bool()) == Some(true) {
        return sent(true, "sent");
      }
      let said = answer.as_ref().and_then(|answer| answer["message"].as_str()).map_or(body.trim(), |message| message);
      if said.contains("Not connected") {
        sent(false, "not_linked")
      } else {
        // The bridge's answer can quote the recipient or a file path: only the status goes to the log.
        log::warn!("The WhatsApp bridge refused a message ({status})");
        sent(false, "refused")
      }
    }
  }
}

// ----------------------------------------------------------------------------------------------------------------
// Folders and files.

/// The canonical path, when it exists and stays inside `base` (canonical) after every link is followed.
fn inside(base: &Path, path: &Path) -> Option<PathBuf> {
  let canonical = path.canonicalize().ok()?;
  canonical.starts_with(base).then_some(canonical)
}

fn executable(path: &Path) -> bool {
  let Ok(metadata) = fs::metadata(path) else {
    return false;
  };
  #[cfg(unix)]
  let runs = {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
  };
  #[cfg(not(unix))]
  let runs = true;
  metadata.is_file() && runs
}

/// The bridge next to the running executable: `Contents/MacOS/whatsapp-bridge` in the app bundle, `target/<profile>/`
/// in a dev build (Tauri's build script copies the sidecar there). Nothing else is ever looked at.
fn bundled_binary(executable: &Path) -> Option<PathBuf> {
  let dir = executable.canonicalize().ok()?.parent()?.to_path_buf();
  Some(dir.join(BINARY))
}

/// `<data>/whatsapp/<user id>`, for a user id that can only name one folder there.
fn store_dir(data_dir: &Path, user_id: &str) -> Result<PathBuf, String> {
  if !valid_user_id(user_id) {
    return Err(format!("\"{user_id}\" is not a valid user id."));
  }
  Ok(data_dir.join(STORES_DIR).join(user_id))
}

/// A folder Tresso keeps for itself, only this user may open: made 0700 when it is not there; when it is, it must be a
/// folder (not a link) of this user, and its rights are set to 0700 again.
fn private_folder(path: &Path) -> io::Result<()> {
  match fs::symlink_metadata(path) {
    Ok(metadata) => {
      if !metadata.is_dir() {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "not a folder"));
      }
      #[cfg(unix)]
      {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: geteuid has no preconditions and cannot fail.
        if metadata.uid() != unsafe { libc::geteuid() } {
          return Err(io::Error::new(io::ErrorKind::PermissionDenied, "the folder belongs to another user"));
        }
        if metadata.mode() & 0o777 != 0o700 {
          fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        }
      }
      Ok(())
    }
    Err(error) if error.kind() == io::ErrorKind::NotFound => {
      let mut builder = fs::DirBuilder::new();
      #[cfg(unix)]
      {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
      }
      builder.create(path)
    }
    Err(error) => Err(error),
  }
}

/// Makes the user's store (and the folder of stores) before the bridge starts, both 0700, and returns its path.
fn prepare_store(data_dir: &Path, user_id: &str) -> Result<PathBuf, String> {
  let store = store_dir(data_dir, user_id)?;
  fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
  private_folder(&data_dir.join(STORES_DIR)).map_err(|error| error.to_string())?;
  private_folder(&store).map_err(|error| error.to_string())?;
  Ok(store)
}

/// Removes a user's store with its linked session and messages. The path is built here from the user id; a link in
/// its place is removed as a link, never followed. Gone already is fine.
fn remove_store(data_dir: &Path, user_id: &str) -> Result<(), String> {
  let store = store_dir(data_dir, user_id)?;
  let removed = match fs::symlink_metadata(&store) {
    Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(&store),
    Ok(_) => fs::remove_file(&store),
    Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
    Err(error) => Err(error),
  };
  removed.map_err(|error| format!("Removing the WhatsApp data on this Mac failed: {error}"))
}

/// A file of the user's store, when it is there.
fn store_file(store: &Path, name: &str) -> Result<PathBuf, String> {
  let canonical = store.canonicalize().map_err(|_| code("no_store"))?;
  inside(&canonical, &store.join(name)).filter(|path| path.is_file()).ok_or_else(|| code("no_store"))
}

/// Writes a file only this user may read, replacing the old one at once (a write cut off leaves the old one).
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
  let partial = path.with_extension("part");
  let mut options = OpenOptions::new();
  options.write(true).create(true).truncate(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  let mut file = options.open(&partial)?;
  file.write_all(bytes)?;
  file.sync_all()?;
  fs::rename(&partial, path)
}

// ----------------------------------------------------------------------------------------------------------------
// The config, one file per Tresso user.

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
  Local,
  All,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
  mode: Mode,
  device_id: String,
  device_name: String,
  #[serde(default)]
  linked_at: Option<String>,
  /// Set once when WhatsApp is connected (that moment less 30 days); older messages are not brought in. The relay
  /// passes it unchanged on every start, so it never moves by itself.
  import_since: String,
  include_groups: bool,
  notify: bool,
  left_out: Vec<String>,
  /// The connection came from the whatsapp-mcp bridge of an earlier version: the phone has to be linked to Tresso's
  /// own bridge again. The web client clears it once the phone is linked.
  #[serde(default)]
  moved: bool,
}

/// Letters, digits, `-` and `_`, as the mail copies' names (sql.rs): a user id can never leave the data folder.
fn valid_user_id(user_id: &str) -> bool {
  !user_id.is_empty() && user_id.len() <= 128 && user_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// `^[0-9A-Za-z.:_-]+@(s\.whatsapp\.net|g\.us|lid)$`
fn valid_jid(jid: &str) -> bool {
  let Some((user, server)) = jid.split_once('@') else {
    return false;
  };
  matches!(server, "s.whatsapp.net" | "g.us" | "lid")
    && !user.is_empty()
    && user.len() <= 128
    && user.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '_' | '-'))
}

/// A phone number in digits, or a JID.
fn valid_recipient(recipient: &str) -> bool {
  (!recipient.is_empty() && recipient.len() <= 32 && recipient.bytes().all(|b| b.is_ascii_digit())) || valid_jid(recipient)
}

fn plain_text(text: &str, max: usize) -> bool {
  !text.trim().is_empty() && text.chars().count() <= max && !text.chars().any(char::is_control)
}

impl Config {
  fn validate(&self) -> Result<(), String> {
    if self.device_id.is_empty() || self.device_id.len() > 64 || !self.device_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
      return Err(code("The device id is not valid."));
    }
    if !plain_text(&self.device_name, 200) {
      return Err(code("The device name is not valid."));
    }
    if let Some(linked_at) = &self.linked_at
      && !valid_time(linked_at)
    {
      return Err(code("The link time is not valid."));
    }
    if !valid_time(&self.import_since) {
      return Err(code("The import date is not valid."));
    }
    if self.left_out.len() > MAX_LEFT_OUT || !self.left_out.iter().all(|jid| valid_jid(jid)) {
      return Err(code("The chats left out are not valid."));
    }
    Ok(())
  }
}

/// An ISO 8601 time as the web client writes it (`2026-11-12T13:48:14.000Z`): digits and `-:.TZ+` only.
fn valid_time(time: &str) -> bool {
  !time.is_empty() && time.len() <= 40 && time.chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | ':' | '.' | 'T' | 'Z' | '+'))
}

fn config_file(data_dir: &Path, user_id: &str) -> Result<PathBuf, String> {
  if !valid_user_id(user_id) {
    return Err(format!("\"{user_id}\" is not a valid user id."));
  }
  Ok(data_dir.join(format!("whatsapp-{user_id}.json")))
}

/// A config of an earlier version, which named the whatsapp-mcp folder its bridge ran from, as this version keeps it:
/// the folder is forgotten (nothing in it is touched), the link time goes (the phone has not linked to this bridge),
/// and `moved` asks the user to link the phone again. Everything else stays: the mode, the device id, the import date
/// and the chats left out, so the relay goes on where it was once the phone is linked again. None for any other config.
fn migrated(value: &Value) -> Option<Value> {
  let object = value.as_object()?;
  object.get("folder")?;
  let mut next = object.clone();
  next.remove("folder");
  next.insert("linkedAt".to_string(), Value::Null);
  next.insert("moved".to_string(), Value::Bool(true));
  Some(Value::Object(next))
}

fn load_config(data_dir: &Path, user_id: &str) -> Result<Option<Config>, String> {
  let file = config_file(data_dir, user_id)?;
  let bytes = match fs::read(&file) {
    Ok(bytes) => bytes,
    Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
    Err(error) => return Err(format!("Reading the WhatsApp settings failed: {error}")),
  };
  let damaged = |error: serde_json::Error| format!("The WhatsApp settings are damaged: {error}");
  let value: Value = serde_json::from_slice(&bytes).map_err(damaged)?;
  let Some(next) = migrated(&value) else {
    return serde_json::from_value(value).map(Some).map_err(damaged);
  };
  let config: Config = serde_json::from_value(next).map_err(damaged)?;
  // Saved at once, so the old folder's path is not kept anywhere.
  let bytes = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
  write_private(&file, &bytes).map_err(|error| format!("Saving the WhatsApp settings failed: {error}"))?;
  log::info!("Moved a WhatsApp connection of an earlier version to Tresso's own bridge; the phone links again");
  Ok(Some(config))
}

fn save_config(data_dir: &Path, user_id: &str, config: &Config) -> Result<(), String> {
  let file = config_file(data_dir, user_id)?;
  config.validate()?;
  let bytes = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
  fs::create_dir_all(data_dir).map_err(|error| format!("Saving the WhatsApp settings failed: {error}"))?;
  write_private(&file, &bytes).map_err(|error| format!("Saving the WhatsApp settings failed: {error}"))
}

/// The user ids that have a config here, from the file names (`whatsapp-<userId>.json`).
fn config_users(data_dir: &Path) -> Vec<String> {
  let Ok(entries) = fs::read_dir(data_dir) else {
    return Vec::new();
  };
  entries
    .flatten()
    .filter_map(|entry| {
      let name = entry.file_name();
      let user = name.to_str()?.strip_prefix("whatsapp-")?.strip_suffix(".json")?.to_string();
      valid_user_id(&user).then_some(user)
    })
    .collect()
}

/// Removes every other user's config but `user_id`'s (the user the server confirmed); returns the users whose config
/// went. Their stores stay, as their whatsapp-mcp folders did before: removing one would leave the device listed on a
/// phone nobody here can unlink, and logging another user's WhatsApp out because someone else signed in is not this
/// Mac's call. Their config is what connects them, and it is gone.
fn keep_only_config(data_dir: &Path, user_id: &str) -> Result<Vec<String>, String> {
  config_file(data_dir, user_id)?;
  let mut others: Vec<String> = config_users(data_dir).into_iter().filter(|user| user != user_id).collect();
  others.sort();
  for user in &others {
    match fs::remove_file(data_dir.join(format!("whatsapp-{user}.json"))) {
      Ok(()) => {}
      Err(error) if error.kind() == io::ErrorKind::NotFound => {}
      Err(error) => return Err(format!("Removing another user's WhatsApp settings failed: {error}")),
    }
  }
  Ok(others)
}

/// Removes a user's config and returns it (sign-out, a connect the server did not take). The store stays.
fn clear_config(data_dir: &Path, user_id: &str) -> Result<Option<Config>, String> {
  let file = config_file(data_dir, user_id)?;
  let old = load_config(data_dir, user_id).unwrap_or(None);
  match fs::remove_file(&file) {
    Ok(()) => {}
    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
    Err(error) => return Err(format!("Removing the WhatsApp settings failed: {error}")),
  }
  Ok(old)
}

/// Whether the user's store holds a linked session (a device in `whatsapp.db`).
fn has_session(store: &Path) -> bool {
  matches!(store_file(store, SESSION_DB).map(|db| identity(&db)), Ok(Ok(Some(_))))
}

/// What Disconnect did on WhatsApp's side.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Disconnected {
  /// The phone no longer lists this Mac: WhatsApp confirmed the log out, or nothing was linked. False when WhatsApp
  /// could not be reached in time; the store is removed all the same.
  unlinked: bool,
}

/// POST /api/logout with this run's token; true once the bridge answered that WhatsApp confirmed.
fn logout(port: u16, token: &str, timeout: Duration) -> bool {
  match post(port, Some(token), "/api/logout", &json!({}), timeout) {
    Answer::Reply { status: 200, body } => serde_json::from_str::<Value>(&body).ok().and_then(|answer| answer["success"].as_bool()) == Some(true),
    Answer::Reply { status, .. } => {
      log::warn!("The WhatsApp bridge could not log out ({status})");
      false
    }
    Answer::NotConnected | Answer::Lost => false,
  }
}

/// The files earlier versions kept in the app's data folder for the whatsapp-mcp folder: removed, so no path of it is
/// kept. Nothing they name is opened or touched.
fn forget_legacy_files(data_dir: &Path) {
  for name in LEGACY_FILES {
    match fs::remove_file(data_dir.join(name)) {
      Ok(()) => log::info!("Removed {name}, left by an earlier version"),
      Err(error) if error.kind() == io::ErrorKind::NotFound => {}
      Err(error) => log::warn!("Removing {name} failed: {error}"),
    }
  }
}

// ----------------------------------------------------------------------------------------------------------------
// The store, read only.

fn open_read_only(path: &Path) -> Result<Connection, String> {
  // Read only (no file is created, no journal written) and query_only on top. The store keeps a rollback journal,
  // which the bridge alone writes; a reader only takes a shared lock.
  let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(store_error)?;
  connection.busy_timeout(BUSY_TIMEOUT).map_err(store_error)?;
  connection.pragma_update(None, "query_only", true).map_err(store_error)?;
  Ok(connection)
}

/// `busy` when the bridge is writing (the caller skips this round), else the error.
fn store_error(error: rusqlite::Error) -> String {
  use rusqlite::ffi;
  match &error {
    rusqlite::Error::SqliteFailure(failure, _)
      if matches!(failure.code, ffi::ErrorCode::DatabaseBusy | ffi::ErrorCode::DatabaseLocked) || failure.extended_code == ffi::SQLITE_READONLY_ROLLBACK =>
    {
      code("busy")
    }
    _ => format!("Reading the WhatsApp store failed: {error}"),
  }
}

/// A row of the bridge's `messages` table (WP1's `BridgeRow`).
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRow {
  rowid: i64,
  id: String,
  chat_jid: String,
  chat_name: Option<String>,
  sender: String,
  text: String,
  /// Epoch milliseconds; null when the timestamp does not parse.
  sent_at: Option<i64>,
  from_me: bool,
  media_type: Option<String>,
  filename: Option<String>,
  file_length: Option<i64>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Rows {
  rows: Vec<BridgeRow>,
  max_rowid: i64,
  /// Names this store and its numbering: the file (device and inode), its schema version (which VACUUM raises, also
  /// when it keeps the file) and its first row. When it changes, a rowid cursor means nothing any more: the relay
  /// reads from 0 again. It also changes on a schema change that renumbers nothing, which only costs a read from 0.
  store_id: String,
}

fn text_of(value: rusqlite::types::ValueRef<'_>) -> Option<String> {
  match value {
    rusqlite::types::ValueRef::Text(text) => Some(String::from_utf8_lossy(text).into_owned()),
    _ => None,
  }
}

fn non_empty(text: Option<String>) -> Option<String> {
  text.filter(|text| !text.is_empty())
}

/// The rows after `after`, by rowid, and the highest rowid. A row the bridge stores again (`INSERT OR REPLACE`) gets a
/// rowid after every other one, also when it was the newest: SQLite picks the rowid before it removes the old row
/// (tested below), so a cursor never passes a row stored again. Only a deleted newest row frees its rowid, and the
/// bridge deletes none. VACUUM may number the rows anew (it raises the schema version), and a store made again does:
/// `store_id` changes for both. Text and file names are cut at 65536 characters (WhatsApp's own limit for a text).
fn read_rows(db: &Path, after: i64, limit: u32) -> Result<Rows, String> {
  let mut connection = open_read_only(db)?;
  let transaction = connection.transaction().map_err(store_error)?;
  let rows = {
    let mut statement = transaction
      .prepare(
        "SELECT m.rowid, m.id, m.chat_jid, m.sender, substr(m.content, 1, ?3), m.timestamp, m.is_from_me, m.media_type, substr(m.filename, 1, ?3), \
         m.file_length, substr(c.name, 1, ?3) FROM messages m LEFT JOIN chats c ON c.jid = m.chat_jid WHERE m.rowid > ?1 ORDER BY m.rowid LIMIT ?2",
      )
      .map_err(store_error)?;
    statement
      .query_map(params![after, limit, MAX_FIELD_CHARS], |row| {
        Ok(BridgeRow {
          rowid: row.get(0)?,
          id: text_of(row.get_ref(1)?).unwrap_or_default(),
          chat_jid: text_of(row.get_ref(2)?).unwrap_or_default(),
          sender: text_of(row.get_ref(3)?).unwrap_or_default(),
          text: text_of(row.get_ref(4)?).unwrap_or_default(),
          sent_at: text_of(row.get_ref(5)?).as_deref().and_then(parse_timestamp),
          from_me: matches!(row.get_ref(6)?, rusqlite::types::ValueRef::Integer(flag) if flag != 0),
          media_type: non_empty(text_of(row.get_ref(7)?)),
          filename: non_empty(text_of(row.get_ref(8)?)),
          file_length: match row.get_ref(9)? {
            rusqlite::types::ValueRef::Integer(length) => Some(length),
            _ => None,
          },
          chat_name: non_empty(text_of(row.get_ref(10)?)),
        })
      })
      .map_err(store_error)?
      .collect::<Result<Vec<_>, _>>()
      .map_err(store_error)?
  };
  let max_rowid = transaction.query_row("SELECT COALESCE(MAX(rowid), 0) FROM messages", [], |row| row.get(0)).map_err(store_error)?;
  let schema: i64 = transaction.query_row("PRAGMA schema_version", [], |row| row.get(0)).map_err(store_error)?;
  let first: Option<(i64, Option<String>, Option<String>)> = transaction
    .query_row("SELECT rowid, chat_jid, id FROM messages ORDER BY rowid LIMIT 1", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
    .optional()
    .map_err(store_error)?;
  transaction.commit().map_err(store_error)?;
  let file = file_id(db).map_err(|error| format!("Reading the WhatsApp store failed: {error}"))?;
  let store_id = match first {
    Some((rowid, chat, id)) => format!("{file}:{schema}:{rowid}:{}/{}", chat.unwrap_or_default(), id.unwrap_or_default()),
    None => format!("{file}:{schema}:0"),
  };
  Ok(Rows { rows, max_rowid, store_id })
}

/// The file's identity on its disk: device and inode (a store deleted and made again is another file).
fn file_id(path: &Path) -> io::Result<String> {
  let metadata = fs::metadata(path)?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::MetadataExt;
    Ok(format!("{}.{}", metadata.dev(), metadata.ino()))
  }
  #[cfg(not(unix))]
  {
    let created = metadata.created()?.duration_since(std::time::UNIX_EPOCH).map(|since| since.as_nanos()).unwrap_or_default();
    Ok(created.to_string())
  }
}

fn days_in_month(year: i64, month: i64) -> i64 {
  match month {
    2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
    2 => 28,
    4 | 6 | 9 | 11 => 30,
    _ => 31,
  }
}

/// Days since 1970-01-01 (Howard Hinnant's days_from_civil).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
  let year = if month <= 2 { year - 1 } else { year };
  let era = if year >= 0 { year } else { year - 399 } / 400;
  let year_of_era = year - era * 400;
  let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
  let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
  era * 146_097 + day_of_era - 719_468
}

/// `YYYY-MM-DD HH:MM:SS[.fraction](+|-)HH:MM` or with `Z` (go-sqlite3 writes a `time.Time` so, in the zone of the
/// moment) to epoch milliseconds; None for anything else.
fn parse_timestamp(text: &str) -> Option<i64> {
  let bytes = text.as_bytes();
  if bytes.len() < 20 || !text.is_ascii() {
    return None;
  }
  let number = |from: usize, to: usize| -> Option<i64> {
    let part = &text[from..to];
    part.bytes().all(|b| b.is_ascii_digit()).then(|| part.parse().ok()).flatten()
  };
  if bytes[4] != b'-' || bytes[7] != b'-' || !matches!(bytes[10], b' ' | b'T') || bytes[13] != b':' || bytes[16] != b':' {
    return None;
  }
  let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
  let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
  if !(1..=12).contains(&month) || !(1..=days_in_month(year, month)).contains(&day) || hour > 23 || minute > 59 || second > 59 {
    return None;
  }
  let mut rest = &text[19..];
  let mut millis = 0;
  if let Some(fraction) = rest.strip_prefix('.') {
    let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 || digits > 9 {
      return None;
    }
    millis = format!("{:0<3}", &fraction[..digits.min(3)]).parse::<i64>().ok()?;
    rest = &fraction[digits..];
  }
  let offset = if rest == "Z" {
    0
  } else {
    let sign = match rest.as_bytes().first() {
      Some(b'+') => 1,
      Some(b'-') => -1,
      _ => return None,
    };
    if rest.len() != 6 || rest.as_bytes()[3] != b':' {
      return None;
    }
    let (hours, minutes) = (rest[1..3].parse::<i64>().ok()?, rest[4..6].parse::<i64>().ok()?);
    if !rest[1..3].bytes().all(|b| b.is_ascii_digit()) || !rest[4..6].bytes().all(|b| b.is_ascii_digit()) || hours > 23 || minutes > 59 {
      return None;
    }
    sign * (hours * 60 + minutes)
  };
  let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset * 60;
  Some(seconds * 1000 + millis)
}

/// Whether the table exists with these columns. whatsmeow's schema is not ours: a table it lacks (`whatsmeow_lid_map`
/// came only in 2024) or changed is skipped, never an error.
fn has_table(connection: &Connection, table: &str, columns: &[&str]) -> Result<bool, String> {
  let exists: bool = connection
    .query_row("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)", [table], |row| row.get(0))
    .map_err(store_error)?;
  if !exists {
    return Ok(false);
  }
  let mut statement = connection.prepare("SELECT name FROM pragma_table_info(?1)").map_err(store_error)?;
  let present = statement.query_map([table], |row| row.get::<_, String>(0)).map_err(store_error)?.collect::<Result<HashSet<_>, _>>().map_err(store_error)?;
  Ok(columns.iter().all(|column| present.contains(*column)))
}

#[derive(Serialize, Debug, Default, PartialEq, Eq)]
pub struct Name {
  /// The phone number, digits only; null for an id that is not known to be one (a LID without a number).
  number: Option<String>,
  name: Option<String>,
}

/// Sender ids are the user part of a JID: digits, a phone number or a LID.
fn valid_sender_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_digit())
}

/// A phone number has at most 13 digits in practice (E.164 allows 15, no country uses them all); LIDs are longer. Only
/// used when no JID in either store says which one an id is.
fn looks_like_number(id: &str) -> bool {
  id.len() <= 13
}

/// Names and numbers for sender ids, from `whatsmeow_lid_map` (LID to phone number) and `whatsmeow_contacts` (full
/// name, else the name they gave themselves, else the business name) in the session store. Whether an id is a phone
/// number comes from a JID that holds it (its server part, `s.whatsapp.net` or `lid`): the LID map, a contact, else a
/// direct chat in the message store; only an id no JID names is judged by its length.
fn names(db: Option<&Path>, messages: Option<&Path>, ids: &[String]) -> Result<HashMap<String, Name>, String> {
  if ids.len() > MAX_IDS || !ids.iter().all(|id| valid_sender_id(id)) {
    return Err(code("The sender ids are not valid."));
  }
  let connection = match db {
    Some(db) => Some(open_read_only(db)?),
    None => None,
  };
  let (lids, contacts) = match &connection {
    Some(connection) => (
      has_table(connection, "whatsmeow_lid_map", &["lid", "pn"])?,
      has_table(connection, "whatsmeow_contacts", &["their_jid", "full_name", "push_name", "business_name"])?,
    ),
    None => (false, false),
  };
  let chats = match messages {
    Some(messages) => {
      let connection = open_read_only(messages)?;
      has_table(&connection, "chats", &["jid"])?.then_some(connection)
    }
    None => None,
  };
  let mut result = HashMap::new();
  for id in ids {
    let mut number = None;
    let mut known = false;
    if let Some(connection) = connection.as_ref().filter(|_| lids) {
      number = connection.query_row("SELECT pn FROM whatsmeow_lid_map WHERE lid = ?1", [id], |row| row.get::<_, String>(0)).optional().map_err(store_error)?;
      known = number.is_some();
      if !known && connection.query_row("SELECT 1 FROM whatsmeow_lid_map WHERE pn = ?1", [id], |_| Ok(())).optional().map_err(store_error)?.is_some() {
        number = Some(id.clone());
        known = true;
      }
    }
    let mut name = None;
    if let Some(connection) = connection.as_ref().filter(|_| contacts) {
      let mut jids = Vec::new();
      if let Some(number) = &number {
        jids.push((format!("{number}@s.whatsapp.net"), true));
      }
      jids.push((format!("{id}@s.whatsapp.net"), true));
      jids.push((format!("{id}@lid"), false));
      for (jid, is_number) in jids {
        let found: Option<(Option<String>, Option<String>, Option<String>)> = connection
          .query_row("SELECT full_name, push_name, business_name FROM whatsmeow_contacts WHERE their_jid = ?1 LIMIT 1", [&jid], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
          })
          .optional()
          .map_err(store_error)?;
        if let Some((full, push, business)) = found {
          name = [full, push, business].into_iter().flatten().map(|name| name.trim().to_string()).find(|name| !name.is_empty());
          if !known {
            number = is_number.then(|| id.clone());
            known = true;
          }
          break;
        }
      }
    }
    if !known && let Some(chats) = &chats {
      let server: Option<String> = chats
        .query_row(
          "SELECT substr(jid, length(?1) + 2) FROM chats WHERE jid IN (?1 || '@s.whatsapp.net', ?1 || '@lid') ORDER BY jid LIKE '%@s.whatsapp.net' DESC LIMIT 1",
          [id],
          |row| row.get(0),
        )
        .optional()
        .map_err(store_error)?;
      if let Some(server) = server {
        number = (server == "s.whatsapp.net").then(|| id.clone());
        known = true;
      }
    }
    if !known && looks_like_number(id) {
      number = Some(id.clone());
    }
    result.insert(id.clone(), Name { number: number.filter(|number| valid_sender_id(number)), name });
  }
  Ok(result)
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Identity {
  /// The linked account's phone number, digits only.
  number: String,
  name: Option<String>,
}

/// The linked account, from `whatsmeow_device` (`<number>:<device>@s.whatsapp.net`); None while nothing is linked.
fn identity(db: &Path) -> Result<Option<Identity>, String> {
  if !db.is_file() {
    return Ok(None);
  }
  let connection = open_read_only(db)?;
  if !has_table(&connection, "whatsmeow_device", &["jid", "push_name"])? {
    return Ok(None);
  }
  let row: Option<(Option<String>, Option<String>)> =
    connection.query_row("SELECT jid, push_name FROM whatsmeow_device LIMIT 1", [], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(store_error)?;
  let Some((Some(jid), push_name)) = row else {
    return Ok(None);
  };
  let number = jid.split([':', '@']).next().unwrap_or_default();
  if !valid_sender_id(number) {
    return Ok(None);
  }
  Ok(Some(Identity { number: number.to_string(), name: push_name.map(|name| name.trim().to_string()).filter(|name| !name.is_empty()) }))
}

// ----------------------------------------------------------------------------------------------------------------
// Downloads.

struct Media {
  kind: String,
  filename: Option<String>,
  sha256: Option<Vec<u8>>,
  length: Option<u64>,
}

fn media_of(db: &Path, message_id: &str, chat_jid: &str) -> Result<Media, String> {
  let connection = open_read_only(db)?;
  type MediaRow = (Option<String>, Option<String>, Option<Vec<u8>>, Option<i64>);
  let row: Option<MediaRow> = connection
    .query_row("SELECT media_type, filename, file_sha256, file_length FROM messages WHERE id = ?1 AND chat_jid = ?2", [message_id, chat_jid], |row| {
      Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })
    .optional()
    .map_err(store_error)?;
  let (kind, filename, sha256, length) = row.ok_or_else(|| code("not_found"))?;
  let kind = non_empty(kind).ok_or_else(|| code("not_media"))?;
  Ok(Media { kind, filename: non_empty(filename), sha256, length: length.and_then(|length| u64::try_from(length).ok()) })
}

fn valid_message_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn hex(bytes: &[u8]) -> String {
  bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The name a download gets: from the chat and message ids (never from the message), with the file's extension only
/// when it is a harmless one.
fn media_name(chat_jid: &str, message_id: &str, kind: &str, filename: Option<&str>) -> String {
  let stem = hex(&Sha256::digest(format!("{chat_jid}\n{message_id}").as_bytes())[..16]);
  let named = filename.and_then(|name| name.rsplit_once('.')).map(|(_, extension)| extension.to_ascii_lowercase()).filter(|extension| SAFE_EXTENSIONS.contains(&extension.as_str()));
  let extension = named.unwrap_or_else(|| {
    match kind {
      "image" => "jpg",
      "video" => "mp4",
      "audio" => "ogg",
      _ => "bin",
    }
    .to_string()
  });
  format!("{stem}.{extension}")
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Downloaded {
  path: String,
  /// The file's SHA-256 is the one the store holds. False only when the store holds none.
  verified: bool,
  /// Hex SHA-256 of the copy.
  sha256: String,
  /// Bytes of the copy.
  size: u64,
}

/// Whether a file name the store holds is one plain name. The bridge writes a download to `store/<chat>/<name>`, and a
/// document's name comes from whoever sent it: `../../Library/LaunchAgents/x.plist` would be written there.
fn plain_file_name(name: &str) -> bool {
  !name.is_empty()
    && name.len() <= 255
    && name != "."
    && name != ".."
    && !name.contains(['/', '\\', '\0'])
    && Path::new(name).file_name() == Some(std::ffi::OsStr::new(name))
}

/// The download folder, made only this user's (also when it existed with other rights).
fn media_folder(media_dir: &Path) -> io::Result<()> {
  fs::create_dir_all(media_dir)?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(media_dir, fs::Permissions::from_mode(0o700))?;
  }
  Ok(())
}

/// Marks a file as downloaded from the internet, as a browser does: Gatekeeper then checks whatever it holds before
/// anything in it runs, and apps open it with care.
#[cfg(target_os = "macos")]
fn quarantine(path: &Path) -> io::Result<()> {
  use std::os::unix::ffi::OsStrExt;
  let seconds = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|since| since.as_secs()).unwrap_or_default();
  let value = format!("0083;{seconds:x};Tresso;");
  let path = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
  // SAFETY: both strings end in NUL, and the value is valid for the length passed along.
  let result = unsafe { libc::setxattr(path.as_ptr(), c"com.apple.quarantine".as_ptr(), value.as_ptr().cast(), value.len(), 0, 0) };
  if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

#[cfg(not(target_os = "macos"))]
fn quarantine(_path: &Path) -> io::Result<()> {
  Ok(())
}

/// Copies the file the bridge reported into `media_dir`, checking it against the store's hash.
fn copy_verified(store: &Path, reported: &str, media_dir: &Path, media: &Media, chat_jid: &str, message_id: &str) -> Result<Downloaded, String> {
  let reported = Path::new(reported);
  if !reported.is_absolute() {
    return Err(code("refused"));
  }
  let source = inside(store, reported).filter(|path| path.is_file()).ok_or_else(|| code("refused"))?;
  let limit = media.length.filter(|length| *length > 0).unwrap_or(MAX_DOWNLOAD_BYTES).min(MAX_DOWNLOAD_BYTES);
  media_folder(media_dir).map_err(|error| format!("Creating the download folder failed: {error}"))?;
  let name = media_name(chat_jid, message_id, &media.kind, media.filename.as_deref());
  let target = media_dir.join(&name);
  // A name of its own per download, so two downloads of one message never write into one file.
  let mut suffix = [0u8; 8];
  getrandom::fill(&mut suffix).map_err(|error| format!("Saving the WhatsApp file failed: {error}"))?;
  let partial = media_dir.join(format!(".{name}.{}.part", hex(&suffix)));
  let copied = (|| -> io::Result<(Vec<u8>, u64)> {
    let mut input = File::open(&source)?.take(limit + 1);
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
      use std::os::unix::fs::OpenOptionsExt;
      options.mode(0o600);
    }
    let mut output = options.open(&partial)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut written = 0u64;
    loop {
      let read = input.read(&mut buffer)?;
      if read == 0 {
        break;
      }
      hasher.update(&buffer[..read]);
      output.write_all(&buffer[..read])?;
      written += read as u64;
    }
    output.sync_all()?;
    quarantine(&partial)?;
    Ok((hasher.finalize().to_vec(), written))
  })();
  let fail = |reason: String| {
    let _ = fs::remove_file(&partial);
    Err(reason)
  };
  let (digest, written) = match copied {
    Ok(copied) => copied,
    Err(error) => return fail(format!("Copying the WhatsApp file failed: {error}")),
  };
  if written > limit {
    return fail(code("too_large"));
  }
  let verified = match media.sha256.as_deref().filter(|hash| hash.len() == 32) {
    Some(expected) if expected != digest.as_slice() => return fail(code("mismatch")),
    Some(_) => true,
    None => false,
  };
  if let Err(error) = fs::rename(&partial, &target) {
    return fail(format!("Saving the WhatsApp file failed: {error}"));
  }
  Ok(Downloaded { path: target.display().to_string(), verified, sha256: hex(&digest), size: written })
}

fn download(port: u16, token: &str, store: &Path, media_dir: &Path, message_id: &str, chat_jid: &str, timeout: Duration) -> Result<Downloaded, String> {
  let media = media_of(&store_file(store, MESSAGES_DB)?, message_id, chat_jid)?;
  if !media.filename.as_deref().is_some_and(plain_file_name) {
    log::warn!("Refused to ask the WhatsApp bridge for a file whose stored name is not one plain name");
    return Err(code("refused"));
  }
  let reported = match post(port, Some(token), "/api/download", &json!({ "message_id": message_id, "chat_jid": chat_jid }), timeout) {
    Answer::NotConnected => return Err(code("bridge_stopped")),
    Answer::Lost => return Err(code("failed")),
    Answer::Reply { status, body } => {
      let answer: Option<Value> = serde_json::from_str(&body).ok();
      match answer.as_ref().filter(|answer| status == 200 && answer["success"].as_bool() == Some(true)).and_then(|answer| answer["path"].as_str()) {
        Some(path) => path.to_string(),
        None => {
          // The bridge's answer can name the file: only the status goes to the log.
          log::warn!("The WhatsApp bridge could not download a file ({status})");
          return Err(code("failed"));
        }
      }
    }
  };
  let store = store.canonicalize().map_err(|_| code("no_store"))?;
  copy_verified(&store, &reported, media_dir, &media, chat_jid, message_id)
}

/// Whether a name is one Tresso gives a download it may open: 32 hex digits and a harmless extension.
fn own_download_name(name: &str) -> bool {
  name.split_once('.').is_some_and(|(stem, extension)| {
    stem.len() == 32 && stem.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) && SAFE_EXTENSIONS.contains(&extension)
  })
}

/// A download the user may open: one of Tresso's own, directly in the app's download folder.
fn openable(media_dir: &Path, path: &str) -> Result<PathBuf, String> {
  let path = Path::new(path);
  let base = media_dir.canonicalize().map_err(|_| code("refused"))?;
  if !path.is_absolute() {
    return Err(code("refused"));
  }
  inside(&base, path)
    .filter(|path| path.is_file() && path.parent() == Some(base.as_path()) && path.file_name().and_then(|name| name.to_str()).is_some_and(own_download_name))
    .ok_or_else(|| code("refused"))
}


// ----------------------------------------------------------------------------------------------------------------
// Commands.

fn supported() -> Result<(), String> {
  if cfg!(target_os = "macos") { Ok(()) } else { Err(code(UNSUPPORTED)) }
}

fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
  app.path().app_data_dir().map_err(|error| format!("The app's data folder is not known: {error}"))
}

/// Connects the bridge state to the app: its data folder, the bundled binary and the event.
pub fn setup<R: Runtime>(app: &AppHandle<R>) {
  let Ok(dir) = data_dir(app) else {
    return;
  };
  let handle = app.clone();
  let bridge = app.state::<Bridge>();
  let binary = std::env::current_exe().ok().and_then(|executable| bundled_binary(&executable));
  bridge.connect(
    dir.clone(),
    binary,
    Arc::new(move |snapshot: &Snapshot| {
      let _ = handle.emit(EVENT, snapshot);
    }),
  );
  // Read once: a change takes effect at the next launch, never halfway through a session.
  bridge.0.switched_on.get_or_init(|| turned_on(std::env::var_os(ENABLE_ENV), enabled_by_default()));
  // Files staged by an earlier run were never sent, or were sent and not removed: none is sent from here on.
  let _ = fs::remove_dir_all(dir.join(OUTBOX_DIR));
  // Also with WhatsApp off: an earlier version's list of whatsapp-mcp folders is not kept.
  forget_legacy_files(&dir);
}

/// The app quits: the bridge it started stops with it.
pub fn stop_on_exit<R: Runtime>(app: &AppHandle<R>) {
  app.state::<Bridge>().stop();
  // Files staged for replies are not sent after a quit: they go now, not only at the next launch.
  if let Ok(dir) = data_dir(app) {
    let _ = fs::remove_dir_all(dir.join(OUTBOX_DIR));
  }
}

/// The user signed out (or the sign-in ended): the bridge started for them stops. Off the caller's thread, since a
/// bridge may take its grace time. Their config and store go with `whatsapp_config_clear`, which the web client calls
/// at a sign-out (not when a session only expired).
pub fn signed_out<R: Runtime>(app: &AppHandle<R>) {
  let shared = Arc::clone(&app.state::<Bridge>().0);
  thread::spawn(move || Bridge(shared).signed_out());
}

/// The `defaults` key and the environment variable that turn WhatsApp on (see the top of this file).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const ENABLE_DEFAULT: &str = "EnableWhatsApp";
pub const ENABLE_ENV: &str = "TRESSO_ENABLE_WHATSAPP";

/// On when the `defaults` key says so, or the variable is set to anything but empty or `0`.
fn turned_on(env: Option<std::ffi::OsString>, by_default: bool) -> bool {
  by_default || env.is_some_and(|value| !value.is_empty() && value != "0")
}

#[cfg(target_os = "macos")]
fn enabled_by_default() -> bool {
  use objc2_foundation::{NSString, NSUserDefaults};
  NSUserDefaults::standardUserDefaults().boolForKey(&NSString::from_str(ENABLE_DEFAULT))
}

#[cfg(not(target_os = "macos"))]
fn enabled_by_default() -> bool {
  false
}

/// WhatsApp can be used: on macOS, once it was turned on; else every command answers `unsupported`.
fn enabled_with(supported: bool, switched_on: bool) -> Result<(), String> {
  if supported && switched_on { Ok(()) } else { Err(code(UNSUPPORTED)) }
}

#[tauri::command]
pub fn whatsapp_available(bridge: State<'_, Bridge>) -> bool {
  bridge.enabled().is_ok()
}

#[derive(Serialize)]
pub struct Device {
  name: String,
}

#[cfg(target_os = "macos")]
fn computer_name() -> Option<String> {
  let output = Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"]).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
  output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(not(target_os = "macos"))]
fn computer_name() -> Option<String> {
  None
}

#[cfg(unix)]
fn host_name() -> Option<String> {
  let mut buffer = vec![0u8; 256];
  // SAFETY: the buffer is valid for its length, which is passed along.
  if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } != 0 {
    return None;
  }
  let end = buffer.iter().position(|byte| *byte == 0).unwrap_or(buffer.len());
  Some(String::from_utf8_lossy(&buffer[..end]).into_owned())
}

#[cfg(not(unix))]
fn host_name() -> Option<String> {
  None
}

fn device_name(computer: Option<String>, host: Option<String>) -> Option<String> {
  [computer, host]
    .into_iter()
    .flatten()
    .map(|name| name.chars().filter(|c| !c.is_control()).take(200).collect::<String>().trim().to_string())
    .find(|name| !name.is_empty())
}

#[tauri::command(async)]
pub fn whatsapp_device(bridge: State<'_, Bridge>) -> Result<Device, String> {
  bridge.enabled()?;
  device_name(computer_name(), host_name()).map(|name| Device { name }).ok_or_else(|| code("This computer's name is not known."))
}

#[tauri::command(async)]
pub fn whatsapp_config_load<R: Runtime>(app: AppHandle<R>, bridge: State<'_, Bridge>, user_id: String) -> Result<Option<Config>, String> {
  bridge.enabled()?;
  load_config(&data_dir(&app)?, &user_id)
}

#[tauri::command(async)]
pub fn whatsapp_config_save<R: Runtime>(app: AppHandle<R>, bridge: State<'_, Bridge>, user_id: String, config: Config) -> Result<(), String> {
  bridge.enabled()?;
  save_config(&data_dir(&app)?, &user_id, &config)
}

/// Signing out, or a connect the server did not take: the bridge running for this user stops and their config goes.
/// The store, with its link to the phone, stays for the next connect.
#[tauri::command(async)]
pub fn whatsapp_config_clear<R: Runtime>(app: AppHandle<R>, bridge: State<'_, Bridge>, user_id: String) -> Result<(), String> {
  bridge.enabled()?;
  let data_dir = data_dir(&app)?;
  config_file(&data_dir, &user_id)?;
  bridge.stop_for(&user_id);
  clear_config(&data_dir, &user_id)?;
  Ok(())
}

/// Disconnect WhatsApp: the device is logged out on WhatsApp's side first, then the bridge stops and the config and the
/// store go (`Bridge::disconnect`).
#[tauri::command(async)]
pub fn whatsapp_disconnect(bridge: State<'_, Bridge>, user_id: String) -> Result<Disconnected, String> {
  bridge.enabled()?;
  bridge.disconnect(&user_id)
}

/// The server confirmed who is signed in (where the mail copies of other users are removed): every other user's config
/// goes, and a bridge Tresso started for another user stops first. Their stores stay (`keep_only_config`). The shell holds the tokens but not who they
/// belong to, so the user id comes from the web client, which asked the server.
#[tauri::command(async)]
pub fn whatsapp_config_keep_only<R: Runtime>(app: AppHandle<R>, bridge: State<'_, Bridge>, user_id: String) -> Result<(), String> {
  bridge.enabled()?;
  let data_dir = data_dir(&app)?;
  config_file(&data_dir, &user_id)?;
  if let Some(running) = bridge.user()
    && running != user_id
  {
    bridge.stop_for(&running);
  }
  keep_only_config(&data_dir, &user_id)?;
  Ok(())
}

/// Starts the bridge on the user's store (made first); one that runs for this user already is kept.
#[tauri::command(async)]
pub fn whatsapp_start(bridge: State<'_, Bridge>, user_id: String) -> Result<Snapshot, String> {
  bridge.enabled()?;
  if !valid_user_id(&user_id) {
    return Err(format!("\"{user_id}\" is not a valid user id."));
  }
  Ok(bridge.start(&user_id))
}

#[tauri::command(async)]
pub fn whatsapp_stop(bridge: State<'_, Bridge>) -> Result<Snapshot, String> {
  bridge.enabled()?;
  Ok(bridge.stop())
}

#[tauri::command]
pub fn whatsapp_state(bridge: State<'_, Bridge>) -> Result<Snapshot, String> {
  bridge.enabled()?;
  Ok(bridge.snapshot())
}

/// The account the bridge's store is linked to; null while nothing is linked or no bridge was started.
#[tauri::command(async)]
pub fn whatsapp_identity(bridge: State<'_, Bridge>) -> Result<Option<Identity>, String> {
  bridge.enabled()?;
  match bridge.store().and_then(|store| store_file(&store, SESSION_DB)) {
    Ok(db) => identity(&db),
    Err(_) => Ok(None),
  }
}

#[tauri::command(async)]
pub fn whatsapp_read(bridge: State<'_, Bridge>, after_rowid: i64, limit: u32) -> Result<Rows, String> {
  bridge.enabled()?;
  if after_rowid < 0 || !(1..=MAX_ROWS).contains(&limit) {
    return Err(format!("Read after a rowid of 0 or more, at most {MAX_ROWS} rows at a time."));
  }
  read_rows(&store_file(&bridge.store()?, MESSAGES_DB)?, after_rowid, limit)
}

#[tauri::command(async)]
pub fn whatsapp_names(bridge: State<'_, Bridge>, ids: Vec<String>) -> Result<HashMap<String, Name>, String> {
  bridge.enabled()?;
  let store = bridge.store().ok();
  let file = |name: &str| store.as_deref().and_then(|store| store_file(store, name).ok());
  names(file(SESSION_DB).as_deref(), file(MESSAGES_DB).as_deref(), &ids)
}

/// Checks a message before it goes to the bridge; the file must be one the user picked (or the relay staged).
fn checked_message(chosen_files: &HashSet<PathBuf>, recipient: &str, text: &str, media_path: Option<&str>) -> Result<Option<PathBuf>, String> {
  if !valid_recipient(recipient) {
    return Err(code("The recipient is not a phone number or a WhatsApp chat."));
  }
  if text.len() > MAX_TEXT_BYTES {
    return Err(code("The message is too long."));
  }
  let media = match media_path {
    None => None,
    Some(path) => {
      let canonical = Path::new(path).canonicalize().map_err(|_| code("The file to send is not there."))?;
      if !chosen_files.contains(&canonical) || !canonical.is_file() {
        return Err(code("Only a file chosen with Attach, or one a reply carries, can be sent."));
      }
      if fs::metadata(&canonical).map_err(|_| code("The file to send is not there."))?.len() > MAX_SEND_BYTES {
        return Err(code("too_large"));
      }
      Some(canonical)
    }
  };
  if text.trim().is_empty() && media.is_none() {
    return Err(code("The message is empty."));
  }
  Ok(media)
}

#[tauri::command(async)]
pub fn whatsapp_send(bridge: State<'_, Bridge>, recipient: String, text: String, media_path: Option<String>) -> Result<Sent, String> {
  bridge.enabled()?;
  let sendable: HashSet<PathBuf> = lock(&bridge.0.chosen_files).union(&lock(&bridge.0.staged_files)).cloned().collect();
  let media = checked_message(&sendable, &recipient, &text, media_path.as_deref())?;
  let snapshot = bridge.snapshot();
  match bridge.endpoint() {
    Some((port, token)) => Ok(send(port, &token, &recipient, &text, media.as_deref(), REQUEST_TIMEOUT)),
    None if snapshot.process == Process::Owned && snapshot.link != Link::Linked => Ok(sent(false, "not_linked")),
    None => Ok(sent(false, "bridge_stopped")),
  }
}

#[tauri::command(async)]
pub fn whatsapp_download<R: Runtime>(app: AppHandle<R>, bridge: State<'_, Bridge>, message_id: String, chat_jid: String) -> Result<Downloaded, String> {
  bridge.enabled()?;
  if !valid_message_id(&message_id) || !valid_jid(&chat_jid) {
    return Err(code("The message is not valid."));
  }
  let data_dir = data_dir(&app)?;
  let store = bridge.store()?;
  let (port, token) = bridge.endpoint().ok_or_else(|| code("bridge_stopped"))?;
  download(port, &token, &store, &data_dir.join(MEDIA_DIR), &message_id, &chat_jid, REQUEST_TIMEOUT)
}

#[tauri::command(async)]
pub fn whatsapp_open_file<R: Runtime>(app: AppHandle<R>, bridge: State<'_, Bridge>, path: String) -> Result<(), String> {
  bridge.enabled()?;
  let file = openable(&data_dir(&app)?.join(MEDIA_DIR), &path)?;
  tauri_plugin_opener::open_path(&file, None::<&str>).map_err(|error| format!("Opening the file failed: {error}"))
}

#[tauri::command(async)]
pub fn whatsapp_choose_file<R: Runtime>(app: AppHandle<R>, bridge: State<'_, Bridge>) -> Result<Option<ChosenFile>, String> {
  use tauri_plugin_dialog::DialogExt;
  bridge.enabled()?;
  let Some(picked) = app.dialog().file().set_title("Attach a file").blocking_pick_file() else {
    return Ok(None);
  };
  let file = picked.into_path().map_err(|error| error.to_string())?.canonicalize().map_err(|error| format!("The file cannot be used: {error}"))?;
  if !file.is_file() {
    return Err(code("Only a file can be attached."));
  }
  let chosen = chosen_file(&file)?;
  lock(&bridge.0.chosen_files).insert(file);
  Ok(Some(chosen))
}

/// The content of one of Tresso's own downloads, for the relay to hand to the server: at most `MAX_SEND_BYTES` (the
/// server takes no larger file), as raw bytes.
#[tauri::command(async)]
pub fn whatsapp_file<R: Runtime>(app: AppHandle<R>, bridge: State<'_, Bridge>, path: String) -> Result<tauri::ipc::Response, String> {
  bridge.enabled()?;
  let file = openable(&data_dir(&app)?.join(MEDIA_DIR), &path)?;
  read_limited(&file, MAX_SEND_BYTES).map(tauri::ipc::Response::new)
}

/// Stages a file a reply carries (the request's raw body), named in the `x-file-name` header, so `whatsapp_send` may
/// send it. Returns its path.
#[tauri::command(async)]
pub fn whatsapp_stage_file<R: Runtime>(app: AppHandle<R>, bridge: State<'_, Bridge>, request: tauri::ipc::Request<'_>) -> Result<String, String> {
  bridge.enabled()?;
  let tauri::ipc::InvokeBody::Raw(content) = request.body() else {
    return Err(code("Send the file as raw bytes."));
  };
  let name = request.headers().get(FILE_NAME_HEADER).and_then(|value| value.to_str().ok()).map(percent_decoded).ok_or_else(|| code("Name the file."))?;
  let staged = stage(&data_dir(&app)?.join(OUTBOX_DIR), &name?, content)?;
  let text = staged.to_str().ok_or_else(|| code("The file's name cannot be used."))?.to_string();
  lock(&bridge.0.staged_files).insert(staged);
  Ok(text)
}

/// Removes a staged file once it was sent (or could not be); one that is gone already is fine.
#[tauri::command(async)]
pub fn whatsapp_discard_file(bridge: State<'_, Bridge>, path: String) -> Result<(), String> {
  bridge.enabled()?;
  let path = PathBuf::from(path);
  let mut staged = lock(&bridge.0.staged_files);
  if !staged.remove(&path) {
    return Ok(());
  }
  discard(&path);
  Ok(())
}

/// Reads a whole file of at most `limit` bytes; `too_large` above it.
fn read_limited(file: &Path, limit: u64) -> Result<Vec<u8>, String> {
  let mut content = Vec::new();
  File::open(file).and_then(|opened| opened.take(limit + 1).read_to_end(&mut content)).map_err(|error| format!("Reading the WhatsApp file failed: {error}"))?;
  if content.len() as u64 > limit {
    return Err(code("too_large"));
  }
  Ok(content)
}

/// `%`-escapes of UTF-8 back to text; `refused` for a broken escape or bytes that are no UTF-8.
fn percent_decoded(value: &str) -> Result<String, String> {
  let bytes = value.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' {
      let pair = bytes.get(i + 1..i + 3).and_then(|pair| std::str::from_utf8(pair).ok()).and_then(|pair| u8::from_str_radix(pair, 16).ok()).ok_or_else(|| code("refused"))?;
      out.push(pair);
      i += 3;
    } else {
      out.push(bytes[i]);
      i += 1;
    }
  }
  String::from_utf8(out).map_err(|_| code("refused"))
}

/// The name a staged file gets: the last part of the given one, without control characters, direction overrides (as the
/// server strips them from every name) or leading dots, at most 200 bytes (cut at a character); `file` when nothing is
/// left. It is the name WhatsApp shows the recipient.
fn staged_name(name: &str) -> String {
  let last = name.rsplit(['/', '\\']).next().unwrap_or_default();
  let clean: String = last
    .chars()
    .filter(|c| !c.is_control() && !matches!(*c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'))
    .collect::<String>()
    .trim()
    .trim_start_matches('.')
    .to_string();
  let mut cut = String::new();
  for c in clean.chars() {
    if cut.len() + c.len_utf8() > 200 {
      break;
    }
    cut.push(c);
  }
  if cut.is_empty() { "file".to_string() } else { cut }
}

/// Writes `content` to `<outbox>/<random>/<name>` (folders 0700, the file 0600), at most `MAX_SEND_BYTES`.
fn stage(outbox: &Path, name: &str, content: &[u8]) -> Result<PathBuf, String> {
  if content.is_empty() {
    return Err(code("The file is empty."));
  }
  if content.len() as u64 > MAX_SEND_BYTES {
    return Err(code("too_large"));
  }
  let mut folder = [0u8; 16];
  getrandom::fill(&mut folder).map_err(|error| format!("Staging the file failed: {error}"))?;
  let dir = outbox.join(hex(&folder));
  let write = || -> io::Result<PathBuf> {
    media_folder(outbox)?;
    media_folder(&dir)?;
    let path = dir.join(staged_name(name));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
      use std::os::unix::fs::OpenOptionsExt;
      options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    file.write_all(content)?;
    file.sync_all()?;
    path.canonicalize()
  };
  write().map_err(|error| {
    let _ = fs::remove_dir_all(&dir);
    format!("Staging the file failed: {error}")
  })
}

/// Removes a staged file with its own folder.
fn discard(path: &Path) {
  let _ = fs::remove_file(path);
  if let Some(dir) = path.parent() {
    let _ = fs::remove_dir(dir);
  }
}

/// A file picked for Attach: its path and its size in bytes, so the sent reply can be matched to the bridge's later copy.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct ChosenFile {
  path: String,
  size: u64,
}

fn chosen_file(file: &Path) -> Result<ChosenFile, String> {
  let path = file.to_str().ok_or_else(|| code("The file's name cannot be used."))?.to_string();
  let size = fs::metadata(file).map_err(|error| format!("The file cannot be used: {error}"))?.len();
  Ok(ChosenFile { path, size })
}


#[cfg(test)]
mod tests {
  use super::*;
  use std::net::TcpListener;
  use std::sync::atomic::{AtomicU32, Ordering};

  /// A folder of its own per test, removed when the test ends.
  struct Temp(PathBuf);

  impl std::ops::Deref for Temp {
    type Target = Path;
    fn deref(&self) -> &Path {
      &self.0
    }
  }

  impl Drop for Temp {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  fn temp() -> Temp {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!("tresso-whatsapp-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    fs::create_dir_all(&dir).unwrap();
    Temp(dir.canonicalize().unwrap())
  }

  // ---- timestamps

  #[test]
  fn parses_the_stores_timestamps() {
    let base = 1_794_491_294_000; // 2026-11-12 13:48:14 UTC
    assert_eq!(parse_timestamp("2026-11-12 14:48:14+01:00"), Some(base));
    assert_eq!(parse_timestamp("2026-11-12 14:48:14.123456789+01:00"), Some(base + 123));
    assert_eq!(parse_timestamp("2026-11-12 14:48:14.5+01:00"), Some(base + 500));
    assert_eq!(parse_timestamp("2026-11-12 13:48:14Z"), Some(base));
    assert_eq!(parse_timestamp("2026-11-12T13:48:14+00:00"), Some(base));
    assert_eq!(parse_timestamp("2026-11-12 08:48:14-05:00"), Some(base));
    // Summer time: the offset changes, the moment is still right.
    assert_eq!(parse_timestamp("2026-07-01 10:00:00+02:00"), Some(1_782_892_800_000));
    assert_eq!(parse_timestamp("2026-03-29 03:59:59+02:00"), Some(1_774_749_599_000));
    assert_eq!(parse_timestamp("2024-02-29 12:00:00+00:00"), Some(1_709_208_000_000));
    assert_eq!(parse_timestamp("1969-12-31 23:59:59Z"), Some(-1000));
    for garbage in [
      "",
      "yesterday",
      "2026-11-12 14:48:14",
      "2026-11-12 14:48:14+0100",
      "2026-11-12 14:48:14.+01:00",
      "2026-11-12 14:48:14.1234567890+01:00",
      "2026-02-30 10:00:00+01:00",
      "2026-13-01 10:00:00+01:00",
      "2026-11-12 24:00:00+01:00",
      "2026-11-12 14:48:14+01:00 extra",
      "2026-11-12 14:48:14+1:000",
      "\u{ff12}026-11-12 14:48:14+01:00",
      "2026/11/12 14:48:14+01:00",
      "+026-11-12 14:48:14+01:00",
    ] {
      assert_eq!(parse_timestamp(garbage), None, "{garbage:?}");
    }
  }

  // ---- the store

  /// A messages.db with the bridge's schema (main.go, NewMessageStore).
  fn messages_db(dir: &Path) -> PathBuf {
    let path = dir.join(MESSAGES_DB);
    let connection = Connection::open(&path).unwrap();
    connection
      .execute_batch(
        "CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TIMESTAMP);
         CREATE TABLE IF NOT EXISTS messages (id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TIMESTAMP, is_from_me BOOLEAN,
           media_type TEXT, filename TEXT, url TEXT, media_key BLOB, file_sha256 BLOB, file_enc_sha256 BLOB, file_length INTEGER,
           PRIMARY KEY (id, chat_jid), FOREIGN KEY (chat_jid) REFERENCES chats(jid));
         INSERT INTO chats VALUES ('31612345678@s.whatsapp.net', 'Bram Visser', '2026-11-12 14:48:14+01:00');
         INSERT INTO chats VALUES ('120363000000000001@g.us', 'Family', '2026-11-12 14:50:00+01:00');",
      )
      .unwrap();
    type Row<'a> = (&'a str, &'a str, &'a str, &'a str, &'a str, i64, &'a str, &'a str, Option<i64>);
    let rows: [Row; 4] = [
      ("A1", "31612345678@s.whatsapp.net", "31612345678", "Can you bring the drill?", "2026-11-12 14:48:14+01:00", 0, "", "", None),
      ("A2", "31612345678@s.whatsapp.net", "31698765432", "Sure", "2026-11-12 14:49:00.250+01:00", 1, "", "", None),
      ("A3", "120363000000000001@g.us", "123456789012345", "", "not a time", 0, "image", "image_20261112_145000.jpg", Some(180_000)),
      ("A4", "99999@s.whatsapp.net", "99999", "No chat row", "2026-11-12 14:51:00Z", 0, "", "", None),
    ];
    for (id, chat, sender, content, timestamp, from_me, media_type, filename, length) in rows {
      // The bridge turns foreign keys on, so every message has its chat; A4 stands for a store changed by hand.
      connection.pragma_update(None, "foreign_keys", id != "A4").unwrap();
      connection
        .execute(
          "INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me, media_type, filename, file_length) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
          params![id, chat, sender, content, timestamp, from_me, media_type, filename, length],
        )
        .unwrap();
    }
    path
  }

  #[test]
  fn reads_rows_after_a_rowid_with_a_limit() {
    let dir = temp();
    let db = messages_db(&dir);
    let first = read_rows(&db, 0, 2).unwrap();
    assert_eq!(first.max_rowid, 4);
    assert_eq!(first.rows.iter().map(|row| row.rowid).collect::<Vec<_>>(), vec![1, 2]);
    assert_eq!(
      first.rows[0],
      BridgeRow {
        rowid: 1,
        id: "A1".into(),
        chat_jid: "31612345678@s.whatsapp.net".into(),
        chat_name: Some("Bram Visser".into()),
        sender: "31612345678".into(),
        text: "Can you bring the drill?".into(),
        sent_at: Some(1_794_491_294_000),
        from_me: false,
        media_type: None,
        filename: None,
        file_length: None,
      }
    );
    assert!(first.rows[1].from_me);
    assert_eq!(first.rows[1].sent_at, Some(1_794_491_340_250));

    let rest = read_rows(&db, 2, 500).unwrap();
    assert_eq!(rest.rows.len(), 2);
    let media = &rest.rows[0];
    assert_eq!((media.sent_at, media.media_type.as_deref(), media.filename.as_deref(), media.file_length), (None, Some("image"), Some("image_20261112_145000.jpg"), Some(180_000)));
    assert_eq!(media.chat_name.as_deref(), Some("Family"));
    // A message whose chat row is missing still comes, without a name.
    assert_eq!((rest.rows[1].id.as_str(), rest.rows[1].chat_name.as_deref()), ("A4", None));
    assert!(read_rows(&db, 4, 10).unwrap().rows.is_empty());
  }

  /// Reading leaves the user's store as it was: same bytes, no journal, no WAL, and no way to write through it.
  #[test]
  fn never_writes_into_the_store() {
    let dir = temp();
    let db = messages_db(&dir);
    let before = fs::read(&db).unwrap();
    read_rows(&db, 0, 500).unwrap();
    let connection = open_read_only(&db).unwrap();
    assert!(connection.execute("DELETE FROM messages", []).is_err());
    assert!(connection.execute_batch("PRAGMA journal_mode = WAL").is_err() || connection.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0)).unwrap() != "wal");
    drop(connection);
    assert_eq!(fs::read(&db).unwrap(), before);
    for suffix in ["-journal", "-wal", "-shm"] {
      assert!(!dir.join(format!("{MESSAGES_DB}{suffix}")).exists(), "{suffix} was created");
    }
    // A store that is not there is not created.
    assert!(open_read_only(&dir.join("missing.db")).is_err());
    assert!(!dir.join("missing.db").exists());
  }

  #[test]
  fn a_busy_store_skips_the_round() {
    let dir = temp();
    let db = messages_db(&dir);
    let writer = Connection::open(&db).unwrap();
    writer.execute_batch("BEGIN EXCLUSIVE").unwrap();
    assert_eq!(read_rows(&db, 0, 10), Err("busy".to_string()));
    writer.execute_batch("ROLLBACK").unwrap();
    assert_eq!(read_rows(&db, 0, 10).unwrap().rows.len(), 4);
  }

  /// A whatsapp.db with whatsmeow's tables (only the columns read), with or without the LID map.
  fn session_db(dir: &Path, with_lid_map: bool) -> PathBuf {
    let path = dir.join(SESSION_DB);
    let connection = Connection::open(&path).unwrap();
    connection
      .execute_batch(
        "CREATE TABLE whatsmeow_device (jid TEXT PRIMARY KEY, push_name TEXT NOT NULL DEFAULT '');
         CREATE TABLE whatsmeow_contacts (our_jid TEXT, their_jid TEXT, first_name TEXT, full_name TEXT, push_name TEXT, business_name TEXT,
           PRIMARY KEY (our_jid, their_jid));
         INSERT INTO whatsmeow_device VALUES ('31698765432:12@s.whatsapp.net', 'Kim Visser');
         INSERT INTO whatsmeow_contacts VALUES ('31698765432@s.whatsapp.net', '31611111111@s.whatsapp.net', 'Bram', 'Bram Visser', 'Bram', '');
         INSERT INTO whatsmeow_contacts VALUES ('31698765432@s.whatsapp.net', '31622222222@s.whatsapp.net', NULL, NULL, 'Joost', NULL);
         INSERT INTO whatsmeow_contacts VALUES ('31698765432@s.whatsapp.net', '31633333333@s.whatsapp.net', NULL, 'Mom', NULL, NULL);
         INSERT INTO whatsmeow_contacts VALUES ('31698765432@s.whatsapp.net', '987654321098765@lid', NULL, '', 'Lid Person', NULL);",
      )
      .unwrap();
    if with_lid_map {
      connection
        .execute_batch(
          "CREATE TABLE whatsmeow_lid_map (lid TEXT PRIMARY KEY, pn TEXT UNIQUE NOT NULL);
           INSERT INTO whatsmeow_lid_map VALUES ('123456789012345', '31633333333');",
        )
        .unwrap();
    }
    path
  }

  fn name(number: Option<&str>, name: Option<&str>) -> Name {
    Name { number: number.map(str::to_string), name: name.map(str::to_string) }
  }

  #[test]
  fn names_senders_from_contacts_and_the_lid_map() {
    let dir = temp();
    let db = session_db(&dir, true);
    let ids: Vec<String> = ["31611111111", "31622222222", "123456789012345", "987654321098765", "31644444444", "111122223333444"].map(str::to_string).to_vec();
    let found = names(Some(&db), None, &ids).unwrap();
    assert_eq!(found["31611111111"], name(Some("31611111111"), Some("Bram Visser")));
    assert_eq!(found["31622222222"], name(Some("31622222222"), Some("Joost")));
    assert_eq!(found["123456789012345"], name(Some("31633333333"), Some("Mom")));
    assert_eq!(found["987654321098765"], name(None, Some("Lid Person")));
    assert_eq!(found["31644444444"], name(Some("31644444444"), None));
    assert_eq!(found["111122223333444"], name(None, None));

    // Without the LID map (whatsmeow before 2024) a LID has no number; contacts still name people.
    let old = temp();
    let db = session_db(&old, false);
    let found = names(Some(&db), None, &["123456789012345".to_string(), "31611111111".to_string()]).unwrap();
    assert_eq!(found["123456789012345"], name(None, None));
    assert_eq!(found["31611111111"], name(Some("31611111111"), Some("Bram Visser")));

    // No session store at all, and ids that are not ids.
    assert_eq!(names(None, None, &["31655555555".to_string()]).unwrap()["31655555555"], name(Some("31655555555"), None));
    assert!(names(Some(&db), None, &["abc".to_string()]).is_err());
    assert!(names(Some(&db), None, &["1@s.whatsapp.net".to_string()]).is_err());
    assert!(names(Some(&db), None, &vec!["1".to_string(); MAX_IDS + 1]).is_err());
  }

  #[test]
  fn reads_the_linked_account() {
    let dir = temp();
    let db = session_db(&dir, true);
    assert_eq!(identity(&db).unwrap(), Some(Identity { number: "31698765432".into(), name: Some("Kim Visser".into()) }));
    Connection::open(&db).unwrap().execute_batch("DELETE FROM whatsmeow_device").unwrap();
    assert_eq!(identity(&db).unwrap(), None);
    Connection::open(&db).unwrap().execute_batch("DROP TABLE whatsmeow_device").unwrap();
    assert_eq!(identity(&db).unwrap(), None);
    assert_eq!(identity(&dir.join("missing.db")).unwrap(), None);
  }


  // ---- the bridge's events

  #[test]
  fn reads_each_event_the_bridge_sends() {
    assert_eq!(parse_event(r#"{"v":1,"event":"qr","qr":"2@abc,def,ghi,jkl"}"#), Some(Event::Qr("2@abc,def,ghi,jkl".into())));
    assert_eq!(parse_event(r#"{"v":1,"event":"qr_timeout"}"#), Some(Event::QrTimeout));
    assert_eq!(parse_event(r#"{"v":1,"event":"linked"}"#), Some(Event::Linked));
    assert_eq!(parse_event(r#"{"v":1,"event":"connected"}"#), Some(Event::Connected));
    assert_eq!(parse_event(r#"{"v":1,"event":"disconnected"}"#), Some(Event::Disconnected));
    assert_eq!(parse_event(r#"{"v":1,"event":"listening","port":8741}"#), Some(Event::Listening(8741)));
    assert_eq!(parse_event(r#"{"v":1,"event":"logged_out"}"#), Some(Event::LoggedOut));
    assert_eq!(parse_event(r#"{"event":"connected","v":1}"#), Some(Event::Connected), "the order of the fields does not matter");
    assert_eq!(parse_event(r#"{"v":1,"event":"fatal","code":"bad_store"}"#), Some(Event::Fatal(Fatal::BadStore)));
    assert_eq!(parse_event(r#"{"v":1,"event":"fatal","code":"something_new"}"#), Some(Event::Fatal(Fatal::Other)));
  }

  #[test]
  fn ignores_every_line_that_is_not_a_known_event_of_version_1() {
    for line in [
      "",
      "Scan this QR code with your WhatsApp app:",
      "[2026-11-12 14:48:14] \u{2190} 31612345678: hi",
      "null",
      "[]",
      r#""connected""#,
      r#"{"event":"connected"}"#,
      r#"{"v":2,"event":"connected"}"#,
      r#"{"v":"1","event":"connected"}"#,
      r#"{"v":1.5,"event":"connected"}"#,
      r#"{"v":1}"#,
      r#"{"v":1,"event":"Connected"}"#,
      r#"{"v":1,"event":"message"}"#,
      r#"{"v":1,"event":7}"#,
      // A message-like payload, as an event of its own or riding on a known one, is never taken.
      r#"{"v":1,"event":"message","chat":"31612345678@s.whatsapp.net","text":"Can you bring the drill?"}"#,
      r#"{"v":1,"event":"connected","text":"Can you bring the drill?"}"#,
      r#"{"v":1,"event":"qr","qr":"2@abc","sender":"31612345678"}"#,
      r#"{"v":1,"event":"listening","port":8741,"token":"secret"}"#,
      r#"{"v":1,"event":"qr"}"#,
      r#"{"v":1,"event":"qr","qr":""}"#,
      r#"{"v":1,"event":"qr","qr":"line\nbreak"}"#,
      r#"{"v":1,"event":"qr","qr":42}"#,
      r#"{"v":1,"event":"listening"}"#,
      r#"{"v":1,"event":"listening","port":0}"#,
      r#"{"v":1,"event":"listening","port":70000}"#,
      r#"{"v":1,"event":"listening","port":"8741"}"#,
      r#"{"v":1,"event":"fatal"}"#,
      r#"{"v":1,"event":"fatal","code":"Bad Store"}"#,
      r#"{"v":1,"event":"connected"} trailing"#,
    ] {
      assert_eq!(parse_event(line), None, "{line:?}");
    }
    let long = format!(r#"{{"v":1,"event":"qr","qr":"{}"}}"#, "a".repeat(MAX_QR_CHARS + 1));
    assert_eq!(parse_event(&long), None);
  }

  #[test]
  fn drops_a_line_longer_than_the_limit_and_reads_on() {
    let mut input = "a".repeat(50);
    input.push('\n');
    input.push_str(&"b".repeat(40));
    input.push_str("\nok\r\n \u{2580} \n");
    input.push_str(&"c".repeat(45));
    let mut lines = Vec::new();
    read_lines(io::Cursor::new(input), 40, |line| lines.push(line.to_string()));
    assert_eq!(lines, vec!["b".repeat(40), "ok".to_string(), " \u{2580} ".to_string()]);
  }

  /// An event longer than MAX_EVENT_BYTES (a padded `connected`) is dropped whole, and the next one is read.
  #[test]
  fn an_overlong_event_line_is_dropped() {
    let padded = format!(r#"{{"v":1,"event":"connected","pad":"{}"}}"#, "x".repeat(MAX_EVENT_BYTES));
    let input = format!("{padded}\n{{\"v\":1,\"event\":\"linked\"}}\n");
    let mut events = Vec::new();
    read_lines(io::Cursor::new(input), MAX_EVENT_BYTES, |line| events.extend(parse_event(line)));
    assert_eq!(events, vec![Event::Linked]);
  }

  /// The code is drawn here from the bridge's string: square, the quiet zone of four light modules on every side, and
  /// the three finder patterns where a QR code has them.
  #[test]
  fn draws_the_qr_code_with_its_quiet_zone() {
    let text = format!("2@{},{},{},{}", "A".repeat(160), "b".repeat(44), "c".repeat(44), "d".repeat(24));
    let rows = qr_rows(&text).unwrap();
    let size = rows.len();
    assert!(size > 2 * QUIET_ZONE + 21);
    assert!(rows.iter().all(|row| row.len() == size && row.bytes().all(|b| b == b'0' || b == b'1')));
    for index in 0..QUIET_ZONE {
      assert!(rows[index].bytes().all(|b| b == b'0') && rows[size - 1 - index].bytes().all(|b| b == b'0'));
      assert!(rows.iter().all(|row| row.as_bytes()[index] == b'0' && row.as_bytes()[size - 1 - index] == b'0'));
    }
    let finder = ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"];
    for (top, left) in [(QUIET_ZONE, QUIET_ZONE), (QUIET_ZONE, size - QUIET_ZONE - 7), (size - QUIET_ZONE - 7, QUIET_ZONE)] {
      for (offset, expected) in finder.iter().enumerate() {
        assert_eq!(&rows[top + offset][left..left + 7], *expected, "finder at {top},{left}");
      }
    }
    assert_ne!(qr_rows("2@other").unwrap(), rows);
  }

  #[test]
  fn names_a_failure_for_each_fatal_code() {
    let expected = [
      ("bad_port", Failure::Exited, true),
      ("bad_token", Failure::Exited, true),
      ("bad_store", Failure::Store, false),
      ("store_failed", Failure::Store, false),
      ("connect_failed", Failure::Offline, true),
      ("not_connected", Failure::Offline, true),
      ("pair_failed", Failure::PairFailed, false),
      ("client_outdated", Failure::Outdated, false),
      ("stream_replaced", Failure::Replaced, false),
      ("temporary_ban", Failure::Banned, false),
      ("listen_failed", Failure::Exited, true),
      ("server_failed", Failure::Exited, true),
      ("panic", Failure::Exited, true),
      ("added_later", Failure::Exited, true),
    ];
    for (code, failure, passing) in expected {
      let fatal = Fatal::of(code);
      assert_eq!((fatal.failure(), fatal.passing()), (failure, passing), "{code}");
    }
    // Every code the bridge's README names has its own variant.
    for code in ["bad_port", "bad_token", "bad_store", "store_failed", "connect_failed", "not_connected", "pair_failed", "client_outdated", "stream_replaced", "temporary_ban", "listen_failed", "server_failed", "panic"] {
      assert_ne!(Fatal::of(code), Fatal::Other, "{code}");
    }
    // The web client reads these names (platform/whatsapp.ts).
    let names: Vec<Value> = [Failure::Missing, Failure::Store, Failure::Offline, Failure::PairFailed, Failure::Outdated, Failure::Replaced, Failure::Banned, Failure::LoggedOut, Failure::Exited]
      .iter()
      .map(|failure| serde_json::to_value(failure).unwrap())
      .collect();
    assert_eq!(names, ["missing", "store", "offline", "pair_failed", "outdated", "replaced", "banned", "logged_out", "exited"].map(|name| json!(name)).to_vec());
  }

  /// Each event, as the fake bridge sends it, moves the state the web client sees as it should.
  #[cfg(unix)]
  #[test]
  fn maps_events_to_the_state() {
    let data = temp();
    let (bridge, seen) = watched(quick(), &data);
    let fake = fake_bridge(
      &data,
      &format!(
        "{STARTED}\nqr 2@first\nwait_for qr-seen\nqr 2@second\nwait_for second-seen\nsay '{{\"v\":1,\"event\":\"linked\"}}'\nsay '{{\"v\":1,\"event\":\"connected\"}}'\nwait_for linked-seen\nsay '{{\"v\":1,\"event\":\"disconnected\"}}'\n{SERVE}\n{UNTIL_STDIN_ENDS}"
      ),
    );
    bridge.connect(data.to_path_buf(), Some(fake), recorder(&seen));
    serve_as_bridge(&data, "u1");
    assert_eq!(bridge.start("u1").process, Process::Owned);
    let first = bridge.wait_until(|snapshot| snapshot.qr.is_some());
    assert_eq!((first.link, first.qr.clone()), (Link::WaitingForScan, qr_rows("2@first")));
    touch(&data, "u1", "qr-seen");
    bridge.wait_until(|snapshot| snapshot.qr == qr_rows("2@second"));
    touch(&data, "u1", "second-seen");
    let linked = bridge.wait_until(|snapshot| snapshot.link == Link::Linked);
    assert_eq!(linked.qr, None);
    touch(&data, "u1", "linked-seen");
    let running = bridge.wait_until(|snapshot| snapshot.port.is_some());
    assert_eq!(running, Snapshot { process: Process::Owned, port: running.port, loopback_only: Some(true), link: Link::Linked, qr: None, error: None });
    assert_eq!(running.port, Some(read_port(&data, "u1")));
    bridge.stop();
    assert_eq!(lock(&seen).last(), Some(&Snapshot::stopped(None)));
  }

  /// A fatal code that starting again cannot help ends the run with its failure and no restart; a passing one restarts
  /// until the crash window says stop, and then names the last one.
  #[cfg(unix)]
  #[test]
  fn a_fatal_code_ends_with_its_failure() {
    for (code, failure, starts_expected) in [
      ("bad_store", Failure::Store, 1),
      ("pair_failed", Failure::PairFailed, 1),
      ("client_outdated", Failure::Outdated, 1),
      ("stream_replaced", Failure::Replaced, 1),
      ("temporary_ban", Failure::Banned, 1),
      ("connect_failed", Failure::Offline, 3),
      ("panic", Failure::Exited, 3),
    ] {
      let data = temp();
      let (bridge, _) = watched(quick(), &data);
      let fake = fake_bridge(&data, &format!("{STARTED}\nsay '{{\"v\":1,\"event\":\"fatal\",\"code\":\"{code}\"}}'\nexit 1"));
      bridge.connect(data.to_path_buf(), Some(fake), Arc::new(|_: &Snapshot| {}));
      bridge.start("u1");
      assert_eq!(bridge.wait_until(|snapshot| snapshot.error.is_some()), Snapshot::stopped(Some(failure)), "{code}");
      thread::sleep(Duration::from_millis(300));
      assert_eq!(starts(&data, "u1"), starts_expected, "{code}");
    }
  }

  #[cfg(unix)]
  #[test]
  fn a_log_out_stops_and_waits_for_the_user() {
    let data = temp();
    let (bridge, seen) = watched(quick(), &data);
    let fake = fake_bridge(&data, &format!("{STARTED}\nsay '{{\"v\":1,\"event\":\"connected\"}}'\nsay '{{\"v\":1,\"event\":\"logged_out\"}}'\nexit 0"));
    bridge.connect(data.to_path_buf(), Some(fake), recorder(&seen));
    bridge.start("u1");
    let ended = bridge.wait_until(|snapshot| snapshot.process == Process::Stopped && snapshot.error.is_some());
    assert_eq!(ended, Snapshot { link: Link::Unlinked, ..Snapshot::stopped(Some(Failure::LoggedOut)) });
    assert!(lock(&seen).iter().any(|snapshot| snapshot.process == Process::Owned && snapshot.link == Link::Unlinked));
    thread::sleep(Duration::from_millis(300));
    assert_eq!(starts(&data, "u1"), 1);
  }

  #[cfg(unix)]
  #[test]
  fn a_code_nobody_scans_waits_for_the_user() {
    let data = temp();
    let (bridge, _) = watched(quick(), &data);
    let fake = fake_bridge(&data, &format!("{STARTED}\nqr 2@code\nsay '{{\"v\":1,\"event\":\"qr_timeout\"}}'\nexit 1"));
    bridge.connect(data.to_path_buf(), Some(fake), Arc::new(|_: &Snapshot| {}));
    bridge.start("u1");
    let ended = bridge.wait_until(|snapshot| snapshot.process == Process::Stopped && snapshot.link == Link::Unlinked);
    assert_eq!(ended, Snapshot { link: Link::Unlinked, ..Snapshot::stopped(None) });
    thread::sleep(Duration::from_millis(300));
    assert_eq!(starts(&data, "u1"), 1);
  }

  // ---- the process

  fn quick() -> Settings {
    Settings {
      grace: Duration::from_millis(500),
      poll: Duration::from_millis(20),
      first_backoff: Duration::from_millis(50),
      max_backoff: Duration::from_millis(200),
      crash_window: Duration::from_secs(30),
      unlink_wait: Duration::from_secs(2),
      logout_timeout: Duration::from_secs(2),
    }
  }

  fn recorder(seen: &Arc<Mutex<Vec<Snapshot>>>) -> Emit {
    let record = Arc::clone(seen);
    Arc::new(move |snapshot: &Snapshot| lock(&record).push(snapshot.clone()))
  }

  /// A bridge state on `data`, recording every state it publishes; the binary comes with `fake_bridge`.
  fn watched(settings: Settings, data: &Path) -> (Bridge, Arc<Mutex<Vec<Snapshot>>>) {
    let bridge = Bridge::new(settings);
    let seen = Arc::new(Mutex::new(Vec::new()));
    bridge.connect(data.to_path_buf(), None, recorder(&seen));
    (bridge, seen)
  }

  /// A shell script that stands in for the bridge, in a folder of its own next to the data folder. The helpers: `say`
  /// prints a line on stdout, `qr` a qr event, `wait_for` waits for a file in the store (the test's go-ahead).
  fn fake_bridge(data: &Path, body: &str) -> PathBuf {
    let dir = data.join("app");
    fs::create_dir_all(&dir).unwrap();
    let binary = dir.join(BINARY);
    let script = format!(
      "#!/bin/sh\nsay() {{ printf '%s\\n' \"$1\"; }}\nqr() {{ say \"{{\\\"v\\\":1,\\\"event\\\":\\\"qr\\\",\\\"qr\\\":\\\"$1\\\"}}\"; }}\n\
       wait_for() {{ while [ ! -e \"$1\" ]; do sleep 0.02; done; }}\n{body}\n"
    );
    fs::write(&binary, script).unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
    }
    binary
  }

  /// Notes the start (the script runs in the store) with what it got: arguments, folder, environment, port and token.
  const STARTED: &str = "echo \"$#\" > args\npwd -P > cwd\nenv | cut -d= -f1 | sort > env\nprintf %s \"$WHATSAPP_BRIDGE_PORT\" > port\n\
                         printf %s \"$WHATSAPP_BRIDGE_TOKEN\" > token\nprintf %s \"$WHATSAPP_BRIDGE_STORE\" > store\necho x >> starts";
  /// Waits for the test's server on the bridge's port (`serve_as_bridge` writes `serving`), then says it listens.
  const SERVE: &str = "wait_for serving\nsay \"{\\\"v\\\":1,\\\"event\\\":\\\"listening\\\",\\\"port\\\":$WHATSAPP_BRIDGE_PORT}\"";
  /// Runs until stdin ends, as the bridge does, and notes that it did.
  const UNTIL_STDIN_ENDS: &str = "cat > /dev/null\necho closed > stdin-closed\nexit 0";

  fn store_of(data: &Path, user: &str) -> PathBuf {
    store_dir(data, user).unwrap()
  }

  fn touch(data: &Path, user: &str, name: &str) {
    fs::write(store_of(data, user).join(name), b"").unwrap();
  }

  fn starts(data: &Path, user: &str) -> usize {
    fs::read_to_string(store_of(data, user).join("starts")).map(|text| text.lines().count()).unwrap_or(0)
  }

  fn read_port(data: &Path, user: &str) -> u16 {
    fs::read_to_string(store_of(data, user).join("port")).unwrap().parse().unwrap()
  }

  /// Serves as the bridge on the port the fake bridge got, once it started: 401 without its token, the bridge's answer
  /// with it. Writes `serving` into the store when it listens.
  fn serve_as_bridge(data: &Path, user: &str) -> Arc<Mutex<Vec<Request>>> {
    let store = store_of(data, user);
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&requests);
    thread::spawn(move || {
      while !store.join("token").exists() || !store.join("port").exists() {
        thread::sleep(Duration::from_millis(5));
      }
      let port: u16 = fs::read_to_string(store.join("port")).unwrap().parse().unwrap();
      let token = fs::read_to_string(store.join("token")).unwrap();
      let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).unwrap();
      fs::write(store.join("serving"), b"").unwrap();
      serve(listener, recorded, move |request| {
        if request.token.as_deref() != Some(token.as_str()) || !request.json {
          return http(401, "Unauthorized\n");
        }
        unprotected_answer(request)
      });
    });
    requests
  }

  #[cfg(unix)]
  #[test]
  fn starts_the_bundled_bridge_on_the_users_store_and_stops_it_by_closing_stdin() {
    let data = temp();
    let (bridge, seen) = watched(quick(), &data);
    let fake = fake_bridge(&data, &format!("{STARTED}\nsay '{{\"v\":1,\"event\":\"connected\"}}'\n{SERVE}\n{UNTIL_STDIN_ENDS}"));
    bridge.connect(data.to_path_buf(), Some(fake), recorder(&seen));
    let requests = serve_as_bridge(&data, "u1");

    assert_eq!(bridge.start("u1").process, Process::Owned);
    let running = bridge.wait_until(|snapshot| snapshot.port.is_some());
    let store = store_of(&data, "u1");
    assert_eq!(running.port, Some(read_port(&data, "u1")));
    assert_eq!(fs::read_to_string(store.join("args")).unwrap().trim(), "0");
    assert_eq!(PathBuf::from(fs::read_to_string(store.join("cwd")).unwrap().trim()), store.canonicalize().unwrap());
    assert_eq!(PathBuf::from(fs::read_to_string(store.join("store")).unwrap()), store);
    let token = fs::read_to_string(store.join("token")).unwrap();
    assert!(token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()), "{token}");
    // env_clear: HOME and TMPDIR, the port, the token and the store, and what the shell adds itself. No PATH, no proxy.
    let passed: HashSet<String> = fs::read_to_string(store.join("env")).unwrap().lines().map(str::to_string).collect();
    let allowed: HashSet<String> = ["HOME", "TMPDIR", "WHATSAPP_BRIDGE_PORT", "WHATSAPP_BRIDGE_TOKEN", "WHATSAPP_BRIDGE_STORE", "PWD", "OLDPWD", "SHLVL", "_"].map(str::to_string).into();
    assert!(passed.is_subset(&allowed), "{passed:?}");
    assert!(passed.contains("WHATSAPP_BRIDGE_TOKEN") && passed.contains("WHATSAPP_BRIDGE_STORE") && !passed.contains("PATH"));
    // The probe asked without the token first, and the token went to this bridge only.
    let requests = lock(&requests).clone();
    assert!(requests.iter().any(|request| request.token.is_none()));
    assert!(requests.iter().any(|request| request.token.as_deref() == Some(token.as_str())));
    // Never in a state the web view sees.
    assert!(lock(&seen).iter().all(|snapshot| !serde_json::to_string(snapshot).unwrap().contains(&token)));
    // Asking again for the same user keeps the running bridge.
    assert_eq!(bridge.start("u1").port, running.port);
    assert_eq!(starts(&data, "u1"), 1);

    let began = Instant::now();
    assert_eq!(bridge.stop(), Snapshot::stopped(None));
    // Stopped by the end of its stdin, well before SIGTERM would have been sent.
    assert!(store.join("stdin-closed").exists());
    assert!(began.elapsed() < Duration::from_millis(500), "{:?}", began.elapsed());
    assert_eq!(lock(&seen).last(), Some(&Snapshot::stopped(None)));
  }

  /// A bridge that ignores the end of its stdin gets SIGTERM, one that ignores that too SIGKILL.
  #[cfg(unix)]
  #[test]
  fn terminates_then_kills_a_bridge_that_does_not_stop() {
    for (script, least) in [("trap 'echo term > got-term; exit 0' TERM\nwhile :; do sleep 0.05; done", 500), ("trap '' TERM\nwhile :; do sleep 0.05; done", 1000)] {
      let data = temp();
      let (bridge, _) = watched(quick(), &data);
      let fake = fake_bridge(&data, &format!("{STARTED}\nexec < /dev/null\n{script}"));
      bridge.connect(data.to_path_buf(), Some(fake), Arc::new(|_: &Snapshot| {}));
      bridge.start("u1");
      while starts(&data, "u1") == 0 {
        thread::sleep(Duration::from_millis(10));
      }
      let began = Instant::now();
      assert_eq!(bridge.stop(), Snapshot::stopped(None));
      assert!(began.elapsed() >= Duration::from_millis(least), "{:?}", began.elapsed());
      assert_eq!(starts(&data, "u1"), 1);
    }
  }

  #[cfg(unix)]
  #[test]
  fn restarts_a_crashed_bridge_and_gives_up_after_three_exits() {
    let data = temp();
    let (bridge, _) = watched(quick(), &data);
    let fake = fake_bridge(&data, &format!("{STARTED}\necho \"$WHATSAPP_BRIDGE_TOKEN $WHATSAPP_BRIDGE_PORT\" >> runs\nexit 1"));
    bridge.connect(data.to_path_buf(), Some(fake), Arc::new(|_: &Snapshot| {}));
    bridge.start("u1");
    assert_eq!(bridge.wait_until(|snapshot| snapshot.error.is_some()), Snapshot::stopped(Some(Failure::Exited)));
    thread::sleep(Duration::from_millis(400));
    assert_eq!(starts(&data, "u1"), 3);
    // Every process got a token of its own.
    let runs: Vec<String> = fs::read_to_string(store_of(&data, "u1").join("runs")).unwrap().lines().map(str::to_string).collect();
    let tokens: HashSet<&str> = runs.iter().map(|run| run.split(' ').next().unwrap()).collect();
    assert_eq!(tokens.len(), 3, "{runs:?}");
  }

  /// A bridge that answers on its port without the token is not this bridge's contract: stopped, counted as a crash.
  #[cfg(unix)]
  #[test]
  fn stops_a_bridge_that_does_not_check_the_token() {
    let data = temp();
    let (bridge, _) = watched(quick(), &data);
    let fake = fake_bridge(&data, &format!("{STARTED}\n{SERVE}\ntrap 'echo term >> got-term; exit 0' TERM\nwhile :; do sleep 0.05; done"));
    bridge.connect(data.to_path_buf(), Some(fake), Arc::new(|_: &Snapshot| {}));
    let store = store_of(&data, "u1");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&requests);
    thread::spawn(move || {
      loop {
        while !store.join("port").exists() {
          thread::sleep(Duration::from_millis(5));
        }
        let port: u16 = fs::read_to_string(store.join("port")).unwrap().parse().unwrap();
        let _ = fs::remove_file(store.join("port"));
        let Ok(listener) = TcpListener::bind((Ipv4Addr::LOCALHOST, port)) else { continue };
        fs::write(store.join("serving"), b"").unwrap();
        serve(listener, Arc::clone(&recorded), unprotected_answer);
      }
    });
    bridge.start("u1");
    assert_eq!(bridge.wait_until(|snapshot| snapshot.error.is_some()), Snapshot::stopped(Some(Failure::Exited)));
    assert!(store_of(&data, "u1").join("got-term").exists());
    // No request with a token ever went to it.
    assert!(lock(&requests).iter().all(|request| request.token.is_none()));
  }

  /// The bridge is the file next to Tresso's executable; without one, nothing starts and the state says so.
  #[cfg(unix)]
  #[test]
  fn starts_only_the_bundled_binary() {
    let data = temp();
    let app = data.join("Tresso.app").join("Contents").join("MacOS");
    fs::create_dir_all(&app).unwrap();
    fs::write(app.join("tresso-desktop"), b"").unwrap();
    assert_eq!(bundled_binary(&app.join("tresso-desktop")), Some(app.canonicalize().unwrap().join(BINARY)));
    // Through a link to the executable, the bundle's own folder still.
    let link = data.join("tresso-link");
    std::os::unix::fs::symlink(app.join("tresso-desktop"), &link).unwrap();
    assert_eq!(bundled_binary(&link), Some(app.canonicalize().unwrap().join(BINARY)));

    let (bridge, _) = watched(quick(), &data);
    assert_eq!(bridge.start("u1"), Snapshot::stopped(Some(Failure::Missing)));
    bridge.connect(data.to_path_buf(), bundled_binary(&app.join("tresso-desktop")), Arc::new(|_: &Snapshot| {}));
    assert_eq!(bridge.start("u1"), Snapshot::stopped(Some(Failure::Missing)));
    // Not executable: not started either.
    fs::write(app.join(BINARY), b"#!/bin/sh\necho x >> /dev/null\n").unwrap();
    assert_eq!(bridge.start("u1"), Snapshot::stopped(Some(Failure::Missing)));
  }

  /// A store that cannot be made (a file in its place) is said, and nothing starts.
  #[cfg(unix)]
  #[test]
  fn a_store_that_cannot_be_made_stops_the_start() {
    let data = temp();
    let (bridge, _) = watched(quick(), &data);
    let fake = fake_bridge(&data, &format!("{STARTED}\n{UNTIL_STDIN_ENDS}"));
    bridge.connect(data.to_path_buf(), Some(fake), Arc::new(|_: &Snapshot| {}));
    fs::create_dir_all(data.join(STORES_DIR)).unwrap();
    fs::write(data.join(STORES_DIR).join("u1"), b"not a folder").unwrap();
    assert_eq!(bridge.start("u1"), Snapshot::stopped(Some(Failure::Store)));
  }

  #[cfg(unix)]
  #[test]
  fn starting_for_another_user_stops_the_first_bridge() {
    let data = temp();
    let (bridge, _) = watched(quick(), &data);
    let fake = fake_bridge(&data, &format!("{STARTED}\n{UNTIL_STDIN_ENDS}"));
    bridge.connect(data.to_path_buf(), Some(fake), Arc::new(|_: &Snapshot| {}));
    bridge.start("u1");
    while starts(&data, "u1") == 0 {
      thread::sleep(Duration::from_millis(10));
    }
    bridge.start("u2");
    assert!(store_of(&data, "u1").join("stdin-closed").exists());
    assert_eq!(bridge.store(), Ok(store_of(&data, "u2")));
    assert!(bridge.stop_for("u2"));
    assert!(!bridge.stop_for("u1"));
  }

  #[test]
  fn forgets_the_picked_files_and_the_store_at_sign_out() {
    let data = temp();
    let (bridge, _) = watched(quick(), &data);
    lock(&bridge.0.chosen_files).insert(data.join("photo.jpg"));
    *lock(&bridge.0.user) = Some("u1".into());
    assert!(bridge.store().is_ok());
    bridge.signed_out();
    assert!(lock(&bridge.0.chosen_files).is_empty());
    assert_eq!(bridge.store(), Err("no_store".to_string()));
  }

  // ---- the store on this Mac

  #[test]
  fn builds_the_store_path_from_a_valid_user_id_only() {
    let data = temp();
    assert_eq!(store_dir(&data, "0193a1b2-c3d4_7e5f"), Ok(data.join("whatsapp").join("0193a1b2-c3d4_7e5f")));
    for user in ["", "..", "../u1", "u.1", "a/b", "a\\b", "/etc", "~", "u1\0", "u 1", &"x".repeat(129)] {
      assert!(store_dir(&data, user).is_err(), "{user:?}");
      assert!(prepare_store(&data, user).is_err(), "{user:?}");
      assert!(remove_store(&data, user).is_err(), "{user:?}");
    }
    // Always one folder directly below the data folder's `whatsapp`.
    let path = store_dir(&data, "u1").unwrap();
    assert_eq!(path.parent(), Some(data.join(STORES_DIR).as_path()));
  }

  #[cfg(unix)]
  #[test]
  fn makes_the_store_private_before_the_bridge_starts() {
    use std::os::unix::fs::PermissionsExt;
    let data = temp();
    let store = prepare_store(&data, "u1").unwrap();
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!((mode(&data.join(STORES_DIR)), mode(&store)), (0o700, 0o700));
    // A folder of Tresso's own that lost its rights gets them back (the bridge refuses one others may open).
    fs::set_permissions(&store, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(data.join(STORES_DIR), fs::Permissions::from_mode(0o777)).unwrap();
    prepare_store(&data, "u1").unwrap();
    assert_eq!((mode(&data.join(STORES_DIR)), mode(&store)), (0o700, 0o700));
    // A link in its place is refused, never followed.
    let elsewhere = data.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    fs::set_permissions(&elsewhere, fs::Permissions::from_mode(0o755)).unwrap();
    std::os::unix::fs::symlink(&elsewhere, data.join(STORES_DIR).join("u2")).unwrap();
    assert!(prepare_store(&data, "u2").is_err());
    assert_eq!(mode(&elsewhere), 0o755);
  }

  /// Removing a store takes the user's own and nothing else: not another user's, not a folder a link points to, not the
  /// data folder around it. Clearing the config (sign-out) leaves the store.
  #[cfg(unix)]
  #[test]
  fn removes_only_tressos_own_store_of_that_user() {
    let data = temp();
    let mine = prepare_store(&data, "u1").unwrap();
    session_db(&mine, true);
    messages_db(&mine);
    fs::create_dir_all(mine.join("120363000000000001@g.us")).unwrap();
    fs::write(mine.join("120363000000000001@g.us").join("A3_photo.jpg"), b"x").unwrap();
    let theirs = prepare_store(&data, "u2").unwrap();
    session_db(&theirs, true);
    let outside = temp();
    fs::write(outside.join("keep.txt"), b"keep").unwrap();
    std::os::unix::fs::symlink(&*outside, mine.join("link")).unwrap();
    std::os::unix::fs::symlink(&*outside, data.join(STORES_DIR).join("u3")).unwrap();
    save_config(&data, "u1", &config()).unwrap();

    // Sign-out: the config goes, the store with its link stays.
    assert_eq!(clear_config(&data, "u1").unwrap(), Some(config()));
    assert!(mine.join(SESSION_DB).exists());
    assert!(has_session(&mine));

    remove_store(&data, "u1").unwrap();
    assert!(!mine.exists());
    assert!(theirs.join(SESSION_DB).exists());
    assert!(outside.join("keep.txt").exists());
    assert!(data.join(STORES_DIR).exists());
    // A link in a store's place goes as a link.
    remove_store(&data, "u3").unwrap();
    assert!(fs::symlink_metadata(data.join(STORES_DIR).join("u3")).is_err());
    assert!(outside.join("keep.txt").exists());
    // Gone already is fine.
    remove_store(&data, "u1").unwrap();
    assert_eq!(clear_config(&data, "u1").unwrap(), None);
    assert!(clear_config(&data, "../u2").is_err());
    assert!(theirs.exists());
  }

  /// Appends a line to `events` in the data folder: the test's and the fake bridge's steps, in order.
  fn note(data: &Path, line: &str) {
    let mut file = OpenOptions::new().create(true).append(true).open(data.join("events")).unwrap();
    writeln!(file, "{line}").unwrap();
  }

  fn events(data: &Path) -> Vec<String> {
    fs::read_to_string(data.join("events")).unwrap_or_default().lines().map(str::to_string).collect()
  }

  /// A fake bridge that notes its start and the end of its stdin in `events`, serves as the bridge once the test listens
  /// (`serve_logging_out`), and stops when stdin ends.
  fn logging_bridge(data: &Path) -> PathBuf {
    let events = data.join("events");
    let events = events.to_str().unwrap();
    fake_bridge(
      data,
      &format!("{STARTED}\necho started >> '{events}'\nsay '{{\"v\":1,\"event\":\"connected\"}}'\n{SERVE}\ncat > /dev/null\necho stdin-closed >> '{events}'\nexit 0"),
    )
  }

  /// Serves as the bridge on the fake's port, as `serve_as_bridge` does, and answers POST /api/logout with `answer`,
  /// noting it in `events`.
  fn serve_logging_out(data: &Path, user: &str, answer: Option<String>) {
    let store = store_of(data, user);
    let data = data.to_path_buf();
    thread::spawn(move || {
      while !store.join("token").exists() || !store.join("port").exists() {
        thread::sleep(Duration::from_millis(5));
      }
      let port: u16 = fs::read_to_string(store.join("port")).unwrap().parse().unwrap();
      let token = fs::read_to_string(store.join("token")).unwrap();
      let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).unwrap();
      fs::write(store.join("serving"), b"").unwrap();
      serve(listener, Arc::new(Mutex::new(Vec::new())), move |request| {
        if request.token.as_deref() != Some(token.as_str()) || !request.json {
          return http(401, "Unauthorized\n");
        }
        if request.path == "/api/logout" {
          note(&data, "logout");
          return answer.clone();
        }
        unprotected_answer(request)
      });
    });
  }

  /// Disconnect logs the device out through the running bridge first, then stops it, then removes the config and the
  /// store.
  #[cfg(unix)]
  #[test]
  fn disconnect_logs_out_then_stops_then_removes() {
    let data = temp();
    let (bridge, _) = watched(quick(), &data);
    bridge.connect(data.to_path_buf(), Some(logging_bridge(&data)), Arc::new(|_: &Snapshot| {}));
    let store = prepare_store(&data, "u1").unwrap();
    session_db(&store, true);
    save_config(&data, "u1", &config()).unwrap();
    serve_logging_out(&data, "u1", http(200, r#"{"success":true,"message":"Logged out"}"#));
    bridge.start("u1");
    bridge.wait_until(|snapshot| snapshot.port.is_some());

    assert_eq!(bridge.disconnect("u1"), Ok(Disconnected { unlinked: true }));
    assert_eq!(events(&data), ["started", "logout", "stdin-closed"]);
    assert!(!store.exists());
    assert_eq!(load_config(&data, "u1").unwrap(), None);
    assert_eq!(bridge.snapshot(), Snapshot::stopped(None));
    assert_eq!(bridge.store(), Err("no_store".to_string()));
  }

  /// A bridge that does not run is started for the log out only when the store holds a session; without one nothing
  /// starts and the store simply goes.
  #[cfg(unix)]
  #[test]
  fn disconnect_starts_the_bridge_only_to_log_out_a_session() {
    let data = temp();
    let (bridge, _) = watched(quick(), &data);
    bridge.connect(data.to_path_buf(), Some(logging_bridge(&data)), Arc::new(|_: &Snapshot| {}));
    let store = prepare_store(&data, "u1").unwrap();
    messages_db(&store);
    assert_eq!(bridge.disconnect("u1"), Ok(Disconnected { unlinked: true }));
    assert!(events(&data).is_empty(), "{:?}", events(&data));
    assert!(!store.exists());

    let store = prepare_store(&data, "u1").unwrap();
    session_db(&store, true);
    serve_logging_out(&data, "u1", http(200, r#"{"success":true,"message":"Logged out"}"#));
    assert_eq!(bridge.disconnect("u1"), Ok(Disconnected { unlinked: true }));
    assert_eq!(events(&data), ["started", "logout", "stdin-closed"]);
    assert!(!store.exists());
  }

  /// WhatsApp cannot be reached: the bridge does not come up, or the log out is refused. The store goes all the same,
  /// within the waits, and Disconnect says the phone may still list this Mac.
  #[cfg(unix)]
  #[test]
  fn disconnect_removes_the_store_when_whatsapp_cannot_be_reached() {
    // The bridge stops before it listens (connect_failed).
    let data = temp();
    let (bridge, _) = watched(quick(), &data);
    let fake = fake_bridge(&data, &format!("{STARTED}\nsay '{{\"v\":1,\"event\":\"fatal\",\"code\":\"connect_failed\"}}'\nexit 1"));
    bridge.connect(data.to_path_buf(), Some(fake), Arc::new(|_: &Snapshot| {}));
    let store = prepare_store(&data, "u1").unwrap();
    session_db(&store, true);
    save_config(&data, "u1", &config()).unwrap();
    let began = Instant::now();
    assert_eq!(bridge.disconnect("u1"), Ok(Disconnected { unlinked: false }));
    assert!(began.elapsed() < Duration::from_secs(5), "{:?}", began.elapsed());
    assert!(!store.exists());
    assert_eq!(load_config(&data, "u1").unwrap(), None);

    // The bridge runs, but WhatsApp does not confirm.
    let data = temp();
    let (bridge, _) = watched(quick(), &data);
    bridge.connect(data.to_path_buf(), Some(logging_bridge(&data)), Arc::new(|_: &Snapshot| {}));
    let store = prepare_store(&data, "u1").unwrap();
    session_db(&store, true);
    serve_logging_out(&data, "u1", http(504, r#"{"success":false,"message":"WhatsApp did not confirm the log out in time"}"#));
    assert_eq!(bridge.disconnect("u1"), Ok(Disconnected { unlinked: false }));
    assert_eq!(events(&data), ["started", "logout", "stdin-closed"]);
    assert!(!store.exists());

    // The bridge never answers within the wait.
    let data = temp();
    let (bridge, _) = watched(quick(), &data);
    let fake = fake_bridge(&data, &format!("{STARTED}\n{UNTIL_STDIN_ENDS}"));
    bridge.connect(data.to_path_buf(), Some(fake), Arc::new(|_: &Snapshot| {}));
    let store = prepare_store(&data, "u1").unwrap();
    session_db(&store, true);
    let began = Instant::now();
    assert_eq!(bridge.disconnect("u1"), Ok(Disconnected { unlinked: false }));
    assert!(began.elapsed() < Duration::from_secs(5), "{:?}", began.elapsed());
    assert!(!store.exists());
  }

  // ---- config

  #[test]
  fn is_off_until_it_is_turned_on() {
    assert!(!turned_on(None, false));
    assert!(turned_on(None, true));
    assert!(turned_on(Some("1".into()), false));
    assert!(!turned_on(Some("0".into()), false));
    assert!(!turned_on(Some("".into()), false));
    assert_eq!(enabled_with(true, true), Ok(()));
    assert_eq!(enabled_with(true, false), Err("unsupported".to_string()));
    // Never outside macOS, whatever turns it on.
    assert_eq!(enabled_with(false, true), Err("unsupported".to_string()));
    // A bridge state the switch was never read into (before setup) is off.
    assert_eq!(Bridge::default().enabled(), Err("unsupported".to_string()));
  }

  /// A bridge state with the switch read as `on`, as setup does at launch.
  fn switched(on: bool) -> Bridge {
    let bridge = Bridge::default();
    bridge.0.switched_on.set(on).unwrap();
    bridge
  }

  fn config() -> Config {
    Config {
      mode: Mode::Local,
      device_id: "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b".into(),
      device_name: "Kim's MacBook Pro".into(),
      linked_at: Some("2026-11-12T13:48:14.000Z".into()),
      import_since: "2026-10-13T13:40:02.000Z".into(),
      include_groups: true,
      notify: false,
      left_out: vec!["120363000000000001@g.us".into()],
      moved: false,
    }
  }

  #[test]
  fn keeps_a_config_per_user_and_checks_it() {
    let data = temp();
    let settings = config();
    save_config(&data, "u1", &settings).unwrap();
    assert_eq!(load_config(&data, "u1").unwrap(), Some(settings.clone()));
    assert_eq!(load_config(&data, "u2").unwrap(), None);
    for user_id in ["", "../u1", "u.1", "a/b", &"x".repeat(129)] {
      assert!(save_config(&data, user_id, &settings).is_err(), "{user_id:?}");
      assert!(load_config(&data, user_id).is_err(), "{user_id:?}");
    }

    let invalid: [fn(&mut Config); 7] = [
      |config| config.left_out.push("someone".into()),
      |config| config.left_out.push("1@evil.example".into()),
      |config| config.device_id = "../x".into(),
      |config| config.device_name = "line\nbreak".into(),
      |config| config.linked_at = Some("tomorrow".into()),
      |config| config.import_since = String::new(),
      |config| config.import_since = "last month".into(),
    ];
    for change in invalid {
      let mut wrong = settings.clone();
      change(&mut wrong);
      assert!(save_config(&data, "u1", &wrong).is_err(), "{wrong:?}");
    }
    let fields = json!({ "mode": "local", "deviceId": "d", "deviceName": "n", "importSince": "2026-10-13T13:40:02.000Z", "includeGroups": true, "notify": false, "leftOut": [] });
    assert!(serde_json::from_value::<Config>(fields.clone()).is_ok());
    let with = |key: &str, value: Value| {
      let mut object = fields.as_object().unwrap().clone();
      object.insert(key.into(), value);
      Value::Object(object)
    };
    // The web view cannot hand the shell a path or a port: no such field exists.
    assert!(serde_json::from_value::<Config>(with("folder", json!("/x"))).is_err());
    assert!(serde_json::from_value::<Config>(with("port", json!(1))).is_err());
    assert!(serde_json::from_value::<Config>(with("mode", json!("everywhere"))).is_err());
    // A config without the import date is refused: it is set once at connect and never made up afterwards.
    let mut without = fields.as_object().unwrap().clone();
    without.remove("importSince");
    assert!(serde_json::from_value::<Config>(Value::Object(without)).is_err());

    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(fs::metadata(config_file(&data, "u1").unwrap()).unwrap().permissions().mode() & 0o777, 0o600);
    }
  }

  /// A config of an earlier version names the whatsapp-mcp folder: it becomes one that waits for the phone to link
  /// again, keeps everything else, and the folder's path is gone from the file. The folder itself is never touched.
  #[cfg(unix)]
  #[test]
  fn moves_a_config_of_an_earlier_version_and_forgets_its_folder() {
    use std::os::unix::fs::PermissionsExt;
    let data = temp();
    let old = temp();
    let store = old.join("whatsapp-bridge").join("store");
    fs::create_dir_all(&store).unwrap();
    session_db(&store, true);
    fs::set_permissions(&*old, fs::Permissions::from_mode(0o755)).unwrap();
    let before: Vec<(PathBuf, u32, Vec<u8>)> = [old.to_path_buf(), store.clone(), store.join(SESSION_DB)]
      .into_iter()
      .map(|path| (path.clone(), fs::metadata(&path).unwrap().permissions().mode(), if path.is_file() { fs::read(&path).unwrap() } else { Vec::new() }))
      .collect();
    let folder = old.to_str().unwrap();
    let written = json!({
      "folder": folder, "mode": "all", "deviceId": "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", "deviceName": "Kim's MacBook Pro",
      "linkedAt": "2026-11-12T13:48:14.000Z", "importSince": "2026-10-13T13:40:02.000Z", "includeGroups": false, "notify": true,
      "leftOut": ["120363000000000001@g.us"]
    });
    fs::write(config_file(&data, "u1").unwrap(), serde_json::to_vec(&written).unwrap()).unwrap();
    for name in LEGACY_FILES {
      fs::write(data.join(name), format!("[\"{folder}\"]")).unwrap();
    }

    let loaded = load_config(&data, "u1").unwrap().unwrap();
    assert_eq!(
      loaded,
      Config {
        mode: Mode::All,
        device_id: "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b".into(),
        device_name: "Kim's MacBook Pro".into(),
        linked_at: None,
        import_since: "2026-10-13T13:40:02.000Z".into(),
        include_groups: false,
        notify: true,
        left_out: vec!["120363000000000001@g.us".into()],
        moved: true,
      }
    );
    // Saved at once, without the folder; read again it stays the same.
    let text = fs::read_to_string(config_file(&data, "u1").unwrap()).unwrap();
    assert!(!text.contains(folder) && !text.contains("folder"), "{text}");
    assert_eq!(load_config(&data, "u1").unwrap(), Some(loaded));
    forget_legacy_files(&data);
    for name in LEGACY_FILES {
      assert!(!data.join(name).exists(), "{name}");
    }
    // The old folder is exactly as it was.
    for (path, mode, bytes) in before {
      assert_eq!(fs::metadata(&path).unwrap().permissions().mode(), mode, "{path:?}");
      if path.is_file() {
        assert_eq!(fs::read(&path).unwrap(), bytes, "{path:?}");
      }
    }
    assert_eq!(fs::read_dir(&store).unwrap().count(), 1);
    // A config without a folder is not touched by the migration.
    assert_eq!(migrated(&serde_json::to_value(config()).unwrap()), None);
  }

  #[test]
  fn keeps_only_the_confirmed_users_config() {
    let data = temp();
    save_config(&data, "u1", &config()).unwrap();
    save_config(&data, "u2", &config()).unwrap();
    prepare_store(&data, "u1").unwrap();
    let theirs = prepare_store(&data, "u2").unwrap();
    session_db(&theirs, true);

    assert_eq!(keep_only_config(&data, "u1").unwrap(), vec!["u2".to_string()]);
    assert!(load_config(&data, "u1").unwrap().is_some());
    assert_eq!(load_config(&data, "u2").unwrap(), None);
    // Their store, and with it their link, stays: nothing here can unlink their phone.
    assert!(has_session(&theirs));
    // A user without a config of their own removes everyone's.
    assert_eq!(keep_only_config(&data, "u4").unwrap(), vec!["u1".to_string()]);
    assert_eq!(load_config(&data, "u1").unwrap(), None);
    assert!(keep_only_config(&data, "../u1").is_err());
  }


  // ---- HTTP

  /// A request as the fake server got it: its path, its body and its token header.
  #[derive(Clone, Debug)]
  struct Request {
    path: String,
    body: String,
    token: Option<String>,
    json: bool,
    host: Option<String>,
  }

  /// A server on 127.0.0.1 that answers every request with `answer(request)`, a whole HTTP response, and records the
  /// requests. `None` keeps the connection open without answering.
  struct Server {
    port: u16,
    requests: Arc<Mutex<Vec<Request>>>,
  }

  /// A token for the probe and request tests (a started bridge gets a new one every time).
  const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  fn server(answer: impl Fn(&Request) -> Option<String> + Send + 'static) -> Server {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::new()));
    serve(listener, Arc::clone(&requests), answer);
    Server { port, requests }
  }

  fn serve(listener: TcpListener, recorded: Arc<Mutex<Vec<Request>>>, answer: impl Fn(&Request) -> Option<String> + Send + 'static) {
    thread::spawn(move || {
      let mut held = Vec::new();
      for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut first = String::new();
        reader.read_line(&mut first).unwrap();
        let path = first.split_whitespace().nth(1).unwrap_or_default().to_string();
        let mut length = 0;
        let mut token = None;
        let mut json = false;
        let mut host = None;
        loop {
          let mut header = String::new();
          reader.read_line(&mut header).unwrap();
          if header == "\r\n" || header.is_empty() {
            break;
          }
          let (name, value) = header.split_once(':').unwrap();
          match name.to_ascii_lowercase().as_str() {
            "content-length" => length = value.trim().parse().unwrap(),
            "x-bridge-token" => token = Some(value.trim().to_string()),
            "content-type" => json = value.trim() == "application/json",
            "host" => host = Some(value.trim().to_string()),
            _ => {}
          }
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        let request = Request { path, body: String::from_utf8(body).unwrap(), token, json, host };
        lock(&recorded).push(request.clone());
        match answer(&request) {
          Some(response) => {
            stream.write_all(response.as_bytes()).unwrap();
          }
          None => held.push(stream),
        }
      }
    });
  }

  fn http(status: u16, body: &str) -> Option<String> {
    Some(format!("HTTP/1.1 {status} Status\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()))
  }

  /// A port nothing listens on.
  fn closed_port() -> u16 {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap().local_addr().unwrap().port()
  }

  /// A bridge without a token check.
  fn unprotected_answer(request: &Request) -> Option<String> {
    (request.path == "/api/send" && request.body == "{}").then(|| http(400, "Recipient is required\n")).flatten()
  }

  /// A bridge that keeps apps/whatsapp-bridge/README.md: 401 without its token.
  fn protected_answer(token: &'static str) -> impl Fn(&Request) -> Option<String> + Send + 'static {
    move |request| if request.token.as_deref() == Some(token) && request.json { unprotected_answer(request) } else { http(401, "Unauthorized\n") }
  }

  #[test]
  fn uses_only_a_bridge_that_insists_on_the_token() {
    let ours = server(protected_answer(TOKEN));
    assert_eq!(probe(ours.port, Some(TOKEN)), Probe::Ours);
    assert_eq!(probe(ours.port, None), Probe::Taken);
    assert_eq!(probe(server(protected_answer("another run's token")).port, Some(TOKEN)), Probe::Taken);
    for answer in [http(404, "404 page not found\n"), http(400, "Bad Request"), http(200, "Recipient is required")] {
      let other = server(move |_| answer.clone());
      assert_eq!(probe(other.port, Some(TOKEN)), Probe::Taken);
      // Only a refusal for want of a token earns the token.
      assert!(lock(&other.requests).iter().all(|request| request.token.is_none()));
    }
    assert_eq!(probe(closed_port(), Some(TOKEN)), Probe::Nothing);
    // The first request goes without the token, so a bridge that ignores it never sees it.
    let open = server(unprotected_answer);
    assert_eq!(probe(open.port, Some(TOKEN)), Probe::Unprotected);
    assert!(lock(&open.requests).iter().all(|request| request.token.is_none()));
    // Every request names 127.0.0.1 and the port as its host (the bridge refuses any other).
    assert!(lock(&ours.requests).iter().all(|request| request.host == Some(format!("127.0.0.1:{}", ours.port))));
  }

  #[test]
  fn sends_to_the_bridge_and_names_why_not() {
    let ok = server(|_| http(200, r#"{"success":true,"message":"Message sent to 31612345678"}"#));
    assert_eq!(send(ok.port, TOKEN, "31612345678", "Hi", None, REQUEST_TIMEOUT), sent(true, "sent"));
    let file = PathBuf::from("/tmp/photo.jpg");
    assert_eq!(send(ok.port, TOKEN, "120363000000000001@g.us", "", Some(&file), REQUEST_TIMEOUT), sent(true, "sent"));
    let requests = lock(&ok.requests).clone();
    assert_eq!(requests[0].path, "/api/send");
    assert_eq!(serde_json::from_str::<Value>(&requests[0].body).unwrap(), json!({ "recipient": "31612345678", "message": "Hi", "media_path": "" }));
    assert_eq!(serde_json::from_str::<Value>(&requests[1].body).unwrap()["media_path"], "/tmp/photo.jpg");

    let unlinked = server(|_| http(500, r#"{"success":false,"message":"Not connected to WhatsApp"}"#));
    assert_eq!(send(unlinked.port, TOKEN, "31612345678", "Hi", None, REQUEST_TIMEOUT), sent(false, "not_linked"));
    let refused = server(|_| http(500, r#"{"success":false,"message":"Error sending message: server returned error 479"}"#));
    assert_eq!(send(refused.port, TOKEN, "31612345678", "Hi", None, REQUEST_TIMEOUT), sent(false, "refused"));
    let plain = server(|_| http(400, "Message or media path is required\n"));
    assert_eq!(send(plain.port, TOKEN, "31612345678", "Hi", None, REQUEST_TIMEOUT), sent(false, "refused"));
    assert_eq!(send(closed_port(), TOKEN, "31612345678", "Hi", None, REQUEST_TIMEOUT), sent(false, "bridge_stopped"));
    // Taken, never answered: it may have gone out, so it is not called refused.
    let silent = server(|_| None);
    assert_eq!(send(silent.port, TOKEN, "31612345678", "Hi", None, Duration::from_millis(300)), sent(false, "unconfirmed"));
  }

  #[test]
  fn never_follows_a_redirect_away_from_the_bridge() {
    let elsewhere = server(|_| http(200, r#"{"success":true}"#));
    let location = format!("http://127.0.0.1:{}/api/send", elsewhere.port);
    let redirecting = server(move |_| Some(format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")));
    assert_eq!(send(redirecting.port, TOKEN, "31612345678", "Hi", None, REQUEST_TIMEOUT), sent(false, "refused"));
    assert!(lock(&elsewhere.requests).is_empty());
  }

  #[test]
  fn stages_a_reply_file_under_one_plain_name_and_removes_it_again() {
    let data = temp();
    let outbox = data.join(OUTBOX_DIR);
    for (given, kept) in [
      ("Drill manual.pdf", "Drill manual.pdf"),
      ("C:\\Users\\kim\\notes.txt", "notes.txt"),
      ("../../Library/LaunchAgents/x.plist", "x.plist"),
      ("..", "file"),
      ("  .hidden\u{7}", "hidden"),
      ("", "file"),
      ("invoice\u{202E}fdp.exe", "invoicefdp.exe"),
      ("\u{2066}report\u{2069}.pdf", "report.pdf"),
    ] {
      assert_eq!(staged_name(given), kept, "{given:?}");
    }
    assert!(staged_name(&"é".repeat(300)).len() <= 200);

    let staged = stage(&outbox, "../manual.pdf", b"%PDF manual").unwrap();
    assert_eq!(staged.file_name().unwrap(), "manual.pdf");
    assert_eq!(staged.parent().unwrap().parent().unwrap(), outbox.canonicalize().unwrap(), "In a folder of its own inside the outbox.");
    assert_eq!(fs::read(&staged).unwrap(), b"%PDF manual");
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(fs::metadata(&staged).unwrap().permissions().mode() & 0o777, 0o600);
      assert_eq!(fs::metadata(staged.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
    }
    let again = stage(&outbox, "manual.pdf", b"other").unwrap();
    assert_ne!(again, staged, "Two files of one name never share a path.");
    assert_eq!(stage(&outbox, "empty", b""), Err(code("The file is empty.")));

    // A staged file may be sent; once discarded it may not.
    let mut sendable: HashSet<PathBuf> = [staged.clone()].into();
    assert_eq!(checked_message(&sendable, "31612345678", "", Some(staged.to_str().unwrap())), Ok(Some(staged.clone())));
    discard(&staged);
    sendable.remove(&staged);
    assert!(!staged.exists() && !staged.parent().unwrap().exists());
    assert!(checked_message(&sendable, "31612345678", "", Some(staged.to_str().unwrap())).is_err());
  }

  #[test]
  fn reads_a_file_name_header_and_a_download_within_its_limit() {
    assert_eq!(percent_decoded("Drill%20manual%20%C3%A9.pdf"), Ok("Drill manual é.pdf".to_string()));
    assert_eq!(percent_decoded("plain.txt"), Ok("plain.txt".to_string()));
    assert_eq!(percent_decoded("bad%2"), Err(code("refused")));
    assert_eq!(percent_decoded("bad%zz"), Err(code("refused")));
    assert_eq!(percent_decoded("%FF"), Err(code("refused")));

    let root = temp();
    let file = root.join("photo.jpg");
    fs::write(&file, b"0123456789").unwrap();
    assert_eq!(read_limited(&file, 10), Ok(b"0123456789".to_vec()));
    assert_eq!(read_limited(&file, 9), Err(code("too_large")));
  }

  #[test]
  fn checks_a_message_before_it_goes_out() {
    let root = temp();
    let picked = root.join("photo.jpg");
    let other = root.join("secret.txt");
    fs::write(&picked, b"jpg").unwrap();
    fs::write(&other, b"key").unwrap();
    let chosen: HashSet<PathBuf> = [picked.canonicalize().unwrap()].into();

    for recipient in ["31612345678", "31612345678@s.whatsapp.net", "120363000000000001@g.us", "123456789012345@lid", "1234:5@s.whatsapp.net"] {
      assert!(checked_message(&chosen, recipient, "Hi", None).is_ok(), "{recipient}");
    }
    for recipient in ["", "+31612345678", "31612345678@example.com", "a b@g.us", "@g.us", "x@g.us@g.us", "status@broadcast", "../x"] {
      assert!(checked_message(&chosen, recipient, "Hi", None).is_err(), "{recipient}");
    }
    assert!(checked_message(&chosen, "31612345678", "  ", None).is_err());
    assert!(checked_message(&chosen, "31612345678", &"x".repeat(MAX_TEXT_BYTES + 1), None).is_err());
    assert_eq!(checked_message(&chosen, "31612345678", "", Some(picked.to_str().unwrap())), Ok(Some(picked.canonicalize().unwrap())));
    assert!(checked_message(&chosen, "31612345678", "", Some(other.to_str().unwrap())).is_err());
    assert!(checked_message(&chosen, "31612345678", "", Some(root.to_str().unwrap())).is_err());
    // The picker hands back the path and the size.
    assert_eq!(chosen_file(&picked.canonicalize().unwrap()), Ok(ChosenFile { path: picked.canonicalize().unwrap().to_str().unwrap().to_string(), size: fs::metadata(&picked).unwrap().len() }));
    // A file over the limit is refused before the bridge reads it (a sparse file: nothing is written).
    File::create(&picked).unwrap().set_len(MAX_SEND_BYTES + 1).unwrap();
    assert_eq!(checked_message(&chosen, "31612345678", "", Some(picked.to_str().unwrap())), Err("too_large".to_string()));
    File::create(&picked).unwrap().set_len(MAX_SEND_BYTES).unwrap();
    assert!(checked_message(&chosen, "31612345678", "", Some(picked.to_str().unwrap())).is_ok());
    fs::remove_file(&picked).unwrap();
    assert!(checked_message(&chosen, "31612345678", "", Some(picked.to_str().unwrap())).is_err());
  }

  // ---- downloads

  /// A store holding one picture message whose hash is the hash of `content`, and a file on disk.
  fn media_install(root: &Path, content: &[u8], hash: Option<Vec<u8>>, filename: &str) -> (PathBuf, PathBuf) {
    let store = root.join("store");
    let chat = store.join("120363000000000001@g.us");
    fs::create_dir_all(&chat).unwrap();
    let db = messages_db(&store);
    Connection::open(&db)
      .unwrap()
      .execute("UPDATE messages SET file_sha256 = ?1, file_length = ?2, filename = ?3 WHERE id = 'A3'", params![hash, content.len() as i64, filename])
      .unwrap();
    let file = chat.join("image_20261112_145000.jpg");
    fs::write(&file, content).unwrap();
    (store, file)
  }

  fn download_answer(path: &Path) -> impl Fn(&Request) -> Option<String> + Send + 'static {
    let body = json!({ "success": true, "message": "Successfully downloaded image media", "filename": "x", "path": path }).to_string();
    move |_| http(200, &body)
  }

  #[test]
  fn downloads_into_the_apps_folder_only_when_the_hash_matches() {
    let root = temp();
    let data = temp();
    let content = b"a picture".to_vec();
    let (store, file) = media_install(&root, &content, Some(Sha256::digest(&content).to_vec()), "image_20261112_145000.jpg");
    let media_dir = data.join(MEDIA_DIR);
    let bridge = server(download_answer(&file));

    let downloaded = download(bridge.port, TOKEN, &store, &media_dir, "A3", "120363000000000001@g.us", REQUEST_TIMEOUT).unwrap();
    assert!(downloaded.verified);
    let saved = PathBuf::from(&downloaded.path);
    assert_eq!(saved.parent(), Some(media_dir.canonicalize().unwrap().as_path()).or(Some(media_dir.as_path())));
    assert_eq!(saved.file_name().unwrap().to_str().unwrap(), media_name("120363000000000001@g.us", "A3", "image", Some("image_20261112_145000.jpg")));
    assert_eq!(fs::read(&saved).unwrap(), content);
    assert_eq!(serde_json::from_str::<Value>(&lock(&bridge.requests)[0].body).unwrap(), json!({ "message_id": "A3", "chat_jid": "120363000000000001@g.us" }));

    // Another message's picture under the same name: refused, and nothing is left behind.
    fs::write(&file, b"another p").unwrap();
    fs::remove_file(&saved).unwrap();
    assert_eq!(download(bridge.port, TOKEN, &store, &media_dir, "A3", "120363000000000001@g.us", REQUEST_TIMEOUT), Err("mismatch".to_string()));
    assert_eq!(fs::read_dir(&media_dir).unwrap().count(), 0);
    // Longer than the store says: not read to the end.
    fs::write(&file, b"a picture, and more").unwrap();
    assert_eq!(download(bridge.port, TOKEN, &store, &media_dir, "A3", "120363000000000001@g.us", REQUEST_TIMEOUT), Err("too_large".to_string()));
    assert_eq!(fs::read_dir(&media_dir).unwrap().count(), 0);

    assert_eq!(download(bridge.port, TOKEN, &store, &media_dir, "A9", "120363000000000001@g.us", REQUEST_TIMEOUT), Err("not_found".to_string()));
    assert_eq!(download(bridge.port, TOKEN, &store, &media_dir, "A1", "31612345678@s.whatsapp.net", REQUEST_TIMEOUT), Err("not_media".to_string()));
    assert_eq!(download(closed_port(), TOKEN, &store, &media_dir, "A3", "120363000000000001@g.us", REQUEST_TIMEOUT), Err("bridge_stopped".to_string()));
    let failing = server(|_| http(500, r#"{"success":false,"message":"Failed to download media: incomplete media information for download"}"#));
    assert_eq!(download(failing.port, TOKEN, &store, &media_dir, "A3", "120363000000000001@g.us", REQUEST_TIMEOUT), Err("failed".to_string()));
  }

  #[test]
  fn a_file_without_a_hash_comes_unverified() {
    let root = temp();
    let data = temp();
    let (store, file) = media_install(&root, b"old", None, "image_20261112_145000.jpg");
    let downloaded = download(server(download_answer(&file)).port, TOKEN, &store, &data.join(MEDIA_DIR), "A3", "120363000000000001@g.us", REQUEST_TIMEOUT).unwrap();
    assert!(!downloaded.verified);
  }

  #[cfg(unix)]
  #[test]
  fn takes_no_path_from_the_bridge_outside_its_store() {
    let root = temp();
    let data = temp();
    let content = b"a picture".to_vec();
    let (store, file) = media_install(&root, &content, Some(Sha256::digest(&content).to_vec()), "image.jpg");
    let outside = root.join("outside.jpg");
    fs::write(&outside, &content).unwrap();
    let link = file.parent().unwrap().join("link.jpg");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    for reported in [outside.clone(), link, store.join("..").join("..").join("..").join("outside.jpg"), PathBuf::from("store/120363000000000001@g.us/image_20261112_145000.jpg"), store.clone()] {
      let bridge = server(download_answer(&reported));
      assert_eq!(download(bridge.port, TOKEN, &store, &data.join(MEDIA_DIR), "A3", "120363000000000001@g.us", REQUEST_TIMEOUT), Err("refused".to_string()), "{reported:?}");
    }
  }

  #[test]
  fn names_a_download_itself_and_keeps_only_harmless_extensions() {
    let name = media_name("31612345678@s.whatsapp.net", "3EB0ABC", "document", Some("Invoice.PDF"));
    assert!(name.ends_with(".pdf") && name.len() == 36 && name[..32].bytes().all(|b| b.is_ascii_hexdigit()));
    assert_ne!(name, media_name("31612345678@s.whatsapp.net", "3EB0ABD", "document", Some("Invoice.PDF")));
    for (kind, filename, extension) in [
      ("document", Some("run.command"), ".bin"),
      ("document", Some("../../evil.app"), ".bin"),
      ("document", Some("archive.tar.gz"), ".bin"),
      ("document", None, ".bin"),
      ("image", Some("image_20261112_145000.jpg"), ".jpg"),
      ("image", Some("noextension"), ".jpg"),
      ("audio", Some("voice"), ".ogg"),
      ("video", None, ".mp4"),
    ] {
      assert!(media_name("1@g.us", "A", kind, filename).ends_with(extension), "{filename:?}");
    }
  }

  #[cfg(unix)]
  #[test]
  fn opens_only_tressos_own_downloads() {
    let data = temp();
    let media_dir = data.join(MEDIA_DIR);
    fs::create_dir_all(&media_dir).unwrap();
    let own = format!("{}.jpg", "0123456789abcdef".repeat(2));
    let file = media_dir.join(&own);
    fs::write(&file, b"x").unwrap();
    let secret = data.join("whatsapp-u1.json");
    fs::write(&secret, b"{}").unwrap();
    std::os::unix::fs::symlink(&secret, media_dir.join(format!("{}.pdf", "ab".repeat(16)))).unwrap();
    fs::create_dir_all(media_dir.join("sub")).unwrap();
    fs::write(media_dir.join("sub").join(&own), b"x").unwrap();
    let mut planted = Vec::new();
    for name in [
      "x.command".to_string(),
      format!("{}.command", "ab".repeat(16)),
      format!("{}.zip", "ab".repeat(16)),
      format!("{}.bin", "ab".repeat(16)),
      format!("{}.html", "ab".repeat(16)),
      format!("{}.JPG", "ab".repeat(16)),
      format!("{}.jpg", "AB".repeat(16)),
      format!("{}.jpg", "ab".repeat(15)),
      format!(".{own}.0011223344556677.part"),
    ] {
      fs::write(media_dir.join(&name), b"x").unwrap();
      planted.push(media_dir.join(name));
    }

    assert_eq!(openable(&media_dir, file.to_str().unwrap()), Ok(file.canonicalize().unwrap()));
    let mut refused = vec![
      secret.clone(),
      media_dir.join("..").join("whatsapp-u1.json"),
      media_dir.join(format!("{}.pdf", "ab".repeat(16))),
      media_dir.join("sub"),
      media_dir.join("sub").join(&own),
      PathBuf::from(&own),
      PathBuf::from("/etc/hosts"),
    ];
    refused.extend(planted);
    for path in refused {
      assert_eq!(openable(&media_dir, path.to_str().unwrap()), Err("refused".to_string()), "{path:?}");
    }
  }

  #[test]
  fn keeps_no_extension_that_opens_into_code() {
    for extension in ["zip", "html", "htm", "svg", "webloc", "inetloc", "fileloc", "terminal", "command", "tool", "app", "pkg", "mpkg", "dmg", "jar", "sh", "py", "scpt", "applescript", "workflow", "doc", "xls", "ppt", "docm", "xlsm", "pptm"] {
      assert!(!SAFE_EXTENSIONS.contains(&extension), "{extension}");
      assert!(media_name("1@g.us", "A", "document", Some(&format!("x.{extension}"))).ends_with(".bin"), "{extension}");
    }
  }

  /// The bridge writes a download to `store/<chat>/<stored name>`: a name that is not one plain name is never asked
  /// for, so the bridge writes nothing anywhere.
  #[test]
  fn never_asks_the_bridge_for_a_file_whose_name_leaves_its_folder() {
    let data = temp();
    let content = b"a picture".to_vec();
    let long = "x".repeat(256);
    for name in ["../../../../Library/LaunchAgents/x.plist", "a/b.pdf", "/etc/x.pdf", "..", ".", "", "a\\b.pdf", "nul\0.pdf", long.as_str()] {
      let root = temp();
      let (store, file) = media_install(&root, &content, Some(Sha256::digest(&content).to_vec()), name);
      let bridge = server(download_answer(&file));
      assert_eq!(download(bridge.port, TOKEN, &store, &data.join(MEDIA_DIR), "A3", "120363000000000001@g.us", REQUEST_TIMEOUT), Err("refused".to_string()), "{name:?}");
      assert!(lock(&bridge.requests).is_empty(), "{name:?}");
    }
    for name in ["Invoice 2026.pdf", "image_20261112_145000.jpg", "..hidden", "a..b"] {
      assert!(plain_file_name(name), "{name}");
    }
  }

  #[cfg(unix)]
  #[test]
  fn keeps_downloads_private_and_marked_as_from_the_internet() {
    use std::os::unix::fs::PermissionsExt;
    let root = temp();
    let data = temp();
    let media_dir = data.join(MEDIA_DIR);
    fs::create_dir_all(&media_dir).unwrap();
    fs::set_permissions(&media_dir, fs::Permissions::from_mode(0o755)).unwrap();
    let content = b"a picture".to_vec();
    let (store, file) = media_install(&root, &content, Some(Sha256::digest(&content).to_vec()), "image_20261112_145000.jpg");
    let downloaded = download(server(download_answer(&file)).port, TOKEN, &store, &media_dir, "A3", "120363000000000001@g.us", REQUEST_TIMEOUT).unwrap();
    assert_eq!(fs::metadata(&media_dir).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(fs::metadata(&downloaded.path).unwrap().permissions().mode() & 0o777, 0o600);
    #[cfg(target_os = "macos")]
    {
      use std::os::unix::ffi::OsStrExt;
      let path = std::ffi::CString::new(Path::new(&downloaded.path).as_os_str().as_bytes()).unwrap();
      let mut value = vec![0u8; 256];
      // SAFETY: the buffer is valid for its length, which is passed along; both names end in NUL.
      let length = unsafe { libc::getxattr(path.as_ptr(), c"com.apple.quarantine".as_ptr(), value.as_mut_ptr().cast(), value.len(), 0, 0) };
      assert!(length > 0, "no quarantine on {}", downloaded.path);
      let value = String::from_utf8(value[..length as usize].to_vec()).unwrap();
      assert!(value.starts_with("0083;") && value.ends_with(";Tresso;"), "{value}");
    }
  }

  #[test]
  fn two_downloads_of_one_message_do_not_share_a_file() {
    let root = temp();
    let data = temp();
    let content = vec![7u8; 4 * 1024 * 1024];
    let (store, file) = media_install(&root, &content, Some(Sha256::digest(&content).to_vec()), "image_20261112_145000.jpg");
    let bridge = server(download_answer(&file));
    let media_dir = data.join(MEDIA_DIR);
    let downloads: Vec<_> = (0..4)
      .map(|_| {
        let (store, media_dir, port) = (store.clone(), media_dir.clone(), bridge.port);
        thread::spawn(move || download(port, TOKEN, &store, &media_dir, "A3", "120363000000000001@g.us", REQUEST_TIMEOUT))
      })
      .collect();
    for download in downloads {
      let downloaded = download.join().unwrap().unwrap();
      assert!(downloaded.verified);
      assert_eq!(fs::read(&downloaded.path).unwrap(), content);
    }
    assert_eq!(fs::read_dir(&media_dir).unwrap().count(), 1);
  }

  #[test]
  fn tells_a_renumbered_store_from_a_row_stored_again() {
    let dir = temp();
    let db = messages_db(&dir);
    let before = read_rows(&db, 0, 500).unwrap();
    assert_eq!(read_rows(&db, 0, 500).unwrap().store_id, before.store_id);
    // Stored again, the newest row gets a rowid after every other one, not its own back; the numbering stays.
    let connection = Connection::open(&db).unwrap();
    connection.pragma_update(None, "foreign_keys", false).unwrap();
    connection
      .execute("INSERT OR REPLACE INTO messages (id, chat_jid, sender, content, timestamp, is_from_me) VALUES ('A4', '99999@s.whatsapp.net', '99999', 'edited', '2026-11-12 14:51:00Z', 0)", [])
      .unwrap();
    drop(connection);
    let again = read_rows(&db, 0, 500).unwrap();
    assert_eq!((again.max_rowid, again.rows[3].rowid, again.rows[3].text.as_str()), (5, 5, "edited"));
    assert_eq!(read_rows(&db, 4, 500).unwrap().rows.len(), 1);
    assert_eq!(again.store_id, before.store_id);
    // A store made anew (the README's advice when out of sync), with its rows numbered differently.
    fs::remove_file(&db).unwrap();
    let rebuilt = Connection::open(&db).unwrap();
    rebuilt
      .execute_batch(
        "CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TIMESTAMP);
         CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TIMESTAMP, is_from_me BOOLEAN, media_type TEXT,
           filename TEXT, url TEXT, media_key BLOB, file_sha256 BLOB, file_enc_sha256 BLOB, file_length INTEGER, PRIMARY KEY (id, chat_jid));
         INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me) VALUES ('A2', '31612345678@s.whatsapp.net', '1', 'Sure', '2026-11-12 14:49:00+01:00', 1);
         INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me) VALUES ('A1', '31612345678@s.whatsapp.net', '1', 'Hi', '2026-11-12 14:48:14+01:00', 0);",
      )
      .unwrap();
    drop(rebuilt);
    let renumbered = read_rows(&db, 0, 500).unwrap();
    assert_ne!(renumbered.store_id, before.store_id);
    assert!(renumbered.max_rowid < before.max_rowid);
    // VACUUM keeps the file (and here its numbering), yet may renumber: the store id changes with it.
    let vacuumed = read_rows(&db, 0, 500).unwrap();
    Connection::open(&db).unwrap().execute_batch("VACUUM").unwrap();
    let after = read_rows(&db, 0, 500).unwrap();
    assert_eq!(file_id(&db).unwrap(), after.store_id.split(':').next().unwrap());
    assert_ne!(after.store_id, vacuumed.store_id);
  }

  #[test]
  fn cuts_long_text_and_file_names() {
    let dir = temp();
    let db = messages_db(&dir);
    let long = "\u{e9}".repeat(MAX_FIELD_CHARS as usize + 10);
    Connection::open(&db).unwrap().execute("UPDATE messages SET content = ?1, filename = ?1 WHERE id = 'A3'", [&long]).unwrap();
    let rows = read_rows(&db, 2, 1).unwrap();
    assert_eq!(rows.rows[0].text.chars().count(), MAX_FIELD_CHARS as usize);
    assert_eq!(rows.rows[0].filename.as_deref().map(|name| name.chars().count()), Some(MAX_FIELD_CHARS as usize));
  }

  /// Which ids are phone numbers comes from a JID that holds them wherever the stores have one; the length rule only
  /// decides for an id no JID names.
  #[test]
  fn takes_number_or_lid_from_a_chat_jid_before_the_length() {
    let dir = temp();
    let messages = messages_db(&dir);
    let connection = Connection::open(&messages).unwrap();
    connection.execute_batch("INSERT INTO chats VALUES ('31612345678901@s.whatsapp.net', 'Long number', NULL); INSERT INTO chats VALUES ('1234567@lid', 'Short lid', NULL);").unwrap();
    drop(connection);
    let ids = ["31612345678901", "1234567", "7654321", "123456789012345"].map(str::to_string).to_vec();
    let found = names(None, Some(&messages), &ids).unwrap();
    assert_eq!(found["31612345678901"], name(Some("31612345678901"), None));
    assert_eq!(found["1234567"], name(None, None));
    assert_eq!(found["7654321"], name(Some("7654321"), None));
    assert_eq!(found["123456789012345"], name(None, None));
  }


  #[test]
  fn names_this_computer() {
    assert_eq!(device_name(Some("Kim's MacBook Pro\n".into()), Some("kims-mbp.local".into())), Some("Kim's MacBook Pro".into()));
    assert_eq!(device_name(Some("  ".into()), Some("kims-mbp.local".into())), Some("kims-mbp.local".into()));
    assert_eq!(device_name(None, None), None);
    assert_eq!(device_name(Some("x".repeat(300)), None).map(|name| name.len()), Some(200));
  }

  // ---- platform and access

  #[test]
  fn answers_unsupported_outside_macos() {
    if cfg!(target_os = "macos") {
      assert!(supported().is_ok());
      assert_eq!(switched(true).enabled(), Ok(()));
    } else {
      assert_eq!(supported(), Err("unsupported".to_string()));
      assert_eq!(switched(true).enabled(), Err("unsupported".to_string()));
    }
    assert_eq!(switched(false).enabled(), Err("unsupported".to_string()));
  }

  /// The handler list in lib.rs, the app manifest in build.rs and the capabilities agree: every command is allowed
  /// once, only for the main window, never for a remote page, and the WhatsApp commands (except
  /// `whatsapp_available`) only on macOS.
  #[test]
  fn every_command_is_allowed_only_for_the_main_window() {
    fn between<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
      let from = source.find(start).unwrap() + start.len();
      &source[from..from + source[from..].find(end).unwrap()]
    }
    let handlers: Vec<String> = between(include_str!("lib.rs"), "generate_handler![", "]")
      .split(',')
      .map(|entry| entry.trim().rsplit("::").next().unwrap().to_string())
      .filter(|entry| !entry.is_empty())
      .collect();
    let manifest: Vec<String> = between(include_str!("../build.rs"), ".commands(&[", "])")
      .split(',')
      .map(|entry| entry.trim().trim_matches('"').to_string())
      .filter(|entry| !entry.is_empty())
      .collect();
    let mut sorted_handlers = handlers.clone();
    sorted_handlers.sort();
    let mut sorted_manifest = manifest.clone();
    sorted_manifest.sort();
    assert_eq!(sorted_handlers, sorted_manifest);

    let capabilities: Vec<Value> =
      [include_str!("../capabilities/default.json"), include_str!("../capabilities/updates.json"), include_str!("../capabilities/whatsapp.json")]
        .iter()
        .map(|text| serde_json::from_str(text).unwrap())
        .collect();
    for capability in &capabilities {
      assert_eq!(capability["windows"], json!(["main"]), "{}", capability["identifier"]);
      assert!(capability.get("webviews").is_none() && capability.get("remote").is_none(), "{}", capability["identifier"]);
    }
    let whatsapp = &capabilities[2];
    assert_eq!(whatsapp["platforms"], json!(["macOS"]));
    for command in &handlers {
      let permission = format!("allow-{}", command.replace('_', "-"));
      let granted: Vec<&Value> = capabilities.iter().filter(|capability| capability["permissions"].as_array().unwrap().iter().any(|p| p == &json!(permission))).collect();
      assert_eq!(granted.len(), 1, "{permission}");
      let macos_only = command.starts_with("whatsapp_") && command != "whatsapp_available";
      assert_eq!(granted[0]["identifier"] == whatsapp["identifier"], macos_only, "{permission}");
    }
  }

  /// Through Tauri's IPC with the app's real capabilities: the main window reaches the commands, another window does
  /// not, and outside macOS the WhatsApp commands are not reachable at all.
  #[test]
  fn another_window_cannot_reach_the_commands() {
    use tauri::test::{INVOKE_KEY, mock_builder};
    let app = mock_builder()
      .manage(switched(true))
      .invoke_handler(tauri::generate_handler![whatsapp_available, whatsapp_state])
      .build(tauri::generate_context!(test = true))
      .unwrap();
    let call = |window: &tauri::WebviewWindow<tauri::test::MockRuntime>, command: &str| {
      tauri::test::get_ipc_response(
        window,
        tauri::webview::InvokeRequest {
          cmd: command.into(),
          callback: tauri::ipc::CallbackFn(0),
          error: tauri::ipc::CallbackFn(1),
          url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(),
          body: tauri::ipc::InvokeBody::Json(json!({})),
          headers: Default::default(),
          invoke_key: INVOKE_KEY.to_string(),
        },
      )
    };
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    let other = tauri::WebviewWindowBuilder::new(&app, "other", Default::default()).build().unwrap();
    assert_eq!(call(&main, "whatsapp_available").unwrap().deserialize::<bool>().unwrap(), cfg!(target_os = "macos"));
    assert!(call(&other, "whatsapp_available").is_err());
    assert!(call(&other, "whatsapp_state").is_err());
    assert_eq!(call(&main, "whatsapp_state").is_ok(), cfg!(target_os = "macos"));
  }

  /// With the switch off every WhatsApp command refuses before it does anything, for the main window too: nothing in
  /// the window can load a config, start a bridge, read or send. The list comes from the app manifest (build.rs), so a
  /// command added there without being added here fails this test.
  #[test]
  fn every_command_refuses_while_whatsapp_is_off() {
    use tauri::test::{INVOKE_KEY, mock_builder};
    const COMMANDS: [&str; 20] = [
      "whatsapp_available",
      "whatsapp_device",
      "whatsapp_config_load",
      "whatsapp_config_save",
      "whatsapp_config_clear",
      "whatsapp_config_keep_only",
      "whatsapp_disconnect",
      "whatsapp_start",
      "whatsapp_stop",
      "whatsapp_state",
      "whatsapp_identity",
      "whatsapp_read",
      "whatsapp_names",
      "whatsapp_send",
      "whatsapp_download",
      "whatsapp_open_file",
      "whatsapp_choose_file",
      "whatsapp_file",
      "whatsapp_stage_file",
      "whatsapp_discard_file",
    ];
    let manifest: Vec<&str> = include_str!("../build.rs")
      .split('"')
      .filter(|word| word.starts_with("whatsapp_") && word.chars().all(|c| c.is_ascii_lowercase() || c == '_'))
      .collect();
    assert_eq!(manifest, COMMANDS.to_vec());

    let app = mock_builder()
      .manage(switched(false))
      .invoke_handler(tauri::generate_handler![
        whatsapp_available,
        whatsapp_device,
        whatsapp_config_load,
        whatsapp_config_save,
        whatsapp_config_clear,
        whatsapp_config_keep_only,
        whatsapp_disconnect,
        whatsapp_start,
        whatsapp_stop,
        whatsapp_state,
        whatsapp_identity,
        whatsapp_read,
        whatsapp_names,
        whatsapp_send,
        whatsapp_download,
        whatsapp_open_file,
        whatsapp_choose_file,
        whatsapp_file,
        whatsapp_stage_file,
        whatsapp_discard_file
      ])
      .build(tauri::generate_context!(test = true))
      .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    // Every argument any command takes, valid, so a refusal can only come from the switch.
    let args = json!({
      "userId": "u1",
      "config": { "mode": "local", "deviceId": "d", "deviceName": "n", "linkedAt": null, "importSince": "2026-10-13T13:40:02.000Z", "includeGroups": true, "notify": false, "leftOut": [] },
      "afterRowid": 0,
      "limit": 1,
      "ids": [],
      "recipient": "31612345678",
      "text": "Hi",
      "mediaPath": null,
      "messageId": "ABC",
      "chatJid": "31612345678@s.whatsapp.net",
      "path": "/x"
    });
    for command in COMMANDS {
      let answer = tauri::test::get_ipc_response(
        &main,
        tauri::webview::InvokeRequest {
          cmd: command.into(),
          callback: tauri::ipc::CallbackFn(0),
          error: tauri::ipc::CallbackFn(1),
          url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(),
          body: tauri::ipc::InvokeBody::Json(args.clone()),
          headers: Default::default(),
          invoke_key: INVOKE_KEY.to_string(),
        },
      );
      if command == "whatsapp_available" {
        assert!(!answer.unwrap().deserialize::<bool>().unwrap());
      } else if cfg!(target_os = "macos") {
        assert_eq!(answer.unwrap_err(), json!("unsupported"), "{command}");
      } else {
        // Outside macOS the capability does not even let the call through.
        assert!(answer.is_err(), "{command}");
      }
    }
  }
}
