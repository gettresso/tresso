//! The local mail copy's SQLite databases, for the web client (its `SqliteMailStore`). Each open database has a
//! connection that writes and one that reads: the client queues its writes, so the writer never meets another writer,
//! and in WAL mode readers see the last committed state without waiting for a write under way. The commands run off
//! the main thread, so the window stays responsive while SQLite works or waits.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, OpenFlags, params_from_iter};
use serde::Deserialize;
use serde_json::{Map, Number, Value};
use tauri::{AppHandle, Manager, State};

/// How many connections each file has open, so a file is never removed while one still uses it.
type Live = Arc<Mutex<HashMap<PathBuf, usize>>>;

struct Database {
  path: PathBuf,
  /// The web view page load that opened it (see `open`).
  page: String,
  writer: Mutex<Connection>,
  reader: Mutex<Connection>,
  live: Live,
}

impl Drop for Database {
  fn drop(&mut self) {
    // The connections close right after this (fields drop after `drop`), so the file counts as closed from here on:
    // nothing can use them any more.
    if let Ok(mut live) = self.live.lock()
      && let Some(count) = live.get_mut(&self.path)
    {
      *count -= 1;
      if *count == 0 {
        live.remove(&self.path);
      }
    }
  }
}

#[derive(Default)]
pub struct Databases {
  next: AtomicU32,
  open: Mutex<HashMap<u32, Arc<Database>>>,
  live: Live,
}

/// Which connection a statement runs on: reads outside a transaction use the reader, everything else the writer.
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum On {
  Reader,
  Writer,
}

fn unavailable<T>(_: T) -> String {
  "The mail copies are unavailable.".to_string()
}

/// Whether a database name is one the commands accept: letters, digits, `-` and `_`, so it cannot leave the folder.
fn valid_name(name: &str) -> bool {
  !name.is_empty() && name.len() <= 128 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Names come from the client (`tresso-mail-<user id>`); anything that could leave the folder is refused.
fn file(folder: &Path, name: &str) -> Result<PathBuf, String> {
  if !valid_name(name) {
    return Err(format!("\"{name}\" is not a valid database name."));
  }
  Ok(folder.join(format!("{name}.sqlite")))
}

/// The prefix of every mail copy's name (`tresso-mail-<user id>[-<server tag>]`, apps/web/src/mail/store.ts).
const COPY_PREFIX: &str = "tresso-mail-";

/// The copy name a file in the folder holds, if it is one of Tresso's mail copies: `<name>.sqlite` with a name that
/// starts with the copy prefix and passes the same check as open and delete. Its `-wal` and `-shm` files, and
/// anything else, are not copies.
fn copy_name(file_name: &str) -> Option<&str> {
  let name = file_name.strip_suffix(".sqlite")?;
  (name.len() > COPY_PREFIX.len() && name.starts_with(COPY_PREFIX) && valid_name(name)).then_some(name)
}

/// The names of the mail copies in `folder`, sorted; no paths. A folder that does not exist yet holds none.
fn list(folder: &Path) -> Result<Vec<String>, String> {
  let entries = match std::fs::read_dir(folder) {
    Ok(entries) => entries,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
    Err(error) => return Err(format!("Listing the mail copies failed: {error}")),
  };
  let mut names = Vec::new();
  for entry in entries {
    let entry = entry.map_err(|error| format!("Listing the mail copies failed: {error}"))?;
    if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
      continue;
    }
    if let Some(name) = entry.file_name().to_str().and_then(copy_name) {
      names.push(name.to_string());
    }
  }
  names.sort();
  Ok(names)
}

fn connect(path: &Path, flags: OpenFlags) -> Result<Connection, String> {
  let connection = Connection::open_with_flags(path, flags).map_err(|error| format!("Opening the mail copy failed: {error}"))?;
  // The reader can meet a checkpoint and the writer a reader finishing one; both wait a moment instead of failing.
  connection.busy_timeout(Duration::from_secs(5)).map_err(|error| error.to_string())?;
  Ok(connection)
}

