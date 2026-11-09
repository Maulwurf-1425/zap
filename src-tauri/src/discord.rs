//! Discord Rich Presence ("Playing ZAP – chatting with qwen3"). Talks to the
//! local Discord app over its IPC pipe; nothing goes over the network from
//! ZAP. Only status and model name are shared, never chat content.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use discord_rich_presence::activity::{Activity, ActivityType, Assets, Button, Timestamps};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

/// The "ZAP" application in the Discord Developer Portal. Its art assets
/// need an image with the key `zap`.
const APP_ID: &str = "1569391371352154245";
const LARGE_IMAGE: &str = "zap";
const DOWNLOAD_URL: &str = "https://github.com/Maulwurf-1425/zap/releases/latest";
/// Discord allows 5 activity updates per 20 s.
const MIN_UPDATE_GAP: Duration = Duration::from_secs(4);
const RETRY_EVERY: Duration = Duration::from_secs(15);

fn app_id() -> Option<String> {
    std::env::var("ZAP_DISCORD_APP_ID")
        .ok()
        .or_else(|| Some(APP_ID.to_string()))
        .filter(|id| !id.trim().is_empty())
}

/// What the UI wants to show. Texts come localized from the frontend.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Presence {
    /// First line, e.g. "Chatting with qwen3".
    pub details: String,
    /// Second line, e.g. "Thinking …".
    pub state: Option<String>,
    /// Session start, Unix ms (Discord shows the elapsed time).
    pub start: i64,
    /// Hover text of the image and the button label.
    pub image_text: String,
    pub button: String,
}

enum Msg {
    Set(Presence),
    Clear,
}

pub struct DiscordState {
    tx: Mutex<Option<Sender<Msg>>>,
}

impl Default for DiscordState {
    fn default() -> Self {
        Self {
            tx: Mutex::new(None),
        }
    }
}

#[derive(Clone, Serialize)]
struct StatusEvent {
    connected: bool,
}

/// Whether this build knows a Discord application id.
#[tauri::command]
pub fn discord_available() -> bool {
    app_id().is_some()
}

#[tauri::command]
pub fn discord_update(app: AppHandle, state: State<'_, DiscordState>, presence: Presence) {
    send(&app, &state, Msg::Set(presence));
}

#[tauri::command]
pub fn discord_clear(app: AppHandle, state: State<'_, DiscordState>) {
    send(&app, &state, Msg::Clear);
}

fn send(app: &AppHandle, state: &DiscordState, msg: Msg) {
    let Some(id) = app_id() else {
        return;
    };
    let mut tx = state.tx.lock().unwrap_or_else(|e| e.into_inner());
    if tx.is_none() {
        let (sender, receiver) = mpsc::channel();
        let app = app.clone();
        std::thread::spawn(move || run(app, id, receiver));
        *tx = Some(sender);
    }
    if let Some(sender) = tx.as_ref() {
        let _ = sender.send(msg);
    }
}

fn activity(p: &Presence) -> Activity<'_> {
    let mut a = Activity::new()
        .activity_type(ActivityType::Playing)
        .details(p.details.as_str())
        .timestamps(Timestamps::new().start(p.start))
        .assets(
            Assets::new()
                .large_image(LARGE_IMAGE)
                .large_text(p.image_text.as_str()),
        )
        .buttons(vec![Button::new(p.button.as_str(), DOWNLOAD_URL)]);
    if let Some(state) = p.state.as_deref() {
        a = a.state(state);
    }
    a
}

/// Owns the IPC client: applies the latest wanted presence, at most every
/// few seconds, and reconnects when Discord (re)starts.
fn run(app: AppHandle, id: String, rx: Receiver<Msg>) {
    let mut client = DiscordIpcClient::new(&id);
    let mut connected = false;
    let mut wanted: Option<Presence> = None;
    let mut shown: Option<Presence> = None;
    let mut dirty = false;
    let mut last_update = Instant::now()
        .checked_sub(MIN_UPDATE_GAP)
        .unwrap_or_else(Instant::now);
    let mut last_try = Instant::now()
        .checked_sub(RETRY_EVERY)
        .unwrap_or_else(Instant::now);

    let set_connected = |c: bool, connected: &mut bool| {
        if *connected != c {
            *connected = c;
            let _ = app.emit("discord://status", StatusEvent { connected: c });
        }
    };

    loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Msg::Set(p)) => {
                dirty |= wanted.as_ref() != Some(&p);
                wanted = Some(p);
            }
            Ok(Msg::Clear) => {
                dirty |= wanted.is_some();
                wanted = None;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if !dirty {
            continue;
        }
        if !connected {
            // Nothing to show: no need to connect.
            if wanted.is_none() {
                shown = None;
                dirty = false;
                continue;
            }
            if last_try.elapsed() < RETRY_EVERY {
                continue;
            }
            last_try = Instant::now();
            if client.connect().is_err() {
                continue;
            }
            set_connected(true, &mut connected);
            shown = None;
        }
        if last_update.elapsed() < MIN_UPDATE_GAP {
            continue;
        }
        let result = match &wanted {
            Some(p) if shown.as_ref() != Some(p) => client.set_activity(activity(p)),
            Some(_) => Ok(()),
            None => client.clear_activity(),
        };
        last_update = Instant::now();
        match result {
            Ok(()) => {
                shown = wanted.clone();
                dirty = false;
            }
            Err(_) => {
                // Discord was closed: reconnect on the next try.
                let _ = client.close();
                set_connected(false, &mut connected);
                last_try = Instant::now();
            }
        }
    }
    let _ = client.clear_activity();
    let _ = client.close();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_an_activity_without_chat_content() {
        let p = Presence {
            details: "Chatting with qwen3".into(),
            state: Some("Thinking …".into()),
            start: 1_700_000_000_000,
            image_text: "ZAP – local AI chat".into(),
            button: "Get ZAP".into(),
        };
        let json = serde_json::to_value(activity(&p)).unwrap();
        assert_eq!(json["details"], "Chatting with qwen3");
        assert_eq!(json["state"], "Thinking …");
        assert_eq!(json["assets"]["large_image"], "zap");
        assert_eq!(json["buttons"][0]["url"], DOWNLOAD_URL);
        assert_eq!(json["timestamps"]["start"], 1_700_000_000_000_i64);
    }

    /// Needs Discord running and ZAP_DISCORD_APP_ID set:
    /// `cargo test live_discord -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_discord() {
        let id = app_id().expect("set ZAP_DISCORD_APP_ID");
        let mut client = DiscordIpcClient::new(&id);
        client.connect().expect("Discord not running?");
        let p = Presence {
            details: "Testing ZAP".into(),
            state: Some("Live test".into()),
            start: crate::db::now_ms(),
            image_text: "ZAP".into(),
            button: "Get ZAP".into(),
        };
        client.set_activity(activity(&p)).unwrap();
        println!("presence set; check your Discord profile");
        std::thread::sleep(Duration::from_secs(10));
        client.clear_activity().unwrap();
        client.close().unwrap();
    }
}
