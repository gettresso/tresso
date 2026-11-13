//! The menu bar of the macOS app, after the Human Interface Guidelines: the app menu, File, Edit, View, Mailbox,
//! Message, Window and Help, with the standard names, order and shortcuts of a Mac mail app. Every item does something
//! real. What the web client does (a new message, a view, Settings, a reply, an archive) reaches it as the `menu` event
//! with the action's name (MENU_EVENT, apps/web/src/platform/menu.ts). The web client says through one command
//! (`menu_state`) whether someone is signed in, whether a conversation is open, whether text is being edited, and
//! what the sidebar and the open conversation are like: the items that act in it are enabled after that, and View >
//! Show Sidebar, Message > Mark as Read and Message > Flag are named after it. The
//! standard items are AppKit's own, so they act on the focused web content: Undo, Cut, Paste and Match Style, Full
//! Screen, Minimize. The shell does the rest itself: updates, Reload, the main window, Help.
//!
//! Windows and Linux keep what the app shows there today: no menu bar. Tauri only makes a default menu on macOS, and
//! the window there has none.
//!
//! The bar is described as data ([`bar`]), so its order, ids and shortcuts are tested without a running app.

/// The event the web client hears the menu's actions on; the payload is the action's name.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const MENU_EVENT: &str = "menu";

/// The item that asks Sparkle for updates (updates.rs).
pub const CHECK_FOR_UPDATES: &str = "check-for-updates";

/// View > Hide Sidebar or Show Sidebar: the web client shows and hides its sidebar (platform/frame.ts).
pub const TOGGLE_SIDEBAR: &str = "toggle-sidebar";

/// The sidebar item's title, after what it does now: AppKit's own names for it.
pub fn sidebar_label(shown: bool) -> &'static str {
  if shown { "Hide Sidebar" } else { "Show Sidebar" }
}

/// Message > Mark as Read or Mark as Unread: the open conversation is marked read or unread (the reading pane).
pub const TOGGLE_READ: &str = "toggle-read";

/// The read item's title, after what it would do: Mail's own names for it. A conversation is read when all its
/// messages are.
pub fn read_label(read: bool) -> &'static str {
  if read { "Mark as Unread" } else { "Mark as Read" }
}

/// Message > Flag or Unflag: the open conversation is flagged, or its flags are taken off (the reading pane).
pub const TOGGLE_FLAG: &str = "toggle-flag";

/// Message > Make To-do: disabled once the conversation has a to-do, as the pane then shows no button for it.
pub const MAKE_TODO: &str = "make-todo";

/// Mailbox > Outbox: enabled only while the sidebar lists the Outbox (while mail waits in it).
pub const GO_OUTBOX: &str = "go-outbox";

/// The flag item's title, after what it would do. A conversation is flagged when one of its messages is.
pub fn flag_label(flagged: bool) -> &'static str {
  if flagged { "Unflag" } else { "Flag" }
}

/// The project's home: the updater's endpoint in tauri.conf.json lives under it (a test keeps the two together). The
/// app has no help pages of its own; its README is the documentation.
#[cfg_attr(not(test), allow(dead_code))]
pub const REPOSITORY: &str = "https://github.com/gettresso/tresso";
/// Help > Tresso Help.
pub const HELP_URL: &str = "https://github.com/gettresso/tresso#readme";
/// Help > Release Notes.
pub const RELEASE_NOTES_URL: &str = "https://github.com/gettresso/tresso/releases";

/// What a menu item of our own does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum Action {
  /// Sent to the web client as MENU_EVENT with this name. It needs someone signed in, so it is disabled until the web
  /// client says so (`menu_state`).
  Web(&'static str),
  /// Sent to the web client like Web, but it acts signed out too (Reload).
  WebAlways(&'static str),
  /// Sent to the web client like Web; it acts on the conversation open in the reading pane, so it is enabled only
  /// while someone is signed in and a conversation is open (`menu_state`), and, after [`Typing`], not while text is
  /// being edited.
  Message(&'static str, Typing),
  /// Done by the shell itself.
  Shell(Shell),
}

/// Whether a Message item acts while text is being edited. Which sees a key first, the menu or the page, is not relied
/// on: AppKit asks the menu for a key equivalent, but wry hands performKeyEquivalent to WKWebView, and WebKit may give
/// the key to the page first and send only what the page left alone back to the menu. Either way is safe for an item
/// that waits: when the menu comes first, the item is disabled while text is edited, so the key goes on to the text;
/// when the page comes first, the text field takes the key (⌘⌫ deletes, ⇧⌘U underlines), and should the key still
/// reach the menu, the web client checks the focus again when the action arrives and does nothing while text is edited.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Typing {
  /// It acts: its shortcut means nothing to a text field.
  Acts,
  /// It is disabled while a text field or the composer has the focus, as a Mac app disables what does not apply to
  /// the focused view: its shortcut edits text there (⌘⌫ deletes to the start of the line, ⇧⌘U underlines).
  Waits,
}

/// Whether the item acts in the web client only while someone is signed in: those are the items `menu_state` enables
/// and disables. The one rule both the bar's setup and its tests use.
pub fn needs_sign_in(action: Action) -> bool {
  matches!(action, Action::Web(_) | Action::Message(..))
}

/// What the web client says through `menu_state`: the items that act in it follow it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MenuState {
  /// Someone is signed in and may use the app.
  pub signed_in: bool,
  /// The sidebar shows (View > Hide Sidebar).
  pub sidebar_shown: bool,
  /// A text field or the composer has the focus.
  pub editing: bool,
  /// Mail waits in the Outbox, so the sidebar lists it (Mailbox > Outbox).
  pub outbox: bool,
  /// The conversation open in the reading pane, while it has the user's attention; None while none is open.
  pub message: Option<OpenMessage>,
}

/// The conversation open in the reading pane, as far as the menu's titles and Make To-do need it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenMessage {
  /// All its messages are read (Mark as Unread).
  pub read: bool,
  /// One of its messages is flagged (Unflag).
  pub flagged: bool,
  /// A to-do was made from it already: the pane shows no Make todo button, and Make To-do is disabled.
  pub has_todo: bool,
}

/// Whether an item `menu_state` manages acts in this state. Items it does not manage (Reload, the shell's) keep what
/// they are; for them this is true.
pub fn enabled_in(action: Action, state: &MenuState) -> bool {
  match action {
    Action::Web(GO_OUTBOX) => state.signed_in && state.outbox,
    Action::Web(_) => state.signed_in,
    Action::Message(name, typing) => {
      let Some(message) = state.message.filter(|_| state.signed_in) else {
        return false;
      };
      !(typing == Typing::Waits && state.editing) && !(name == MAKE_TODO && message.has_todo)
    }
    Action::WebAlways(_) | Action::Shell(_) => true,
  }
}

/// What a Message item does with its action. It acts on the conversation on screen: while the window is closed
/// (hidden) or minimized none is, so the item only brings the window back (the conversation the window held is not
/// acted on unseen).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub enum Delivery {
  /// Sent to the web client.
  Send,
  /// Only the window comes back.
  ShowOnly,
}