fn to_sql(value: Value) -> Result<SqlValue, String> {
  match value {
    Value::Null => Ok(SqlValue::Null),
    Value::Bool(flag) => Ok(SqlValue::Integer(i64::from(flag))),
    Value::Number(number) => match number.as_i64() {
      Some(integer) => Ok(SqlValue::Integer(integer)),
      None => number.as_f64().map(SqlValue::Real).ok_or_else(|| format!("{number} cannot be stored.")),
    },
    Value::String(text) => Ok(SqlValue::Text(text)),
    other => Err(format!("{other} cannot be stored: only text, numbers and null are.")),
  }
}

fn to_json(value: ValueRef<'_>) -> Result<Value, String> {
  Ok(match value {
    ValueRef::Null => Value::Null,
    ValueRef::Integer(integer) => Value::Number(integer.into()),
    ValueRef::Real(real) => Number::from_f64(real).map(Value::Number).unwrap_or(Value::Null),
    ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).into_owned()),
    ValueRef::Blob(_) => return Err("The mail copy holds no binary data.".to_string()),
  })
}

fn bind(params: Vec<Value>) -> Result<Vec<SqlValue>, String> {
  params.into_iter().map(to_sql).collect()
}

impl Databases {
  /// Opens (or creates) a mail copy in `folder` for the web view page load `page`, and returns its handle.
  fn open(&self, folder: &Path, name: &str, page: &str) -> Result<u32, String> {
    let path = file(folder, name)?;
    let database = {
      // Held while connecting, so a delete of the same file cannot remove it between its check and this open.
      let mut live = self.live.lock().map_err(unavailable)?;
      std::fs::create_dir_all(folder).map_err(|error| format!("Creating the mail folder failed: {error}"))?;
      let writer = connect(&path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
      writer
        .execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
        .map_err(|error| format!("Preparing the mail copy failed: {error}"))?;
      let reader = connect(&path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
      *live.entry(path.clone()).or_insert(0) += 1;
      Arc::new(Database {
        path: path.clone(),
        page: page.to_string(),
        writer: Mutex::new(writer),
        reader: Mutex::new(reader),
        live: Arc::clone(&self.live),
      })
    };

    let handle = self.next.fetch_add(1, Ordering::Relaxed);
    let evicted: Vec<Arc<Database>> = {
      let mut open = self.open.lock().map_err(unavailable)?;
      // Handles of the same copy left by an earlier page load (the web view reloaded) can never be used again: they
      // go, and a transaction one of them left open is rolled back as its connection closes. Handles of this page
      // load stay, even when two of its opens overlap.
      let stale: Vec<u32> = open.iter().filter(|(_, other)| other.path == path && other.page != page).map(|(id, _)| *id).collect();
      let evicted = stale.iter().filter_map(|id| open.remove(id)).collect();
      open.insert(handle, database);
      evicted
    };
    // Dropped outside the lock: closing their connections takes the `live` lock.
    drop(evicted);
    Ok(handle)
  }

  fn database(&self, handle: u32) -> Result<Arc<Database>, String> {
    self.open.lock().map_err(unavailable)?.get(&handle).cloned().ok_or_else(|| "The mail copy is closed.".to_string())
  }

  fn connection(database: &Database, on: On) -> Result<MutexGuard<'_, Connection>, String> {
    match on {
      On::Reader => database.reader.lock(),
      On::Writer => database.writer.lock(),
    }
    .map_err(|_| "The mail copy is unavailable.".to_string())
  }

  fn exec(&self, handle: u32, source: &str) -> Result<(), String> {
    let database = self.database(handle)?;
    Self::connection(&database, On::Writer)?.execute_batch(source).map_err(|error| error.to_string())
  }

  /// Starts a write transaction. The client runs one at a time, so one still open was left by a write that failed
  /// halfway (or whose rollback failed): it is rolled back first instead of blocking every write after it.
  fn begin(&self, handle: u32) -> Result<(), String> {
    let database = self.database(handle)?;
    let writer = Self::connection(&database, On::Writer)?;
    if !writer.is_autocommit() {
      writer.execute_batch("ROLLBACK").map_err(|error| error.to_string())?;
    }
    writer.execute_batch("BEGIN IMMEDIATE").map_err(|error| error.to_string())
  }

  /// Ends the write transaction, if one is open; SQLite may have rolled it back already after an error.
  fn finish(&self, handle: u32, commit: bool) -> Result<(), String> {
    let database = self.database(handle)?;
    let writer = Self::connection(&database, On::Writer)?;
    if writer.is_autocommit() {
      return if commit { Err("The write was undone before it could be stored.".to_string()) } else { Ok(()) };
    }
    writer.execute_batch(if commit { "COMMIT" } else { "ROLLBACK" }).map_err(|error| error.to_string())
  }

  fn run(&self, handle: u32, source: &str, params: Vec<Value>) -> Result<(), String> {
    let database = self.database(handle)?;
    let params = bind(params)?;
    let connection = Self::connection(&database, On::Writer)?;
    let mut statement = connection.prepare_cached(source).map_err(|error| error.to_string())?;
    statement.execute(params_from_iter(params)).map_err(|error| error.to_string())?;
    Ok(())
  }

  fn select(&self, handle: u32, source: &str, params: Vec<Value>, on: On) -> Result<Vec<Map<String, Value>>, String> {
    let database = self.database(handle)?;
    let params = bind(params)?;
    let connection = Self::connection(&database, on)?;
    let mut statement = connection.prepare_cached(source).map_err(|error| error.to_string())?;
    let columns: Vec<String> = statement.column_names().into_iter().map(str::to_string).collect();
    let mut rows = statement.query(params_from_iter(params)).map_err(|error| error.to_string())?;
    let mut result = Vec::new();
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
      let mut object = Map::with_capacity(columns.len());
      for (index, column) in columns.iter().enumerate() {
        object.insert(column.clone(), to_json(row.get_ref(index).map_err(|error| error.to_string())?)?);
      }
      result.push(object);
    }
    Ok(result)
  }

