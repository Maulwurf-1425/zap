// Hide the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod engine;
mod error;
mod file_tools;
mod files;
mod lmstudio;
mod ndjson;
mod ollama;
mod provider;
mod state;
mod tools;
mod web;

use tauri::{Manager, RunEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags, WindowExt};

use crate::state::AppState;

/// Size, position and maximized state are restored; visibility is handled
/// here so the window only appears once it is in place (no jump).
fn window_flags() -> StateFlags {
    StateFlags::all().difference(StateFlags::VISIBLE)
}

fn focus_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        // Must be registered first: a second launch just focuses this one.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main(app)
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_flags())
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = db::open(&dir.join("zap.db"))?;
            app.manage(AppState::new(conn, dir.clone()));

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.restore_state(window_flags());
                let _ = window.show();
            }

            tauri::async_runtime::spawn(engine::supervise(app.handle().clone()));
            // With file access on, keep the file index ready (and live) from the start.
            if db::get_settings(&app.state::<AppState>().db()).is_ok_and(|s| s.file_tools_enabled) {
                file_tools::ensure_index(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::provider_status,
            commands::provider_start,
            commands::list_models,
            commands::model_capabilities,
            commands::show_model,
            commands::pull_model,
            commands::cancel_pull,
            commands::delete_model,
            commands::chat_stream,
            commands::stop_generation,
            commands::generate_title,
            commands::create_chat,
            commands::list_chats,
            commands::search_chats,
            commands::rename_chat,
            commands::pin_chat,
            commands::set_chat_model,
            commands::delete_chat,
            commands::delete_all_chats,
            commands::get_messages,
            commands::save_message,
            commands::update_message,
            commands::delete_message,
            commands::delete_messages_after,
            commands::export_chat,
            commands::export_all,
            commands::import_all,
            commands::token_usage,
            commands::chat_usage,
            commands::reset_usage,
            commands::search_status,
            commands::set_brave_key,
            commands::test_search,
            commands::searxng_setup,
            commands::file_search,
            commands::index_status,
            commands::rebuild_index,
            commands::read_file_attachment,
            commands::answer_approval,
            commands::get_settings,
            commands::set_settings,
        ])
        .build(tauri::generate_context!())
        .expect("error while building ZAP")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let _ = app.save_window_state(window_flags());
                // Only stops Ollama if ZAP started it.
                if let Some(state) = app.try_state::<AppState>() {
                    state.kill_child();
                }
            }
        });
}