/// Whether an action goes to the web client, given whether the main window is on screen (visible, not minimized).
/// Only the Message menu's actions depend on it: the others act wherever the window is, after it comes back.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub fn delivery(action: Action, window_on_screen: bool) -> Delivery {
  match action {
    Action::Message(..) if !window_on_screen => Delivery::ShowOnly,
    _ => Delivery::Send,
  }
}

/// The ids of the items `menu_state` enables and disables, in the bar's order.
#[cfg(test)]
pub fn signed_in_ids() -> Vec<&'static str> {
  bar()
    .into_iter()
    .flat_map(|submenu| submenu.entries)
    .filter_map(|entry| match entry {
      Entry::Item { id, action, .. } if needs_sign_in(action) => Some(id),
      _ => None,
    })
    .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum Shell {
  /// Sparkle's "Check for Updates…"; disabled when Sparkle does not run (a development build).
  CheckForUpdates,
  /// Shows the main window again, also after it was closed (Window > Tresso).
  ShowMainWindow,
  /// Opens a web page in the user's browser.
  Open(&'static str),
}

/// AppKit's standard items. Each acts on the key window and its focused content, as in every Mac app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum Native {
  About,
  Services,
  Hide,
  HideOthers,
  ShowAll,
  Quit,
  CloseWindow,
  Undo,
  Redo,
  Cut,
  Copy,
  Paste,
  /// AppKit's `pasteAsPlainText:`, which Tauri has no item for: added to the Edit menu natively.
  PasteAndMatchStyle,
  /// AppKit's `delete:`, which Tauri has no item for: added to the Edit menu natively.
  Delete,
  SelectAll,
  EnterFullScreen,
  Minimize,
  Zoom,
  BringAllToFront,
}

