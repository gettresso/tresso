//! Liquid Glass behind the sidebar card (macOS 26 and later): one `NSGlassEffectView` per shape the web client reports
//! (platform/glass.ts), placed under the web view, exactly where the card is. The page leaves the card see-through and
//! macOS draws the glass. The window paints its own opaque background then, instead of the whole-window sidebar
//! material of tauri.macos.conf.json, which stays as it is before macOS 26, when the glass is turned off, and on the
//! systems without it.
//!
//! Turning it off without a new release: `defaults write app.tresso.desktop DisableLiquidGlass -bool YES` (and
//! `defaults delete app.tresso.desktop DisableLiquidGlass` to turn it on again), or start the app with
//! `TRESSO_DISABLE_GLASS=1`; read at launch. The card is then drawn by the page over the old material.
//!
//! Known risk: tauri-apps/tauri#14454 reports AppKit aborting on macOS 27 in packaged apps that combine a WKWebView
//! with NSGlassEffectView during a native resize (not reproduced on macOS 26.7). The switch above is the way out.
//!
//! The bookkeeping (which view belongs to which shape, what to create, move and remove) and the geometry are plain
//! functions over the [`Views`] trait, so they are tested without AppKit; only [`appkit`] touches it.

// The geometry and bookkeeping run on macOS only; elsewhere the command answers unsupported, and the tests still run.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::collections::HashMap;

/// At most this many shapes at once: the frame reports one (the sidebar card).
pub const MAX_SHAPES: usize = 4;
/// No coordinate, size or radius beyond this many points: far larger than any screen.
pub const MAX_POINTS: f64 = 100_000.0;
/// A shape's id: 1 to 32 characters of a to z, 0 to 9 and hyphens.
pub const MAX_ID: usize = 32;

/// The `defaults` key and the environment variable that turn the glass off.
pub const DISABLE_DEFAULT: &str = "DisableLiquidGlass";
pub const DISABLE_ENV: &str = "TRESSO_DISABLE_GLASS";

/// One glass shape, in CSS pixels from the top-left corner of the page.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
pub struct GlassRect {
  pub id: String,
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
  pub radius: f64,
}

/// What the web client learns: whether the glass is on (macOS 26 and later, not turned off), so the page draws the
/// card itself when it is not.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub struct GlassAnswer {
  pub supported: bool,
}

/// A rectangle in AppKit points, in the content view's own coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

/// The shapes as the web view sends them; refused whole when one is wrong, as the page is not trusted with AppKit.
pub fn validate(rects: &[GlassRect], viewport_width: f64) -> Result<(), String> {
  if rects.len() > MAX_SHAPES {
    return Err(format!("at most {MAX_SHAPES} glass shapes, not {}", rects.len()));
  }
  if !viewport_width.is_finite() || viewport_width <= 0.0 || viewport_width > MAX_POINTS {
    return Err(format!("the page's width {viewport_width} is not a width"));
  }
  for (index, rect) in rects.iter().enumerate() {
    let id_ok = (1..=MAX_ID).contains(&rect.id.len()) && rect.id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !id_ok {
      return Err(format!("glass shape {index} has an unusable id"));
    }
    if rects[..index].iter().any(|other| other.id == rect.id) {
      return Err(format!("the glass shape {} is listed twice", rect.id));
    }
    let position_ok = [rect.x, rect.y].iter().all(|value| value.is_finite() && value.abs() <= MAX_POINTS);
    let size_ok = [rect.width, rect.height, rect.radius].iter().all(|value| value.is_finite() && (0.0..=MAX_POINTS).contains(value));
    if !position_ok || !size_ok {
      return Err(format!("the glass shape {} has an unusable position or size", rect.id));
    }
  }
  Ok(())
}

/// How many points one CSS pixel is: the content view's width over the page's. Not 1 when the web view is zoomed.
pub fn zoom(content_width: f64, viewport_width: f64) -> f64 {
  content_width / viewport_width
}

/// A page rectangle in the content view's coordinates: scaled to points, and turned upside down when the view counts
/// from the bottom (AppKit's default; the page counts from the top).
pub fn appkit_frame(rect: &GlassRect, zoom: f64, content_height: f64, flipped: bool) -> Frame {
  let (x, y, width, height) = (rect.x * zoom, rect.y * zoom, rect.width * zoom, rect.height * zoom);
  Frame { x, y: if flipped { y } else { content_height - y - height }, width, height }
}

