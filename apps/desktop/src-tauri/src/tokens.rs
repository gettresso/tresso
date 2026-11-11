//! The signed-in user's OAuth tokens, kept in the OS keychain (Keychain on macOS, Credential Manager on Windows, the
//! Secret Service on Linux) instead of web storage. The web client hands them over as an opaque JSON string.
//!
//! One entry, `oauth-tokens`, holds the string. The Windows Credential Manager refuses a secret above 2560 bytes of
//! UTF-16, and the token set is larger, so there the string is split: the pieces go to `oauth-tokens.<slot>.<n>` and
//! `oauth-tokens` holds a header naming the slot, the number of pieces and the length. A save writes the slot the
//! header does not point at and switches the header last, so a save cut off halfway leaves the previous token set
//! whole. Every platform reads both forms, so a sign-in saved as one entry by an earlier version still loads.
//!
//! The commands run off the main thread (the OS may ask the user before it opens the keychain, and the window must
//! keep drawing meanwhile) and one at a time, so a save and a sign-out never interleave their entries.

use std::sync::{Arc, Mutex, PoisonError, TryLockError};
use std::time::{Duration, Instant};

use keyring_core::{CredentialStore, Entry, Error};

const SERVICE: &str = "app.tresso.desktop";
const ACCOUNT: &str = "oauth-tokens";
/// Starts the header of a value stored in pieces. A plain value is the web client's JSON, which starts with `{`.
const HEADER: &str = "tresso-chunks:";
const SLOTS: [&str; 2] = ["a", "b"];
/// No token set comes near this many pieces; a slot that seems to have more is not ours to walk through.
const MAX_PIECES: usize = 256;

/// The most UTF-16 code units one entry holds. Windows: `CRED_MAX_CREDENTIAL_BLOB_SIZE` is 2560 bytes, so 1280
/// units; 1000 leaves room. The other keychains have no such limit and keep the value in one entry.
#[cfg(target_os = "windows")]
const PIECE_UNITS: usize = 1000;
#[cfg(not(target_os = "windows"))]
const PIECE_UNITS: usize = usize::MAX;

/// The platform store, once it opened. Holding the lock is also what runs the commands one at a time.
static KEYCHAIN: Mutex<Option<Arc<CredentialStore>>> = Mutex::new(None);

#[tauri::command(async)]
pub fn load_tokens() -> Result<Option<String>, String> {
  with_keychain(|store| load(store).map_err(|error| format!("Reading the sign-in from the keychain failed: {error}")))
}

#[tauri::command(async)]
pub fn save_tokens(tokens: String) -> Result<(), String> {
  with_keychain(|store| {
    save(store, &tokens, PIECE_UNITS).map_err(|error| format!("Saving the sign-in in the keychain failed: {error}"))
  })
}

#[tauri::command(async)]
pub fn clear_tokens() -> Result<(), String> {
  with_keychain(|store| clear(store).map_err(|error| format!("Removing the sign-in from the keychain failed: {error}")))
}

/// Waits, at most `timeout`, for a keychain command that is running to finish. Called when the app quits: a token
/// set the server just rotated exists nowhere else, and quitting while it is written would lose it.
pub fn finish_pending(timeout: Duration) {
  if !wait_until_free(&KEYCHAIN, timeout) {
    log::warn!("Quitting while the sign-in is still being written to the keychain");
  }
}

fn with_keychain<T>(run: impl FnOnce(&CredentialStore) -> Result<T, String>) -> Result<T, String> {
  let mut keychain = KEYCHAIN.lock().unwrap_or_else(PoisonError::into_inner);
  let store = open_once(&mut keychain, platform_store).map_err(|error| format!("The keychain is not available: {error}"))?;
  run(store.as_ref())
}

/// The store, opening it when no earlier call managed to. A keychain that was not ready yet (the Secret Service at
/// login) is tried again on the next call instead of staying unavailable until the app restarts.
fn open_once(
  keychain: &mut Option<Arc<CredentialStore>>,
  open: impl FnOnce() -> keyring_core::Result<Arc<CredentialStore>>,
) -> keyring_core::Result<Arc<CredentialStore>> {
  if let Some(store) = keychain {
    return Ok(store.clone());
  }
  let store = open()?;
  *keychain = Some(store.clone());
  Ok(store)
}

fn platform_store() -> keyring_core::Result<Arc<CredentialStore>> {
  #[cfg(target_os = "macos")]
  let store: Arc<CredentialStore> = apple_native_keyring_store::keychain::Store::new()?;
  #[cfg(target_os = "windows")]
  let store: Arc<CredentialStore> = windows_native_keyring_store::Store::new()?;
  #[cfg(target_os = "linux")]
  let store: Arc<CredentialStore> = zbus_secret_service_keyring_store::Store::new()?;
  #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
  return Ok(store);
  #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
  Err(Error::NotSupportedByStore("This platform has no keychain the desktop app can use.".to_string()))
}

