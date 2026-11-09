use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::Connection;
use tokio_util::sync::CancellationToken;

use crate::files::FileIndex;
use crate::provider::{ProviderKind, ProviderStatus, Statuses};

/// The user's answer to a file-tool approval request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Allow,
    Deny,
    /// Allow this and every further file action in the same chat.
    AllowChat,
}

pub struct AppState {
    /// Loopback model servers (Ollama, LM Studio).
    pub http: reqwest::Client,
    /// Optional web tools (search, page reading); browser UA, public hosts only.
    pub web: reqwest::Client,
    pub db: Mutex<Connection>,
    pub statuses: Mutex<Statuses>,
    /// Only set when ZAP spawned `ollama serve` itself.
    pub child: Mutex<Option<Child>>,
    pub starting_ollama: AtomicBool,
    pub starting_lmstudio: AtomicBool,
    /// Per-chat stream cancellation, tagged with a generation so a finished
    /// stream never removes the token of a newer one.
    pub chat_tokens: Mutex<HashMap<String, (u64, CancellationToken)>>,
    pub pull_tokens: Mutex<HashMap<String, CancellationToken>>,
    pub next_generation: AtomicU64,
    /// ZAP's data folder (database, backups, SearXNG config).
    pub data_dir: PathBuf,
    pub file_index: Mutex<FileIndex>,
    /// Pending approvals, by activity id.
    pub approvals: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Decision>>>,
    /// Chats where the user chose "allow everything in this chat".
    pub chat_grants: Mutex<HashSet<String>>,
    /// Keeps the file index current (set once the first index is built).
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// The user chose the built-in search while SearXNG was down: don't ask
    /// again until ZAP restarts.
    pub searxng_fallback: AtomicBool,
}

impl AppState {
    pub fn new(db: Connection, data_dir: PathBuf) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .build()
            .expect("failed to build HTTP client");
        Self {
            http,
            web: crate::web::client(),
            db: Mutex::new(db),
            statuses: Mutex::new(Statuses {
                ollama: ProviderStatus::Starting,
                lmstudio: ProviderStatus::Disabled,
            }),
            child: Mutex::new(None),
            starting_ollama: AtomicBool::new(false),
            starting_lmstudio: AtomicBool::new(false),
            chat_tokens: Mutex::new(HashMap::new()),
            pull_tokens: Mutex::new(HashMap::new()),
            next_generation: AtomicU64::new(0),
            data_dir,
            file_index: Mutex::new(FileIndex::default()),
            approvals: Mutex::new(HashMap::new()),
            chat_grants: Mutex::new(HashSet::new()),
            watcher: Mutex::new(None),
            searxng_fallback: AtomicBool::new(false),
        }
    }

    pub fn db(&self) -> MutexGuard<'_, Connection> {
        lock(&self.db)
    }

    pub fn starting(&self, kind: ProviderKind) -> &AtomicBool {
        match kind {
            ProviderKind::Ollama => &self.starting_ollama,
            ProviderKind::Lmstudio => &self.starting_lmstudio,
        }
    }

    pub fn status(&self, kind: ProviderKind) -> ProviderStatus {
        lock(&self.statuses).get(kind)
    }

    pub fn kill_child(&self) {
        if let Some(mut child) = lock(&self.child).take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Locks a mutex, recovering from poisoning (a panicked holder must not
/// take the whole app down with it).
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
