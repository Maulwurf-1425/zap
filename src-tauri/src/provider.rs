//! Provider-agnostic types and dispatch. Each local engine (Ollama, LM Studio)
//! implements [`ChatProvider`]; [`AnyProvider`] routes a model key to the
//! right one, so the UI contract (`chat://token|done|error`) stays the same.

use std::future::Future;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::error::AppResult;
use crate::lmstudio::LmStudio;
use crate::ollama::Ollama;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Ollama,
    Lmstudio,
}

impl ProviderKind {
    pub const ALL: [ProviderKind; 2] = [ProviderKind::Ollama, ProviderKind::Lmstudio];
}

const LMSTUDIO_PREFIX: &str = "lmstudio::";

/// Model keys: Ollama models keep their plain name (e.g. `llama3.2:3b`, as
/// stored by older versions); LM Studio models are `lmstudio::<id>`.
pub fn model_key(kind: ProviderKind, name: &str) -> String {
    match kind {
        ProviderKind::Ollama => name.to_string(),
        ProviderKind::Lmstudio => format!("{LMSTUDIO_PREFIX}{name}"),
    }
}

pub fn parse_model_key(key: &str) -> (ProviderKind, &str) {
    match key.strip_prefix(LMSTUDIO_PREFIX) {
        Some(name) => (ProviderKind::Lmstudio, name),
        None => (ProviderKind::Ollama, key),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderStatus {
    Disabled,
    Starting,
    Running,
    NotFound,
    /// Installed (or was running) but not reachable now.
    Stopped,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Statuses {
    pub ollama: ProviderStatus,
    pub lmstudio: ProviderStatus,
}

impl Statuses {
    pub fn get(&self, kind: ProviderKind) -> ProviderStatus {
        match kind {
            ProviderKind::Ollama => self.ollama,
            ProviderKind::Lmstudio => self.lmstudio,
        }
    }

    pub fn set(&mut self, kind: ProviderKind, status: ProviderStatus) {
        match kind {
            ProviderKind::Ollama => self.ollama = status,
            ProviderKind::Lmstudio => self.lmstudio = status,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    /// Images as data URLs (`data:image/jpeg;base64,...`). Only sent to
    /// vision models; each provider converts them to its own format.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    /// Tools the assistant asked to call in this turn (role "assistant").
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// Which call a tool result answers (role "tool").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
}

/// A tool call requested by the model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// A tool offered to the model (OpenAI / Ollama function format).
#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: serde_json::Value,
}

/// `tools` array for a request; both engines accept this shape.
pub fn tools_json(tools: &[ToolSpec]) -> serde_json::Value {
    serde_json::Value::Array(
        tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "type": "function",
                    "function": { "name": t.name, "description": t.description, "parameters": t.parameters },
                })
            })
            .collect(),
    )
}

/// One streamed piece of a model turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Piece<'a> {
    /// Answer text.
    Text(&'a str),
    /// Reasoning of a thinking model (not part of the answer, but it costs
    /// time and tokens).
    Thinking(&'a str),
}

/// Result of one model turn: stats plus any tool calls to run next.
#[derive(Debug, Clone, Default)]
pub struct ChatTurn {
    pub stats: ChatStats,
    pub tool_calls: Vec<ToolCall>,
}

impl ChatMessage {
    pub fn text(role: &str, content: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: content.into(),
            ..Default::default()
        }
    }
}

/// What a model can take as input beyond text.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct ModelCaps {
    pub vision: bool,
    /// Can call tools (function calling).
    pub tools: bool,
}