/// True once nobody holds `lock`, false when `timeout` passed first.
fn wait_until_free<T>(lock: &Mutex<T>, timeout: Duration) -> bool {
  let deadline = Instant::now() + timeout;
  loop {
    match lock.try_lock() {
      Ok(_) | Err(TryLockError::Poisoned(_)) => return true,
      Err(TryLockError::WouldBlock) if Instant::now() >= deadline => return false,
      Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(10)),
    }
  }
}

/// What the `oauth-tokens` entry holds.
#[derive(Debug, PartialEq)]
enum Stored {
  /// The value itself.
  Plain(String),
  /// The value is in `count` pieces in `slot`, `length` bytes together.
  Pieces { slot: usize, count: usize, length: usize },
}

fn header(slot: usize, count: usize, length: usize) -> String {
  format!("{HEADER}{}:{count}:{length}", SLOTS[slot])
}

fn parse(value: String) -> Result<Stored, String> {
  let Some(rest) = value.strip_prefix(HEADER) else {
    return Ok(Stored::Plain(value));
  };
  let unreadable = || format!("the saved sign-in has an unknown form ({value})");
  let mut fields = rest.split(':');
  let (Some(slot), Some(count), Some(length), None) = (fields.next(), fields.next(), fields.next(), fields.next()) else {
    return Err(unreadable());
  };
  let slot = SLOTS.iter().position(|name| *name == slot).ok_or_else(unreadable)?;
  let count = count.parse::<usize>().ok().filter(|count| (1..=MAX_PIECES).contains(count)).ok_or_else(unreadable)?;
  let length = length.parse::<usize>().map_err(|_| unreadable())?;
  Ok(Stored::Pieces { slot, count, length })
}

/// Splits `value` into pieces of at most `max_units` UTF-16 code units, never inside a character.
fn split(value: &str, max_units: usize) -> Vec<String> {
  let mut pieces = Vec::new();
  let mut piece = String::new();
  let mut units = 0;
  for character in value.chars() {
    let width = character.len_utf16();
    if units + width > max_units && !piece.is_empty() {
      pieces.push(std::mem::take(&mut piece));
      units = 0;
    }
    piece.push(character);
    units += width;
  }
  if !piece.is_empty() || pieces.is_empty() {
    pieces.push(piece);
  }
  pieces
}

/// The value the pieces make, or `None` when one is missing or they do not add up to `length` bytes.
fn join(pieces: Vec<Option<String>>, length: usize) -> Option<String> {
  let value = pieces.into_iter().collect::<Option<String>>()?;
  (value.len() == length).then_some(value)
}

fn entry(store: &CredentialStore, account: &str) -> Result<Entry, String> {
  store.build(SERVICE, account, None).map_err(|error| error.to_string())
}

fn piece_account(slot: usize, index: usize) -> String {
  format!("{ACCOUNT}.{}.{index}", SLOTS[slot])
}

fn get(store: &CredentialStore, account: &str) -> Result<Option<String>, String> {
  match entry(store, account)?.get_password() {
    Ok(value) => Ok(Some(value)),
    Err(Error::NoEntry) => Ok(None),
    Err(error) => Err(error.to_string()),
  }
}

fn set(store: &CredentialStore, account: &str, value: &str) -> Result<(), String> {
  entry(store, account)?.set_password(value).map_err(|error| error.to_string())
}

fn delete(store: &CredentialStore, account: &str) -> Result<(), String> {
  match entry(store, account)?.delete_credential() {
    Ok(()) | Err(Error::NoEntry) => Ok(()),
    Err(error) => Err(error.to_string()),
  }
}

fn load(store: &CredentialStore) -> Result<Option<String>, String> {
  match get(store, ACCOUNT)?.map(parse).transpose()? {
    None => Ok(None),
    Some(Stored::Plain(value)) => Ok(Some(value)),
    Some(Stored::Pieces { slot, count, length }) => {
      let pieces = (0..count).map(|index| get(store, &piece_account(slot, index))).collect::<Result<Vec<_>, _>>()?;
      join(pieces, length).map(Some).ok_or_else(|| "the saved sign-in is incomplete".to_string())
    }
  }
}