impl Native {
  /// The shortcut AppKit gives the item, for the test that no two items share one.
  #[cfg_attr(not(test), allow(dead_code))]
  pub fn accelerator(self) -> Option<&'static str> {
    match self {
      Native::Hide => Some("Cmd+H"),
      Native::HideOthers => Some("Alt+Cmd+H"),
      Native::Quit => Some("Cmd+Q"),
      Native::CloseWindow => Some("Cmd+W"),
      Native::Undo => Some("Cmd+Z"),
      Native::Redo => Some("Shift+Cmd+Z"),
      Native::Cut => Some("Cmd+X"),
      Native::Copy => Some("Cmd+C"),
      Native::Paste => Some("Cmd+V"),
      Native::PasteAndMatchStyle => Some("Alt+Shift+Cmd+V"),
      Native::SelectAll => Some("Cmd+A"),
      Native::EnterFullScreen => Some("Ctrl+Cmd+F"),
      Native::Minimize => Some("Cmd+M"),
      Native::About | Native::Services | Native::ShowAll | Native::Delete | Native::Zoom | Native::BringAllToFront => None,
    }
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Entry {
  Item { id: &'static str, label: &'static str, accelerator: Option<&'static str>, action: Action },
  Native(Native),
  Separator,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Submenu {
  /// Tauri's ids for the Window and Help menus, which it hands to AppKit as such (the window list, Help's search).
  pub id: Option<&'static str>,
  pub title: &'static str,
  pub entries: Vec<Entry>,
}

const fn web(id: &'static str, label: &'static str, accelerator: Option<&'static str>) -> Entry {
  Entry::Item { id, label, accelerator, action: Action::Web(id) }
}

const fn message(id: &'static str, label: &'static str, accelerator: Option<&'static str>, typing: Typing) -> Entry {
  Entry::Item { id, label, accelerator, action: Action::Message(id, typing) }
}

/// The macOS menu bar, in order.
pub fn bar() -> Vec<Submenu> {
  use Entry::{Native as N, Separator};
  vec![
    Submenu {
      id: None,
      title: "Tresso",
      entries: vec![
        N(Native::About),
        // Directly after About, as Sparkle's own apps place it.
        Entry::Item { id: CHECK_FOR_UPDATES, label: "Check for Updates…", accelerator: None, action: Action::Shell(Shell::CheckForUpdates) },
        Separator,
        web("settings", "Settings…", Some("Cmd+,")),
        Separator,
        N(Native::Services),
        Separator,
        N(Native::Hide),
        N(Native::HideOthers),
        N(Native::ShowAll),
        Separator,
        N(Native::Quit),
      ],
    },
    Submenu {
      id: None,
      title: "File",
      entries: vec![
        web("new-message", "New Message", Some("Cmd+N")),
        // The web client's own shortcut for these is a single key in their view ("N" in the calendar), which a menu
        // cannot take; they get none here.
        web("new-event", "New Event", None),
        web("new-todo", "New To-do", None),
        Separator,
        N(Native::CloseWindow),
      ],
    },
    Submenu {
      id: None,
      title: "Edit",
      entries: vec![
        N(Native::Undo),
        N(Native::Redo),
        Separator,
        N(Native::Cut),
        N(Native::Copy),
        N(Native::Paste),
        N(Native::PasteAndMatchStyle),
        N(Native::Delete),
        N(Native::SelectAll),
        Separator,
        web("find", "Find…", Some("Cmd+F")),
      ],
    },
    Submenu {
      id: None,
      title: "View",
      entries: vec![
        // The web client moves between these by clicks only (its keys act within a view), so no shortcuts.
        web("view-inbox", "Inbox", None),
        web("view-triage", "Triage", None),
        web("view-todos", "To-dos", None),
        web("view-calendar", "Calendar", None),
        web("view-search", "Search", None),
        Separator,
        // The standard shortcut of every Mac app with a sidebar. Its title follows the sidebar (`menu_state`); the
        // sidebar starts shown, as the web client's does on a first launch.
        web(TOGGLE_SIDEBAR, sidebar_label(true), Some("Ctrl+Cmd+S")),
        Separator,
        // Loads the web client again, after it saved the draft and waited for files and a send under way, as before a
        // restart for an update (the web client does it: platform/menu.ts). No ⌘R: other mail apps answer with it.
        Entry::Item { id: "reload", label: "Reload", accelerator: None, action: Action::WebAlways("reload") },
        N(Native::EnterFullScreen),
      ],
    },
    Submenu {
      id: None,
      title: "Mailbox",
      entries: vec![
        // Mail's own name and shortcut: the web client pulls what changed on the server now (the mail store's syncNow).
        web("get-new-mail", "Get New Mail", Some("Shift+Cmd+N")),
        Separator,
        // The sidebar's fixed places, in its order, except those View lists already (Inbox, Triage, To-dos, Calendar).
        // No smart inboxes or accounts: those are the user's own, not fixed. No shortcuts, as for View's places.
        web("go-brief", "Daily Brief", None),
        web("go-waiting", "Waiting On", None),
        web("go-drafts", "Drafts", None),
        web("go-cleanup", "Clean Up", None),
        // Listed in the sidebar only while mail waits in it, and enabled only then (`menu_state`).
        web(GO_OUTBOX, "Outbox", None),
        web("go-batches", "Batches", None),
      ],
    },
    Submenu {
      id: None,
      title: "Message",
      entries: vec![
        // Mail's names and shortcuts. They act on the conversation open in the reading pane, as its buttons do, and on
        // nothing while none has the user's attention (`menu_state`) or the window is not on screen ([`delivery`]).
        message("reply", "Reply", Some("Cmd+R"), Typing::Acts),
        message("reply-all", "Reply All", Some("Shift+Cmd+R"), Typing::Acts),
        message("forward", "Forward", Some("Shift+Cmd+F"), Typing::Acts),
        Separator,
        message("archive", "Archive", Some("Ctrl+Cmd+A"), Typing::Acts),
        // The reading pane's own name for it; "Delete" is Edit > Delete, which deletes the selected text.
        message("move-to-trash", "Move to Trash", Some("Cmd+Backspace"), Typing::Waits),
        // Opens the reading pane's folder menu.
        message("move-to", "Move to…", None, Typing::Acts),
        Separator,
        // Their titles follow the open conversation (`menu_state`): opening one reads it, so it starts as Mark as
        // Unread. ⇧⌘U underlines in the composer, so it waits while text is edited.
        message(TOGGLE_READ, read_label(true), Some("Shift+Cmd+U"), Typing::Waits),
        message(TOGGLE_FLAG, flag_label(false), Some("Shift+Cmd+L"), Typing::Acts),
        Separator,
        // The reading pane's own verdicts and to-do, as its buttons name them (D, H, K and T there: single keys, which a
        // menu cannot take, and no standard shortcut fits them).
        message("settle-do", "Do", None, Typing::Acts),
        message("hand-over", "Hand Over…", None, Typing::Acts),
        message("settle-noted", "Noted", None, Typing::Acts),
        message(MAKE_TODO, "Make To-do", None, Typing::Acts),
      ],
    },
    Submenu {
      id: Some(tauri::menu::WINDOW_SUBMENU_ID),
      title: "Window",
      entries: vec![
        N(Native::Minimize),
        N(Native::Zoom),
        Separator,
        N(Native::BringAllToFront),
        Separator,
        // The main window as Mail's Message Viewer: it is left out of AppKit's own list (which drops a closed, hidden
        // window), so it is listed once, also after Close Window.
        Entry::Item { id: "main-window", label: "Tresso", accelerator: Some("Cmd+0"), action: Action::Shell(Shell::ShowMainWindow) },
      ],
    },
    Submenu {
      id: Some(tauri::menu::HELP_SUBMENU_ID),
      title: "Help",
      entries: vec![
        Entry::Item { id: "help", label: "Tresso Help", accelerator: None, action: Action::Shell(Shell::Open(HELP_URL)) },
        // No "Keyboard Shortcuts": the web client has no overview of them to open.
        Entry::Item { id: "release-notes", label: "Release Notes", accelerator: None, action: Action::Shell(Shell::Open(RELEASE_NOTES_URL)) },
      ],
    },
  ]
}

/// The action of the item with this id.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn action_of(id: &str) -> Option<Action> {
  bar().into_iter().flat_map(|submenu| submenu.entries).find_map(|entry| match entry {
    Entry::Item { id: item, action, .. } if item == id => Some(action),
    _ => None,
  })
}

/// A menu item that can be enabled and disabled, and renamed: Tauri's, or a test's.
pub trait Toggle {
  fn set_enabled(&self, enabled: bool) -> Result<(), String>;
  fn set_text(&self, text: &str) -> Result<(), String>;
}

impl<R: tauri::Runtime> Toggle for tauri::menu::MenuItem<R> {
  fn set_enabled(&self, enabled: bool) -> Result<(), String> {
    tauri::menu::MenuItem::set_enabled(self, enabled).map_err(|error| error.to_string())
  }

  fn set_text(&self, text: &str) -> Result<(), String> {
    tauri::menu::MenuItem::set_text(self, text).map_err(|error| error.to_string())
  }
}

/// The items the web client acts on, by id, with what they do: enabled after `menu_state`. Managed once (lib.rs); the
/// bar's setup fills it, as Tauri keeps the first value managed for a type and ignores a second.
pub struct MenuItems<T: Toggle = tauri::menu::MenuItem<tauri::Wry>>(std::sync::Mutex<Vec<(&'static str, Action, T)>>);

impl<T: Toggle> Default for MenuItems<T> {
  fn default() -> Self {
    Self(std::sync::Mutex::new(Vec::new()))
  }
}

impl<T: Toggle> MenuItems<T> {
  /// Takes the items the bar was built with.
  #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
  pub fn fill(&self, items: Vec<(&'static str, Action, T)>) -> Result<(), String> {
    self.0.lock().map_err(|error| error.to_string())?.extend(items);
    Ok(())
  }

  /// Enables each item as the state says ([`enabled_in`]) and names the items whose titles follow it: Hide Sidebar or
  /// Show Sidebar, Mark as Unread or Mark as Read, Unflag or Flag (with no conversation open, the titles it starts with).
  /// Nothing where the app has no menu bar.
  pub fn apply(&self, state: &MenuState) -> Result<(), String> {
    for (id, action, item) in self.0.lock().map_err(|error| error.to_string())?.iter() {
      item.set_enabled(enabled_in(*action, state))?;
      match *id {
        TOGGLE_SIDEBAR => item.set_text(sidebar_label(state.sidebar_shown))?,
        TOGGLE_READ => item.set_text(read_label(state.message.is_none_or(|message| message.read)))?,
        TOGGLE_FLAG => item.set_text(flag_label(state.message.is_some_and(|message| message.flagged)))?,
        _ => {}
      }
    }
    Ok(())
  }

  #[cfg(test)]
  fn ids(&self) -> Vec<&'static str> {
    self.0.lock().unwrap().iter().map(|(id, ..)| *id).collect()
  }
}

/// The web client says whether someone is signed in (and may use the app), whether its sidebar shows, whether text is
/// being edited, and which conversation is open (None while none is): the items that act in it follow, and the items
/// whose titles follow the state are named after what they would do. It says so once per change, not per key.
///
/// Every item is changed in one task on the main thread: each of Tauri's setters runs there at once from it, where from
/// another thread each would wait for a hop of its own.
#[tauri::command]
pub fn menu_state<R: tauri::Runtime>(app: tauri::AppHandle<R>, signed_in: bool, sidebar_shown: bool, editing: bool, outbox: bool, message: Option<OpenMessage>) -> Result<(), String> {
  let state = MenuState { signed_in, sidebar_shown, editing, outbox, message };
  let handle = app.clone();
  app
    .run_on_main_thread(move || {
      use tauri::Manager;

      if let Err(error) = handle.state::<MenuItems<tauri::menu::MenuItem<R>>>().apply(&state) {
        log::error!("The menu could not follow the app's state: {error}");
      }
    })
    .map_err(|error| error.to_string())
}

/// The bar's items of our own, in its order, each enabled as it starts: the items that act in the web client wait for
/// `menu_state`, Check for Updates for Sparkle (`updates`).
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub fn own_items<R: tauri::Runtime, M: tauri::Manager<R>>(manager: &M, updates: bool) -> tauri::Result<Vec<(&'static str, Action, tauri::menu::MenuItem<R>)>> {
  let mut items = Vec::new();
  for entry in bar().into_iter().flat_map(|submenu| submenu.entries) {
    if let Entry::Item { id, label, accelerator, action } = entry {
      let enabled = match action {
        Action::Shell(Shell::CheckForUpdates) => updates,
        action => !needs_sign_in(action),
      };
      items.push((id, action, tauri::menu::MenuItem::with_id(manager, id, label, enabled, accelerator)?));
    }
  }
  Ok(items)
}

/// What `menu_state` enables and disables: the items among `own_items` that need someone signed in.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub fn for_signed_in<R: tauri::Runtime>(items: &[(&'static str, Action, tauri::menu::MenuItem<R>)]) -> Vec<(&'static str, Action, tauri::menu::MenuItem<R>)> {
  items.iter().filter(|(_, action, _)| needs_sign_in(*action)).cloned().collect()
}

/// Brings the main window to the front, also from hidden (a closed window on macOS): for a click on a notification,
/// which opens what it is about in the window.
#[tauri::command]
pub fn show_main_window_command<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
  show_main_window(&app);
}

/// Builds the menu bar and handles its items (macOS). `updates`: whether Sparkle runs, so Check for Updates can act.
#[cfg(target_os = "macos")]
pub fn setup(app: &tauri::App, updates: bool) -> tauri::Result<()> {
  use tauri::Manager;
  use tauri::menu::{IsMenuItem, Menu, PredefinedMenuItem};

  let handle = app.handle();
  let own = own_items(handle, updates)?;
  let mut submenus = Vec::new();
  for spec in bar() {
    let submenu = match spec.id {
      Some(id) => tauri::menu::Submenu::with_id(handle, id, spec.title, true)?,
      None => tauri::menu::Submenu::new(handle, spec.title, true)?,
    };
    for entry in &spec.entries {
      match *entry {
        Entry::Separator => submenu.append(&PredefinedMenuItem::separator(handle)?)?,
        Entry::Native(native) => {
          if let Some(item) = predefined(handle, native)? {
            submenu.append(&item)?;
          }
        }
        Entry::Item { id, .. } => {
          if let Some((_, _, item)) = own.iter().find(|(own_id, ..)| *own_id == id) {
            submenu.append(item)?;
          }
        }
      }
    }
    submenus.push(submenu);
  }
  let items: Vec<&dyn IsMenuItem<tauri::Wry>> = submenus.iter().map(|submenu| submenu as &dyn IsMenuItem<tauri::Wry>).collect();
  app.set_menu(Menu::with_items(handle, &items)?)?;
  // After set_menu's own work on the main thread, which made it AppKit's main menu.
  app.run_on_main_thread(appkit::add_edit_actions)?;
  // Into the state lib.rs manages: a second manage() of the type would be ignored, leaving menu_state nothing to enable.
  app.state::<MenuItems>().fill(for_signed_in(&own)).map_err(|error| tauri::Error::Io(std::io::Error::other(error)))?;
  app.on_menu_event(|app, event| run(app, event.id().as_ref()));
  Ok(())
}

/// Tauri's item for an AppKit standard item; None for the two Tauri has none for, which appkit.rs adds.
#[cfg(target_os = "macos")]
fn predefined(handle: &tauri::AppHandle, native: Native) -> tauri::Result<Option<tauri::menu::PredefinedMenuItem<tauri::Wry>>> {
  use tauri::menu::{AboutMetadata, PredefinedMenuItem};

  Ok(Some(match native {
    Native::About => {
      let package = handle.package_info();
      let about = AboutMetadata { name: Some(package.name.clone()), version: Some(package.version.to_string()), ..Default::default() };
      PredefinedMenuItem::about(handle, Some("About Tresso"), Some(about))?
    }
    Native::Services => PredefinedMenuItem::services(handle, None)?,
    Native::Hide => PredefinedMenuItem::hide(handle, Some("Hide Tresso"))?,
    Native::HideOthers => PredefinedMenuItem::hide_others(handle, None)?,
    Native::ShowAll => PredefinedMenuItem::show_all(handle, None)?,
    Native::Quit => PredefinedMenuItem::quit(handle, Some("Quit Tresso"))?,
    Native::CloseWindow => PredefinedMenuItem::close_window(handle, Some("Close Window"))?,
    Native::Undo => PredefinedMenuItem::undo(handle, None)?,
    Native::Redo => PredefinedMenuItem::redo(handle, None)?,
    Native::Cut => PredefinedMenuItem::cut(handle, None)?,
    Native::Copy => PredefinedMenuItem::copy(handle, None)?,
    Native::Paste => PredefinedMenuItem::paste(handle, None)?,
    Native::SelectAll => PredefinedMenuItem::select_all(handle, None)?,
    // AppKit names it Enter or Exit Full Screen as the window is.
    Native::EnterFullScreen => PredefinedMenuItem::fullscreen(handle, Some("Enter Full Screen"))?,
    Native::Minimize => PredefinedMenuItem::minimize(handle, None)?,
    // `performZoom:` on macOS.
    Native::Zoom => PredefinedMenuItem::maximize(handle, Some("Zoom"))?,
    Native::BringAllToFront => PredefinedMenuItem::bring_all_to_front(handle, None)?,
    Native::PasteAndMatchStyle | Native::Delete => return Ok(None),
  }))
}

/// Runs a menu item of our own.
#[cfg(target_os = "macos")]
fn run(app: &tauri::AppHandle, id: &str) {
  use tauri::{Emitter, Manager};

  let Some(action) = action_of(id) else {
    return;
  };
  match action {
    Action::Web(name) | Action::WebAlways(name) | Action::Message(name, _) => {
      let on_screen = app.get_webview_window("main").is_some_and(|window| window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true));
      // The window may be closed (hidden): what the item does happens in it, so it comes back first.
      show_main_window(app);
      if delivery(action, on_screen) == Delivery::ShowOnly {
        return;
      }
      if let Err(error) = app.emit_to("main", MENU_EVENT, name) {
        log::error!("Sending the menu action {name} to the web client failed: {error}");
      }
    }
    Action::Shell(Shell::CheckForUpdates) => crate::updates::check_or_relaunch(app),
    Action::Shell(Shell::ShowMainWindow) => show_main_window(app),
    Action::Shell(Shell::Open(url)) => {
      if let Err(error) = tauri_plugin_opener::open_url(url, None::<&str>) {
        log::error!("Opening {url} failed: {error}");
      }
    }
  }
}

/// Brings the main window back: after Close Window (which only hides it on macOS), when minimized, or behind others.
pub fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
  use tauri::Manager;

  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
  }
}