/// What the bookkeeping asks of AppKit: a glass view made, placed or removed. A test fakes it.
pub trait Views {
  type View: Copy;
  /// A new glass view at this frame, under the web view; None when it cannot be made.
  fn create(&mut self, frame: Frame, radius: f64) -> Option<Self::View>;
  fn place(&mut self, view: Self::View, frame: Frame, radius: f64);
  fn remove(&mut self, view: Self::View);
}

/// The glass views that exist, by the id the page gave their shape.
pub struct Shapes<V>(HashMap<String, V>);

impl<V> Default for Shapes<V> {
  fn default() -> Self {
    Self(HashMap::new())
  }
}

impl<V: Copy> Shapes<V> {
  /// Shows exactly these shapes: a view is made for a new id, moved for a known one, removed for one no longer listed.
  pub fn apply<T: Views<View = V>>(&mut self, views: &mut T, rects: &[GlassRect], zoom: f64, content_height: f64, flipped: bool) {
    self.0.retain(|id, view| {
      let keep = rects.iter().any(|rect| &rect.id == id);
      if !keep {
        views.remove(*view);
      }
      keep
    });
    for rect in rects {
      let frame = appkit_frame(rect, zoom, content_height, flipped);
      let radius = rect.radius * zoom;
      match self.0.get(&rect.id) {
        Some(view) => views.place(*view, frame, radius),
        None => {
          if let Some(view) = views.create(frame, radius) {
            self.0.insert(rect.id.clone(), view);
          }
        }
      }
    }
  }

  /// Removes every view: a new page starts without glass until it reports its own.
  pub fn clear<T: Views<View = V>>(&mut self, views: &mut T) {
    for (_, view) in self.0.drain() {
      views.remove(view);
    }
  }

  #[cfg(test)]
  fn ids(&self) -> Vec<&str> {
    let mut ids: Vec<&str> = self.0.keys().map(String::as_str).collect();
    ids.sort_unstable();
    ids
  }
}

/// The views of the main window, managed once (lib.rs). A view is kept as its address: AppKit objects are not `Send`,
/// and they are only touched on the main thread (`run_on_main_thread`).
#[derive(Default)]
pub struct GlassViews(pub std::sync::Mutex<Shapes<usize>>);

/// Whether the glass is turned off by the user (the `defaults` key or the environment variable).
pub fn turned_off(env: Option<std::ffi::OsString>, default: bool) -> bool {
  default || env.is_some_and(|value| !value.is_empty() && value != "0")
}

/// Whether the glass is on, decided once at launch (setup asks first) and kept for the app's life: the window was made
/// for it or not, so a reload must not change it. macOS 26 or later (the class exists and does what is asked of it)
/// and not turned off.
pub fn supported() -> bool {
  static DECIDED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
  *DECIDED.get_or_init(decide)
}

fn decide() -> bool {
  #[cfg(target_os = "macos")]
  {
    appkit::class_usable() && !turned_off(std::env::var_os(DISABLE_ENV), appkit::disabled_by_default())
  }
  #[cfg(not(target_os = "macos"))]
  {
    false
  }
}

/// The window around the card in the light appearance while the glass is on: the spec's #f3f3f3 (sRGB, 0 to 1).
pub const LIGHT_WINDOW: f64 = 243.0 / 255.0;

/// The window with glass: it paints its own opaque background, and the whole-window material is cleared (the glass
/// would show it through, or double it). Without glass the window stays exactly as tauri.macos.conf.json made it.
/// Main thread (setup).
pub fn setup<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
  if !supported() {
    return;
  }
  if let Err(error) = window.set_effects(None::<tauri::utils::config::WindowEffectsConfig>) {
    log::error!("Clearing the window's material failed: {error}");
  }
  #[cfg(target_os = "macos")]
  match window.ns_window() {
    Ok(ns_window) => appkit::opaque_background(ns_window),
    Err(error) => log::error!("The window's NSWindow is not known: {error}"),
  }
}

