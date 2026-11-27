//! Cloud models with the user's own API keys: OpenAI, Anthropic, Google
//! Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI or any OpenAI-compatible
//! server. All of them speak the chat-completions format (see `openai.rs`).
//!
//! Connections live in the settings; their keys only in the Windows
//! Credential Manager. Model keys look like `cloud::<connection id>::<model>`.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::db::{self, CloudConnection};
use crate::error::{AppError, AppResult};
use crate::openai::{self, Dialect};
use crate::provider::{
    model_key, ChatMessage, ChatOptions, ChatProvider, ChatTurn, ModelCaps, ModelInfo, Piece,
    ProviderKind, ToolSpec,
};
use crate::state::AppState;

const KEYRING_SERVICE: &str = "ZAP";
const LIST_TIMEOUT: Duration = Duration::from_secs(10);
const COMPLETE_TIMEOUT: Duration = Duration::from_secs(60);
/// Anthropic needs a token limit on every request.
const ANTHROPIC_MAX_TOKENS: u32 = 8192;

/// Known providers and where their OpenAI-compatible API lives.
pub fn preset_base_url(preset: &str) -> Option<&'static str> {
    Some(match preset {
        "openai" => "https://api.openai.com/v1",
        "anthropic" => "https://api.anthropic.com/v1",
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/openai",
        "openrouter" => "https://openrouter.ai/api/v1",
        "groq" => "https://api.groq.com/openai/v1",
        "mistral" => "https://api.mistral.ai/v1",
        "deepseek" => "https://api.deepseek.com/v1",
        "xai" => "https://api.x.ai/v1",
        _ => return None,
    })
}

/// Base URL of a connection: the preset's, or the user's for "custom".
pub fn base_url(conn: &CloudConnection) -> String {
    preset_base_url(&conn.preset)
        .map(str::to_string)
        .unwrap_or_else(|| conn.base_url.trim().trim_end_matches('/').to_string())
}

/// Keys go over the network: only HTTPS, except to this PC or the local
/// network (a server of your own).
pub fn url_allowed(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    match parsed.scheme() {
        "https" => parsed.host_str().is_some(),
        "http" => match parsed.host() {
            Some(url::Host::Domain(d)) => d == "localhost" || d.ends_with(".local"),
            Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        },
        _ => false,
    }
}

// --- Keys ----------------------------------------------------------------------

fn key_entry(id: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("cloud-api-key-{id}")).ok()
}

pub fn api_key(id: &str) -> Option<String> {
    key_entry(id)?
        .get_password()
        .ok()
        .filter(|k| !k.trim().is_empty())
}

fn set_api_key(id: &str, key: Option<&str>) -> AppResult<()> {
    let entry =
        key_entry(id).ok_or_else(|| AppError::Other("credential store unavailable".into()))?;
    match key.map(str::trim).filter(|k| !k.is_empty()) {
        Some(k) => entry
            .set_password(k)
            .map_err(|_| AppError::Other("credential store unavailable".into())),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AppError::Other("credential store unavailable".into())),
        },
    }
}

// --- Model keys ------------------------------------------------------------------

/// `cloud::<id>::<model>` for a model of a connection.
pub fn cloud_model_key(conn_id: &str, model: &str) -> String {
    model_key(ProviderKind::Cloud, &format!("{conn_id}::{model}"))
}

/// Splits the part after `cloud::` into connection id and model.
pub fn split_cloud_name(name: &str) -> (&str, &str) {
    name.split_once("::").unwrap_or(("", name))
}

/// Chat models only: providers also list embedding, image, speech and
/// moderation models that can't chat.
pub fn is_chat_model(id: &str) -> bool {
    const NOT_CHAT: &[&str] = &[
        "embed",
        "tts",
        "whisper",
        "dall-e",
        "moderation",
        "image",
        "imagen",
        "veo",
        "audio",
        "realtime",
        "transcribe",
        "aqa",
        "rerank",
        "sora",
        "babbage",
        "davinci",
        "guard",
    ];
    let id = id.to_lowercase();
    !NOT_CHAT.iter().any(|w| id.contains(w))
}

/// Whether a cloud model takes images (by name; providers don't say).
fn has_vision(model: &str) -> bool {
    const VISION: &[&str] = &[
        "gpt-4o",
        "gpt-4.1",
        "gpt-5",
        "o3",
        "o4",
        "claude",
        "gemini",
        "vision",
        "pixtral",
        "llama-4",
        "-vl",
        "grok-4",
        "grok-2-vision",
    ];
    let m = model.to_lowercase();
    VISION.iter().any(|w| m.contains(w))
}

// --- Provider ----------------------------------------------------------------------