/// Splits a data URL into (mime, base64 payload). Plain base64 is passed
/// through with an `image/png` default.
pub fn split_data_url(url: &str) -> (&str, &str) {
    match url
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(";base64,"))
    {
        Some((mime, data)) => (mime, data),
        None => ("image/png", url),
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChatOptions {
    pub temperature: Option<f32>,
    /// Context window in tokens (`num_ctx` for Ollama; LM Studio sets it at load time).
    pub num_ctx: Option<u32>,
    /// Upper bound for generated tokens.
    pub max_tokens: Option<u32>,
    /// Offer the web tools (search, read page) to the model.
    #[serde(default)]
    pub web: bool,
    /// Offer the file tools (search, read, write, edit, delete) to the model.
    #[serde(default)]
    pub files: bool,
    /// Offer PowerShell commands (ZAPs).
    #[serde(default)]
    pub terminal: bool,
    /// Offer opening apps, files and links (ZAPs).
    #[serde(default)]
    pub apps: bool,
    /// Offer the ZAP management tools (list, create, start, stop, delete).
    #[serde(default)]
    pub zaps: bool,
    /// Upper bound for model turns; `None` uses the chat default.
    #[serde(default)]
    pub max_rounds: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChatStats {
    /// Output tokens.
    pub eval_count: u64,
    /// Input (prompt) tokens processed for this reply. 0 when unknown.
    #[serde(default)]
    pub prompt_eval_count: u64,
    pub eval_duration_ns: u64,
    pub total_duration_ns: u64,
    pub tokens_per_sec: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
    /// Model key used everywhere else (see [`model_key`]).
    pub id: String,
    pub name: String,
    pub provider: ProviderKind,
    /// 0 when the provider does not report a size.
    pub size_bytes: u64,
    pub modified_at: Option<String>,
}

pub trait ChatProvider {
    fn list_models(&self) -> impl Future<Output = AppResult<Vec<ModelInfo>>> + Send;

    /// Streams one model turn, calling `on_token` per text or thinking chunk. Resolves
    /// with stats and any requested tool calls, or `AppError::Cancelled`.
    fn chat_stream<F>(
        &self,
        model: &str,
        messages: &[ChatMessage],
        options: &ChatOptions,
        tools: &[ToolSpec],
        cancel: &CancellationToken,
        on_token: F,
    ) -> impl Future<Output = AppResult<ChatTurn>> + Send
    where
        F: FnMut(Piece<'_>) + Send;

    /// One-shot, non-streaming completion (used for chat titles).
    fn complete(
        &self,
        model: &str,
        messages: &[ChatMessage],
        options: &ChatOptions,
    ) -> impl Future<Output = AppResult<String>> + Send;

    /// Input capabilities of a model (e.g. whether it accepts images).
    fn capabilities(&self, model: &str) -> impl Future<Output = AppResult<ModelCaps>> + Send;
}

/// Static dispatch over the supported engines.
pub enum AnyProvider<'a> {
    Ollama(Ollama<'a>),
    LmStudio(LmStudio<'a>),
}

impl ChatProvider for AnyProvider<'_> {
    async fn list_models(&self) -> AppResult<Vec<ModelInfo>> {
        match self {
            AnyProvider::Ollama(p) => p.list_models().await,
            AnyProvider::LmStudio(p) => p.list_models().await,
        }
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
        match self {
            AnyProvider::Ollama(p) => {
                p.chat_stream(model, messages, options, tools, cancel, on_token)
                    .await
            }
            AnyProvider::LmStudio(p) => {
                p.chat_stream(model, messages, options, tools, cancel, on_token)
                    .await
            }
        }
    }

    async fn complete(
        &self,
        model: &str,
        messages: &[ChatMessage],
        options: &ChatOptions,
    ) -> AppResult<String> {
        match self {
            AnyProvider::Ollama(p) => p.complete(model, messages, options).await,
            AnyProvider::LmStudio(p) => p.complete(model, messages, options).await,
        }
    }

    async fn capabilities(&self, model: &str) -> AppResult<ModelCaps> {
        match self {
            AnyProvider::Ollama(p) => p.capabilities(model).await,
            AnyProvider::LmStudio(p) => p.capabilities(model).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_keys_roundtrip() {
        assert_eq!(
            parse_model_key("llama3.2:3b"),
            (ProviderKind::Ollama, "llama3.2:3b")
        );
        let key = model_key(ProviderKind::Lmstudio, "lmstudio-community/qwen2.5-7b");
        assert_eq!(key, "lmstudio::lmstudio-community/qwen2.5-7b");
        assert_eq!(
            parse_model_key(&key),
            (ProviderKind::Lmstudio, "lmstudio-community/qwen2.5-7b")
        );
        assert_eq!(model_key(ProviderKind::Ollama, "mistral:7b"), "mistral:7b");
    }

    #[test]
    fn splits_data_urls() {
        assert_eq!(
            split_data_url("data:image/jpeg;base64,QUJD"),
            ("image/jpeg", "QUJD")
        );
        assert_eq!(split_data_url("QUJD"), ("image/png", "QUJD"));
    }

    #[test]
    fn images_are_optional_in_json() {
        let m: ChatMessage = serde_json::from_str(r#"{"role":"user","content":"hi"}"#).unwrap();
        assert!(m.images.is_empty());
        assert_eq!(
            serde_json::to_string(&m).unwrap(),
            r#"{"role":"user","content":"hi"}"#
        );
    }
}
