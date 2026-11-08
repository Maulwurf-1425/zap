//! Running the tools a model asks for, plus the stored settings they need
//! (search provider, Brave key in the Windows Credential Manager).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

use crate::db;
use crate::error::AppError;
use crate::file_tools;
use crate::provider::{ChatStats, ToolCall};
use crate::state::AppState;
use crate::web::{self, SearchConfig, SearchProvider};

const KEYRING_SERVICE: &str = "ZAP";
const KEYRING_BRAVE: &str = "brave-search-api-key";

/// One tool use as shown in the chat (stored with the reply as JSON).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolActivity {
    pub id: String,
    pub name: String,
    /// Search query, URL or file path.
    pub input: String,
    /// "pending" (waiting for approval) | "running" | "done" | "error" | "denied"
    pub status: String,
    #[serde(default)]
    pub sources: Vec<Source>,
    /// Error code for the UI (see `error_code`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Short result note, e.g. "12 results" or "overwrites existing file".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Diff / new content shown in the approval card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Source {
    pub title: String,
    pub url: String,
}

impl ToolActivity {
    pub fn started(call: &ToolCall) -> Self {
        let args = &call.arguments;
        let input = match call.name.as_str() {
            web::TOOL_SEARCH | file_tools::SEARCH => args["query"].as_str(),
            web::TOOL_FETCH => args["url"].as_str(),
            _ => args["path"].as_str().or_else(|| args["source"].as_str()),
        };
        Self {
            // Unique per reply: models reuse call ids like "call_1" every round.
            id: uuid::Uuid::new_v4().to_string(),
            name: call.name.clone(),
            input: input.unwrap_or_default().trim().to_string(),
            status: "running".into(),
            sources: Vec::new(),
            error: None,
            detail: None,
            preview: None,
        }
    }

    pub fn done(mut self, sources: Vec<Source>) -> Self {
        self.status = "done".into();
        self.sources = sources;
        self
    }

    pub fn failed(mut self, code: &str) -> Self {
        self.status = "error".into();
        self.error = Some(code.into());
        self
    }
}

// --- Brave key -----------------------------------------------------------------

fn brave_entry() -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_BRAVE).ok()
}

pub fn brave_key() -> Option<String> {
    brave_entry()?
        .get_password()
        .ok()
        .filter(|k| !k.trim().is_empty())
}

pub fn set_brave_key(key: Option<&str>) -> Result<(), AppError> {
    let entry =
        brave_entry().ok_or_else(|| AppError::Other("credential store unavailable".into()))?;
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

// --- Config ----------------------------------------------------------------------

pub fn provider_from(name: &str) -> SearchProvider {
    match name {
        "brave" => SearchProvider::Brave,
        "searxng" => SearchProvider::Searxng,
        _ => SearchProvider::Builtin,
    }
}

pub fn provider_name(p: SearchProvider) -> &'static str {
    match p {
        SearchProvider::Builtin => "builtin",
        SearchProvider::Brave => "brave",
        SearchProvider::Searxng => "searxng",
    }
}

pub fn search_config(state: &AppState) -> (SearchConfig, u32) {
    let s = db::get_settings(&state.db()).unwrap_or_default();
    let provider = provider_from(&s.search_provider);
    let cfg = SearchConfig {
        provider,
        brave_key: (provider == SearchProvider::Brave)
            .then(brave_key)
            .flatten(),
        searxng_url: s.searxng_url,
        language: if s.language == "de" {
            "de".into()
        } else {
            "en".into()
        },
    };
    (cfg, s.search_monthly_limit)
}

/// Stable error codes the UI translates.
pub fn error_code(err: &AppError) -> &'static str {
    match err {
        AppError::Other(msg) => match msg.as_str() {
            "brave key missing" => "brave_key_missing",
            "brave key invalid" => "brave_key_invalid",
            "brave quota exceeded" => "brave_quota",
            "searxng json disabled" => "searxng_json",
            "blocked url" => "blocked_url",
            "limit reached" => "limit_reached",
            "invalid url" | "host not found" => "fetch_failed",
            m if m.starts_with("unsupported content") => "unsupported_content",
            _ => "failed",
        },
        AppError::Unreachable => "unreachable",
        _ => "failed",
    }
}

/// Runs one web search with the configured provider, enforcing the Brave
/// monthly limit and counting the search.
pub async fn search(
    state: &AppState,
    query: &str,
    max: usize,
) -> Result<Vec<web::SearchResult>, AppError> {
    let (cfg, limit) = search_config(state);
    let name = provider_name(cfg.provider);
    let month = db::current_month();
    if cfg.provider == SearchProvider::Brave {
        let used = db::search_count(&state.db(), &month, name)?;
        if used >= i64::from(limit) {
            return Err(AppError::Other("limit reached".into()));
        }
    }
    let results = web::search(&state.web, &cfg, query, max).await?;
    db::record_search(&state.db(), &month, name)?;
    Ok(results)
}

// --- Running tools ---------------------------------------------------------------

/// Where a tool runs: for emitting activity updates (approval cards) and
/// stopping when the user cancels the reply.
pub struct ToolCtx<'a> {
    pub app: &'a AppHandle,
    pub chat_id: &'a str,
    pub cancel: &'a CancellationToken,
}

