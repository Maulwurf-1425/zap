//! Tray icon and "keep running in the background": closing the window hides
//! it (when enabled), so scheduled ZAPs keep working; the tray brings it back
//! or quits. With autostart, Windows starts ZAP hidden (`--hidden`).

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;

use crate::db;
use crate::state::AppState;

/// Argument the autostart entry passes: start in the tray, no window.
pub const HIDDEN_ARG: &str = "--hidden";

/// The "still running in the tray" notice is shown once per session.
static HINT_SHOWN: AtomicBool = AtomicBool::new(false);

pub fn started_hidden() -> bool {
    std::env::args().any(|a| a == HIDDEN_ARG)
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    // Opened after a notification (click, tray or a new launch): show that ZAP.
    if let Some(zap_id) = crate::zaps::take_notified() {
        let _ = app.emit("zap://focus", zap_id);
    }
}

fn german(app: &AppHandle) -> bool {
    db::get_settings(&app.state::<AppState>().db()).is_ok_and(|s| s.language == "de")
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let de = german(app);
    let open = MenuItem::with_id(
        app,
        "open",
        if de { "ZAP öffnen" } else { "Open ZAP" },
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        if de { "Beenden" } else { "Quit" },
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("ZAP")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Window focus and closing: closing hides it into the tray when the setting is on.
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    // Back in front after a notification (taskbar, Alt+Tab): show that ZAP.
    if let WindowEvent::Focused(true) = event {
        if let Some(zap_id) = crate::zaps::take_notified() {
            let _ = window.app_handle().emit("zap://focus", zap_id);
        }
        return;
    }
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    let app = window.app_handle();
    let keep = db::get_settings(&app.state::<AppState>().db()).is_ok_and(|s| s.close_to_tray);
    if !keep {
        return;
    }
    api.prevent_close();
    let _ = window.hide();
    if !HINT_SHOWN.swap(true, Ordering::Relaxed) {
        let (title, body) = if german(app) {
            (
                "ZAP läuft im Hintergrund weiter",
                "Geplante ZAPs arbeiten weiter. Über das Symbol im Infobereich öffnest oder beendest du ZAP.",
            )
        } else {
            (
                "ZAP keeps running in the background",
                "Scheduled ZAPs keep working. Use the tray icon to open or quit ZAP.",
            )
        };
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

/// Matches the Windows autostart entry to the setting.
pub fn sync_autostart(app: &AppHandle, enabled: bool) {
    let launcher = app.autolaunch();
    let current = launcher.is_enabled().unwrap_or(false);
    if enabled && !current {
        let _ = launcher.enable();
    } else if !enabled && current {
        let _ = launcher.disable();
    }
}