  /// Closes a copy. Its handle stops working; closing one that is closed already does nothing. A read still running
  /// keeps its connection until it ends, and the file counts as open until then.
  fn close(&self, handle: u32) -> Result<(), String> {
    let removed = self.open.lock().map_err(unavailable)?.remove(&handle);
    if let Some(database) = removed {
      // Folds the write-ahead log back into the database, so a closed copy is a single file.
      if let Ok(writer) = database.writer.lock() {
        let _ = writer.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
      }
    }
    Ok(())
  }

  /// Removes a closed copy from `folder`. A copy any connection still uses is refused.
  fn delete(&self, folder: &Path, name: &str) -> Result<(), String> {
    let path = file(folder, name)?;
    // Held until the files are gone, so an open of the same copy waits instead of writing into a removed file.
    let live = self.live.lock().map_err(unavailable)?;
    if live.contains_key(&path) {
      return Err("The mail copy is still open.".to_string());
    }
    for suffix in ["", "-wal", "-shm"] {
      let file = PathBuf::from(format!("{}{suffix}", path.display()));
      match std::fs::remove_file(&file) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Removing the mail copy failed: {error}")),
      }
    }
    Ok(())
  }
}

fn folder(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(app.path().app_data_dir().map_err(|error| format!("The app's data folder is not known: {error}"))?.join("mail"))
}

#[tauri::command(async)]
pub fn sql_open(app: AppHandle, state: State<'_, Databases>, name: String, page: String) -> Result<u32, String> {
  state.open(&folder(&app)?, &name, &page)
}

/// Runs statements without results (several may be given at once, without parameters).
#[tauri::command(async)]
pub fn sql_exec(state: State<'_, Databases>, handle: u32, source: String) -> Result<(), String> {
  state.exec(handle, &source)
}

#[tauri::command(async)]
pub fn sql_begin(state: State<'_, Databases>, handle: u32) -> Result<(), String> {
  state.begin(handle)
}

#[tauri::command(async)]
pub fn sql_commit(state: State<'_, Databases>, handle: u32) -> Result<(), String> {
  state.finish(handle, true)
}

#[tauri::command(async)]
pub fn sql_rollback(state: State<'_, Databases>, handle: u32) -> Result<(), String> {
  state.finish(handle, false)
}

/// Runs one statement that changes the copy.
#[tauri::command(async)]
pub fn sql_run(state: State<'_, Databases>, handle: u32, source: String, params: Vec<Value>) -> Result<(), String> {
  state.run(handle, &source, params)
}

/// Runs one query and returns its rows as objects keyed by column name.
#[tauri::command(async)]
pub fn sql_select(state: State<'_, Databases>, handle: u32, source: String, params: Vec<Value>, on: On) -> Result<Vec<Map<String, Value>>, String> {
  state.select(handle, &source, params, on)
}