fn save(store: &CredentialStore, value: &str, max_units: usize) -> Result<(), String> {
  let pieces = split(value, max_units);
  if pieces.len() == 1 && !value.starts_with(HEADER) {
    set(store, ACCOUNT, value)?;
    remove_leftovers(store, &[(0, 0), (1, 0)]);
    return Ok(());
  }
  // A header that cannot be read points at no slot; its pieces are overwritten or removed below either way.
  let current = match get(store, ACCOUNT)?.map(parse) {
    Some(Ok(Stored::Pieces { slot, .. })) => Some(slot),
    _ => None,
  };
  let slot = current.map_or(0, |current| 1 - current);
  for (index, piece) in pieces.iter().enumerate() {
    set(store, &piece_account(slot, index), piece)?;
  }
  remove_pieces(store, slot, pieces.len())?;
  set(store, ACCOUNT, &header(slot, pieces.len(), value.len()))?;
  remove_leftovers(store, &[(1 - slot, 0)]);
  Ok(())
}

fn clear(store: &CredentialStore) -> Result<(), String> {
  // The header first: without it nothing loads, whatever pieces a cut-off clear leaves.
  delete(store, ACCOUNT)?;
  remove_pieces(store, 0, 0)?;
  remove_pieces(store, 1, 0)
}

/// Removes pieces nothing points at any more. The new value is saved already, so a failure here only leaves unused
/// entries, which the next save removes again.
fn remove_leftovers(store: &CredentialStore, slots: &[(usize, usize)]) {
  for &(slot, from) in slots {
    if let Err(error) = remove_pieces(store, slot, from) {
      log::warn!("Removing an old part of the sign-in from the keychain failed: {error}");
    }
  }
}

