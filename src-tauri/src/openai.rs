//! The OpenAI chat-completions format, shared by LM Studio and the cloud
//! providers (OpenAI, Anthropic, Gemini, OpenRouter, … all speak it): request
//! bodies, streaming with tool calls and thinking, and error mapping.

use std::time::Instant;

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::ndjson::{SseDecoder, SseEvent};
use crate::provider::{
    tools_json, ChatMessage, ChatOptions, ChatStats, ChatTurn, Piece, ToolCall, ToolSpec,
};

/// How a server wants the request (LM Studio extras, OpenAI's newer token
/// field, …). The cloud client flips these when a provider rejects a field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Dialect {
    /// LM Studio's `ttl` and `reasoning_effort: "none"`.
    pub lmstudio: bool,
    /// Send `max_completion_tokens` instead of `max_tokens` (newer OpenAI models).
    pub max_completion_tokens: bool,
    /// Always send a token limit (Anthropic requires one).
    pub default_max_tokens: Option<u32>,
    /// Send the temperature (some reasoning models only accept the default).
    pub temperature: bool,
    /// Ask for token counts in the last chunk (`stream_options`).
    pub stream_usage: bool,
}

impl Dialect {
    pub const LM_STUDIO: Dialect = Dialect {
        lmstudio: true,
        max_completion_tokens: false,
        default_max_tokens: None,
        temperature: true,
        stream_usage: true,
    };
}

/// Accepts both `{"error": "..."}` and `{"error": {"message": "..."}}`.
pub fn error_message(body: &Value) -> Option<String> {
    let err = body.get("error")?;
    err.as_str().map(str::to_owned).or_else(|| {
        err.get("message")
            .and_then(Value::as_str)
            .map(str::to_owned)
    })
}

/// Turns a failed response into a typed error (wrong key, rate limit, …).
pub async fn error_from_response(resp: reqwest::Response) -> AppError {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    // Some APIs answer with a list of errors (Gemini).
    let message = error_message(&body).or_else(|| body.get(0).and_then(error_message));
    match status.as_u16() {
        401 | 403 => AppError::Auth(message.unwrap_or_else(|| status.to_string())),
        429 => AppError::RateLimited(message.unwrap_or_else(|| status.to_string())),
        _ => match message {
            Some(msg) => AppError::from_provider_message(&msg),
            None if status == reqwest::StatusCode::NOT_FOUND => {
                AppError::ModelNotFound(String::new())
            }
            None => AppError::Provider(status.to_string()),
        },
    }
}