/// The main window closes as a Mac app's window does: it goes, the app stays in the Dock, and the Dock icon or Window >
/// Tresso brings it back (lib.rs). It is hidden rather than destroyed, so the mail on screen and the sync keep going.
/// AppKit's window list leaves it out: Window > Tresso lists it once, also while it is hidden.
#[cfg(target_os = "macos")]
pub fn keep_main_window(window: &tauri::WebviewWindow) {
  let hidden = window.clone();
  window.on_window_event(move |event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
      api.prevent_close();
      if let Err(error) = hidden.hide() {
        log::error!("Hiding the window failed: {error}");
      }
    }
  });
  match window.ns_window() {
    Ok(ns_window) => appkit::leave_out_of_window_list(ns_window),
    Err(error) => log::error!("The window's NSWindow is not known: {error}"),
  }
}

#[cfg(target_os = "macos")]
mod appkit {
  use objc2::{MainThreadMarker, MainThreadOnly, sel};
  use objc2_app_kit::{NSApplication, NSEventModifierFlags, NSMenuItem, NSWindow};
  use objc2_foundation::NSString;

  use super::{Entry, Native, bar};

  /// Adds Paste and Match Style and Delete to the Edit menu where bar() places them. Their actions go to the first
  /// responder (the focused web content), as in every Mac app. Main thread.
  pub fn add_edit_actions() {
    let Some(mtm) = MainThreadMarker::new() else {
      log::error!("The Edit menu can only be changed on the main thread");
      return;
    };
    let Some(edit) = NSApplication::sharedApplication(mtm).mainMenu().and_then(|menu| menu.itemWithTitle(&NSString::from_str("Edit"))).and_then(|item| item.submenu()) else {
      log::error!("The menu bar has no Edit menu to add Paste and Match Style to");
      return;
    };
    let entries = bar().into_iter().find(|submenu| submenu.title == "Edit").map(|submenu| submenu.entries).unwrap_or_default();
    for (index, entry) in entries.iter().enumerate() {
      let (title, action, key, modifiers) = match entry {
        Entry::Native(Native::PasteAndMatchStyle) => ("Paste and Match Style", sel!(pasteAsPlainText:), "v", NSEventModifierFlags::Option | NSEventModifierFlags::Shift | NSEventModifierFlags::Command),
        Entry::Native(Native::Delete) => ("Delete", sel!(delete:), "", NSEventModifierFlags::empty()),
        _ => continue,
      };
      // SAFETY: a plain menu item; a nil target sends the action along the responder chain.
      let item = unsafe { NSMenuItem::initWithTitle_action_keyEquivalent(NSMenuItem::alloc(mtm), &NSString::from_str(title), Some(action), &NSString::from_str(key)) };
      item.setKeyEquivalentModifierMask(modifiers);
      // Items before it are in place already (Tauri's, and this loop's), so its index in bar() is its index here.
      edit.insertItem_atIndex(&item, index as isize);
    }
  }

