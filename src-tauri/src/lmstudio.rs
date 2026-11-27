//! LM Studio client over its OpenAI-compatible local server
//! (`http://127.0.0.1:<port>/v1`). Models are managed inside LM Studio;
//! ZAP lists them and chats with them. The host is always loopback.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use crate::error::AppResult;
use crate::openai::{self, Dialect};
use crate::provider::{
    model_key, ChatMessage, ChatOptions, ChatProvider, ChatTurn, ModelCaps, ModelInfo, Piece,
    ProviderKind, ProviderStatus, ToolSpec,
};

pub const DEFAULT_PORT: u16 = 1234;
const START_TIMEOUT: Duration = Duration::from_secs(30);
const COMPLETE_TIMEOUT: Duration = Duration::from_secs(60);

pub fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

// ---------------------------------------------------------------------------
// Detection and start
// ---------------------------------------------------------------------------

pub async fn is_up(http: &reqwest::Client, port: u16) -> bool {
    http.get(format!("{}/v1/models", base_url(port)))
        .timeout(Duration::from_millis(1500))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// The `lms` CLI that ships with LM Studio.
fn find_lms() -> Option<PathBuf> {
    if let Some(home) = home() {
        for candidate in [
            home.join(".lmstudio").join("bin").join("lms.exe"),
            home.join(".cache")
                .join("lm-studio")
                .join("bin")
                .join("lms.exe"),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("lms.exe"))
        .find(|p| p.is_file())
}

/// Per-user install (default) or a machine-wide one under Program Files.
pub fn app_exe() -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("Programs"));
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        roots.push(PathBuf::from(program_files));
    }
    roots
        .iter()
        .flat_map(|root| ["LM Studio", "lm-studio"].map(|dir| root.join(dir).join("LM Studio.exe")))
        .find(|p| p.is_file())
}

fn app_installed() -> bool {
    app_exe().is_some()
}

/// Whether the `lms` CLI exists (LM Studio sets it up on its first launch).
pub fn cli_ready() -> bool {
    find_lms().is_some()
}

/// Opens the LM Studio app (after a fresh install it sets up `lms` and lets
/// the user download a first model).
pub fn launch_app() -> bool {
    app_exe().is_some_and(|exe| Command::new(exe).spawn().is_ok())
}

pub fn installed() -> bool {
    find_lms().is_some() || app_installed()
}

/// File size per model key from `lms ls --json` (the server API has no
/// sizes). Empty when `lms` is missing or slow.
async fn model_sizes() -> std::collections::HashMap<String, u64> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Local {
        model_key: String,
        #[serde(default)]
        size_bytes: u64,
    }
    let Some(lms) = find_lms() else {
        return Default::default();
    };
    let mut cmd = tokio::process::Command::new(lms);
    cmd.args(["ls", "--json"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(crate::ollama::CREATE_NO_WINDOW);
    let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(5), cmd.output()).await else {
        return Default::default();
    };
    serde_json::from_slice::<Vec<Local>>(&out.stdout)
        .map(|list| {
            list.into_iter()
                .map(|m| (m.model_key, m.size_bytes))
                .collect()
        })
        .unwrap_or_default()
}

/// Ids of the models LM Studio has in memory right now.
pub async fn loaded_models(http: &reqwest::Client, port: u16) -> Vec<String> {
    let Ok(resp) = http
        .get(format!("{}/api/v0/models", base_url(port)))
        .timeout(Duration::from_secs(5))
        .send()
        .await
    else {
        return Vec::new();
    };
    resp.json::<ModelList>()
        .await
        .map(|list| {
            list.data
                .into_iter()
                .filter(|m| m.state.as_deref() == Some("loaded"))
                .map(|m| m.id)
                .collect()
        })
        .unwrap_or_default()
}

