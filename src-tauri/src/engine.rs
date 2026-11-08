//! Engine orchestration: which providers are enabled, their status, starting
//! them, health checks, and routing a model key to the right provider.

use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::db;
use crate::lmstudio::{self, LmStudio};
use crate::ollama::{self, Ollama};
use crate::provider::{
    parse_model_key, AnyProvider, ChatProvider, ModelInfo, ProviderKind, ProviderStatus,
};
use crate::state::{lock, AppState};

const HEALTH_INTERVAL: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, Copy)]
pub struct EngineConfig {
    pub ollama_enabled: bool,
    pub lmstudio_enabled: bool,
    pub lmstudio_port: u16,
}

impl EngineConfig {
    pub fn enabled(&self, kind: ProviderKind) -> bool {
        match kind {
            ProviderKind::Ollama => self.ollama_enabled,
            ProviderKind::Lmstudio => self.lmstudio_enabled,
        }
    }
}

pub fn config(state: &AppState) -> EngineConfig {
    let s = db::get_settings(&state.db()).unwrap_or_default();
    EngineConfig {
        ollama_enabled: s.ollama_enabled,
        lmstudio_enabled: s.lmstudio_enabled,
        lmstudio_port: if s.lmstudio_port == 0 {
            lmstudio::DEFAULT_PORT
        } else {
            s.lmstudio_port
        },
    }
}

#[derive(Clone, Serialize)]
struct StatusEvent {
    provider: ProviderKind,
    status: ProviderStatus,
}

pub fn set_status(app: &AppHandle, kind: ProviderKind, status: ProviderStatus) {
    let state = app.state::<AppState>();
    let changed = {
        let mut statuses = lock(&state.statuses);
        let changed = statuses.get(kind) != status;
        statuses.set(kind, status);
        changed
    };
    if changed {
        let _ = app.emit(
            "provider://status",
            StatusEvent {
                provider: kind,
                status,
            },
        );
    }
}

async fn is_up(state: &AppState, kind: ProviderKind, cfg: &EngineConfig) -> bool {
    match kind {
        ProviderKind::Ollama => ollama::is_up(&state.http).await,
        ProviderKind::Lmstudio => lmstudio::is_up(&state.http, cfg.lmstudio_port).await,
    }
}

fn installed(kind: ProviderKind) -> bool {
    match kind {
        ProviderKind::Ollama => ollama::installed(),
        ProviderKind::Lmstudio => lmstudio::installed(),
    }
}

/// Uses a running server or starts it. Disabled providers report `Disabled`.
pub async fn ensure(app: &AppHandle, kind: ProviderKind) -> ProviderStatus {
    let state = app.state::<AppState>();
    let cfg = config(&state);
    if !cfg.enabled(kind) {
        set_status(app, kind, ProviderStatus::Disabled);
        return ProviderStatus::Disabled;
    }
    if state.starting(kind).swap(true, Ordering::SeqCst) {
        return state.status(kind);
    }
    let on_starting = || set_status(app, kind, ProviderStatus::Starting);
    let status = match kind {
        ProviderKind::Ollama => ollama::start(&state, on_starting).await,
        ProviderKind::Lmstudio => {
            lmstudio::start(&state.http, cfg.lmstudio_port, on_starting).await
        }
    };
    set_status(app, kind, status);
    state.starting(kind).store(false, Ordering::SeqCst);
    status
}

/// Starts enabled providers, then keeps their status in sync (a server
/// quits, the user installs or enables one while ZAP is open).
pub async fn supervise(app: AppHandle) {
    futures_util::future::join(
        ensure(&app, ProviderKind::Ollama),
        ensure(&app, ProviderKind::Lmstudio),
    )
    .await;
    loop {
        tokio::time::sleep(HEALTH_INTERVAL).await;
        let state = app.state::<AppState>();
        let cfg = config(&state);
        for kind in ProviderKind::ALL {
            if state.starting(kind).load(Ordering::SeqCst) {
                continue;
            }
            if !cfg.enabled(kind) {
                set_status(&app, kind, ProviderStatus::Disabled);
                continue;
            }
            let up = is_up(&state, kind, &cfg).await;
            let next = match (state.status(kind), up) {
                (_, true) => ProviderStatus::Running,
                (ProviderStatus::Running | ProviderStatus::Disabled, false) => {
                    if installed(kind) {
                        ProviderStatus::Stopped
                    } else {
                        ProviderStatus::NotFound
                    }
                }
                (current, false) => current,
            };
            set_status(&app, kind, next);
        }
    }
}

pub fn provider<'a>(
    state: &'a AppState,
    kind: ProviderKind,
    cfg: &EngineConfig,
) -> AnyProvider<'a> {
    match kind {
        ProviderKind::Ollama => AnyProvider::Ollama(Ollama { http: &state.http }),
        ProviderKind::Lmstudio => AnyProvider::LmStudio(LmStudio {
            http: &state.http,
            port: cfg.lmstudio_port,
        }),
    }
}

/// Resolves a model key (see `provider::model_key`) to its provider and the
/// provider-native model name.
pub fn route<'a, 'k>(state: &'a AppState, key: &'k str) -> (AnyProvider<'a>, &'k str) {
    let cfg = config(state);
    let (kind, name) = parse_model_key(key);
    (provider(state, kind, &cfg), name)
}

/// Models of every enabled, running provider. A provider that fails to
/// answer is skipped so the other one still shows its models.
pub async fn list_all_models(state: &AppState) -> Vec<ModelInfo> {
    let cfg = config(state);
    let mut all = Vec::new();
    for kind in ProviderKind::ALL {
        if !cfg.enabled(kind) || state.status(kind) != ProviderStatus::Running {
            continue;
        }
        if let Ok(models) = provider(state, kind, &cfg).list_models().await {
            all.extend(models);
        }
    }
    all
}
