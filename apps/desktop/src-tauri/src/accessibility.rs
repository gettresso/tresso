//! System display settings the web client cannot read itself: WebKit on macOS does not support the
//! `prefers-reduced-transparency` media query, yet the window's own vibrancy turns solid when the user asks for less
//! transparency, so the glass in the page has to follow. Nor can a page read the user's accent colour, which fills the
//! selected row of the sidebar as in every Mac app.

/// Whether the user asked the system for less transparency (macOS: Accessibility, Display, Reduce transparency).
#[tauri::command]
pub fn reduce_transparency() -> bool {
  #[cfg(target_os = "macos")]
  {
    objc2_app_kit::NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceTransparency()
  }
  #[cfg(not(target_os = "macos"))]
  {
    false
  }
}

/// The fill of a selected row in a focused sidebar, in the light and the dark appearance, as `#rrggbb`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct SelectionColors {
  pub light: String,
  pub dark: String,
}

/// The colour macOS fills the selected row of a focused list or sidebar with: AppKit's
/// `selectedContentBackgroundColor`, which follows the accent colour the user picked (System Settings, Appearance).
/// It is the accent made a little deeper so white text reads on it (#0064e1 for the blue accent, where
/// `controlAccentColor` is #007aff), and it is what native sidebars use. None where the system has no such colour
/// (Windows, Linux) or it cannot be read: the web client then uses its own blue (frame.css).
#[tauri::command]
pub fn selection_accent() -> Option<SelectionColors> {
  #[cfg(target_os = "macos")]
  {
    appkit::selection_colors()
  }
  #[cfg(not(target_os = "macos"))]
  {
    None
  }
}

/// sRGB components (0 to 1) as `#rrggbb`. Components of an extended-range colour are clamped to the sRGB range.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn hex(red: f64, green: f64, blue: f64) -> String {
  let byte = |component: f64| (component.clamp(0.0, 1.0) * 255.0).round() as u8;
  format!("#{:02x}{:02x}{:02x}", byte(red), byte(green), byte(blue))
}

#[cfg(target_os = "macos")]
mod appkit {
  use objc2_app_kit::{NSAppearance, NSAppearanceName, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSColor, NSColorSpace};

  use super::{SelectionColors, hex};

  pub fn selection_colors() -> Option<SelectionColors> {
    // SAFETY: AppKit's constant appearance names, valid for the life of the process.
    let (aqua, dark_aqua) = unsafe { (NSAppearanceNameAqua, NSAppearanceNameDarkAqua) };
    Some(SelectionColors { light: resolved(aqua)?, dark: resolved(dark_aqua)? })
  }

  /// The system colour as it draws in the named appearance. A dynamic colour resolves against the thread's current
  /// appearance, which is set for the moment and put back. `performAsCurrentDrawingAppearance:` would do the same from
  /// macOS 11 on; the current appearance's getter and setter (deprecated, still supported) work on every macOS Tauri
  /// supports.
  #[allow(deprecated)]
  fn resolved(name: &NSAppearanceName) -> Option<String> {
    let appearance = NSAppearance::appearanceNamed(name)?;
    let previous = NSAppearance::currentAppearance();
    // SAFETY: the setter takes any appearance, and nil restores the default; both values are valid NSAppearances.
    unsafe {
      NSAppearance::setCurrentAppearance(Some(&appearance));
    }
    let color = NSColor::selectedContentBackgroundColor().colorUsingColorSpace(&NSColorSpace::sRGBColorSpace());
    unsafe {
      NSAppearance::setCurrentAppearance(previous.as_deref());
    }
    let color = color?;
    Some(hex(color.redComponent(), color.greenComponent(), color.blueComponent()))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn components_become_a_css_hex_colour() {
    assert_eq!(hex(0.0, 0.392, 0.882), "#0064e1");
    assert_eq!(hex(1.0, 1.0, 1.0), "#ffffff");
    assert_eq!(hex(0.0, 0.0, 0.0), "#000000");
    // Extended sRGB (Display P3 accents) may step outside 0 to 1.
    assert_eq!(hex(-0.2, 1.3, 0.5), "#00ff80");
  }

  /// The command the web client calls (platform/frame.ts), through Tauri's IPC on a mock app: an object with both
  /// appearances as hex colours on macOS, null elsewhere, never an error.
  #[test]
  fn the_web_client_gets_the_selection_colours_or_null() {
    use tauri::test::{INVOKE_KEY, mock_builder, mock_context, noop_assets};

    let app = mock_builder()
      .invoke_handler(tauri::generate_handler![selection_accent])
      .build(mock_context(noop_assets()))
      .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    let response = tauri::test::get_ipc_response(
      &webview,
      tauri::webview::InvokeRequest {
        cmd: "selection_accent".into(),
        callback: tauri::ipc::CallbackFn(0),
        error: tauri::ipc::CallbackFn(1),
        url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(),
        body: tauri::ipc::InvokeBody::default(),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
      },
    )
    .unwrap();
    let value: serde_json::Value = response.deserialize().unwrap();
    let is_hex = |value: &serde_json::Value| value.as_str().is_some_and(|text| text.len() == 7 && text.starts_with('#') && text[1..].chars().all(|c| c.is_ascii_hexdigit()));
    if cfg!(target_os = "macos") {
      assert!(is_hex(&value["light"]) && is_hex(&value["dark"]), "{value}");
    } else {
      assert!(value.is_null(), "{value}");
    }
  }

  /// With the app's real capabilities (build.rs, capabilities/): the main window reads the colour, another window is
  /// refused.
  #[test]
  fn only_the_main_window_reads_the_selection_colour() {
    use tauri::test::{INVOKE_KEY, mock_builder};

    let app = mock_builder()
      .invoke_handler(tauri::generate_handler![selection_accent])
      .build(tauri::generate_context!(test = true))
      .unwrap();
    let call = |window: &tauri::WebviewWindow<tauri::test::MockRuntime>| {
      tauri::test::get_ipc_response(
        window,
        tauri::webview::InvokeRequest {
          cmd: "selection_accent".into(),
          callback: tauri::ipc::CallbackFn(0),
          error: tauri::ipc::CallbackFn(1),
          url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(),
          body: tauri::ipc::InvokeBody::default(),
          headers: Default::default(),
          invoke_key: INVOKE_KEY.to_string(),
        },
      )
    };
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    let other = tauri::WebviewWindowBuilder::new(&app, "other", Default::default()).build().unwrap();
    assert!(call(&main).is_ok());
    assert!(call(&other).is_err());
  }
}