/// Unloads one model (`lms unload <id>`) or all (`None`). Waits up to 20 s.
pub async fn unload(model: Option<&str>) -> bool {
    let Some(lms) = find_lms() else {
        return false;
    };
    let mut cmd = Command::new(lms);
    cmd.arg("unload");
    match model {
        Some(id) => cmd.arg(id),
        None => cmd.arg("--all"),
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::ollama::CREATE_NO_WINDOW);
    }
    let Ok(mut child) = cmd.spawn() else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => tokio::time::sleep(Duration::from_millis(200)).await,
            Err(_) => return false,
        }
    }
    let _ = child.kill();
    false
}

/// Stops LM Studio's local server (`lms server stop`) for a restart and waits
/// up to 10 s until it no longer answers. The LM Studio app stays open.
pub async fn stop_server(http: &reqwest::Client, port: u16) {
    if let Some(lms) = find_lms() {
        let mut cmd = Command::new(lms);
        cmd.args(["server", "stop"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(crate::ollama::CREATE_NO_WINDOW);
        }
        if let Ok(mut child) = cmd.spawn() {
            // `lms` can hang while LM Studio is busy; don't wait on it forever.
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline && matches!(child.try_wait(), Ok(None)) {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            let _ = child.kill();
        }
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && is_up(http, port).await {
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// Uses a running LM Studio server, otherwise asks `lms server start` to
/// start it (hidden, not awaited: the CLI can block while LM Studio wakes up)
/// and polls for up to 30 s. ZAP never stops LM Studio.
pub async fn start(http: &reqwest::Client, port: u16, on_starting: impl Fn()) -> ProviderStatus {
    if is_up(http, port).await {
        return ProviderStatus::Running;
    }
    let Some(lms) = find_lms() else {
        return if app_installed() {
            ProviderStatus::Stopped
        } else {
            ProviderStatus::NotFound
        };
    };
    on_starting();

    let mut cmd = Command::new(lms);
    cmd.args(["server", "start", "--port", &port.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::ollama::CREATE_NO_WINDOW);
    }
    // Dropping the handle does not kill the process; `lms` exits on its own.
    if cmd.spawn().is_err() {
        return ProviderStatus::Stopped;
    }

    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if is_up(http, port).await {
            return ProviderStatus::Running;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    ProviderStatus::Stopped
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn is_embedding(id: &str, kind: Option<&str>) -> bool {
    kind == Some("embeddings") || id.to_lowercase().contains("embed")
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

pub struct LmStudio<'a> {
    pub http: &'a reqwest::Client,
    pub port: u16,
}

#[derive(Deserialize)]
struct ModelList {
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
    /// Only in the native `/api/v0/models`: "llm" | "vlm" | "embeddings".
    #[serde(rename = "type")]
    kind: Option<String>,
    /// Only in `/api/v0/models`: "loaded" | "not-loaded".
    #[serde(default)]
    state: Option<String>,
    /// Only in `/api/v0/models`, e.g. ["tool_use"].
    #[serde(default)]
    capabilities: Option<Vec<String>>,
}

impl LmStudio<'_> {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", base_url(self.port))
    }

    async fn fetch_models(&self, path: &str) -> AppResult<Vec<ModelEntry>> {
        let resp = self.http.get(self.url(path)).send().await?;
        if !resp.status().is_success() {
            return Err(openai::error_from_response(resp).await);
        }
        Ok(resp.json::<ModelList>().await?.data)
    }
}

impl ChatProvider for LmStudio<'_> {
    async fn list_models(&self) -> AppResult<Vec<ModelInfo>> {
        // The native endpoint knows the model type (skip embeddings); older
        // versions only have the OpenAI one.
        let entries = match self.fetch_models("/api/v0/models").await {
            Ok(entries) => entries,
            Err(_) => self.fetch_models("/v1/models").await?,
        };
        let sizes = model_sizes().await;
        let mut models: Vec<ModelInfo> = entries
            .into_iter()
            .filter(|m| !is_embedding(&m.id, m.kind.as_deref()))
            .map(|m| ModelInfo {
                id: model_key(ProviderKind::Lmstudio, &m.id),
                size_bytes: sizes.get(&m.id).copied().unwrap_or(0),
                name: m.id,
                provider: ProviderKind::Lmstudio,
                modified_at: None,
                source: None,
            })
            .collect();
        models.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(models)
    }

    async fn chat_stream<F>(
        &self,
        model: &str,
        messages: &[ChatMessage],
        options: &ChatOptions,
        tools: &[ToolSpec],
        cancel: &CancellationToken,
        on_token: F,
    ) -> AppResult<ChatTurn>
    where
        F: FnMut(Piece<'_>) + Send,
    {
        let body = openai::request_body(model, messages, options, true, tools, Dialect::LM_STUDIO);
        let request = self.http.post(self.url("/v1/chat/completions")).json(&body);
        openai::stream_turn(request, cancel, on_token).await
    }

    async fn complete(
        &self,
        model: &str,
        messages: &[ChatMessage],
        options: &ChatOptions,
    ) -> AppResult<String> {
        let body = openai::request_body(model, messages, options, false, &[], Dialect::LM_STUDIO);
        let request = self
            .http
            .post(self.url("/v1/chat/completions"))
            .timeout(COMPLETE_TIMEOUT)
            .json(&body);
        openai::complete_text(request).await
    }

    /// Vision models have type "vlm" in the native model list. Older LM
    /// Studio versions without that endpoint report no image support.
    async fn capabilities(&self, model: &str) -> AppResult<ModelCaps> {
        let entry = self
            .fetch_models("/api/v0/models")
            .await
            .ok()
            .and_then(|entries| entries.into_iter().find(|m| m.id == model));
        let vision = entry
            .as_ref()
            .is_some_and(|m| m.kind.as_deref() == Some("vlm"));
        // Older LM Studio versions don't list capabilities: assume yes.
        let native_tools = entry
            .as_ref()
            .and_then(|m| m.capabilities.as_ref())
            .map_or(true, |c| c.iter().any(|c| c == "tool_use"));
        // LM Studio adds tool use to any model via its prompt template.
        Ok(ModelCaps {
            vision,
            tools: true,
            native_tools,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_embedding_models() {
        assert!(is_embedding("text-embedding-nomic-embed-text-v1.5", None));
        assert!(is_embedding("x", Some("embeddings")));
        assert!(!is_embedding("qwen2.5-7b-instruct", Some("llm")));
    }

    #[test]
    fn urls_are_loopback_only() {
        assert_eq!(base_url(1234), "http://127.0.0.1:1234");
    }

    // Live check against a running LM Studio with a loaded model:
    // `cargo test live_lmstudio_tool_call -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_lmstudio_tool_call() {
        let http = reqwest::Client::new();
        let p = LmStudio {
            http: &http,
            port: DEFAULT_PORT,
        };
        let entries = p.fetch_models("/api/v0/models").await.unwrap();
        let model = entries
            .iter()
            .find(|m| m.kind.as_deref() != Some("embeddings"))
            .unwrap()
            .id
            .clone();
        let messages = [
            ChatMessage::text("system", crate::web::system_prompt("2026-11-08")),
            ChatMessage::text("user", "What is the current stable version of the Rust programming language? Search the web."),
        ];
        let turn = p
            .chat_stream(
                &model,
                &messages,
                &ChatOptions::default(),
                &crate::web::tool_specs(),
                &CancellationToken::new(),
                |p| {
                    if let Piece::Text(t) = p {
                        print!("{t}");
                    }
                },
            )
            .await
            .unwrap();
        println!(
            "\nmodel: {model}\ntool calls: {:?}\nstats: {:?}",
            turn.tool_calls, turn.stats
        );
        assert!(!turn.tool_calls.is_empty(), "model should call a tool");
        assert_eq!(turn.tool_calls[0].name, "web_search");
        assert!(turn.tool_calls[0].arguments["query"].as_str().is_some());
    }
}
