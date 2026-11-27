//! System display settings the web client cannot read itself: WebKit on macOS does not support the
//! `prefers-reduced-transparency` media query, yet the window's own vibrancy turns solid when the user asks for less
//! transparency, so the glass in the page has to follow.

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
