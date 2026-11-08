//! LM Studio client over its OpenAI-compatible local server
//! (`http://127.0.0.1:<port>/v1`). Models are managed inside LM Studio;
//! ZAP lists them and chats with them. The host is always loopback.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::ndjson::{SseDecoder, SseEvent};
use crate::provider::{
    model_key, tools_json, ChatMessage, ChatOptions, ChatProvider, ChatStats, ChatTurn, ModelCaps,
    ModelInfo, ProviderKind, ProviderStatus, ToolCall, ToolSpec,
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

fn app_installed() -> bool {
    std::env::var_os("LOCALAPPDATA").is_some_and(|local| {
        let programs = PathBuf::from(local).join("Programs");
        ["LM Studio", "lm-studio"]
            .iter()
            .any(|dir| programs.join(dir).join("LM Studio.exe").is_file())
    })
}

pub fn installed() -> bool {
    find_lms().is_some() || app_installed()
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

/// Accepts both `{"error": "..."}` and `{"error": {"message": "..."}}`.
fn error_message(body: &Value) -> Option<String> {
    let err = body.get("error")?;
    err.as_str().map(str::to_owned).or_else(|| {
        err.get("message")
            .and_then(Value::as_str)
            .map(str::to_owned)
    })
}

async fn error_from_response(resp: reqwest::Response) -> AppError {
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    match error_message(&body) {
        Some(msg) => AppError::from_provider_message(&msg),
        None if status == reqwest::StatusCode::NOT_FOUND => AppError::ModelNotFound(String::new()),
        None => AppError::Provider(status.to_string()),
    }
}

/// OpenAI format: a message with images gets a content array of
/// `text` and `image_url` parts (data URLs).
fn messages_json(messages: &[ChatMessage]) -> Value {
    Value::Array(
        messages
            .iter()
            .map(|m| {
                if m.role == "tool" {
                    return json!({ "role": "tool", "tool_call_id": m.tool_call_id, "content": m.content });
                }
                if !m.tool_calls.is_empty() {
                    // OpenAI format: arguments are a JSON string.
                    let calls: Vec<Value> = m
                        .tool_calls
                        .iter()
                        .map(|c| {
                            json!({
                                "id": c.id,
                                "type": "function",
                                "function": { "name": c.name, "arguments": c.arguments.to_string() },
                            })
                        })
                        .collect();
                    return json!({ "role": "assistant", "content": m.content, "tool_calls": calls });
                }
                if m.images.is_empty() {
                    return json!({ "role": m.role, "content": m.content });
                }
                let mut parts = vec![json!({ "type": "text", "text": m.content })];
                parts.extend(
                    m.images
                        .iter()
                        .map(|url| json!({ "type": "image_url", "image_url": { "url": url } })),
                );
                json!({ "role": m.role, "content": parts })
            })
            .collect(),
    )
}

fn request_body(
    model: &str,
    messages: &[ChatMessage],
    options: &ChatOptions,
    stream: bool,
    tools: &[ToolSpec],
) -> Value {
    let mut body = json!({ "model": model, "messages": messages_json(messages), "stream": stream });
    if !tools.is_empty() {
        body["tools"] = tools_json(tools);
    }
    if stream {
        // Final chunk then carries prompt/completion token counts.
        body["stream_options"] = json!({ "include_usage": true });
    }
    if let Some(t) = options.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(n) = options.max_tokens {
        body["max_tokens"] = json!(n);
    }
    body
}

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
}

#[derive(Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
    usage: Option<Usage>,
    error: Option<Value>,
}

#[derive(Deserialize)]
struct StreamChoice {
    delta: Option<Delta>,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct Delta {
    content: Option<String>,
    tool_calls: Option<Vec<DeltaToolCall>>,
}

/// Tool calls stream in pieces: the first chunk for an `index` carries id
/// and name, later chunks append to the JSON `arguments` string.
#[derive(Deserialize)]
struct DeltaToolCall {
    index: Option<usize>,
    id: Option<String>,
    function: Option<DeltaFunction>,
}

#[derive(Deserialize)]
struct DeltaFunction {
    name: Option<String>,
    arguments: Option<String>,
}

#[derive(Default)]
struct PartialCall {
    id: String,
    name: String,
    arguments: String,
}

fn finish_calls(parts: Vec<PartialCall>) -> Vec<ToolCall> {
    parts
        .into_iter()
        .enumerate()
        .filter(|(_, p)| !p.name.is_empty())
        .map(|(i, p)| ToolCall {
            id: if p.id.is_empty() {
                format!("call_{}", i + 1)
            } else {
                p.id
            },
            name: p.name,
            arguments: serde_json::from_str(&p.arguments).unwrap_or_else(|_| json!({})),
        })
        .collect()
}

#[derive(Deserialize)]
struct Usage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
}

