//! Quick ask: a global shortcut (default Alt+Space) opens a small window at
//! the bottom of the screen, above all apps. It looks like ZAP's chat box,
//! grows upward with the answer, and can attach a screenshot (a picked area
//! or the whole screen) with its text read by Windows OCR.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalRect, PhysicalSize, State, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::db;
use crate::error::{AppError, AppResult};
use crate::state::{lock, AppState};

pub const LABEL: &str = "quick";
/// Logical width of the window and its distance to the taskbar.
const WIDTH: f64 = 760.0;
const MARGIN: f64 = 18.0;
const MIN_HEIGHT: f64 = 90.0;

/// The shortcut currently registered (to swap it when the setting changes).
static ACTIVE: Mutex<Option<Shortcut>> = Mutex::new(None);

/// Where the window sits: the work area of the monitor it opened on, its
/// scale and the current height (logical).
struct Placement {
    area: PhysicalRect<i32, u32>,
    scale: f64,
    height: f64,
}
static PLACEMENT: Mutex<Option<Placement>> = Mutex::new(None);
/// While a screenshot area is picked, losing focus must not hide the window.
static CAPTURING: Mutex<bool> = Mutex::new(false);

fn window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(LABEL)
}

/// Creates the hidden quick window once (transparent: only the cards show).
fn ensure_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    if let Some(w) = window(app) {
        return Ok(w);
    }
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?quick".into()))
        .title("ZAP")
        .inner_size(WIDTH, 140.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()
}

/// Moves the window to the bottom center of its monitor's work area.
fn place(w: &tauri::WebviewWindow, p: &Placement) {
    let width = (WIDTH * p.scale).round() as u32;
    let height = (p.height * p.scale).round() as u32;
    let x = p.area.position.x + (p.area.size.width as i32 - width as i32) / 2;
    let y =
        p.area.position.y + p.area.size.height as i32 - height as i32 - (MARGIN * p.scale) as i32;
    let _ = w.set_size(PhysicalSize::new(width, height));
    let _ = w.set_position(PhysicalPosition::new(x, y));
}

/// The monitor under the mouse (falls back to the primary one).
fn current_monitor(app: &AppHandle) -> Option<tauri::Monitor> {
    app.cursor_position()
        .ok()
        .and_then(|c| app.monitor_from_point(c.x, c.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
}

/// Shows the window (bottom of the screen, focused) or hides it when in front.
pub fn toggle(app: &AppHandle) {
    let Ok(w) = ensure_window(app) else { return };
    let showing = w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false);
    if showing {
        let _ = w.hide();
        return;
    }
    if let Some(m) = current_monitor(app) {
        let mut placement = lock(&PLACEMENT);
        let height = placement.as_ref().map_or(140.0, |p| p.height);
        let p = Placement {
            area: *m.work_area(),
            scale: m.scale_factor(),
            height,
        };
        place(&w, &p);
        *placement = Some(p);
    }
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
    let _ = app.emit_to(LABEL, "quick://show", ());
}

/// Hides the quick window when it loses focus (like a launcher).
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    match event {
        WindowEvent::Focused(false) if !*lock(&CAPTURING) => {
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
    let mut active = lock(&ACTIVE);
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

// --- Screen capture ------------------------------------------------------------

#[derive(Serialize)]
pub struct Capture {
    /// The whole monitor as JPEG data URL.
    pub image: String,
    pub width: u32,
    pub height: u32,
}

fn jpeg_data_url(img: &image::RgbImage) -> AppResult<String> {
    use base64::Engine;
    let mut out = std::io::Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 88)
        .encode_image(img)
        .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(out.into_inner())
    ))
}