pub struct Cloud<'a> {
    pub http: &'a reqwest::Client,
    pub conn: CloudConnection,
    pub key: Option<String>,
}

#[derive(Deserialize)]
struct ModelList {
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

impl Cloud<'_> {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", base_url(&self.conn))
    }

    fn with_auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let mut req = req;
        if let Some(key) = &self.key {
            req = req.bearer_auth(key);
            if self.conn.preset == "anthropic" {
                req = req
                    .header("x-api-key", key)
                    .header("anthropic-version", "2023-06-01");
            }
        }
        if self.conn.preset == "openrouter" {
            // OpenRouter shows the app name in its activity list.
            req = req
                .header("HTTP-Referer", "https://github.com/Maulwurf-1425/zap")
                .header("X-Title", "ZAP");
        }
        req
    }

    fn dialect(&self, model: &str) -> Dialect {
        let reasoning =
            self.conn.preset == "openai" && (model.starts_with('o') || model.starts_with("gpt-5"));
        Dialect {
            lmstudio: false,
            max_completion_tokens: self.conn.preset == "openai",
            default_max_tokens: (self.conn.preset == "anthropic").then_some(ANTHROPIC_MAX_TOKENS),
            // OpenAI's reasoning models only accept the default temperature.
            temperature: !reasoning,
            stream_usage: true,
        }
    }

    /// Asks the provider about the key (OpenRouter: `GET /key`).
    async fn check_key(&self) -> AppResult<()> {
        let resp = self
            .with_auth(self.http.get(self.url("/key")))
            .timeout(LIST_TIMEOUT)
            .send()
            .await?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(openai::error_from_response(resp).await)
        }
    }

    /// Requests a model list (also used to test a key).
    async fn fetch_models(&self) -> AppResult<Vec<String>> {
        let resp = self
            .with_auth(self.http.get(self.url("/models")))
            .timeout(LIST_TIMEOUT)
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(openai::error_from_response(resp).await);
        }
        let list: ModelList = resp.json().await?;
        let mut ids: Vec<String> = list
            .data
            .into_iter()
            // Gemini lists "models/gemini-…"; its chat endpoint wants the plain name.
            .map(|m| m.id.trim_start_matches("models/").to_string())
            .filter(|id| is_chat_model(id))
            .collect();
        ids.sort();
        ids.dedup();
        Ok(ids)
    }
}

/// The server says this model can't use tools.
fn rejects_tools(err: &AppError) -> bool {
    let AppError::Provider(msg) = err else {
        return false;
    };
    let m = msg.to_lowercase();
    m.contains("does not support tools") || (m.contains("tool") && m.contains("not supported"))
}

/// A field the provider rejected, so the request can be sent without it.
fn adjust_for(err: &AppError, d: Dialect) -> Option<Dialect> {
    let AppError::Provider(msg) = err else {
        return None;
    };
    let m = msg.to_lowercase();
    if d.temperature && m.contains("temperature") {
        return Some(Dialect {
            temperature: false,
            ..d
        });
    }
    if m.contains("max_tokens") && !d.max_completion_tokens {
        return Some(Dialect {
            max_completion_tokens: true,
            ..d
        });
    }
    if m.contains("max_completion_tokens") && d.max_completion_tokens {
        return Some(Dialect {
            max_completion_tokens: false,
            ..d
        });
    }
    if d.stream_usage && (m.contains("stream_options") || m.contains("include_usage")) {
        return Some(Dialect {
            stream_usage: false,
            ..d
        });
    }
    None
}