impl LmStudio<'_> {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", base_url(self.port))
    }

    async fn fetch_models(&self, path: &str) -> AppResult<Vec<ModelEntry>> {
        let resp = self.http.get(self.url(path)).send().await?;
        if !resp.status().is_success() {
            return Err(error_from_response(resp).await);
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
        let mut models: Vec<ModelInfo> = entries
            .into_iter()
            .filter(|m| !is_embedding(&m.id, m.kind.as_deref()))
            .map(|m| ModelInfo {
                id: model_key(ProviderKind::Lmstudio, &m.id),
                name: m.id,
                provider: ProviderKind::Lmstudio,
                size_bytes: 0,
                modified_at: None,
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
        let started = Instant::now();
        let send = self
            .http
            .post(self.url("/v1/chat/completions"))
            .json(&request_body(model, messages, options, true, tools))
            .send();
        let resp = tokio::select! {
            _ = cancel.cancelled() => return Err(AppError::Cancelled),
            r = send => r?,
        };
        if !resp.status().is_success() {
            return Err(error_from_response(resp).await);
        }

        let mut stream = resp.bytes_stream();
        let mut decoder = SseDecoder::new();
        let mut first_token: Option<Instant> = None;
        let mut chunks: u64 = 0;
        let mut usage_tokens: Option<u64> = None;
        let mut prompt_tokens: u64 = 0;
        let mut finished = false;
        let mut calls: Vec<PartialCall> = Vec::new();

        let stats = |first: Option<Instant>, tokens: u64, prompt: u64| {
            let gen = first.map(|t| t.elapsed()).unwrap_or_default();
            let secs = gen.as_secs_f64();
            ChatStats {
                eval_count: tokens,
                prompt_eval_count: prompt,
                eval_duration_ns: gen.as_nanos() as u64,
                total_duration_ns: started.elapsed().as_nanos() as u64,
                tokens_per_sec: if secs > 0.0 {
                    tokens as f64 / secs
                } else {
                    0.0
                },
            }
        };

        loop {
            let next = tokio::select! {
                _ = cancel.cancelled() => return Err(AppError::Cancelled),
                n = stream.next() => n,
            };
            let stream_ended = next.is_none();
            let events: Vec<SseEvent<StreamChunk>> = match next {
                Some(chunk) => decoder.push(&chunk?),
                None => decoder.finish::<StreamChunk>().into_iter().collect(),
            };
            for event in events {
                let chunk = match event {
                    SseEvent::Done => {
                        return Ok(ChatTurn {
                            stats: stats(
                                first_token,
                                usage_tokens.unwrap_or(chunks),
                                prompt_tokens,
                            ),
                            tool_calls: finish_calls(calls),
                        })
                    }
                    SseEvent::Data(chunk) => chunk,
                };
                if let Some(err) = chunk.error.as_ref().and_then(|e| {
                    e.as_str()
                        .map(str::to_owned)
                        .or_else(|| e.get("message").and_then(Value::as_str).map(str::to_owned))
                }) {
                    return Err(AppError::from_provider_message(&err));
                }
                if let Some(usage) = chunk.usage {
                    if let Some(n) = usage.completion_tokens {
                        usage_tokens = Some(n);
                    }
                    prompt_tokens = usage.prompt_tokens.unwrap_or(prompt_tokens);
                }
                for choice in chunk.choices {
                    let Some(delta) = choice.delta else {
                        if choice.finish_reason.is_some() {
                            finished = true;
                        }
                        continue;
                    };
                    if let Some(text) = delta.content.filter(|t| !t.is_empty()) {
                        first_token.get_or_insert_with(Instant::now);
                        chunks += 1;
                        on_token(&text);
                    }
                    for part in delta.tool_calls.unwrap_or_default() {
                        let idx = part.index.unwrap_or(calls.len().saturating_sub(1));
                        if calls.len() <= idx {
                            calls.resize_with(idx + 1, PartialCall::default);
                        }
                        let slot = &mut calls[idx];
                        if let Some(id) = part.id {
                            slot.id = id;
                        }
                        if let Some(f) = part.function {
                            if let Some(name) = f.name {
                                slot.name.push_str(&name);
                            }
                            if let Some(args) = f.arguments {
                                slot.arguments.push_str(&args);
                            }
                        }
                    }
                    if choice.finish_reason.is_some() {
                        finished = true;
                    }
                }
            }
            if stream_ended {
                // Some servers omit `[DONE]`; a finish reason is enough.
                return if finished {
                    Ok(ChatTurn {
                        stats: stats(first_token, usage_tokens.unwrap_or(chunks), prompt_tokens),
                        tool_calls: finish_calls(calls),
                    })
                } else {
                    Err(AppError::Unreachable)
                };
            }
        }
    }

    async fn complete(
        &self,
        model: &str,
        messages: &[ChatMessage],
        options: &ChatOptions,
    ) -> AppResult<String> {
        let resp = self
            .http
            .post(self.url("/v1/chat/completions"))
            .timeout(COMPLETE_TIMEOUT)
            .json(&request_body(model, messages, options, false, &[]))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(error_from_response(resp).await);
        }
        let body: Value = resp.json().await?;
        Ok(body["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or_default()
            .to_string())
    }

    /// Vision models have type "vlm" in the native model list. Older LM
    /// Studio versions without that endpoint report no image support.
    async fn capabilities(&self, model: &str) -> AppResult<ModelCaps> {
        let vision = self
            .fetch_models("/api/v0/models")
            .await
            .map(|entries| {
                entries
                    .iter()
                    .any(|m| m.id == model && m.kind.as_deref() == Some("vlm"))
            })
            .unwrap_or(false);
        // LM Studio adds tool use to any model via its prompt template.
        Ok(ModelCaps {
            vision,
            tools: true,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_both_error_shapes() {
        assert_eq!(
            error_message(&json!({"error": "boom"})).as_deref(),
            Some("boom")
        );
        assert_eq!(
            error_message(&json!({"error": {"message": "nope"}})).as_deref(),
            Some("nope")
        );
        assert_eq!(error_message(&json!({"ok": true})), None);
    }

    #[test]
    fn filters_embedding_models() {
        assert!(is_embedding("text-embedding-nomic-embed-text-v1.5", None));
        assert!(is_embedding("x", Some("embeddings")));
        assert!(!is_embedding("qwen2.5-7b-instruct", Some("llm")));
    }

    #[test]
    fn stream_chunks_deserialize() {
        let mut d = SseDecoder::new();
        let raw = b"data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n\
data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"},\"finish_reason\":null}]}\n\n\
data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"completion_tokens\":3}}\n\n\
data: [DONE]\n\n";
        let events: Vec<SseEvent<StreamChunk>> = d.push(raw);
        assert_eq!(events.len(), 4);
        let SseEvent::Data(second) = &events[1] else {
            panic!("expected data")
        };
        assert_eq!(
            second.choices[0]
                .delta
                .as_ref()
                .and_then(|d| d.content.as_deref()),
            Some("Hi")
        );
        let SseEvent::Data(third) = &events[2] else {
            panic!("expected data")
        };
        assert_eq!(third.choices[0].finish_reason.as_deref(), Some("stop"));
        assert_eq!(
            third.usage.as_ref().and_then(|u| u.completion_tokens),
            Some(3)
        );
        assert!(matches!(events[3], SseEvent::Done));
    }

    #[test]
    fn images_become_openai_content_parts() {
        let msgs = [
            ChatMessage::text("system", "be brief"),
            ChatMessage {
                role: "user".into(),
                content: "what is this?".into(),
                images: vec!["data:image/png;base64,QUJD".into()],
                ..Default::default()
            },
        ];
        let body = request_body("m", &msgs, &ChatOptions::default(), true, &[]);
        assert_eq!(body["messages"][0]["content"], "be brief");
        let parts = &body["messages"][1]["content"];
        assert_eq!(parts[0], json!({ "type": "text", "text": "what is this?" }));
        assert_eq!(parts[1]["image_url"]["url"], "data:image/png;base64,QUJD");
    }

    #[test]
    fn assembles_streamed_tool_calls() {
        let mut d = SseDecoder::new();
        let raw = br#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"web_search","arguments":""}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"query\":"}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"zap\"}"}}]},"finish_reason":"tool_calls"}]}

"#;
        let events: Vec<SseEvent<StreamChunk>> = d.push(raw);
        let mut calls: Vec<PartialCall> = Vec::new();
        for e in events {
            let SseEvent::Data(chunk) = e else { continue };
            for choice in chunk.choices {
                for part in choice.delta.and_then(|d| d.tool_calls).unwrap_or_default() {
                    let idx = part.index.unwrap_or(0);
                    if calls.len() <= idx {
                        calls.resize_with(idx + 1, PartialCall::default);
                    }
                    if let Some(id) = part.id {
                        calls[idx].id = id;
                    }
                    if let Some(f) = part.function {
                        calls[idx].name.push_str(&f.name.unwrap_or_default());
                        calls[idx]
                            .arguments
                            .push_str(&f.arguments.unwrap_or_default());
                    }
                }
            }
        }
        let done = finish_calls(calls);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].id, "c1");
        assert_eq!(done[0].name, "web_search");
        assert_eq!(done[0].arguments, json!({ "query": "zap" }));
    }

    #[test]
    fn tool_messages_use_openai_shape() {
        let msgs = [
            ChatMessage {
                role: "assistant".into(),
                tool_calls: vec![ToolCall {
                    id: "c1".into(),
                    name: "web_search".into(),
                    arguments: json!({"query": "x"}),
                }],
                ..Default::default()
            },
            ChatMessage {
                role: "tool".into(),
                content: "results".into(),
                tool_call_id: Some("c1".into()),
                ..Default::default()
            },
        ];
        let json = messages_json(&msgs);
        assert_eq!(
            json[0]["tool_calls"][0]["function"]["arguments"],
            "{\"query\":\"x\"}"
        );
        assert_eq!(
            json[1],
            json!({ "role": "tool", "tool_call_id": "c1", "content": "results" })
        );
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
                |t| print!("{t}"),
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
