mod accessibility;
mod glass;
mod menu;
mod sql;
mod tokens;
mod updates;
mod whatsapp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  single_instance(tauri::Builder::default())
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_dialog::init())
    .manage(sql::Databases::default())
    .manage(updates::UpdateListener::default())
    .manage(whatsapp::Bridge::default())
    // Filled on macOS once the menu bar is built (menu.rs); empty where the app has none.
    .manage(<menu::MenuItems>::default())
    // The Liquid Glass views behind the sidebar card (glass.rs, macOS 26 and later).
    .manage(glass::GlassViews::default())
    // A new page in the main window does not listen for Sparkle's relaunch question until it says so (updates.rs).
    .on_page_load(|webview, payload| {
      use tauri::Manager;
      if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Started {
        webview.state::<updates::UpdateListener>().page_loading();
        glass::page_loading(webview);
      }
    })
    .invoke_handler(tauri::generate_handler![
      accessibility::reduce_transparency,
      accessibility::selection_accent,
      glass::set_glass,
      updates::update_channel,
      updates::check_for_updates_natively,
      updates::update_listening,
      updates::update_relaunch,
      menu::menu_state,
      menu::show_main_window_command,
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
      sql::sql_list,
      whatsapp::whatsapp_available,
      whatsapp::whatsapp_device,
      whatsapp::whatsapp_config_load,
      whatsapp::whatsapp_config_save,
      whatsapp::whatsapp_config_clear,
      whatsapp::whatsapp_config_keep_only,
      whatsapp::whatsapp_choose_folder,
      whatsapp::whatsapp_inspect,
      whatsapp::whatsapp_start,
      whatsapp::whatsapp_stop,
      whatsapp::whatsapp_state,
      whatsapp::whatsapp_identity,
      whatsapp::whatsapp_read,
      whatsapp::whatsapp_names,
      whatsapp::whatsapp_send,
      whatsapp::whatsapp_download,
      whatsapp::whatsapp_open_file,
      whatsapp::whatsapp_choose_file,
    ])
    .setup(|app| {
      main_window(app)?;
      // The WhatsApp bridge's events go to the window; a bridge a crashed run left behind is stopped (whatsapp.rs).
      whatsapp::setup(app.handle());
      // macOS updates through Sparkle, which its item in the menu bar asks; Windows and Linux through Tauri's updater,
      // driven by the web client. Only macOS has a menu bar (menu.rs).
      #[cfg(target_os = "macos")]
      {
        let updates = updates::setup(app);
        menu::setup(app, updates)?;
      }
      #[cfg(not(target_os = "macos"))]
      app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // A `tresso://` link (the sign-in coming back from the browser, a link the user clicked) is handled in the window,
      // which may be closed (hidden, macOS) or minimized: it comes to the front first.
      {
        use tauri_plugin_deep_link::DeepLinkExt;
        let handle = app.handle().clone();
        app.deep_link().on_open_url(move |_| menu::show_main_window(&handle));
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
    .run(|app, event| match event {
      tauri::RunEvent::Exit => {
        // A token set the server just rotated is lost when the app quits before the keychain has it.
        tokens::finish_pending(std::time::Duration::from_secs(5));
        // The WhatsApp bridge Tresso started does not outlive it.
        whatsapp::stop_on_exit(app);
      }
      // A click on the Dock icon while the window is closed (macOS keeps the app running) brings it back.
      #[cfg(target_os = "macos")]
      tauri::RunEvent::Reopen { has_visible_windows: false, .. } => menu::show_main_window(app),
      _ => {}
    });
}

/// The main window, from the window in tauri.conf.json (`create: false` there, so it is made here). Links in a mail
/// body ask for a new window (the frame's `<base target="_blank">`), and so does `window.open`: web views open none
/// in the desktop app by themselves (macOS and Linux) or a bare one inside it (Windows), so web addresses and mail
/// links open in the user's browser and mail app, and anything else is refused.
fn main_window(app: &tauri::App) -> tauri::Result<()> {
  let config = app
    .config()
    .app
    .windows
    .iter()
    .find(|window| window.label == "main")
    .expect("tauri.conf.json defines the main window");
  let window = tauri::WebviewWindowBuilder::from_config(app.handle(), config)?
    .on_new_window(|url, _features| {
      if opens_outside(&url)
        && let Err(error) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>)
      {
        log::error!("Opening {url} failed: {error}");
      }
      tauri::webview::NewWindowResponse::Deny
    })
    .build()?;
  // Liquid Glass behind the sidebar card where macOS has it (glass.rs); the window as configured elsewhere.
  glass::setup(&window);
  // Closing it keeps the app in the Dock (macOS); elsewhere closing the only window quits, as it does there.
  #[cfg(target_os = "macos")]
  menu::keep_main_window(&window);
  #[cfg(not(target_os = "macos"))]
  let _ = window;
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
  builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| crate::menu::show_main_window(app)))
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

  /// A pixel token of the web client's frame stylesheet, where the window frame keeps its numbers.
  fn frame_token(name: &str) -> f64 {
    let css = include_str!("../../../web/src/assets/frame.css");
    let start = css.find(&format!("--{name}:")).unwrap_or_else(|| panic!("frame.css has no --{name}")) + name.len() + 3;
    css[start..].trim_start().split("px;").next().unwrap().parse().unwrap()
  }

  /// The window frame's spec: 1240 x 780 on every system (each launch: the app keeps no window state), and the traffic
  /// lights' inset the frame keeps with its other numbers. Where AppKit then draws them is only seen on a built app.
  #[test]
  fn the_window_opens_as_the_frame_says() {
    for config in [include_str!("../tauri.conf.json"), include_str!("../tauri.macos.conf.json")] {
      let config: serde_json::Value = serde_json::from_str(config).unwrap();
      let window = &config["app"]["windows"][0];
      assert_eq!((window["width"].as_f64(), window["height"].as_f64()), (Some(1240.0), Some(780.0)));
    }
    let mac: serde_json::Value = serde_json::from_str(include_str!("../tauri.macos.conf.json")).unwrap();
    let inset = &mac["app"]["windows"][0]["trafficLightPosition"];
    assert_eq!(inset["x"].as_f64(), Some(frame_token("frame-traffic-light-inset-x")));
    assert_eq!(inset["y"].as_f64(), Some(frame_token("frame-traffic-light-inset-y")));
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