impl ChatProvider for Cloud<'_> {
    async fn list_models(&self) -> AppResult<Vec<ModelInfo>> {
        Ok(self
            .fetch_models()
            .await?
            .into_iter()
            .map(|id| ModelInfo {
                id: cloud_model_key(&self.conn.id, &id),
                name: id,
                provider: ProviderKind::Cloud,
                size_bytes: 0,
                modified_at: None,
                source: Some(self.conn.name.clone()),
            })
            .collect())
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
        F: FnMut(Piece<'_>) + Send,
    {
        let mut dialect = self.dialect(model);
        let mut tools = tools;
        // A rejected field fails before any token arrives: retry without it.
        for _ in 0..5 {
            let body = openai::request_body(model, messages, options, true, tools, dialect);
            let request = self
                .with_auth(self.http.post(self.url("/chat/completions")))
                .json(&body);
            match openai::stream_turn(request, cancel, &mut on_token).await {
                // A model without tool support (e.g. on your own server)
                // still answers, just without tools.
                Err(err) if !tools.is_empty() && rejects_tools(&err) => tools = &[],
                Err(err) => match adjust_for(&err, dialect) {
                    Some(next) => dialect = next,
                    None => return Err(err),
                },
                ok => return ok,
            }
        }
        Err(AppError::Provider("request rejected".into()))
    }

    async fn complete(
        &self,
        model: &str,
        messages: &[ChatMessage],
        options: &ChatOptions,
    ) -> AppResult<String> {
        let mut dialect = self.dialect(model);
        for _ in 0..4 {
            let body = openai::request_body(model, messages, options, false, &[], dialect);
            let request = self
                .with_auth(self.http.post(self.url("/chat/completions")))
                .timeout(COMPLETE_TIMEOUT)
                .json(&body);
            match openai::complete_text(request).await {
                Err(err) => match adjust_for(&err, dialect) {
                    Some(next) => dialect = next,
                    None => return Err(err),
                },
                ok => return ok,
            }
        }
        Err(AppError::Provider("request rejected".into()))
    }

    async fn capabilities(&self, model: &str) -> AppResult<ModelCaps> {
        // Current cloud chat models call tools natively.
        Ok(ModelCaps {
            vision: has_vision(model),
            tools: true,
            native_tools: true,
        })
    }
}

/// The client for a model key's connection (`name` = "<id>::<model>").
pub fn provider_for<'a>(state: &'a AppState, conn_id: &str) -> Cloud<'a> {
    let conn = db::get_settings(&state.db())
        .ok()
        .and_then(|s| s.cloud_providers.into_iter().find(|c| c.id == conn_id))
        .unwrap_or_default();
    let key = api_key(&conn.id);
    Cloud {
        http: &state.cloud,
        conn,
        key,
    }
}

/// Models of every enabled connection with a key, asked in parallel.
/// A connection that fails (offline, wrong key) is skipped.
pub async fn list_all(state: &AppState) -> Vec<ModelInfo> {
    let conns: Vec<CloudConnection> = db::get_settings(&state.db())
        .map(|s| s.cloud_providers)
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.enabled)
        .collect();
    let lists = futures_util::future::join_all(conns.into_iter().map(|conn| async move {
        let key = api_key(&conn.id);
        if key.is_none() && conn.preset != "custom" {
            return Vec::new();
        }
        let provider = Cloud {
            http: &state.cloud,
            conn,
            key,
        };
        provider.list_models().await.unwrap_or_default()
    }))
    .await;
    lists.into_iter().flatten().collect()
}

// --- Tauri commands ----------------------------------------------------------------

#[derive(Serialize)]
pub struct CloudKeyStatus {
    pub id: String,
    pub has_key: bool,
}

/// Which connections have a key stored (keys themselves never leave Rust).
#[tauri::command]
pub fn cloud_key_status(state: State<'_, AppState>) -> AppResult<Vec<CloudKeyStatus>> {
    Ok(db::get_settings(&state.db())?
        .cloud_providers
        .into_iter()
        .map(|c| CloudKeyStatus {
            has_key: api_key(&c.id).is_some(),
            id: c.id,
        })
        .collect())
}

/// Stores (or with an empty key removes) a connection's API key.
#[tauri::command]
pub fn cloud_set_key(id: String, key: Option<String>) -> AppResult<()> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(AppError::Other("bad id".into()));
    }
    set_api_key(&id, key.as_deref())
}

#[derive(Serialize)]
pub struct CloudTest {
    /// Number of chat models, when the connection works.
    pub models: Option<usize>,
    /// Error code otherwise ("auth_failed", "rate_limited", "provider_unreachable", "bad_url", …).
    pub error: Option<String>,
}

