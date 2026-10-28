//! Updates. The macOS app updates through Sparkle: its own windows ask, show the release notes, download, verify the
//! EdDSA signature and relaunch. The framework is bundled (tauri.macos.conf.json) and loaded at runtime, so a
//! development build without it simply has no updater. Windows and Linux update through Tauri's updater plugin, which
//! the web client drives.

#[cfg(target_os = "macos")]
mod sparkle {
  use std::cell::RefCell;

  use objc2::rc::Retained;
  use objc2::runtime::{AnyClass, AnyObject};
  use objc2::msg_send;
  use objc2_foundation::{NSBundle, NSString};

  thread_local! {
    /// The SPUStandardUpdaterController, which lives as long as the app; only touched on the main thread.
    static UPDATER: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
  }

  /// Loads Sparkle from the app's Frameworks folder and starts its updater, which then checks on its own schedule
  /// (SUEnableAutomaticChecks in Info.plist). Must run on the main thread. Returns whether Sparkle runs.
  pub fn start() -> bool {
    let Some(frameworks) = NSBundle::mainBundle().privateFrameworksPath() else {
      return false;
    };
    let path = NSString::from_str(&format!("{frameworks}/Sparkle.framework"));
    let Some(bundle) = NSBundle::bundleWithPath(&path) else {
      eprintln!("Sparkle is not bundled; this build does not update itself");
      return false;
    };
    // SAFETY: loading a framework the app ships, from its own bundle.
    if !unsafe { bundle.load() } {
      eprintln!("Sparkle is bundled but could not be loaded");
      return false;
    }
    let Some(class) = AnyClass::get(c"SPUStandardUpdaterController") else {
      eprintln!("Sparkle loaded without SPUStandardUpdaterController");
      return false;
    };
    let nil: *mut AnyObject = std::ptr::null_mut();
    // SAFETY: -initWithStartingUpdater:updaterDelegate:userDriverDelegate: is Sparkle 2's documented initializer; nil
    // delegates are allowed. alloc/init returns a +1 reference, which Retained takes over.
    let controller: Option<Retained<AnyObject>> = unsafe {
      let allocated: *mut AnyObject = msg_send![class, alloc];
      let initialized: *mut AnyObject = msg_send![allocated, initWithStartingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil];
      Retained::from_raw(initialized)
    };
    let started = controller.is_some();
    UPDATER.with(|updater| *updater.borrow_mut() = controller);
    started
  }

  /// Opens Sparkle's "Check for Updates" window. Must run on the main thread; does nothing without Sparkle.
  pub fn check() {
    UPDATER.with(|updater| {
      if let Some(controller) = updater.borrow().as_ref() {
        let nil: *mut AnyObject = std::ptr::null_mut();
        // SAFETY: -checkForUpdates: is the IBAction behind Sparkle's own "Check for Updates…" menu item.
        let _: () = unsafe { msg_send![&**controller, checkForUpdates: nil] };
      }
    });
  }

  pub fn running() -> bool {
    UPDATER.with(|updater| updater.borrow().is_some())
  }
}

/// The menu item that asks Sparkle for updates, next to "About Tresso" in the app menu.
#[cfg(target_os = "macos")]
pub const CHECK_MENU_ID: &str = "check-for-updates";

/// Starts Sparkle and adds "Check for Updates…" to the app menu (macOS). Elsewhere the updater plugin is registered
/// in lib.rs instead.
#[cfg(target_os = "macos")]
pub fn setup(app: &tauri::App) -> tauri::Result<()> {
  use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

  // A debug bundle (tauri build --debug) would otherwise offer to replace itself with the latest release.
  if cfg!(debug_assertions) || !sparkle::start() {
    return Ok(());
  }
  let menu = Menu::default(app.handle())?;
  if let Some(app_menu) = menu.items()?.first().and_then(|item| item.as_submenu().cloned()) {
    let check = MenuItem::with_id(app, CHECK_MENU_ID, "Check for Updates…", true, None::<&str>)?;
    app_menu.insert(&check, 1)?;
    app_menu.insert(&PredefinedMenuItem::separator(app)?, 1)?;
  }
  app.set_menu(menu)?;
  app.on_menu_event(|_app, event| {
    if event.id() == CHECK_MENU_ID {
      sparkle::check();
    }
  });
  Ok(())
}

/// How this build updates itself: "sparkle" (macOS), "tauri" (the Windows setup and the Linux AppImage) or "none".
/// None covers macOS without Sparkle (a development build), and the .deb and .msi: the releases only sign the setup
/// and the AppImage, so an update would fail on a .deb and install a second copy next to an .msi. Those update by
/// installing the new release. The web client shows its own update card only for "tauri".
#[tauri::command]
pub fn update_channel() -> &'static str {
  #[cfg(target_os = "macos")]
  {
    if sparkle::running() { "sparkle" } else { "none" }
  }
  #[cfg(not(target_os = "macos"))]
  {
    use tauri::utils::{config::BundleType, platform::bundle_type};
    match bundle_type() {
      Some(BundleType::AppImage | BundleType::Nsis) => "tauri",
      _ => "none",
    }
  }
}

/// Opens Sparkle's check window (macOS), for the button in Settings. A sync command, so it runs on the main thread.
#[tauri::command]
pub fn check_for_updates_natively() {
  #[cfg(target_os = "macos")]
  sparkle::check();
}