#[derive(Clone, Serialize)]
struct ToolEvent<'a> {
    chat_id: &'a str,
    activity: &'a ToolActivity,
}

impl ToolCtx<'_> {
    pub fn emit(&self, activity: &ToolActivity) {
        let _ = self.app.emit(
            "chat://tool",
            ToolEvent {
                chat_id: self.chat_id,
                activity,
            },
        );
    }
}

/// Runs any tool: web tools directly, file tools via `file_tools` (which
/// asks for approval first).
pub async fn run_any(
    state: &AppState,
    ctx: &ToolCtx<'_>,
    call: &ToolCall,
    activity: ToolActivity,
) -> (ToolActivity, String) {
    if file_tools::NAMES.contains(&call.name.as_str()) {
        file_tools::run(state, ctx, call, activity).await
    } else {
        run_tool(state, call, activity).await
    }
}

/// Executes a tool call. Returns the activity for the UI and the text for
/// the model. Failures are reported to the model as text so it can still
/// answer (and say that the lookup did not work).
async fn run_tool(
    state: &AppState,
    call: &ToolCall,
    activity: ToolActivity,
) -> (ToolActivity, String) {
    match call.name.as_str() {
        web::TOOL_SEARCH => {
            let max = call.arguments["max_results"]
                .as_u64()
                .map_or(web::DEFAULT_RESULTS, |n| n as usize);
            if activity.input.is_empty() {
                return (activity.failed("failed"), "Error: missing query.".into());
            }
            let query = activity.input.clone();
            match search(state, &query, max).await {
                Ok(results) => {
                    let sources = results
                        .iter()
                        .map(|r| Source {
                            title: r.title.clone(),
                            url: r.url.clone(),
                        })
                        .collect();
                    (
                        activity.done(sources),
                        web::format_results(&query, &results),
                    )
                }
                Err(err) => {
                    let code = error_code(&err);
                    (
                        activity.failed(code),
                        format!("Error: the web search failed ({code}). Tell the user and answer as well as you can."),
                    )
                }
            }
        }
        web::TOOL_FETCH => {
            let url = activity.input.clone();
            match web::fetch_page(&state.web, &url).await {
                Ok(page) => {
                    let title = if page.title.is_empty() {
                        page.url.clone()
                    } else {
                        page.title.clone()
                    };
                    let sources = vec![Source {
                        title,
                        url: page.url.clone(),
                    }];
                    (activity.done(sources), web::format_page(&page))
                }
                Err(err) => {
                    let code = error_code(&err);
                    (
                        activity.failed(code),
                        format!("Error: could not read the page ({code})."),
                    )
                }
            }
        }
        other => (
            activity.failed("unknown_tool"),
            format!("Error: unknown tool \"{other}\"."),
        ),
    }
}

/// Adds up the stats of several model turns in one reply.
pub fn merge_stats(total: Option<ChatStats>, turn: ChatStats) -> ChatStats {
    let Some(t) = total else {
        return turn;
    };
    let eval_count = t.eval_count + turn.eval_count;
    let eval_duration_ns = t.eval_duration_ns + turn.eval_duration_ns;
    ChatStats {
        eval_count,
        prompt_eval_count: t.prompt_eval_count + turn.prompt_eval_count,
        eval_duration_ns,
        total_duration_ns: t.total_duration_ns + turn.total_duration_ns,
        tokens_per_sec: if eval_duration_ns > 0 {
            eval_count as f64 / (eval_duration_ns as f64 / 1e9)
        } else {
            0.0
        },
    }
}

pub fn today() -> String {
    let (y, m, d) = db::ymd(db::now_ms());
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn activity_takes_input_from_arguments() {
        let call = ToolCall {
            id: "c1".into(),
            name: web::TOOL_SEARCH.into(),
            arguments: json!({ "query": " rust " }),
        };
        let a = ToolActivity::started(&call);
        assert_eq!((a.input.as_str(), a.status.as_str()), ("rust", "running"));
        let failed = a.failed("limit_reached");
        assert_eq!(failed.error.as_deref(), Some("limit_reached"));
    }

    #[test]
    fn merges_stats_over_turns() {
        let a = ChatStats {
            eval_count: 10,
            prompt_eval_count: 100,
            eval_duration_ns: 1_000_000_000,
            total_duration_ns: 2,
            tokens_per_sec: 10.0,
        };
        let b = ChatStats {
            eval_count: 30,
            prompt_eval_count: 200,
            eval_duration_ns: 1_000_000_000,
            total_duration_ns: 3,
            tokens_per_sec: 30.0,
        };
        let m = merge_stats(Some(a), b);
        assert_eq!(
            (m.eval_count, m.prompt_eval_count, m.total_duration_ns),
            (40, 300, 5)
        );
        assert!((m.tokens_per_sec - 20.0).abs() < 1e-9);
    }

    #[test]
    fn maps_error_codes() {
        assert_eq!(
            error_code(&AppError::Other("brave key invalid".into())),
            "brave_key_invalid"
        );
        assert_eq!(
            error_code(&AppError::Other(
                "unsupported content: application/pdf".into()
            )),
            "unsupported_content"
        );
        assert_eq!(error_code(&AppError::Unreachable), "unreachable");
        assert_eq!(provider_name(provider_from("searxng")), "searxng");
        assert_eq!(provider_from("nonsense"), SearchProvider::Builtin);
    }
}