/// Hides the window, takes a picture of its monitor, then covers that
/// monitor with the window so an area can be picked on the frozen image.
#[tauri::command]
pub async fn quick_capture_start(app: AppHandle) -> AppResult<Capture> {
    let w = window(&app).ok_or_else(|| AppError::Other("no window".into()))?;
    *lock(&CAPTURING) = true;
    let _ = w.hide();
    // Let Windows remove the window before the picture.
    tokio::time::sleep(Duration::from_millis(220)).await;
    let center = lock(&PLACEMENT).as_ref().map(|p| {
        (
            p.area.position.x + p.area.size.width as i32 / 2,
            p.area.position.y + p.area.size.height as i32 / 2,
        )
    });
    let shot =
        tokio::task::spawn_blocking(move || -> Result<(i32, i32, image::RgbImage), String> {
            let monitor = match center {
                Some((x, y)) => xcap::Monitor::from_point(x, y).map_err(|e| e.to_string())?,
                None => xcap::Monitor::all()
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .next()
                    .ok_or_else(|| "no monitor".to_string())?,
            };
            let x = monitor.x().map_err(|e| e.to_string())?;
            let y = monitor.y().map_err(|e| e.to_string())?;
            let rgba = monitor.capture_image().map_err(|e| e.to_string())?;
            Ok((x, y, image::DynamicImage::ImageRgba8(rgba).to_rgb8()))
        })
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    let (x, y, img) = match shot {
        Ok(s) => s,
        Err(e) => {
            *lock(&CAPTURING) = false;
            let _ = w.show();
            return Err(AppError::Other(format!("capture_failed: {e}")));
        }
    };
    let (width, height) = img.dimensions();
    let image = tokio::task::spawn_blocking(move || jpeg_data_url(&img))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    let _ = w.set_position(PhysicalPosition::new(x, y));
    let _ = w.set_size(PhysicalSize::new(width, height));
    let _ = w.show();
    let _ = w.set_focus();
    Ok(Capture {
        image,
        width,
        height,
    })
}

/// Back to the chat box at the bottom after picking (or cancelling).
#[tauri::command]
pub fn quick_capture_end(app: AppHandle) {
    if let (Some(w), Some(p)) = (window(&app), lock(&PLACEMENT).as_ref()) {
        place(&w, p);
        let _ = w.set_focus();
    }
    *lock(&CAPTURING) = false;
}

/// Text on an image (JPEG/PNG data URL), read by the Windows OCR in the
/// user's languages. Empty when there is none or OCR isn't available.
#[tauri::command]
pub async fn quick_ocr(image: String) -> AppResult<String> {
    tokio::task::spawn_blocking(move || ocr(&image))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[cfg(windows)]
fn ocr(data_url: &str) -> AppResult<String> {
    use base64::Engine;
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::DataWriter;
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

    let b64 = data_url.split_once(";base64,").map_or(data_url, |(_, d)| d);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|_| AppError::Other("bad image".into()))?;
    let img = image::load_from_memory(&bytes)
        .map_err(|_| AppError::Other("bad image".into()))?
        .to_rgba8();
    let (w, h) = img.dimensions();
    // Windows wants BGRA.
    let mut bgra = img.into_raw();
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    let run = || -> windows::core::Result<String> {
        unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
        }
        let writer = DataWriter::new()?;
        writer.WriteBytes(&bgra)?;
        let buffer = writer.DetachBuffer()?;
        let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
            &buffer,
            BitmapPixelFormat::Bgra8,
            w as i32,
            h as i32,
        )?;
        let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
        let result = engine.RecognizeAsync(&bitmap)?.join()?;
        let mut lines = Vec::new();
        for line in result.Lines()? {
            lines.push(line.Text()?.to_string());
        }
        Ok(lines.join("\n"))
    };
    run().map_err(|e| AppError::Other(format!("ocr: {e}")))
}

#[cfg(not(windows))]
fn ocr(_: &str) -> AppResult<String> {
    Ok(String::new())
}

// --- Tauri commands ----------------------------------------------------------------

#[tauri::command]
pub fn quick_hide(app: AppHandle) {
    if let Some(w) = window(&app) {
        let _ = w.hide();
    }
}

/// The chat box grew or shrank: keep the window bottom-anchored.
#[tauri::command]
pub fn quick_resize(app: AppHandle, height: f64) {
    let Some(w) = window(&app) else { return };
    if *lock(&CAPTURING) {
        return;
    }
    let mut placement = lock(&PLACEMENT);
    if let Some(p) = placement.as_mut() {
        let max = p.area.size.height as f64 / p.scale - 2.0 * MARGIN;
        p.height = height.clamp(MIN_HEIGHT, max);
        place(&w, p);
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

    // Live OCR on a rendered text image: `cargo test live_ocr -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_ocr() {
        // A screenshot of the primary monitor, read back.
        let m = xcap::Monitor::all().unwrap().into_iter().next().unwrap();
        let img = image::DynamicImage::ImageRgba8(m.capture_image().unwrap()).to_rgb8();
        let url = jpeg_data_url(&img).unwrap();
        let text = ocr(&url).unwrap();
        println!(
            "{} chars of text, start: {:?}",
            text.len(),
            text.chars().take(120).collect::<String>()
        );
        assert!(!text.trim().is_empty(), "a normal screen has some text");
    }
}
