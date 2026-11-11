mod accessibility;
mod sql;
mod tokens;
mod updates;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  single_instance(tauri::Builder::default())
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_process::init())
    .manage(sql::Databases::default())
    .manage(updates::UpdateListener::default())
    // A new page in the main window does not listen for Sparkle's relaunch question until it says so (updates.rs).
    .on_page_load(|webview, payload| {
      use tauri::Manager;
      if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Started {
        webview.state::<updates::UpdateListener>().page_loading();
      }
    })
    .invoke_handler(tauri::generate_handler![
      accessibility::reduce_transparency,
      updates::update_channel,
      updates::check_for_updates_natively,
      updates::update_listening,
      updates::update_relaunch,
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
      main_window(app)?;
      // macOS updates through Sparkle; Windows and Linux through Tauri's updater, driven by the web client.
      #[cfg(target_os = "macos")]
      updates::setup(app)?;
      #[cfg(not(target_os = "macos"))]
      app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
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
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|_app, event| {
      // A token set the server just rotated is lost when the app quits before the keychain has it.
      if let tauri::RunEvent::Exit = event {
        tokens::finish_pending(std::time::Duration::from_secs(5));
      }
    });
}

/// The main window, from the window in tauri.conf.json (`create: false` there, so it is made here). Links in a mail
/// body ask for a new window (the frame's `<base target="_blank">`), and so does `window.open`: web views open none
/// in the desktop app by themselves (macOS and Linux) or a bare one inside it (Windows), so web addresses and mail
/// links open in the user's browser and mail app, and anything else is refused.
fn main_window(app: &tauri::App) -> tauri::Result<()> {
  use tauri::Manager;

  let config = app
    .config()
    .app
    .windows
    .iter()
    .find(|window| window.label == "main")
    .expect("tauri.conf.json defines the main window");
  tauri::WebviewWindowBuilder::from_config(app.handle(), config)?
    .on_new_window(|url, _features| {
      if opens_outside(&url)
        && let Err(error) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>)
      {
        log::error!("Opening {url} failed: {error}");
      }
      tauri::webview::NewWindowResponse::Deny
    })
    .build()?;
  Ok(())
}

/// Whether a link a page wants in a new window opens outside the app: web pages and mail addresses only.
fn opens_outside(url: &tauri::Url) -> bool {
  matches!(url.scheme(), "http" | "https" | "mailto")
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

#[cfg(test)]
mod tests {
  use super::opens_outside;

  /// The sources of one directive of the app's Content-Security-Policy.
  fn csp_sources(directive: &str) -> Vec<String> {
    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let csp = config["app"]["security"]["csp"].as_str().unwrap();
    csp
      .split(';')
      .map(str::trim)
      .find_map(|part| part.strip_prefix(directive).filter(|rest| rest.starts_with(' ')))
      .unwrap_or_else(|| panic!("the CSP has no {directive}"))
      .split_whitespace()
      .map(str::to_string)
      .collect()
  }

  /// A server on the user's own machine (the sign-in screen accepts http://localhost) serves mail images as well.
  #[test]
  fn every_local_server_the_app_talks_to_may_serve_images() {
    let images = csp_sources("img-src");
    let local = csp_sources("connect-src").into_iter().filter(|source| source.starts_with("http://"));
    let mut checked = 0;
    for source in local.filter(|source| !source.starts_with("http://ipc.")) {
      assert!(images.contains(&source), "img-src lacks {source}");
      checked += 1;
    }
    assert_eq!(checked, 2);
  }

  #[test]
  fn only_web_pages_and_mail_addresses_open_outside_the_app() {
    for url in ["https://example.com/a?b=c", "http://example.com/", "mailto:kim@example.com"] {
      assert!(opens_outside(&url.parse().unwrap()), "{url}");
    }
    for url in ["tresso://auth/callback?code=x", "file:///etc/passwd", "javascript:alert(1)", "about:blank", "tel:+31201234567", "data:text/html,x", "smb://host/share"] {
      assert!(!opens_outside(&url.parse().unwrap()), "{url}");
    }
  }
}