  /// Leaves the window out of AppKit's own window list (Window > Tresso lists it instead). Main thread.
  pub fn leave_out_of_window_list(ns_window: *mut std::ffi::c_void) {
    if MainThreadMarker::new().is_none() || ns_window.is_null() {
      return;
    }
    // SAFETY: Tauri's NSWindow for this window, alive while the window is, used on the main thread.
    let window = unsafe { &*(ns_window as *const NSWindow) };
    window.setExcludedFromWindowsMenu(true);
  }
}

#[cfg(test)]
mod tests {
  use std::collections::HashSet;

  use super::*;

  fn items() -> Vec<(&'static str, &'static str, Option<&'static str>, Action)> {
    bar()
      .into_iter()
      .flat_map(|submenu| submenu.entries)
      .filter_map(|entry| match entry {
        Entry::Item { id, label, accelerator, action } => Some((id, label, accelerator, action)),
        _ => None,
      })
      .collect()
  }

  /// A shortcut with its modifiers in one order, so "Shift+Cmd+Z" and "Cmd+Shift+Z" count as the same.
  fn normalized(accelerator: &str) -> String {
    let mut parts: Vec<String> = accelerator.split('+').map(|part| part.to_ascii_lowercase()).collect();
    let key = parts.pop().unwrap();
    parts.sort();
    parts.push(key);
    parts.join("+")
  }

  fn titles(submenu: &Submenu) -> Vec<String> {
    submenu
      .entries
      .iter()
      .map(|entry| match entry {
        Entry::Item { label, .. } => (*label).to_string(),
        Entry::Native(native) => format!("{native:?}"),
        Entry::Separator => "-".to_string(),
      })
      .collect()
  }

  #[test]
  fn the_menus_come_in_the_order_of_the_guidelines() {
    let menus: Vec<_> = bar().iter().map(|submenu| submenu.title).collect();
    assert_eq!(menus, ["Tresso", "File", "Edit", "View", "Mailbox", "Message", "Window", "Help"]);
  }

  #[test]
  fn every_menu_has_its_items_in_order() {
    let bar = bar();
    assert_eq!(titles(&bar[0]), ["About", "Check for Updates…", "-", "Settings…", "-", "Services", "-", "Hide", "HideOthers", "ShowAll", "-", "Quit"]);
    assert_eq!(titles(&bar[1]), ["New Message", "New Event", "New To-do", "-", "CloseWindow"]);
    assert_eq!(titles(&bar[2]), ["Undo", "Redo", "-", "Cut", "Copy", "Paste", "PasteAndMatchStyle", "Delete", "SelectAll", "-", "Find…"]);
    assert_eq!(titles(&bar[3]), ["Inbox", "Triage", "To-dos", "Calendar", "Search", "-", "Hide Sidebar", "-", "Reload", "EnterFullScreen"]);
    assert_eq!(titles(&bar[4]), ["Get New Mail", "-", "Daily Brief", "Waiting On", "Drafts", "Clean Up", "Outbox", "Batches"]);
    assert_eq!(titles(&bar[5]), ["Reply", "Reply All", "Forward", "-", "Archive", "Move to Trash", "Move to…", "-", "Mark as Unread", "Flag", "-", "Do", "Hand Over…", "Noted", "Make To-do"]);
    assert_eq!(titles(&bar[6]), ["Minimize", "Zoom", "-", "BringAllToFront", "-", "Tresso"]);
    assert_eq!(titles(&bar[7]), ["Tresso Help", "Release Notes"]);
  }

  #[test]
  fn no_menu_starts_or_ends_with_a_separator_or_has_two_in_a_row() {
    for submenu in bar() {
      let entries = &submenu.entries;
      assert_ne!(entries.first(), Some(&Entry::Separator), "{}", submenu.title);
      assert_ne!(entries.last(), Some(&Entry::Separator), "{}", submenu.title);
      assert!(!entries.windows(2).any(|pair| pair[0] == Entry::Separator && pair[1] == Entry::Separator), "{}", submenu.title);
    }
  }