/// OpenAI format: a message with images gets a content array of
/// `text` and `image_url` parts (data URLs).
pub fn messages_json(messages: &[ChatMessage]) -> Value {
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

pub fn request_body(
    model: &str,
    messages: &[ChatMessage],
    options: &ChatOptions,
    stream: bool,
    tools: &[ToolSpec],
    dialect: Dialect,
) -> Value {
    let mut body = json!({ "model": model, "messages": messages_json(messages), "stream": stream });
    if !tools.is_empty() {
        body["tools"] = tools_json(tools);
    }
    if stream && dialect.stream_usage {
        // Final chunk then carries prompt/completion token counts.
        body["stream_options"] = json!({ "include_usage": true });
    }
    if dialect.temperature {
        if let Some(t) = options.temperature {
            body["temperature"] = json!(t);
        }
    }
    if let Some(n) = options.max_tokens.or(dialect.default_max_tokens) {
        let field = if dialect.max_completion_tokens {
            "max_completion_tokens"
        } else {
            "max_tokens"
        };
        body[field] = json!(n);
    }
    if dialect.lmstudio {
        // LM Studio's switch for reasoning models.
        if options.think == Some(false) {
            body["reasoning_effort"] = json!("none");
        }
        // Idle time before LM Studio unloads a model it loaded for a request.
        if let Some(min) = options.keep_alive_min {
            body["ttl"] = json!(u64::from(min) * 60);
        }
    }
    body
}

#[derive(Deserialize)]
pub(crate) struct StreamChunk {
    #[serde(default)]
    pub(crate) choices: Vec<StreamChoice>,
    pub(crate) usage: Option<Usage>,
    error: Option<Value>,
}

#[derive(Deserialize)]
pub(crate) struct StreamChoice {
    pub(crate) delta: Option<Delta>,
    pub(crate) finish_reason: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct Delta {
    pub(crate) content: Option<String>,
    /// Reasoning of thinking models (LM Studio, DeepSeek, OpenRouter, …).
    #[serde(alias = "reasoning")]
    reasoning_content: Option<String>,
    pub(crate) tool_calls: Option<Vec<DeltaToolCall>>,
}

/// Tool calls stream in pieces: the first chunk for an `index` carries id
/// and name, later chunks append to the JSON `arguments` string.
#[derive(Deserialize)]
pub(crate) struct DeltaToolCall {
    pub(crate) index: Option<usize>,
    pub(crate) id: Option<String>,
    pub(crate) function: Option<DeltaFunction>,
}

#[derive(Deserialize)]
pub(crate) struct DeltaFunction {
    pub(crate) name: Option<String>,
    pub(crate) arguments: Option<String>,
}

#[derive(Default)]
pub(crate) struct PartialCall {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) arguments: String,
}

pub(crate) fn finish_calls(parts: Vec<PartialCall>) -> Vec<ToolCall> {
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
pub(crate) struct Usage {
    pub(crate) prompt_tokens: Option<u64>,
    pub(crate) completion_tokens: Option<u64>,
}

/// Sends a streaming request and reads one model turn: text and thinking go
/// to `on_token`, tool calls are assembled, token counts come from the
/// final chunk (or the number of chunks when the server sends none).
pub async fn stream_turn<F>(
    request: reqwest::RequestBuilder,
    cancel: &CancellationToken,
    mut on_token: F,
) -> AppResult<ChatTurn>
where
    F: FnMut(Piece<'_>) + Send,
{
    let started = Instant::now();
    let resp = tokio::select! {
        _ = cancel.cancelled() => return Err(AppError::Cancelled),
        r = request.send() => r?,
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
                        stats: stats(first_token, usage_tokens.unwrap_or(chunks), prompt_tokens),
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
                if let Some(text) = delta.reasoning_content.filter(|t| !t.is_empty()) {
                    first_token.get_or_insert_with(Instant::now);
                    chunks += 1;
                    on_token(Piece::Thinking(&text));
                }
                if let Some(text) = delta.content.filter(|t| !t.is_empty()) {
                    first_token.get_or_insert_with(Instant::now);
                    chunks += 1;
                    on_token(Piece::Text(&text));
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

/// Sends a non-streaming request and returns the answer text.
pub async fn complete_text(request: reqwest::RequestBuilder) -> AppResult<String> {
    let resp = request.send().await?;
    if !resp.status().is_success() {
        return Err(error_from_response(resp).await);
    }
    let body: Value = resp.json().await?;
    Ok(body["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .to_string())
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
        let body = request_body(
            "m",
            &msgs,
            &ChatOptions::default(),
            true,
            &[],
            Dialect::LM_STUDIO,
        );
        assert_eq!(body["messages"][0]["content"], "be brief");
        let parts = &body["messages"][1]["content"];
        assert_eq!(parts[0], json!({ "type": "text", "text": "what is this?" }));
        assert_eq!(parts[1]["image_url"]["url"], "data:image/png;base64,QUJD");
    }

    #[test]
    fn dialects_shape_the_body() {
        let options = ChatOptions {
            temperature: Some(0.5),
            max_tokens: Some(32),
            think: Some(false),
            keep_alive_min: Some(5),
            ..Default::default()
        };
        let lm = request_body("m", &[], &options, true, &[], Dialect::LM_STUDIO);
        assert_eq!(lm["reasoning_effort"], "none");
        assert_eq!(lm["ttl"], 300);
        assert_eq!(lm["max_tokens"], 32);

        let cloud = Dialect {
            lmstudio: false,
            max_completion_tokens: true,
            default_max_tokens: None,
            temperature: false,
            stream_usage: false,
        };
        let body = request_body("m", &[], &options, true, &[], cloud);
        assert!(body.get("ttl").is_none() && body.get("reasoning_effort").is_none());
        assert!(body.get("temperature").is_none() && body.get("stream_options").is_none());
        assert_eq!(body["max_completion_tokens"], 32);

        let anthropic = Dialect {
            default_max_tokens: Some(8192),
            ..cloud
        };
        let body = request_body("m", &[], &ChatOptions::default(), false, &[], anthropic);
        assert_eq!(body["max_completion_tokens"], 8192);
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
}
