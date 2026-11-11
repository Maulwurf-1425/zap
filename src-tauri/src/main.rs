// Hide the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod commands;
mod db;
mod discord;
mod docker;
mod engine;
mod error;
mod file_tools;
mod files;
mod installer;
mod lmstudio;
mod monitor;
mod ndjson;
mod ollama;
mod provider;
mod schedule;
mod state;
mod system_tools;
mod tools;
mod tray;
mod versions;
mod voice;
mod web;
mod zaps;

use tauri::{Manager, RunEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags, WindowExt};

use crate::state::AppState;

/// Size, position and maximized state are restored; visibility is handled
/// here so the window only appears once it is in place (no jump).
fn window_flags() -> StateFlags {
    StateFlags::all().difference(StateFlags::VISIBLE)
}

fn main() {
    tauri::Builder::default()
        // Must be registered first: a second launch just focuses this one.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main(app)
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![tray::HIDDEN_ARG]),
        ))
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
            app.manage(voice::VoiceState::default());
            app.manage(discord::DiscordState::default());

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.restore_state(window_flags());
                // Started by Windows autostart: stay in the tray.
                if !tray::started_hidden() {
                    let _ = window.show();
                }
            }
            tray::init(app.handle())?;
            let settings = db::get_settings(&app.state::<AppState>().db()).unwrap_or_default();
            tray::sync_autostart(app.handle(), settings.autostart);

            tauri::async_runtime::spawn(engine::supervise(app.handle().clone()));
            zaps::init(app.handle());
            schedule::init(app.handle());
            // With file access on, keep the file index ready (and live) from the start.
            if db::get_settings(&app.state::<AppState>().db()).is_ok_and(|s| s.file_tools_enabled) {
                file_tools::ensure_index(app.handle());
            }
            Ok(())
        })
        .on_window_event(tray::on_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::provider_status,
            commands::provider_start,
            commands::provider_restart,
            versions::tool_versions,
            versions::open_tool,
            commands::searxng_container,
            commands::searxng_control,
            commands::read_link,
            discord::discord_available,
            discord::discord_update,
            discord::discord_clear,
            voice::voice_status,
            voice::voice_install,
            voice::voice_remove,
            voice::record_start,
            voice::record_stop,
            voice::record_cancel,
            voice::speak_start,
            voice::speak_push,
            voice::speak_end,
            voice::speak_stop,
            commands::engine_install_supported,
            commands::install_engine,
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
            commands::set_chat_group,
            commands::list_groups,
            commands::create_group,
            commands::rename_group,
            commands::set_group_color,
            commands::set_group_collapsed,
            commands::reorder_groups,
            commands::delete_group,
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
            monitor::system_usage,
            monitor::loaded_models,
            monitor::unload_models,
            zaps::zaps_list,
            zaps::zap_save,
            zaps::zap_delete,
            zaps::zap_runs,
            zaps::zap_totals,
            zaps::zap_active_runs,
            zaps::zap_start,
            zaps::zap_stop,
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