  #[test]
  fn ids_are_unique() {
    let mut seen = HashSet::new();
    for (id, ..) in items() {
      assert!(seen.insert(id), "{id} is used twice");
    }
  }

  #[test]
  fn no_two_items_share_a_shortcut() {
    let mut seen = HashSet::new();
    let natives = bar().into_iter().flat_map(|submenu| submenu.entries).filter_map(|entry| match entry {
      Entry::Native(native) => native.accelerator(),
      _ => None,
    });
    for accelerator in items().into_iter().filter_map(|(_, _, accelerator, _)| accelerator).chain(natives) {
      assert!(seen.insert(normalized(accelerator)), "{accelerator} is used twice");
    }
    assert!(seen.contains(&normalized("Cmd+,")) && seen.contains(&normalized("Cmd+N")) && seen.contains(&normalized("Cmd+F")));
    assert!(seen.contains(&normalized("Cmd+Ctrl+S")) && seen.contains(&normalized("Cmd+Ctrl+F")));
    // Mail's own shortcuts for its Mailbox and Message menus.
    for (id, accelerator) in [("get-new-mail", "Cmd+Shift+N"), ("reply", "Cmd+R"), ("reply-all", "Cmd+Shift+R"), ("forward", "Cmd+Shift+F"), ("archive", "Cmd+Ctrl+A"), ("move-to-trash", "Cmd+Backspace"), (TOGGLE_READ, "Cmd+Shift+U"), (TOGGLE_FLAG, "Cmd+Shift+L")] {
      let item = items().into_iter().find(|(own, ..)| *own == id).unwrap();
      assert_eq!(item.2.map(normalized), Some(normalized(accelerator)), "{id}");
    }
    // ⌘R is Reply: Reload keeps none.
    assert_eq!(items().into_iter().find(|(id, ..)| *id == "reload").unwrap().2, None);
  }

  /// Tauri drops a shortcut it cannot read without a word, which would leave the item without one: each must read.
  #[test]
  fn every_shortcut_is_one_tauri_reads() {
    let natives = bar().into_iter().flat_map(|submenu| submenu.entries).filter_map(|entry| match entry {
      Entry::Native(native) => native.accelerator(),
      _ => None,
    });
    for accelerator in items().into_iter().filter_map(|(_, _, accelerator, _)| accelerator).chain(natives) {
      assert!(accelerator.parse::<muda::accelerator::Accelerator>().is_ok(), "{accelerator}");
    }
  }

  /// The shortcuts a focused text field or the composer uses itself: WebKit's text editing (⌘⌫ and ⌘⌦ delete to the
  /// start and end of the line) and the composer's editor (RichEditor.vue: TipTap's StarterKit and Link; bold, italic,
  /// underline, strike, code, the two lists, quote, code block, paragraph, a hard break, redo). Whichever sees a key
  /// first ([`Typing`]), an item with one of these must leave it to the text while text is edited.
  const TEXT_KEYS: &[&str] = &[
    "Cmd+Backspace",
    "Cmd+Delete",
    "Cmd+B",
    "Cmd+I",
    "Cmd+U",
    "Shift+Cmd+U",
    "Cmd+E",
    "Shift+Cmd+S",
    "Shift+Cmd+B",
    "Shift+Cmd+7",
    "Shift+Cmd+8",
    "Alt+Cmd+0",
    "Alt+Cmd+C",
    "Cmd+Enter",
    "Cmd+Y",
  ];

  /// An item whose shortcut is also a text-editing key is disabled while text is edited, so the key edits the text: the
  /// mail actions among them wait (Typing::Waits), and no other item of our own takes one.
  #[test]
  fn a_shortcut_that_edits_text_is_left_to_the_text_while_typing() {
    let text: HashSet<String> = TEXT_KEYS.iter().map(|key| normalized(key)).collect();
    let taken: Vec<_> = items().into_iter().filter(|(_, _, accelerator, _)| accelerator.is_some_and(|key| text.contains(&normalized(key)))).collect();
    assert_eq!(taken.iter().map(|(id, ..)| *id).collect::<Vec<_>>(), ["move-to-trash", TOGGLE_READ]);
    for (id, _, _, action) in taken {
      assert!(matches!(action, Action::Message(_, Typing::Waits)), "{id} must be disabled while text is edited");
      let typing = MenuState { signed_in: true, sidebar_shown: true, editing: true, outbox: true, message: Some(OpenMessage::default()) };
      assert!(!enabled_in(action, &typing), "{id} acts while typing");
      assert!(enabled_in(action, &MenuState { editing: false, ..typing }), "{id} does not act once typing ends");
    }
  }

  #[test]
  fn the_web_client_hears_exactly_these_actions() {
    let mut web: Vec<_> = items()
      .into_iter()
      .filter_map(|(id, _, _, action)| match action {
        Action::Web(name) | Action::WebAlways(name) | Action::Message(name, _) => {
          assert_eq!(name, id, "a web action is named after its item");
          Some(name)
        }
        Action::Shell(_) => None,
      })
      .collect();
    web.sort_unstable();
    // The same list as MENU_ACTIONS in apps/web/src/platform/menu.ts.
    assert_eq!(
      web,
      [
        "archive",
        "find",
        "forward",
        "get-new-mail",
        "go-batches",
        "go-brief",
        "go-cleanup",
        "go-drafts",
        "go-outbox",
        "go-waiting",
        "hand-over",
        "make-todo",
        "move-to",
        "move-to-trash",
        "new-event",
        "new-message",
        "new-todo",
        "reload",
        "reply",
        "reply-all",
        "settings",
        "settle-do",
        "settle-noted",
        "toggle-flag",
        "toggle-read",
        "toggle-sidebar",
        "view-calendar",
        "view-inbox",
        "view-search",
        "view-todos",
        "view-triage"
      ]
    );
    let source = include_str!("../../../web/src/platform/menu.ts");
    for name in web {
      assert!(source.contains(&format!("'{name}'")), "the web client does not handle {name}");
    }
  }

  /// A menu item of a test, which remembers whether it is enabled and its title.
  struct FakeItem(std::cell::Cell<bool>, std::cell::RefCell<String>);

  impl FakeItem {
    fn new() -> Self {
      Self(std::cell::Cell::new(false), std::cell::RefCell::new(String::new()))
    }
  }

  // SAFETY for the tests only: MenuItems is used from one thread here.
  unsafe impl Sync for FakeItem {}

  impl Toggle for FakeItem {
    fn set_enabled(&self, enabled: bool) -> Result<(), String> {
      self.0.set(enabled);
      Ok(())
    }

    fn set_text(&self, text: &str) -> Result<(), String> {
      *self.1.borrow_mut() = text.to_string();
      Ok(())
    }
  }

  fn fake_items() -> MenuItems<FakeItem> {
    let items = MenuItems::<FakeItem>::default();
    items.fill(signed_in_ids().into_iter().map(|id| (id, action_of(id).unwrap(), FakeItem::new())).collect()).unwrap();
    items
  }