/// Checks a connection by listing its models.
#[tauri::command]
pub async fn cloud_test(state: State<'_, AppState>, id: String) -> AppResult<CloudTest> {
    let provider = provider_for(&state, &id);
    if provider.conn.id.is_empty() {
        return Err(AppError::Other("unknown connection".into()));
    }
    if !url_allowed(&base_url(&provider.conn)) {
        return Ok(CloudTest {
            models: None,
            error: Some("bad_url".into()),
        });
    }
    if provider.key.is_none() && provider.conn.preset != "custom" {
        return Ok(CloudTest {
            models: None,
            error: Some("no_key".into()),
        });
    }
    // OpenRouter lists its models without a key: check the key itself.
    if provider.conn.preset == "openrouter" {
        if let Err(err) = provider.check_key().await {
            return Ok(CloudTest {
                models: None,
                error: Some(err.code().into()),
            });
        }
    }
    Ok(match provider.fetch_models().await {
        Ok(models) => CloudTest {
            models: Some(models.len()),
            error: None,
        },
        Err(err) => CloudTest {
            models: None,
            error: Some(err.code().into()),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn(preset: &str, base: &str) -> CloudConnection {
        CloudConnection {
            id: "c1".into(),
            preset: preset.into(),
            name: preset.into(),
            base_url: base.into(),
            enabled: true,
        }
    }

    #[test]
    fn presets_and_custom_urls() {
        assert_eq!(base_url(&conn("openai", "")), "https://api.openai.com/v1");
        assert_eq!(
            base_url(&conn("custom", " http://192.168.1.5:8000/v1/ ")),
            "http://192.168.1.5:8000/v1"
        );
    }

    #[test]
    fn keys_only_over_https_or_locally() {
        assert!(url_allowed("https://api.example.com/v1"));
        assert!(url_allowed("http://127.0.0.1:1234/v1"));
        assert!(url_allowed("http://192.168.0.10:8080/v1"));
        assert!(url_allowed("http://localhost:11434/v1"));
        assert!(!url_allowed("http://api.example.com/v1"));
        assert!(!url_allowed("ftp://x"));
        assert!(!url_allowed("not a url"));
    }

    #[test]
    fn model_keys_roundtrip() {
        let key = cloud_model_key("abc", "gpt-4.1-mini");
        assert_eq!(key, "cloud::abc::gpt-4.1-mini");
        let (kind, name) = crate::provider::parse_model_key(&key);
        assert_eq!(kind, ProviderKind::Cloud);
        assert_eq!(split_cloud_name(name), ("abc", "gpt-4.1-mini"));
        // Model ids with "::" or "/" survive.
        let key = cloud_model_key("x", "meta-llama/llama-3.3-70b");
        assert_eq!(
            split_cloud_name(crate::provider::parse_model_key(&key).1).1,
            "meta-llama/llama-3.3-70b"
        );
    }

    #[test]
    fn filters_non_chat_models() {
        assert!(is_chat_model("gpt-4.1-mini"));
        assert!(is_chat_model("claude-sonnet-4-5"));
        assert!(is_chat_model("gemini-2.5-flash"));
        assert!(!is_chat_model("text-embedding-3-small"));
        assert!(!is_chat_model("gpt-4o-mini-tts"));
        assert!(!is_chat_model("dall-e-3"));
        assert!(!is_chat_model("imagen-4.0-generate-001"));
    }

    #[test]
    fn retries_drop_rejected_fields() {
        let d = Dialect {
            lmstudio: false,
            max_completion_tokens: false,
            default_max_tokens: None,
            temperature: true,
            stream_usage: true,
        };
        let temp =
            AppError::Provider("Unsupported value: 'temperature' does not support 0.7".into());
        assert!(!adjust_for(&temp, d).unwrap().temperature);
        let max = AppError::Provider("Unsupported parameter: 'max_tokens'".into());
        assert!(adjust_for(&max, d).unwrap().max_completion_tokens);
        let usage = AppError::Provider("Unknown name \"stream_options\"".into());
        assert!(!adjust_for(&usage, d).unwrap().stream_usage);
        assert!(adjust_for(&AppError::Auth("bad key".into()), d).is_none());
        assert!(rejects_tools(&AppError::Provider(
            "registry.ollama.ai/library/gemma2:2b does not support tools".into()
        )));
        assert!(!rejects_tools(&AppError::Provider(
            "context length exceeded".into()
        )));
    }

    // Live check through any OpenAI-compatible server (default: Ollama's
    // /v1 with mistral): `cargo test live_cloud_tool_call -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_cloud_tool_call() {
        let http = reqwest::Client::new();
        let p = Cloud {
            http: &http,
            conn: conn("custom", "http://127.0.0.1:11434/v1"),
            key: Some("test".into()),
        };
        let models = p.list_models().await.unwrap();
        println!(
            "models: {:?}",
            models.iter().map(|m| &m.name).collect::<Vec<_>>()
        );
        let tool = ToolSpec {
            name: "get_weather",
            description: "Get the weather for a city",
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "city": { "type": "string" } },
                "required": ["city"]
            }),
        };
        let turn = p
            .chat_stream(
                "mistral:7b",
                &[ChatMessage::text(
                    "user",
                    "What is the weather in Berlin? Use the tool.",
                )],
                &ChatOptions::default(),
                &[tool],
                &CancellationToken::new(),
                |_| {},
            )
            .await
            .unwrap();
        println!(
            "tool calls: {:?}
stats: {:?}",
            turn.tool_calls, turn.stats
        );
        assert_eq!(turn.tool_calls[0].name, "get_weather");
        assert_eq!(turn.tool_calls[0].arguments["city"], "Berlin");
        assert!(
            turn.stats.prompt_eval_count > 0,
            "usage from the last chunk"
        );
    }
}