#[tauri::command(async)]
pub fn sql_close(state: State<'_, Databases>, handle: u32) -> Result<(), String> {
  state.close(handle)
}

/// Removes a closed copy from the computer, e.g. on sign-out.
#[tauri::command(async)]
pub fn sql_delete(app: AppHandle, state: State<'_, Databases>, name: String) -> Result<(), String> {
  state.delete(&folder(&app)?, &name)
}

/// The names of the mail copies on this computer (no paths), so the client finds copies an earlier release left
/// without listing them.
#[tauri::command(async)]
pub fn sql_list(app: AppHandle) -> Result<Vec<String>, String> {
  list(&folder(&app)?)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  /// A folder of its own per test, removed when the test ends.
  struct Folder(PathBuf);

  impl std::ops::Deref for Folder {
    type Target = Path;
    fn deref(&self) -> &Path {
      &self.0
    }
  }

  impl Drop for Folder {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  fn folder() -> Folder {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let folder = std::env::temp_dir().join(format!("tresso-sql-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&folder).unwrap();
    Folder(folder)
  }

  fn count(databases: &Databases, handle: u32, on: On) -> i64 {
    let rows = databases.select(handle, "SELECT COUNT(*) AS n FROM t", vec![], on).unwrap();
    rows[0]["n"].as_i64().unwrap()
  }

  #[test]
  fn converts_values_both_ways() {
    assert!(matches!(to_sql(Value::Null), Ok(SqlValue::Null)));
    assert!(matches!(to_sql(json!(42)), Ok(SqlValue::Integer(42))));
    assert!(matches!(to_sql(json!(1.5)), Ok(SqlValue::Real(r)) if (r - 1.5).abs() < f64::EPSILON));
    assert!(matches!(to_sql(json!("x")), Ok(SqlValue::Text(t)) if t == "x"));
    assert!(to_sql(json!([1])).is_err());

    assert_eq!(to_json(ValueRef::Integer(7)), Ok(json!(7)));
    assert_eq!(to_json(ValueRef::Text(b"hi")), Ok(json!("hi")));
    assert!(to_json(ValueRef::Blob(b"x")).is_err());
  }

  #[test]
  fn refuses_names_that_leave_the_folder() {
    let databases = Databases::default();
    let folder = folder();
    for name in ["", "../x", "a/b", "a.b", "a b", &"x".repeat(129)] {
      assert!(databases.open(&folder, name, "page").is_err(), "{name:?} was accepted");
      assert!(databases.delete(&folder, name).is_err(), "{name:?} was accepted");
    }
    assert!(databases.open(&folder, "tresso-mail-0a1B_c", "page").is_ok());
  }

  #[test]
  fn readers_see_only_committed_writes() {
    let databases = Databases::default();
    let folder = folder();
    let handle = databases.open(&folder, "copy", "page").unwrap();
    databases.exec(handle, "CREATE TABLE t (v TEXT)").unwrap();

    databases.begin(handle).unwrap();
    databases.run(handle, "INSERT INTO t (v) VALUES (?)", vec![json!("a")]).unwrap();
    assert_eq!(count(&databases, handle, On::Writer), 1);
    assert_eq!(count(&databases, handle, On::Reader), 0);
    databases.finish(handle, true).unwrap();
    assert_eq!(count(&databases, handle, On::Reader), 1);

    databases.begin(handle).unwrap();
    databases.run(handle, "INSERT INTO t (v) VALUES (?)", vec![json!("b")]).unwrap();
    databases.finish(handle, false).unwrap();
    assert_eq!(count(&databases, handle, On::Reader), 1);
  }

  #[test]
  fn rolls_back_a_transaction_left_open_before_starting_the_next() {
    let databases = Databases::default();
    let folder = folder();
    let handle = databases.open(&folder, "copy", "page").unwrap();
    databases.exec(handle, "CREATE TABLE t (v TEXT)").unwrap();
    databases.begin(handle).unwrap();
    databases.run(handle, "INSERT INTO t (v) VALUES ('left')", vec![]).unwrap();

    databases.begin(handle).unwrap();
    databases.finish(handle, true).unwrap();

    assert_eq!(count(&databases, handle, On::Reader), 0);
    // Rolling back when nothing is open is fine; committing then says the write was lost.
    assert!(databases.finish(handle, false).is_ok());
    assert!(databases.finish(handle, true).is_err());
  }

  #[test]
  fn drops_handles_of_a_reloaded_web_view_and_their_open_transaction() {
    let databases = Databases::default();
    let folder = folder();
    let stale = databases.open(&folder, "copy", "before reload").unwrap();
    databases.exec(stale, "CREATE TABLE t (v TEXT)").unwrap();
    databases.begin(stale).unwrap();
    databases.run(stale, "INSERT INTO t (v) VALUES ('half')", vec![]).unwrap();

    let fresh = databases.open(&folder, "copy", "after reload").unwrap();

    assert!(databases.exec(stale, "SELECT 1").is_err());
    assert_eq!(count(&databases, fresh, On::Reader), 0);
    databases.begin(fresh).unwrap();
    databases.finish(fresh, true).unwrap();
  }

  #[test]
  fn keeps_both_handles_when_opens_of_one_page_load_overlap() {
    let databases = Databases::default();
    let folder = folder();
    let first = databases.open(&folder, "copy", "page").unwrap();
    let second = databases.open(&folder, "copy", "page").unwrap();

    databases.exec(first, "CREATE TABLE t (v TEXT)").unwrap();
    assert_eq!(count(&databases, second, On::Reader), 0);
    databases.close(first).unwrap();
    assert!(databases.delete(&folder, "copy").is_err());
    databases.close(second).unwrap();
    databases.delete(&folder, "copy").unwrap();
  }

  #[test]
  fn deletes_a_copy_only_once_nothing_uses_it() {
    let databases = Databases::default();
    let folder = folder();
    let handle = databases.open(&folder, "copy", "page").unwrap();
    databases.exec(handle, "CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('x')").unwrap();
    assert!(databases.delete(&folder, "copy").is_err());

    // A read that started before the copy closed still holds it.
    let in_flight = databases.database(handle).unwrap();
    databases.close(handle).unwrap();
    assert!(databases.exec(handle, "SELECT 1").is_err());
    assert!(databases.delete(&folder, "copy").is_err());
    drop(in_flight);

    databases.delete(&folder, "copy").unwrap();
    assert!(!folder.join("copy.sqlite").exists());
    assert!(!folder.join("copy.sqlite-wal").exists());
    // Closing and deleting again is fine.
    databases.close(handle).unwrap();
    databases.delete(&folder, "copy").unwrap();
  }

  #[test]
  fn names_only_tressos_own_mail_copies() {
    assert_eq!(copy_name("tresso-mail-0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.sqlite"), Some("tresso-mail-0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"));
    assert_eq!(copy_name("tresso-mail-u1-1a2b3c4d.sqlite"), Some("tresso-mail-u1-1a2b3c4d"));
    // The write-ahead log and shared memory files of a copy, the bare prefix, other files and names the commands refuse.
    for file_name in ["tresso-mail-u1.sqlite-wal", "tresso-mail-u1.sqlite-shm", "tresso-mail-.sqlite", "other.sqlite", "tresso-mail-u1.db", "tresso-mail-u 1.sqlite", "tresso-mail-..sqlite"] {
      assert_eq!(copy_name(file_name), None, "{file_name}");
    }
  }

  #[test]
  fn lists_the_copies_in_the_folder_and_nothing_else() {
    let folder = folder();
    let databases = Databases::default();
    let handle = databases.open(&folder, "tresso-mail-u2", "page").unwrap();
    databases.exec(handle, "CREATE TABLE t (x INTEGER)").unwrap();
    std::fs::write(folder.join("tresso-mail-u1.sqlite"), b"").unwrap();
    std::fs::write(folder.join("notes.txt"), b"").unwrap();
    std::fs::create_dir(folder.join("tresso-mail-dir.sqlite")).unwrap();

    assert_eq!(list(&folder).unwrap(), vec!["tresso-mail-u1".to_string(), "tresso-mail-u2".to_string()]);
    assert_eq!(list(&folder.join("missing")).unwrap(), Vec::<String>::new());
    databases.close(handle).unwrap();
  }
}