  const MESSAGE_IDS: [&str; 12] = ["reply", "reply-all", "forward", "archive", "move-to-trash", "move-to", TOGGLE_READ, TOGGLE_FLAG, "settle-do", "hand-over", "settle-noted", MAKE_TODO];

  /// What setup stores is what menu_state enables: every item that acts in the web client while someone is signed
  /// in, and nothing else (Reload acts signed out too).
  #[test]
  fn the_items_menu_state_enables_are_the_web_actions() {
    let items = fake_items();
    let enabled = |id: &str| items.0.lock().unwrap().iter().find(|(own, ..)| *own == id).map(|(.., item)| item.0.get()).unwrap();

    assert_eq!(
      items.ids(),
      [
        "settings",
        "new-message",
        "new-event",
        "new-todo",
        "find",
        "view-inbox",
        "view-triage",
        "view-todos",
        "view-calendar",
        "view-search",
        "toggle-sidebar",
        "get-new-mail",
        "go-brief",
        "go-waiting",
        "go-drafts",
        "go-cleanup",
        "go-outbox",
        "go-batches",
        "reply",
        "reply-all",
        "forward",
        "archive",
        "move-to-trash",
        "move-to",
        TOGGLE_READ,
        TOGGLE_FLAG,
        "settle-do",
        "hand-over",
        "settle-noted",
        MAKE_TODO
      ]
    );
    let open = Some(OpenMessage { read: true, flagged: false, has_todo: false });
    items.apply(&MenuState { signed_in: true, sidebar_shown: true, editing: false, outbox: true, message: open }).unwrap();
    assert!(items.0.lock().unwrap().iter().all(|(.., item)| item.0.get()));
    items.apply(&MenuState { signed_in: false, sidebar_shown: true, editing: false, outbox: true, message: open }).unwrap();
    assert!(items.0.lock().unwrap().iter().all(|(.., item)| !item.0.get()));

    // Signed in without an open conversation: the Message menu waits, the rest acts.
    items.apply(&MenuState { signed_in: true, sidebar_shown: true, editing: false, outbox: true, message: None }).unwrap();
    for id in items.ids() {
      assert_eq!(enabled(id), !MESSAGE_IDS.contains(&id), "{id} without an open conversation");
    }
    assert!(!needs_sign_in(Action::WebAlways("reload")) && !needs_sign_in(Action::Shell(Shell::ShowMainWindow)));
  }

  /// While text is edited, only the items whose shortcut edits text are disabled; the rest of the Message menu acts.
  #[test]
  fn editing_text_disables_only_the_items_whose_shortcut_edits_text() {
    let items = fake_items();
    let enabled = |id: &str| items.0.lock().unwrap().iter().find(|(own, ..)| *own == id).map(|(.., item)| item.0.get()).unwrap();

    items.apply(&MenuState { signed_in: true, sidebar_shown: true, editing: true, outbox: true, message: Some(OpenMessage::default()) }).unwrap();
    assert!(!enabled("move-to-trash") && !enabled(TOGGLE_READ));
    assert!(enabled("reply") && enabled("archive") && enabled("move-to") && enabled(TOGGLE_FLAG) && enabled("get-new-mail"));
    items.apply(&MenuState { signed_in: true, sidebar_shown: true, editing: false, outbox: true, message: Some(OpenMessage::default()) }).unwrap();
    assert!(enabled("move-to-trash") && enabled(TOGGLE_READ));
  }

  /// The sidebar item, the read item and the flag item are named after what they would do; no other item is renamed.
  #[test]
  fn the_items_with_a_state_are_named_after_what_they_would_do() {
    let items = fake_items();
    let title = |id: &str| items.0.lock().unwrap().iter().find(|(own, ..)| *own == id).map(|(.., item)| item.1.borrow().clone()).unwrap();
    let state = |sidebar_shown: bool, message: Option<OpenMessage>| MenuState { signed_in: true, sidebar_shown, editing: false, outbox: true, message };

    items.apply(&state(false, Some(OpenMessage { read: false, flagged: true, has_todo: false }))).unwrap();
    assert_eq!(title(TOGGLE_SIDEBAR), "Show Sidebar");
    assert_eq!(title(TOGGLE_READ), "Mark as Read");
    assert_eq!(title(TOGGLE_FLAG), "Unflag");
    items.apply(&state(true, Some(OpenMessage { read: true, flagged: false, has_todo: false }))).unwrap();
    assert_eq!(title(TOGGLE_SIDEBAR), "Hide Sidebar");
    assert_eq!(title(TOGGLE_READ), "Mark as Unread");
    assert_eq!(title(TOGGLE_FLAG), "Flag");
    // With nothing open, the titles the bar starts with.
    items.apply(&state(true, Some(OpenMessage { read: false, flagged: true, has_todo: false }))).unwrap();
    items.apply(&state(true, None)).unwrap();
    assert_eq!((title(TOGGLE_READ).as_str(), title(TOGGLE_FLAG).as_str()), (read_label(true), flag_label(false)));
    assert_eq!(title("view-inbox"), "", "no other item is renamed");
    assert_eq!(title("reply"), "", "no other item is renamed");
    assert_eq!(action_of(TOGGLE_SIDEBAR), Some(Action::Web(TOGGLE_SIDEBAR)));
    assert_eq!(action_of(TOGGLE_READ), Some(Action::Message(TOGGLE_READ, Typing::Waits)));
  }

