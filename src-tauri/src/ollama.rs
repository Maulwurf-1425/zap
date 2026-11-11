//! Ollama client: model management, NDJSON streaming and process start.
//! Status bookkeeping lives in `engine.rs`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::ndjson::NdjsonDecoder;
use crate::provider::{
    model_key, split_data_url, tools_json, ChatMessage, ChatOptions, ChatProvider, ChatStats,
    ChatTurn, ModelCaps, ModelInfo, ProviderKind, ProviderStatus, ToolCall, ToolSpec,
};
use crate::state::{lock, AppState};

pub const BASE_URL: &str = "http://127.0.0.1:11434";
const START_TIMEOUT: Duration = Duration::from_secs(15);
const PROGRESS_THROTTLE: Duration = Duration::from_millis(150);
const COMPLETE_TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

pub async fn version(http: &reqwest::Client) -> Option<String> {
    #[derive(Deserialize)]
    struct V {
        version: String,
    }
    let resp = http
        .get(format!("{BASE_URL}/api/version"))
        .timeout(Duration::from_millis(1500))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<V>().await.ok().map(|v| v.version)
}

pub async fn is_up(http: &reqwest::Client) -> bool {
    version(http).await.is_some()
}

pub fn find_executable() -> Option<PathBuf> {
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let candidate = PathBuf::from(local)
            .join("Programs")
            .join("Ollama")
            .join("ollama.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("ollama.exe"))
        .find(|p| p.is_file())
}

pub fn installed() -> bool {
    find_executable().is_some()
}

fn spawn_serve(exe: &Path) -> std::io::Result<std::process::Child> {
    let mut cmd = Command::new(exe);
    cmd.arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

/// Uses a running Ollama if there is one, otherwise spawns `ollama serve`
/// (hidden) and waits up to 15 s. `on_starting` fires once a start begins.
pub async fn start(state: &AppState, on_starting: impl Fn()) -> ProviderStatus {
    if is_up(&state.http).await {
        return ProviderStatus::Running;
    }
    let Some(exe) = find_executable() else {
        return ProviderStatus::NotFound;
    };
    on_starting();

    {
        let mut child = lock(&state.child);
        let alive = child
            .as_mut()
            .is_some_and(|c| matches!(c.try_wait(), Ok(None)));
        if !alive {
            match spawn_serve(&exe) {
                Ok(c) => *child = Some(c),
                Err(_) => return ProviderStatus::Stopped,
            }
        }
    }

    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if is_up(&state.http).await {
            return ProviderStatus::Running;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    ProviderStatus::Stopped
}

/// Stops Ollama for a restart: ZAP's own `ollama serve`, and also an Ollama
/// started elsewhere (tray app), so the restart really reloads it. Waits up
/// to 10 s until it no longer answers.
pub async fn stop(state: &AppState) {
    if let Some(mut child) = lock(&state.child).take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    if is_up(&state.http).await {
        for image in ["ollama app.exe", "ollama.exe"] {
            let mut cmd = Command::new("taskkill");
            cmd.args(["/F", "/IM", image])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            let _ = cmd.status();
        }
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && is_up(&state.http).await {
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn error_from_response(resp: reqwest::Response) -> AppError {
    #[derive(Deserialize)]
    struct ErrBody {
        error: String,
    }
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    match serde_json::from_str::<ErrBody>(&text) {
        Ok(body) => AppError::from_provider_message(&body.error),
        Err(_) if status == reqwest::StatusCode::NOT_FOUND => {
            AppError::ModelNotFound(String::new())
        }
        Err(_) => AppError::Provider(status.to_string()),
    }
}

fn options_json(options: &ChatOptions) -> Value {
    let mut opts = serde_json::Map::new();
    if let Some(t) = options.temperature {
        opts.insert("temperature".into(), json!(t));
    }
    if let Some(n) = options.num_ctx {
        opts.insert("num_ctx".into(), json!(n));
    }
    if let Some(n) = options.max_tokens {
        opts.insert("num_predict".into(), json!(n));
    }
    Value::Object(opts)
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

pub struct Ollama<'a> {
    pub http: &'a reqwest::Client,
}

#[derive(Deserialize)]
struct TagsResponse {
    models: Vec<TagModel>,
}

#[derive(Deserialize)]
struct TagModel {
    name: String,
    size: u64,
    modified_at: String,
}

#[derive(Deserialize)]
struct ChatLine {
    message: Option<ChatLineMessage>,
    #[serde(default)]
    done: bool,
    error: Option<String>,
    eval_count: Option<u64>,
    prompt_eval_count: Option<u64>,
    eval_duration: Option<u64>,
    total_duration: Option<u64>,
}

#[derive(Deserialize)]
struct ChatLineMessage {
    #[serde(default)]
    content: String,
    #[serde(default)]
    tool_calls: Vec<OllamaToolCall>,
}

#[derive(Deserialize)]
struct OllamaToolCall {
    function: OllamaFunction,
}

#[derive(Deserialize)]
struct OllamaFunction {
    name: String,
    #[serde(default)]
    arguments: Value,
}

fn stats_from(line: &ChatLine) -> ChatStats {
    let eval_count = line.eval_count.unwrap_or(0);
    let eval_ns = line.eval_duration.unwrap_or(0);
    let tokens_per_sec = if eval_ns > 0 {
        eval_count as f64 / (eval_ns as f64 / 1e9)
    } else {
        0.0
    };
    ChatStats {
        eval_count,
        prompt_eval_count: line.prompt_eval_count.unwrap_or(0),
        eval_duration_ns: eval_ns,
        total_duration_ns: line.total_duration.unwrap_or(0),
        tokens_per_sec,
    }
}

/// Ollama wants images as raw base64 in a per-message `images` array.
fn messages_json(messages: &[ChatMessage]) -> Value {
    Value::Array(
        messages
            .iter()
            .map(|m| {
                let mut msg = json!({ "role": m.role, "content": m.content });
                if !m.tool_calls.is_empty() {
                    // Ollama takes arguments as an object and has no call ids.
                    msg["tool_calls"] = json!(m
                        .tool_calls
                        .iter()
                        .map(
                            |c| json!({ "function": { "name": c.name, "arguments": c.arguments } })
                        )
                        .collect::<Vec<_>>());
                }
                if let Some(name) = &m.tool_name {
                    msg["tool_name"] = json!(name);
                }
                if !m.images.is_empty() {
                    msg["images"] = json!(m
                        .images
                        .iter()
                        .map(|url| split_data_url(url).1)
                        .collect::<Vec<_>>());
                }
                msg
            })
            .collect(),
    )
}

/// Vision support from `/api/show`: the `capabilities` list (Ollama 0.6+),
/// falling back to CLIP / mllama projector families on older versions.
fn tools_from_show(body: &Value) -> bool {
    body["capabilities"]
        .as_array()
        .is_some_and(|caps| caps.iter().any(|c| c.as_str() == Some("tools")))
}

fn vision_from_show(body: &Value) -> bool {
    let caps = body["capabilities"].as_array();
    if let Some(caps) = caps {
        return caps.iter().any(|c| c.as_str() == Some("vision"));
    }
    body["details"]["families"].as_array().is_some_and(|f| {
        f.iter()
            .filter_map(Value::as_str)
            .any(|f| f == "clip" || f == "mllama")
    }) || body["projector_info"].is_object()
}
impl ChatProvider for Ollama<'_> {
    async fn list_models(&self) -> AppResult<Vec<ModelInfo>> {
        let resp = self.http.get(format!("{BASE_URL}/api/tags")).send().await?;
        if !resp.status().is_success() {
            return Err(error_from_response(resp).await);
        }
        let tags: TagsResponse = resp.json().await?;
        let mut models: Vec<ModelInfo> = tags
            .models
            .into_iter()
            .map(|m| ModelInfo {
                id: model_key(ProviderKind::Ollama, &m.name),
                name: m.name,
                provider: ProviderKind::Ollama,
                size_bytes: m.size,
                modified_at: Some(m.modified_at),
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
        mut on_token: F,
    ) -> AppResult<ChatTurn>
    where
        F: FnMut(&str) + Send,
    {
        let mut body = json!({
            "model": model,
            "messages": messages_json(messages),
            "stream": true,
            "options": options_json(options),
        });
        if !tools.is_empty() {
            body["tools"] = tools_json(tools);
        }
        let mut tool_calls: Vec<ToolCall> = Vec::new();

        let send = self
            .http
            .post(format!("{BASE_URL}/api/chat"))
            .json(&body)
            .send();
        let resp = tokio::select! {
            _ = cancel.cancelled() => return Err(AppError::Cancelled),
            r = send => r?,
        };
        if !resp.status().is_success() {
            return Err(error_from_response(resp).await);
        }

        let mut stream = resp.bytes_stream();
        let mut decoder = NdjsonDecoder::new();
        loop {
            let next = tokio::select! {
                _ = cancel.cancelled() => return Err(AppError::Cancelled),
                n = stream.next() => n,
            };
            let stream_ended = next.is_none();
            let lines: Vec<ChatLine> = match next {
                Some(chunk) => decoder.push(&chunk?),
                // Stream closed: accept a final unterminated line.
                None => decoder.finish::<ChatLine>().into_iter().collect(),
            };
            for line in lines {
                if let Some(err) = &line.error {
                    return Err(AppError::from_provider_message(err));
                }
                if let Some(msg) = &line.message {
                    if !msg.content.is_empty() {
                        on_token(&msg.content);
                    }
                    for call in &msg.tool_calls {
                        tool_calls.push(ToolCall {
                            id: format!("call_{}", tool_calls.len() + 1),
                            name: call.function.name.clone(),
                            arguments: call.function.arguments.clone(),
                        });
                    }
                }
                if line.done {
                    return Ok(ChatTurn {
                        stats: stats_from(&line),
                        tool_calls,
                    });
                }
            }
            if stream_ended {
                // Closed without `done`: Ollama went away mid-answer.
                return Err(AppError::Unreachable);
            }
        }
    }

    async fn complete(
        &self,
        model: &str,
        messages: &[ChatMessage],
        options: &ChatOptions,
    ) -> AppResult<String> {
        #[derive(Deserialize)]
        struct Resp {
            message: Option<ChatLineMessage>,
        }
        let body = json!({
            "model": model,
            "messages": messages_json(messages),
            "stream": false,
            "options": options_json(options),
        });
        let resp = self
            .http
            .post(format!("{BASE_URL}/api/chat"))
            .timeout(COMPLETE_TIMEOUT)
            .json(&body)
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(error_from_response(resp).await);
        }
        let parsed: Resp = resp.json().await?;
        Ok(parsed.message.map(|m| m.content).unwrap_or_default())
    }

    async fn capabilities(&self, model: &str) -> AppResult<ModelCaps> {
        let resp = self
            .http
            .post(format!("{BASE_URL}/api/show"))
            .json(&json!({ "model": model }))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(error_from_response(resp).await);
        }
        let body: Value = resp.json().await?;
        Ok(ModelCaps {
            vision: vision_from_show(&body),
            tools: tools_from_show(&body),
        })
    }
}

// ---------------------------------------------------------------------------
// Model management (Ollama-specific)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct PullProgress {
    pub name: String,
    pub status: String,
    pub completed: u64,
    pub total: u64,
    pub speed_bps: f64,
}

#[derive(Deserialize)]
struct PullLine {
    status: Option<String>,
    digest: Option<String>,
    total: Option<u64>,
    completed: Option<u64>,
    error: Option<String>,
}

/// Exponentially smoothed download speed for the current layer.
struct SpeedMeter {
    digest: Option<String>,
    last_at: Instant,
    last_completed: u64,
    bps: f64,
}

impl SpeedMeter {
    fn new() -> Self {
        Self {
            digest: None,
            last_at: Instant::now(),
            last_completed: 0,
            bps: 0.0,
        }
    }

    fn update(&mut self, digest: Option<&str>, completed: u64) -> f64 {
        if self.digest.as_deref() != digest {
            self.digest = digest.map(str::to_owned);
            self.last_at = Instant::now();
            self.last_completed = completed;
            return self.bps;
        }
        let dt = self.last_at.elapsed().as_secs_f64();
        if dt >= 0.25 {
            let inst = completed.saturating_sub(self.last_completed) as f64 / dt;
            self.bps = if self.bps == 0.0 {
                inst
            } else {
                self.bps * 0.7 + inst * 0.3
            };
            self.last_at = Instant::now();
            self.last_completed = completed;
        }
        self.bps
    }
}

pub async fn pull<F>(
    http: &reqwest::Client,
    name: &str,
    cancel: &CancellationToken,
    mut on_progress: F,
) -> AppResult<()>
where
    F: FnMut(PullProgress),
{
    let send = http
        .post(format!("{BASE_URL}/api/pull"))
        .json(&json!({ "model": name, "stream": true }))
        .send();
    let resp = tokio::select! {
        _ = cancel.cancelled() => return Err(AppError::Cancelled),
        r = send => r?,
    };
    if !resp.status().is_success() {
        return Err(error_from_response(resp).await);
    }

    let mut stream = resp.bytes_stream();
    let mut decoder = NdjsonDecoder::new();
    let mut meter = SpeedMeter::new();
    let mut last_emit: Option<Instant> = None;
    let mut last_status = String::new();

    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => return Err(AppError::Cancelled),
            n = stream.next() => n,
        };
        let stream_ended = next.is_none();
        let lines: Vec<PullLine> = match next {
            Some(chunk) => decoder.push(&chunk?),
            None => decoder.finish::<PullLine>().into_iter().collect(),
        };
        for parsed in lines {
            if let Some(err) = parsed.error {
                return Err(AppError::from_provider_message(&err));
            }
            let status = parsed.status.unwrap_or_default();
            let completed = parsed.completed.unwrap_or(0);
            let total = parsed.total.unwrap_or(0);
            let speed = if total > 0 {
                meter.update(parsed.digest.as_deref(), completed)
            } else {
                0.0
            };
            let done = status == "success";

            let throttled = last_emit.is_some_and(|t| t.elapsed() < PROGRESS_THROTTLE);
            if done || status != last_status || !throttled {
                on_progress(PullProgress {
                    name: name.to_string(),
                    status: status.clone(),
                    completed,
                    total,
                    speed_bps: speed,
                });
                last_emit = Some(Instant::now());
                last_status = status;
            }
            if done {
                return Ok(());
            }
        }
        if stream_ended {
            return Err(AppError::Unreachable);
        }
    }
}

pub async fn delete(http: &reqwest::Client, name: &str) -> AppResult<()> {
    let resp = http
        .delete(format!("{BASE_URL}/api/delete"))
        .json(&json!({ "model": name }))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(error_from_response(resp).await);
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ModelDetails {
    pub name: String,
    pub family: Option<String>,
    pub parameter_size: Option<String>,
    pub quantization: Option<String>,
    pub context_length: Option<u64>,
}

/// `POST /api/show`: family, size, quantization and the model's max context.
pub async fn show(http: &reqwest::Client, name: &str) -> AppResult<ModelDetails> {
    let resp = http
        .post(format!("{BASE_URL}/api/show"))
        .json(&json!({ "model": name }))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(error_from_response(resp).await);
    }
    let body: Value = resp.json().await?;
    let details = &body["details"];
    let text = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    // model_info keys are architecture-prefixed, e.g. "llama.context_length".
    let context_length = body["model_info"].as_object().and_then(|info| {
        info.iter()
            .find(|(k, _)| k.ends_with(".context_length"))
            .and_then(|(_, v)| v.as_u64())
    });
    Ok(ModelDetails {
        name: name.to_string(),
        family: text(&details["family"]),
        parameter_size: text(&details["parameter_size"]),
        quantization: text(&details["quantization_level"]),
        context_length,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn images_become_raw_base64() {
        let msgs = [
            ChatMessage::text("user", "hi"),
            ChatMessage {
                role: "user".into(),
                content: "look".into(),
                images: vec!["data:image/jpeg;base64,QUJD".into()],
                ..Default::default()
            },
        ];
        let json = messages_json(&msgs);
        assert!(json[0].get("images").is_none());
        assert_eq!(json[1]["images"], json!(["QUJD"]));
        assert_eq!(json[1]["content"], "look");
    }

    #[test]
    fn detects_vision_models() {
        assert!(vision_from_show(
            &json!({ "capabilities": ["completion", "vision"] })
        ));
        assert!(!vision_from_show(
            &json!({ "capabilities": ["completion", "tools"] })
        ));
        // Older Ollama: no capabilities list, CLIP projector family instead.
        assert!(vision_from_show(
            &json!({ "details": { "families": ["llama", "clip"] } })
        ));
        assert!(!vision_from_show(
            &json!({ "details": { "families": ["llama"] } })
        ));
    }
}