/// The web client reports where the glass goes (its sidebar card), in CSS pixels, with the page's width so a zoomed
/// web view is scaled; an empty list removes it (the sidebar hidden, the sign-in screen).
#[tauri::command]
pub fn set_glass<R: tauri::Runtime>(window: tauri::WebviewWindow<R>, rects: Vec<GlassRect>, viewport_width: f64) -> Result<GlassAnswer, String> {
  validate(&rects, viewport_width)?;
  if !supported() {
    return Ok(GlassAnswer { supported: false });
  }
  #[cfg(target_os = "macos")]
  {
    use tauri::Manager;
    let app = window.app_handle().clone();
    let target = window.clone();
    window
      .run_on_main_thread(move || {
        let state = app.state::<GlassViews>();
        let mut shapes = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match target.ns_window() {
          Ok(ns_window) => appkit::apply(ns_window, &mut shapes, &rects, viewport_width),
          Err(error) => log::error!("The window's NSWindow is not known: {error}"),
        }
      })
      .map_err(|error| error.to_string())?;
  }
  #[cfg(not(target_os = "macos"))]
  let _ = window;
  Ok(GlassAnswer { supported: true })
}

/// A new page in the main window (a reload) starts without the old page's glass; it reports its own once it shows.
pub fn page_loading<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
  #[cfg(target_os = "macos")]
  {
    use tauri::Manager;
    let app = webview.app_handle().clone();
    let _ = webview.run_on_main_thread(move || {
      let state = app.state::<GlassViews>();
      let mut shapes = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
      appkit::clear(&mut shapes);
    });
  }
  #[cfg(not(target_os = "macos"))]
  let _ = webview;
}

#[cfg(target_os = "macos")]
mod appkit {
  use std::ptr::NonNull;

  use objc2::rc::Retained;
  use objc2::runtime::{AnyClass, AnyObject};
  use objc2::{msg_send, sel};
  use objc2_app_kit::{NSAppearance, NSColor, NSWindow};
  use objc2_foundation::{NSPoint, NSRect, NSSize, NSString, NSUserDefaults};

  use super::{Frame, GlassRect, Shapes, Views, zoom};

  /// `NSWindowBelow`: under every other view of the same parent, so under the web view.
  const BELOW: isize = -1;