  /// The command the web client calls, through Tauri's IPC on a mock app: signing in enables exactly the items that act
  /// in the web client, in the state the bar's setup fills, except the Message menu, which waits for an open
  /// conversation; signing out disables them. Reload, Help and the window item stay as they are. The same command names
  /// the sidebar, read and flag items after what they would do, and disables Move to Trash and Mark as Unread while text
  /// is edited.
  #[test]
  fn signing_in_enables_the_web_items_through_menu_state() {
    use tauri::Manager;
    use tauri::test::{INVOKE_KEY, MockRuntime, mock_builder, mock_context, noop_assets};

    let app = mock_builder()
      .invoke_handler(tauri::generate_handler![menu_state])
      .build(mock_context(noop_assets()))
      .unwrap();
    app.manage(MenuItems::<tauri::menu::MenuItem<MockRuntime>>::default());
    let own = own_items(&app, false).unwrap();
    app.state::<MenuItems<tauri::menu::MenuItem<MockRuntime>>>().fill(for_signed_in(&own)).unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    let send = |body: serde_json::Value| {
      tauri::test::get_ipc_response(
        &webview,
        tauri::webview::InvokeRequest {
          cmd: "menu_state".into(),
          callback: tauri::ipc::CallbackFn(0),
          error: tauri::ipc::CallbackFn(1),
          url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(),
          body: tauri::ipc::InvokeBody::Json(body),
          headers: Default::default(),
          invoke_key: INVOKE_KEY.to_string(),
        },
      )
      .unwrap();
    };
    let enabled = |id: &str| own.iter().find(|(own_id, ..)| *own_id == id).unwrap().2.is_enabled().unwrap();
    let title = |id: &str| own.iter().find(|(own_id, ..)| *own_id == id).unwrap().2.text().unwrap();
    let is_message = |action: &Action| matches!(action, Action::Message(..));

    assert!(!enabled("new-message") && !enabled("settings") && !enabled("view-calendar") && !enabled(TOGGLE_SIDEBAR) && !enabled("get-new-mail") && !enabled("reply"));
    assert_eq!((title(TOGGLE_SIDEBAR), title(TOGGLE_READ), title(TOGGLE_FLAG)), (String::from("Hide Sidebar"), String::from("Mark as Unread"), String::from("Flag")));

    // Signed in, nothing open: the Message menu waits.
    send(serde_json::json!({ "signedIn": true, "sidebarShown": false, "editing": false, "outbox": true, "message": null }));
    assert_eq!(title(TOGGLE_SIDEBAR), "Show Sidebar");
    for (id, action, item) in &own {
      assert_eq!(item.is_enabled().unwrap(), !is_message(action) && !matches!(action, Action::Shell(Shell::CheckForUpdates)), "{id} after sign-in");
    }

    // A conversation opens, unread and flagged: everything acts, and the titles say what they would do.
    send(serde_json::json!({ "signedIn": true, "sidebarShown": false, "editing": false, "outbox": true, "message": { "read": false, "flagged": true, "hasTodo": false } }));
    for (id, action, item) in &own {
      assert_eq!(item.is_enabled().unwrap(), !matches!(action, Action::Shell(Shell::CheckForUpdates)), "{id} with a conversation open");
    }
    assert_eq!((title(TOGGLE_READ), title(TOGGLE_FLAG)), (String::from("Mark as Read"), String::from("Unflag")));

    // Text is edited: ⌘⌫ and ⇧⌘U are left to the text.
    send(serde_json::json!({ "signedIn": true, "sidebarShown": false, "editing": true, "outbox": true, "message": { "read": true, "flagged": false, "hasTodo": false } }));
    assert!(!enabled("move-to-trash") && !enabled(TOGGLE_READ));
    assert!(enabled("reply") && enabled("archive") && enabled(TOGGLE_FLAG));
    assert_eq!((title(TOGGLE_READ), title(TOGGLE_FLAG)), (String::from("Mark as Unread"), String::from("Flag")));

    send(serde_json::json!({ "signedIn": false, "sidebarShown": true, "editing": false, "outbox": true, "message": null }));
    assert_eq!(title(TOGGLE_SIDEBAR), "Hide Sidebar");
    for (id, action, item) in &own {
      assert_eq!(item.is_enabled().unwrap(), !needs_sign_in(*action) && !matches!(action, Action::Shell(Shell::CheckForUpdates)), "{id} after sign-out");
    }
    assert!(enabled("reload") && enabled("help") && enabled("main-window"));
  }

  /// A source check, not a behaviour test: setup's own line that fills the state runs only on macOS inside a real app,
  /// which no test can start. Tauri keeps the first value managed for a type and ignores a second, so a `manage` call
  /// here would leave menu_state with nothing to enable (as it once did); the state is managed only in lib.rs.
  #[test]
  fn menu_rs_manages_no_state_of_its_own() {
    // The app's code only: the tests below manage state on their own mock app.
    let source = include_str!("menu.rs");
    let code = &source[..source.find(&["#[cfg(test)]", "\nmod tests"].concat()).expect("menu.rs has its tests at the end")];
    assert!(!code.contains(".manage("), "menu.rs must not manage state; lib.rs manages MenuItems");
  }

  /// A Message item acts on the conversation on screen: with the window closed (hidden) or minimized it only brings the
  /// window back. Every other item acts as before, after the window came back.
  #[test]
  fn a_message_item_only_shows_a_window_that_is_not_on_screen() {
    for id in MESSAGE_IDS {
      let action = action_of(id).unwrap();
      assert_eq!(delivery(action, false), Delivery::ShowOnly, "{id}");
      assert_eq!(delivery(action, true), Delivery::Send, "{id}");
    }
    for id in ["new-message", "get-new-mail", "view-inbox", "toggle-sidebar", "reload", GO_OUTBOX] {
      assert_eq!(delivery(action_of(id).unwrap(), false), Delivery::Send, "{id}");
    }
  }

  /// Mailbox > Outbox follows the sidebar, which lists the Outbox only while mail waits; Make To-do waits while the
  /// conversation has a to-do, as the pane's button does.
  #[test]
  fn outbox_and_make_todo_follow_what_the_pane_and_the_sidebar_show() {
    let open = OpenMessage { read: true, flagged: false, has_todo: false };
    let state = MenuState { signed_in: true, sidebar_shown: true, editing: false, outbox: false, message: Some(open) };
    assert!(!enabled_in(Action::Web(GO_OUTBOX), &state));
    assert!(enabled_in(Action::Web(GO_OUTBOX), &MenuState { outbox: true, ..state }));
    assert!(!enabled_in(Action::Web(GO_OUTBOX), &MenuState { outbox: true, signed_in: false, ..state }));
    assert!(enabled_in(Action::Web("go-drafts"), &state));

    let make = action_of(MAKE_TODO).unwrap();
    assert!(enabled_in(make, &state));
    assert!(!enabled_in(make, &MenuState { message: Some(OpenMessage { has_todo: true, ..open }), ..state }));
    assert!(enabled_in(action_of("settle-do").unwrap(), &MenuState { message: Some(OpenMessage { has_todo: true, ..open }), ..state }));
  }

  #[test]
  fn each_item_finds_its_action() {
    assert_eq!(action_of(CHECK_FOR_UPDATES), Some(Action::Shell(Shell::CheckForUpdates)));
    assert_eq!(action_of("new-message"), Some(Action::Web("new-message")));
    assert_eq!(action_of("get-new-mail"), Some(Action::Web("get-new-mail")));
    assert_eq!(action_of("reply"), Some(Action::Message("reply", Typing::Acts)));
    assert_eq!(action_of("move-to-trash"), Some(Action::Message("move-to-trash", Typing::Waits)));
    assert_eq!(action_of("main-window"), Some(Action::Shell(Shell::ShowMainWindow)));
    assert_eq!(action_of("release-notes"), Some(Action::Shell(Shell::Open(RELEASE_NOTES_URL))));
    assert_eq!(action_of("nothing"), None);
  }

  /// Help and Release Notes open the project the app updates from, not some other address.
  #[test]
  fn help_opens_the_repository_the_app_updates_from() {
    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let endpoint = config["plugins"]["updater"]["endpoints"][0].as_str().unwrap();
    assert!(endpoint.starts_with(&format!("{REPOSITORY}/releases/")), "{endpoint}");
    assert!(HELP_URL.starts_with(REPOSITORY) && RELEASE_NOTES_URL == format!("{REPOSITORY}/releases"));
  }
}
