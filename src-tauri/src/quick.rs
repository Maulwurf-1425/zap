//! Quick ask: a global shortcut (default Alt+Space) opens a small window
//! above all apps. Ask, read the answer, and either close it (Esc, or
//! clicking elsewhere) or continue the exchange as a chat in ZAP.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::db;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub const LABEL: &str = "quick";
const WIDTH: f64 = 680.0;
const HEIGHT: f64 = 460.0;

/// The shortcut currently registered (to swap it when the setting changes).
static ACTIVE: Mutex<Option<Shortcut>> = Mutex::new(None);

fn window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(LABEL)
}

/// Creates the hidden quick window once.
fn ensure_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    if let Some(w) = window(app) {
        return Ok(w);
    }
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?quick".into()))
        .title("ZAP")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .center()
        .shadow(true)
        .build()
}

/// Shows the window (centered, focused) or hides it when it is in front.
pub fn toggle(app: &AppHandle) {
    let Ok(w) = ensure_window(app) else { return };
    let showing = w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false);
    if showing {
        let _ = w.hide();
        return;
    }
    let _ = w.center();
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
    let _ = app.emit_to(LABEL, "quick://show", ());
}

/// Hides the quick window when it loses focus (like a launcher).
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    match event {
        WindowEvent::Focused(false) => {
            let _ = window.hide();
        }
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = window.hide();
        }
        _ => {}
    }
}

/// Registers the shortcut from the settings (or none when turned off).
/// Returns an error code when the shortcut is invalid or taken.
pub fn apply(app: &AppHandle) -> Result<(), &'static str> {
    let settings = db::get_settings(&app.state::<AppState>().db()).unwrap_or_default();
    let manager = app.global_shortcut();
    let mut active = crate::state::lock(&ACTIVE);
    if let Some(old) = active.take() {
        let _ = manager.unregister(old);
    }
    if !settings.quick_ask_enabled {
        return Ok(());
    }
    let shortcut: Shortcut = settings
        .quick_ask_shortcut
        .parse()
        .map_err(|_| "invalid_shortcut")?;
    manager.register(shortcut).map_err(|_| "shortcut_taken")?;
    *active = Some(shortcut);
    Ok(())
}

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                toggle(app);
            }
        })
        .build()
}

/// Sets up the window (hidden) and the shortcut at startup.
pub fn init(app: &AppHandle) {
    let _ = ensure_window(app);
    let _ = apply(app);
}

// --- Tauri commands ----------------------------------------------------------------

#[tauri::command]
pub fn quick_hide(app: AppHandle) {
    if let Some(w) = window(&app) {
        let _ = w.hide();
    }
}

/// Registers the shortcut again after a settings change; error code if it fails.
#[tauri::command]
pub fn quick_apply_shortcut(app: AppHandle) -> Option<&'static str> {
    apply(&app).err()
}

/// Model for quick questions: the default model, else the one used last.
#[tauri::command]
pub fn quick_model(state: State<'_, AppState>) -> Option<String> {
    let conn = state.db();
    db::get_settings(&conn)
        .ok()
        .and_then(|s| s.default_model)
        .filter(|m| !m.trim().is_empty())
        .or_else(|| db::last_chat_model(&conn).ok().flatten())
}

#[derive(Clone, Serialize)]
struct OpenChat<'a> {
    chat_id: &'a str,
}

/// Continues a quick question as a chat: hides the quick window and shows
/// the chat in ZAP's main window.
#[tauri::command]
pub fn quick_open_chat(app: AppHandle, chat_id: String) -> AppResult<()> {
    if chat_id.is_empty() {
        return Err(AppError::Other("missing chat".into()));
    }
    quick_hide(app.clone());
    crate::tray::show_main(&app);
    let _ = app.emit_to("main", "quick://open-chat", OpenChat { chat_id: &chat_id });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_choices_parse() {
        for s in [
            "Alt+Space",
            "Ctrl+Space",
            "Ctrl+Alt+Space",
            "Ctrl+Shift+Space",
            "Alt+Q",
        ] {
            assert!(s.parse::<Shortcut>().is_ok(), "{s} should parse");
        }
        assert!("Nonsense+Key".parse::<Shortcut>().is_err());
    }
}