/// Removes the pieces of `slot` from index `from` on. Pieces are written from 0 up and removed from the last one
/// down, so the pieces in a slot always run from 0 without a gap, also after a save or removal that was cut off.
fn remove_pieces(store: &CredentialStore, slot: usize, from: usize) -> Result<(), String> {
  let mut end = from;
  while end < MAX_PIECES && get(store, &piece_account(slot, end))?.is_some() {
    end += 1;
  }
  for index in (from..end).rev() {
    delete(store, &piece_account(slot, index))?;
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use keyring_core::mock;

  fn store() -> Arc<CredentialStore> {
    mock::Store::new().unwrap()
  }

  fn token_set(length: usize) -> String {
    let body: String = (0..length).map(|index| char::from(b'a' + (index % 26) as u8)).collect();
    format!("{{\"accessToken\":\"{body}\"}}")
  }

  #[test]
  fn split_and_join_round_trip_a_long_value() {
    let value = token_set(4000);
    let pieces = split(&value, 1000);
    assert_eq!(pieces.len(), 5);
    assert!(pieces.iter().all(|piece| piece.encode_utf16().count() <= 1000));
    assert_eq!(join(pieces.into_iter().map(Some).collect(), value.len()), Some(value));
  }

  #[test]
  fn split_counts_utf16_units_and_never_cuts_a_character() {
    let value = "😀".repeat(10);
    let pieces = split(&value, 5);
    assert!(pieces.iter().all(|piece| piece.encode_utf16().count() <= 5));
    assert_eq!(pieces.concat(), value);
    assert_eq!(split("", 5), vec![String::new()]);
  }

  #[test]
  fn join_refuses_a_missing_or_changed_piece() {
    let pieces = split(&token_set(3000), 1000);
    let length = pieces.iter().map(String::len).sum();
    let mut missing: Vec<_> = pieces.iter().cloned().map(Some).collect();
    missing[1] = None;
    assert_eq!(join(missing, length), None);
    let mut shorter: Vec<_> = pieces.iter().cloned().map(Some).collect();
    shorter[2] = Some("x".to_string());
    assert_eq!(join(shorter, length), None);
  }

  #[test]
  fn a_long_value_round_trips_through_the_store_in_pieces() {
    let store = store();
    let value = token_set(4000);
    save(store.as_ref(), &value, 1000).unwrap();
    assert!(get(store.as_ref(), ACCOUNT).unwrap().unwrap().starts_with(HEADER));
    assert!(get(store.as_ref(), &piece_account(0, 4)).unwrap().is_some());
    assert_eq!(load(store.as_ref()).unwrap(), Some(value));
  }

  #[test]
  fn a_save_switches_slots_and_removes_the_old_pieces() {
    let store = store();
    save(store.as_ref(), &token_set(4000), 1000).unwrap();
    let next = token_set(2500);
    save(store.as_ref(), &next, 1000).unwrap();
    assert_eq!(load(store.as_ref()).unwrap(), Some(next.clone()));
    assert!(get(store.as_ref(), &piece_account(0, 0)).unwrap().is_none());
    assert!(get(store.as_ref(), &piece_account(1, 2)).unwrap().is_some());
    assert!(get(store.as_ref(), &piece_account(1, 3)).unwrap().is_none());
  }

  #[test]
  fn a_save_cut_off_before_the_header_leaves_the_previous_value_whole() {
    let store = store();
    let previous = token_set(4000);
    save(store.as_ref(), &previous, 1000).unwrap();
    // What a save that stopped after its pieces leaves behind: the other slot written, the header unchanged.
    for (index, piece) in split(&token_set(3500), 1000).iter().enumerate() {
      set(store.as_ref(), &piece_account(1, index), piece).unwrap();
    }
    assert_eq!(load(store.as_ref()).unwrap(), Some(previous));
    let next = token_set(1500);
    save(store.as_ref(), &next, 1000).unwrap();
    assert_eq!(load(store.as_ref()).unwrap(), Some(next));
    assert!(get(store.as_ref(), &piece_account(1, 2)).unwrap().is_none());
    assert!(get(store.as_ref(), &piece_account(0, 0)).unwrap().is_none());
  }

  #[test]
  fn a_missing_piece_is_reported_instead_of_loading_part_of_the_value() {
    let store = store();
    save(store.as_ref(), &token_set(4000), 1000).unwrap();
    delete(store.as_ref(), &piece_account(0, 2)).unwrap();
    assert_eq!(load(store.as_ref()), Err("the saved sign-in is incomplete".to_string()));
  }

  #[test]
  fn a_value_saved_as_one_entry_by_an_earlier_version_still_loads() {
    let store = store();
    set(store.as_ref(), ACCOUNT, "{\"accessToken\":\"old\"}").unwrap();
    assert_eq!(load(store.as_ref()).unwrap(), Some("{\"accessToken\":\"old\"}".to_string()));
  }

  #[test]
  fn a_short_value_is_one_entry_and_removes_earlier_pieces() {
    let store = store();
    save(store.as_ref(), &token_set(4000), 1000).unwrap();
    let short = token_set(10);
    save(store.as_ref(), &short, 1000).unwrap();
    assert_eq!(get(store.as_ref(), ACCOUNT).unwrap(), Some(short.clone()));
    assert!(get(store.as_ref(), &piece_account(0, 0)).unwrap().is_none());
    assert_eq!(load(store.as_ref()).unwrap(), Some(short));
  }

  #[test]
  fn without_a_limit_the_value_stays_one_entry() {
    let store = store();
    let value = token_set(4000);
    save(store.as_ref(), &value, usize::MAX).unwrap();
    assert_eq!(get(store.as_ref(), ACCOUNT).unwrap(), Some(value));
  }

  #[test]
  fn a_value_that_looks_like_a_header_is_stored_in_pieces() {
    let store = store();
    let value = format!("{HEADER}a:1:3");
    save(store.as_ref(), &value, usize::MAX).unwrap();
    assert_eq!(load(store.as_ref()).unwrap(), Some(value));
  }

  #[test]
  fn clear_removes_the_header_and_every_piece() {
    let store = store();
    save(store.as_ref(), &token_set(4000), 1000).unwrap();
    set(store.as_ref(), &piece_account(1, 0), "left over").unwrap();
    clear(store.as_ref()).unwrap();
    assert_eq!(load(store.as_ref()).unwrap(), None);
    for slot in 0..2 {
      assert!(get(store.as_ref(), &piece_account(slot, 0)).unwrap().is_none());
    }
    clear(store.as_ref()).unwrap();
  }

  #[test]
  fn an_unknown_header_is_an_error() {
    assert!(parse(format!("{HEADER}c:1:3")).is_err());
    assert!(parse(format!("{HEADER}a:0:3")).is_err());
    assert!(parse(format!("{HEADER}a:1")).is_err());
    assert_eq!(parse(format!("{HEADER}b:2:9")), Ok(Stored::Pieces { slot: 1, count: 2, length: 9 }));
  }

  #[test]
  fn a_store_that_failed_to_open_is_opened_again_on_the_next_call() {
    let mut keychain = None;
    assert!(open_once(&mut keychain, || Err(Error::NoDefaultStore)).is_err());
    assert!(keychain.is_none());
    let opened = open_once(&mut keychain, || Ok(store())).unwrap();
    let again = open_once(&mut keychain, || panic!("the store is open already")).unwrap();
    assert!(Arc::ptr_eq(&opened, &again));
  }

  #[test]
  fn waiting_for_a_running_command_ends_when_it_does_or_at_the_timeout() {
    let lock = Arc::new(Mutex::new(()));
    let held = lock.clone();
    let (started, wait_for_start) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
      let _guard = held.lock().unwrap();
      started.send(()).unwrap();
      std::thread::sleep(Duration::from_millis(100));
    });
    wait_for_start.recv().unwrap();
    assert!(!wait_until_free(&lock, Duration::from_millis(10)));
    assert!(wait_until_free(&lock, Duration::from_secs(5)));
    worker.join().unwrap();
  }
}
