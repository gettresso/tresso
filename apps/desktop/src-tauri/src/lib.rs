mod accessibility;
mod sql;
mod tokens;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  single_instance(tauri::Builder::default())
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_notification::init())
    .manage(sql::Databases::default())
    .invoke_handler(tauri::generate_handler![
      accessibility::reduce_transparency,
      tokens::load_tokens,
      tokens::save_tokens,
      tokens::clear_tokens,
      sql::sql_open,
      sql::sql_exec,
      sql::sql_begin,
      sql::sql_commit,
      sql::sql_rollback,
      sql::sql_run,
      sql::sql_select,
      sql::sql_close,
      sql::sql_delete,
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // Installed apps register the scheme through their bundle; a development build registers it at runtime
      // (macOS only accepts the bundle, so sign-in there needs `tauri build` or the debug bundle).
      #[cfg(all(debug_assertions, any(target_os = "linux", target_os = "windows")))]
      {
        use tauri_plugin_deep_link::DeepLinkExt;
        app.deep_link().register_all()?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}

/// On Windows and Linux a `tresso://` link starts a second process; this hands the link to the running app instead
/// (the deep link plugin then emits it there). It must be the first plugin.
#[cfg(any(target_os = "linux", target_os = "windows"))]
fn single_instance(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
  use tauri::Manager;

  builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
    if let Some(window) = app.get_webview_window("main") {
      let _ = window.unminimize();
      let _ = window.set_focus();
    }
  }))
}

/// macOS delivers links to the running app itself.
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn single_instance(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
  builder
}