  fn glass_class() -> Option<&'static AnyClass> {
    AnyClass::get(c"NSGlassEffectView")
  }

  /// The class exists and its views answer every message sent to them here; a class that changed falls back to no
  /// glass instead of aborting on an unknown selector.
  pub fn class_usable() -> bool {
    glass_class().is_some_and(|class| [sel!(initWithFrame:), sel!(setFrame:), sel!(setCornerRadius:), sel!(removeFromSuperview)].into_iter().all(|selector| class.responds_to(selector)))
  }

  pub fn disabled_by_default() -> bool {
    NSUserDefaults::standardUserDefaults().boolForKey(&NSString::from_str(super::DISABLE_DEFAULT))
  }

  pub fn opaque_background(ns_window: *mut std::ffi::c_void) {
    if ns_window.is_null() {
      return;
    }
    // SAFETY: Tauri's NSWindow for the main window, alive while it is, used on the main thread (setup).
    let window = unsafe { &*(ns_window as *const NSWindow) };
    window.setBackgroundColor(Some(&window_background()));
  }

  /// The spec's light grey in the light appearance, AppKit's window colour in the dark ones; it follows the appearance
  /// by itself, as a system colour does.
  fn window_background() -> Retained<NSColor> {
    let provider = block2::RcBlock::new(|appearance: NonNull<NSAppearance>| -> NonNull<NSColor> {
      // SAFETY: AppKit passes the appearance the colour is drawn in, alive for the call.
      let dark = unsafe { appearance.as_ref() }.name().to_string().contains("Dark");
      let color = if dark { NSColor::windowBackgroundColor() } else { NSColor::colorWithSRGBRed_green_blue_alpha(super::LIGHT_WINDOW, super::LIGHT_WINDOW, super::LIGHT_WINDOW, 1.0) };
      // Returned autoreleased (+0), as the block's contract asks; AppKit calls it inside its autorelease pool.
      NonNull::new(Retained::autorelease_ptr(color)).expect("a new colour is never null")
    });
    // SAFETY: the provider always returns a valid colour.
    unsafe { NSColor::colorWithName_dynamicProvider(None, &provider) }
  }

  /// The glass views of one content view. Main thread.
  struct ContentViews {
    content: *mut AnyObject,
    class: &'static AnyClass,
  }

  fn ns_rect(frame: Frame) -> NSRect {
    NSRect::new(NSPoint::new(frame.x, frame.y), NSSize::new(frame.width, frame.height))
  }

  impl Views for ContentViews {
    type View = usize;

    fn create(&mut self, frame: Frame, radius: f64) -> Option<usize> {
      // SAFETY: main thread; `content` is the window's live content view. The view keeps the reference `alloc` gave
      // until `remove` releases it, so its address stays valid also if AppKit drops it from the content view.
      unsafe {
        let view: *mut AnyObject = msg_send![self.class, alloc];
        let view: *mut AnyObject = msg_send![view, initWithFrame: ns_rect(frame)];
        if view.is_null() {
          return None;
        }
        let nothing: *mut AnyObject = std::ptr::null_mut();
        let _: () = msg_send![self.content, addSubview: view, positioned: BELOW, relativeTo: nothing];
        let _: () = msg_send![view, setCornerRadius: radius];
        Some(view as usize)
      }
    }

    fn place(&mut self, view: usize, frame: Frame, radius: f64) {
      let view = view as *mut AnyObject;
      // SAFETY: main thread; a view `create` made and still holds.
      unsafe {
        let _: () = msg_send![view, setFrame: ns_rect(frame)];
        let _: () = msg_send![view, setCornerRadius: radius];
      }
    }

    fn remove(&mut self, view: usize) {
      let view = view as *mut AnyObject;
      // SAFETY: main thread; a view `create` made: it leaves its parent, and the reference it kept is given up.
      unsafe {
        let _: () = msg_send![view, removeFromSuperview];
        let _: () = msg_send![view, release];
      }
    }
  }

  fn content_views(ns_window: *mut std::ffi::c_void) -> Option<ContentViews> {
    let class = glass_class()?;
    if ns_window.is_null() {
      return None;
    }
    // SAFETY: Tauri's NSWindow, alive while the window is, used on the main thread.
    let content: *mut AnyObject = unsafe { msg_send![ns_window as *mut AnyObject, contentView] };
    (!content.is_null()).then_some(ContentViews { content, class })
  }

  pub fn apply(ns_window: *mut std::ffi::c_void, shapes: &mut Shapes<usize>, rects: &[GlassRect], viewport_width: f64) {
    let Some(mut views) = content_views(ns_window) else {
      log::error!("The window has no content view to put the glass in");
      return;
    };
    // SAFETY: the live content view, on the main thread.
    let (bounds, flipped): (NSRect, bool) = unsafe { (msg_send![views.content, bounds], msg_send![views.content, isFlipped]) };
    shapes.apply(&mut views, rects, zoom(bounds.size.width, viewport_width), bounds.size.height, flipped);
  }

  pub fn clear(shapes: &mut Shapes<usize>) {
    // Removing needs no content view: each view leaves whatever parent it has.
    let Some(class) = glass_class() else {
      return;
    };
    shapes.clear(&mut ContentViews { content: std::ptr::null_mut(), class });
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn rect(id: &str, x: f64, y: f64, width: f64, height: f64) -> GlassRect {
    GlassRect { id: id.to_string(), x, y, width, height, radius: 18.0 }
  }

  #[test]
  fn the_page_counts_from_the_top_and_appkit_from_the_bottom() {
    // The card at the default width in a 1240 x 780 window: 8 in, 202 wide, 8 from the top and the bottom.
    let card = rect("sidebar", 8.0, 8.0, 202.0, 764.0);
    assert_eq!(appkit_frame(&card, 1.0, 780.0, false), Frame { x: 8.0, y: 8.0, width: 202.0, height: 764.0 });
    let top = rect("top", 0.0, 0.0, 100.0, 52.0);
    assert_eq!(appkit_frame(&top, 1.0, 780.0, false), Frame { x: 0.0, y: 728.0, width: 100.0, height: 52.0 });
    assert_eq!(appkit_frame(&top, 1.0, 780.0, true), Frame { x: 0.0, y: 0.0, width: 100.0, height: 52.0 });
  }

  #[test]
  fn a_zoomed_page_is_scaled_to_points() {
    // At 125 % a 1240 point wide window shows 992 CSS pixels.
    let factor = zoom(1240.0, 992.0);
    assert_eq!(factor, 1.25);
    let card = rect("sidebar", 8.0, 8.0, 202.0, 608.0);
    assert_eq!(appkit_frame(&card, factor, 780.0, false), Frame { x: 10.0, y: 10.0, width: 252.5, height: 760.0 });
    assert_eq!(zoom(1240.0, 1240.0), 1.0);
  }

  #[test]
  fn what_the_web_view_sends_is_checked_first() {
    assert!(validate(&[rect("sidebar", 8.0, 8.0, 202.0, 764.0)], 1240.0).is_ok());
    assert!(validate(&[], 1240.0).is_ok());
    // Sliding out, the card is left of the window.
    assert!(validate(&[rect("sidebar", -210.0, 8.0, 202.0, 764.0)], 1240.0).is_ok());
    for (rects, width) in [
      (vec![rect("sidebar", f64::NAN, 8.0, 202.0, 764.0)], 1240.0),
      (vec![rect("sidebar", 8.0, f64::INFINITY, 202.0, 764.0)], 1240.0),
      (vec![rect("sidebar", 8.0, 8.0, -1.0, 764.0)], 1240.0),
      (vec![rect("sidebar", 8.0, 8.0, 202.0, 1e9)], 1240.0),
      (vec![GlassRect { radius: -2.0, ..rect("sidebar", 8.0, 8.0, 202.0, 764.0) }], 1240.0),
      (vec![rect("", 8.0, 8.0, 202.0, 764.0)], 1240.0),
      (vec![rect("Side Bar", 8.0, 8.0, 202.0, 764.0)], 1240.0),
      (vec![rect(&"a".repeat(MAX_ID + 1), 8.0, 8.0, 202.0, 764.0)], 1240.0),
      (vec![rect("a", 0.0, 0.0, 1.0, 1.0), rect("a", 0.0, 0.0, 1.0, 1.0)], 1240.0),
      ((0..=MAX_SHAPES).map(|n| rect(&format!("s{n}"), 0.0, 0.0, 1.0, 1.0)).collect(), 1240.0),
      (vec![rect("sidebar", 8.0, 8.0, 202.0, 764.0)], 0.0),
      (vec![rect("sidebar", 8.0, 8.0, 202.0, 764.0)], f64::NAN),
    ] {
      assert!(validate(&rects, width).is_err(), "{rects:?} {width}");
    }
  }

  /// AppKit faked: what was made, moved and removed, by a number per view.
  #[derive(Default)]
  struct FakeViews {
    next: usize,
    log: Vec<String>,
    live: Vec<usize>,
  }

  impl Views for FakeViews {
    type View = usize;

    fn create(&mut self, frame: Frame, radius: f64) -> Option<usize> {
      self.next += 1;
      self.live.push(self.next);
      self.log.push(format!("create {} at {},{} {}x{} r{radius}", self.next, frame.x, frame.y, frame.width, frame.height));
      Some(self.next)
    }

    fn place(&mut self, view: usize, frame: Frame, radius: f64) {
      self.log.push(format!("place {view} at {},{} {}x{} r{radius}", frame.x, frame.y, frame.width, frame.height));
    }

    fn remove(&mut self, view: usize) {
      self.live.retain(|live| *live != view);
      self.log.push(format!("remove {view}"));
    }
  }

  #[test]
  fn one_view_per_shape_moved_while_listed_and_removed_once_it_is_not() {
    let mut shapes = Shapes::default();
    let mut views = FakeViews::default();

    shapes.apply(&mut views, &[rect("sidebar", 8.0, 8.0, 202.0, 764.0)], 1.0, 780.0, false);
    shapes.apply(&mut views, &[rect("sidebar", 8.0, 8.0, 282.0, 764.0)], 1.0, 780.0, false);
    assert_eq!(views.log, ["create 1 at 8,8 202x764 r18", "place 1 at 8,8 282x764 r18"]);
    assert_eq!(shapes.ids(), ["sidebar"]);

    // The sidebar hidden: the list is empty and the view goes; shown again, a new one comes.
    shapes.apply(&mut views, &[], 1.0, 780.0, false);
    assert_eq!(views.log.last().unwrap(), "remove 1");
    assert!(shapes.ids().is_empty() && views.live.is_empty());
    shapes.apply(&mut views, &[rect("sidebar", 8.0, 8.0, 202.0, 764.0), rect("other", 0.0, 0.0, 10.0, 10.0)], 2.0, 780.0, false);
    assert_eq!(shapes.ids(), ["other", "sidebar"]);
    assert!(views.log.contains(&"create 2 at 16,-764 404x1528 r36".to_string()), "{:?}", views.log);

    // A reload: everything goes.
    shapes.clear(&mut views);
    assert!(shapes.ids().is_empty() && views.live.is_empty());
  }

  /// Decided once: what the switch says later (a key deleted, then View > Reload) changes nothing until a relaunch.
  #[test]
  fn the_decision_holds_for_the_apps_life() {
    let first = supported();
    // SAFETY: tests only; no other test reads this variable.
    unsafe { std::env::set_var(DISABLE_ENV, if first { "1" } else { "0" }) };
    assert_eq!(supported(), first);
    unsafe { std::env::remove_var(DISABLE_ENV) };
    assert_eq!(supported(), first);
    if !cfg!(target_os = "macos") {
      assert!(!first);
    }
  }

  #[test]
  fn the_light_window_is_the_specs_grey() {
    assert_eq!(crate::accessibility::hex(LIGHT_WINDOW, LIGHT_WINDOW, LIGHT_WINDOW), "#f3f3f3");
  }

  #[test]
  fn the_switch_turns_the_glass_off() {
    assert!(!turned_off(None, false));
    assert!(turned_off(None, true));
    assert!(turned_off(Some("1".into()), false));
    assert!(!turned_off(Some("0".into()), false));
    assert!(!turned_off(Some("".into()), false));
  }

  /// Through Tauri's IPC on a mock app: a wrong shape is refused before anything else; where the glass is off (before
  /// macOS 26, Windows, Linux) the answer says so.
  #[test]
  fn the_command_checks_its_input_and_says_whether_glass_is_on() {
    use tauri::test::{INVOKE_KEY, mock_builder, mock_context, noop_assets};

    let app = mock_builder()
      .invoke_handler(tauri::generate_handler![set_glass])
      .build(mock_context(noop_assets()))
      .unwrap();
    tauri::Manager::manage(&app, GlassViews::default());
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    let send = |body: serde_json::Value| {
      tauri::test::get_ipc_response(
        &webview,
        tauri::webview::InvokeRequest {
          cmd: "set_glass".into(),
          callback: tauri::ipc::CallbackFn(0),
          error: tauri::ipc::CallbackFn(1),
          url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(),
          body: tauri::ipc::InvokeBody::Json(body),
          headers: Default::default(),
          invoke_key: INVOKE_KEY.to_string(),
        },
      )
    };

    let refused = send(serde_json::json!({ "rects": [{ "id": "sidebar", "x": 8, "y": 8, "width": -5, "height": 764, "radius": 18 }], "viewportWidth": 1240 }));
    assert!(refused.is_err());
    assert!(send(serde_json::json!({ "rects": [], "viewportWidth": -1 })).is_err());
    // Where the glass is on, a valid list goes to AppKit, which the mock app has no window for: only checked by hand.
    if !supported() {
      let answer: serde_json::Value = send(serde_json::json!({ "rects": [], "viewportWidth": 1240 })).unwrap().deserialize().unwrap();
      assert_eq!(answer["supported"], serde_json::Value::Bool(false));
    }
  }

  /// With the app's real capabilities (build.rs, capabilities/): the main window reaches the command (a wrong shape is
  /// refused by the command itself, so no glass is placed on the mock app), another window is refused before it runs.
  #[test]
  fn only_the_main_window_places_glass() {
    use tauri::test::{INVOKE_KEY, mock_builder};

    let app = mock_builder()
      .manage(GlassViews::default())
      .invoke_handler(tauri::generate_handler![set_glass])
      .build(tauri::generate_context!(test = true))
      .unwrap();
    let call = |window: &tauri::WebviewWindow<tauri::test::MockRuntime>| {
      tauri::test::get_ipc_response(
        window,
        tauri::webview::InvokeRequest {
          cmd: "set_glass".into(),
          callback: tauri::ipc::CallbackFn(0),
          error: tauri::ipc::CallbackFn(1),
          url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(),
          body: tauri::ipc::InvokeBody::Json(serde_json::json!({ "rects": [{ "id": "sidebar", "x": 8, "y": 8, "width": -5, "height": 764, "radius": 18 }], "viewportWidth": 1240 })),
          headers: Default::default(),
          invoke_key: INVOKE_KEY.to_string(),
        },
      )
      .unwrap_err()
      .to_string()
    };
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    let other = tauri::WebviewWindowBuilder::new(&app, "other", Default::default()).build().unwrap();
    assert!(call(&main).contains("unusable position or size"), "{}", call(&main));
    assert!(!call(&other).contains("unusable position or size"), "{}", call(&other));
  }
}
