//! IPC commands. Message contents are never logged.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio_util::sync::CancellationToken;

use crate::db::{self, Chat, ChatGroup, ExportFile, Message, SearchHit, Settings};
use crate::docker::{docker, SEARXNG_CONTAINER};
use crate::engine;
use crate::error::{AppError, AppResult};
use crate::ollama::{self, ModelDetails, PullProgress};
use crate::provider::{
    parse_model_key, AnyProvider, ChatMessage, ChatOptions, ChatProvider, ChatStats, ModelCaps,
    ModelInfo, ProviderKind, ProviderStatus, Statuses, ToolSpec,
};
use crate::state::{lock, AppState, Decision};
use crate::tools;
use crate::web;
use crate::{file_tools, files, installer, lmstudio};

const SEARCH_LIMIT: usize = 50;
const TITLE_INPUT_CHARS: usize = 1200;
const TITLE_PROMPT: &str =
    "You write short chat titles. Reply with the title only: at most 5 words, \
in the same language as the message, no quotes, no trailing punctuation.";

// --- App ---------------------------------------------------------------------

#[derive(Serialize)]
pub struct AppInfo {
    pub version: String,
    pub ollama_version: Option<String>,
}

#[tauri::command]
pub async fn app_info(app: AppHandle, state: State<'_, AppState>) -> AppResult<AppInfo> {
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        ollama_version: ollama::version(&state.http).await,
    })
}

// --- Providers -----------------------------------------------------------------

#[tauri::command]
pub fn provider_status(state: State<'_, AppState>) -> Statuses {
    *lock(&state.statuses)
}

/// Re-runs detection/startup for one provider (after enabling it, changing
/// the port, or installing it). Returns the new status.
#[tauri::command]
pub async fn provider_start(app: AppHandle, provider: ProviderKind) -> AppResult<ProviderStatus> {
    Ok(engine::ensure(&app, provider).await)
}

/// Stops an engine's server and starts it again. Returns the new status.
#[tauri::command]
pub async fn provider_restart(app: AppHandle, provider: ProviderKind) -> AppResult<ProviderStatus> {
    Ok(engine::restart(&app, provider).await)
}

#[derive(Serialize)]
pub struct LinkResult {
    page: Option<web::Page>,
    /// Error code for the UI (same codes as the fetch_page tool).
    error: Option<&'static str>,
}

/// Reads a web page the user pasted into a message, so every model can use
/// it (not only tool-capable ones). Same safety rules as the fetch_page tool.
#[tauri::command]
pub async fn read_link(state: State<'_, AppState>, url: String) -> AppResult<LinkResult> {
    Ok(match web::fetch_page(&state.web, &url).await {
        Ok(page) => LinkResult {
            page: Some(page),
            error: None,
        },
        Err(err) => LinkResult {
            page: None,
            error: Some(match tools::error_code(&err) {
                "failed" | "unreachable" => "fetch_failed",
                code => code,
            }),
        },
    })
}

/// Whether ZAP can install engines itself (winget is available).
#[tauri::command]
pub async fn engine_install_supported() -> bool {
    installer::available().await
}

/// Installs an engine via winget, then starts it. LM Studio is opened once
/// after installing so it can set up its `lms` CLI.
#[tauri::command]
pub async fn install_engine(app: AppHandle, provider: ProviderKind) -> AppResult<ProviderStatus> {
    static BUSY: Mutex<Vec<ProviderKind>> = Mutex::new(Vec::new());
    {
        let mut busy = lock(&BUSY);
        if busy.contains(&provider) {
            return Err(AppError::Other("install already running".into()));
        }
        busy.push(provider);
    }
    let ok = installer::install(&app, provider).await;
    lock(&BUSY).retain(|k| *k != provider);
    if !ok {
        return Err(AppError::Other("install_failed".into()));
    }
    if provider == ProviderKind::Lmstudio && lmstudio::launch_app() {
        // First launch writes ~/.lmstudio/bin/lms.exe; give it up to a minute.
        for _ in 0..60 {
            if lmstudio::cli_ready() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }
    let status = engine::ensure(&app, provider).await;
    installer::emit(&app, provider, installer::Phase::Done, None, None);
    Ok(status)
}

/// Models of all enabled, running providers.
#[tauri::command]
pub async fn list_models(state: State<'_, AppState>) -> AppResult<Vec<ModelInfo>> {
    Ok(engine::list_all_models(&state).await)
}

/// Input capabilities of a model key (e.g. whether it accepts images).
/// Unknown or unreachable models report no extra capabilities.
#[tauri::command]
pub async fn model_capabilities(state: State<'_, AppState>, model: String) -> AppResult<ModelCaps> {
    let (provider, name) = engine::route(&state, &model);
    Ok(provider.capabilities(name).await.unwrap_or_default())
}

// --- Ollama model management ---------------------------------------------------

#[tauri::command]
pub async fn show_model(state: State<'_, AppState>, name: String) -> AppResult<ModelDetails> {
    match parse_model_key(&name) {
        (ProviderKind::Ollama, model) => ollama::show(&state.http, model).await,
        _ => Err(AppError::Unsupported),
    }
}

#[tauri::command]
pub async fn pull_model(app: AppHandle, state: State<'_, AppState>, name: String) -> AppResult<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Other("empty model name".into()));
    }
    let token = CancellationToken::new();
    if let Some(old) = lock(&state.pull_tokens).insert(name.clone(), token.clone()) {
        old.cancel();
    }
    let result = ollama::pull(&state.http, &name, &token, |p: PullProgress| {
        let _ = app.emit("model://progress", p);
    })
    .await;
    lock(&state.pull_tokens).remove(&name);
    result
}

#[tauri::command]
pub fn cancel_pull(state: State<'_, AppState>, name: String) {
    if let Some(token) = lock(&state.pull_tokens).remove(&name) {
        token.cancel();
    }
}

#[tauri::command]
pub async fn delete_model(state: State<'_, AppState>, name: String) -> AppResult<()> {
    ollama::delete(&state.http, &name).await
}

// --- Chat streaming ----------------------------------------------------------

#[derive(Clone, Serialize)]
struct TokenEvent<'a> {
    chat_id: &'a str,
    content: &'a str,
}

#[derive(Clone, Serialize)]
struct DoneEvent<'a> {
    chat_id: &'a str,
    stats: Option<ChatStats>,
    stopped: bool,
}

#[derive(Clone, Serialize)]
struct ErrorEvent<'a> {
    chat_id: &'a str,
    error: &'a AppError,
    /// Tokens used before the error (so a partial reply is still counted).
    stats: Option<ChatStats>,
}

/// Streams a reply. Events carry the `chat_id`, so several chats can stream
/// at once without mixing. Ends with exactly one `chat://done` or
/// `chat://error`; the command resolves when streaming ends.
#[tauri::command]
pub async fn chat_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: String,
    model: String,
    messages: Vec<ChatMessage>,
    options: Option<ChatOptions>,
) -> AppResult<()> {
    let token = CancellationToken::new();
    let generation = state.next_generation.fetch_add(1, Ordering::Relaxed);
    if let Some((_, old)) =
        lock(&state.chat_tokens).insert(chat_id.clone(), (generation, token.clone()))
    {
        old.cancel();
    }
    let options = options.unwrap_or_default();
    let (provider, model_name) = engine::route(&state, &model);
    let mut used: Option<ChatStats> = None;
    let result = run_agent(
        &app, &state, &provider, model_name, messages, &options, &token, &chat_id, &mut used,
    )
    .await;

    {
        let mut tokens = lock(&state.chat_tokens);
        if tokens.get(&chat_id).is_some_and(|(g, _)| *g == generation) {
            tokens.remove(&chat_id);
        }
    }

    match result {
        Ok(stats) => {
            let _ = app.emit(
                "chat://done",
                DoneEvent {
                    chat_id: &chat_id,
                    stats: Some(stats),
                    stopped: false,
                },
            );
        }
        Err(AppError::Cancelled) => {
            let _ = app.emit(
                "chat://done",
                DoneEvent {
                    chat_id: &chat_id,
                    stats: used,
                    stopped: true,
                },
            );
        }
        Err(err) => {
            let _ = app.emit(
                "chat://error",
                ErrorEvent {
                    chat_id: &chat_id,
                    error: &err,
                    stats: used,
                },
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub fn stop_generation(state: State<'_, AppState>, chat_id: String) {
    if let Some((_, token)) = lock(&state.chat_tokens).remove(&chat_id) {
        token.cancel();
    }
}

fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// Asks the model for a ≤ 5-word title after the first reply. Falls back to
/// the first 40 characters of the first user message. A manual rename is
/// never overwritten.
#[tauri::command]
pub async fn generate_title(
    state: State<'_, AppState>,
    chat_id: String,
    model: String,
) -> AppResult<Option<Chat>> {
    let (user, assistant) = {
        let conn = state.db();
        db::first_exchange(&conn, &chat_id)?
    };
    let Some(user) = user else {
        return db::get_chat(&state.db(), &chat_id);
    };
    let fallback = db::title_from(&user);

    let mut content = format!("Message: {}", truncate_chars(&user, TITLE_INPUT_CHARS));
    if let Some(answer) = assistant {
        content.push_str(&format!(
            "\n\nReply: {}",
            truncate_chars(&answer, TITLE_INPUT_CHARS)
        ));
    }
    let messages = [
        ChatMessage::text("system", TITLE_PROMPT),
        ChatMessage::text("user", content),
    ];
    let options = ChatOptions {
        temperature: Some(0.2),
        num_ctx: None,
        max_tokens: Some(32),
        web: false,
        files: false,
    };
    let (provider, model_name) = engine::route(&state, &model);
    let generated = provider
        .complete(model_name, &messages, &options)
        .await
        .ok()
        .and_then(|raw| db::clean_generated_title(&raw));

    let title = generated.unwrap_or(fallback);
    db::apply_generated_title(&state.db(), &chat_id, &title)
}

/// Rough token count of a prompt (about 4 characters per token, plus a few
/// tokens of framing per message). Only used when a turn was stopped and the
/// server sent no numbers.
pub fn estimate_tokens(messages: &[ChatMessage]) -> u64 {
    messages
        .iter()
        .map(|m| (m.content.chars().count() as u64).div_ceil(4) + 4)
        .sum()
}

/// Joins all system messages into one at the start. Several chat templates
/// (Qwen among them) reject a second system message or one after the first.
pub fn merge_system(messages: Vec<ChatMessage>) -> Vec<ChatMessage> {
    let (system, rest): (Vec<_>, Vec<_>) = messages.into_iter().partition(|m| m.role == "system");
    let text = system
        .iter()
        .map(|m| m.content.trim())
        .filter(|c| !c.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut out = Vec::with_capacity(rest.len() + 1);
    if !text.is_empty() {
        out.push(ChatMessage::text("system", text));
    }
    out.extend(rest);
    out
}

/// Upper bound for model turns in one reply (each turn may call tools).
/// File tasks need a few steps (search, read, edit), so this is generous.
const MAX_TOOL_ROUNDS: usize = 12;

/// One reply: streams the model; when it asks for tools, runs them
/// (emitting `chat://tool`, waiting for approval where needed), feeds the
/// results back and continues. The last round offers no tools, so the model
/// has to answer.
#[allow(clippy::too_many_arguments)]
async fn run_agent(
    app: &AppHandle,
    state: &AppState,
    provider: &AnyProvider<'_>,
    model: &str,
    mut messages: Vec<ChatMessage>,
    options: &ChatOptions,
    cancel: &CancellationToken,
    chat_id: &str,
    used: &mut Option<ChatStats>,
) -> AppResult<ChatStats> {
    let mut specs: Vec<ToolSpec> = Vec::new();
    let mut prompts: Vec<String> = Vec::new();
    if options.web {
        specs.extend(web::tool_specs());
        prompts.push(web::system_prompt(&tools::today()));
    }
    if options.files {
        specs.extend(file_tools::tool_specs());
        prompts.push(file_tools::system_prompt());
        file_tools::ensure_index(app);
    }
    if !prompts.is_empty() {
        messages.insert(0, ChatMessage::text("system", prompts.join("\n\n")));
    }
    let mut messages = merge_system(messages);
    let ctx = tools::ToolCtx {
        app,
        chat_id,
        cancel,
    };

    // Calls already made in this reply (name + arguments): small models
    // sometimes repeat the same search or page read in a loop.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for round in 0..MAX_TOOL_ROUNDS {
        let offer: &[ToolSpec] = if round + 1 < MAX_TOOL_ROUNDS {
            &specs
        } else {
            &[]
        };
        let mut text = String::new();
        let mut attempt = 0;
        // Streamed pieces of this turn; each is about one token.
        let mut chunks: u64 = 0;
        let turn = loop {
            let result = provider
                .chat_stream(model, &messages, options, offer, cancel, |content| {
                    text.push_str(content);
                    chunks += 1;
                    let _ = app.emit("chat://token", TokenEvent { chat_id, content });
                })
                .await;
            match result {
                // Small models sometimes garble a tool call; one retry usually works.
                Err(AppError::ToolFormat(_)) if attempt == 0 && text.is_empty() => attempt += 1,
                Ok(turn) => break turn,
                Err(err) => {
                    // A stopped or failed turn has no server stats, but the
                    // model did read the prompt and write what was streamed.
                    if matches!(err, AppError::Cancelled) || chunks > 0 {
                        let estimate = ChatStats {
                            eval_count: chunks,
                            prompt_eval_count: estimate_tokens(&messages),
                            ..Default::default()
                        };
                        *used = Some(tools::merge_stats(used.take(), estimate));
                    }
                    return Err(err);
                }
            }
        };
        *used = Some(tools::merge_stats(used.take(), turn.stats));
        if turn.tool_calls.is_empty() || offer.is_empty() {
            break;
        }

        // Keep text written before the tool calls apart from what follows.
        if !text.trim().is_empty() {
            let _ = app.emit(
                "chat://token",
                TokenEvent {
                    chat_id,
                    content: "\n\n",
                },
            );
        }
        messages.push(ChatMessage {
            role: "assistant".into(),
            content: text,
            tool_calls: turn.tool_calls.clone(),
            ..Default::default()
        });
        for call in &turn.tool_calls {
            if !seen.insert(format!("{}\u{0}{}", call.name, call.arguments)) {
                messages.push(ChatMessage {
                    role: "tool".into(),
                    content:
                        "You already made exactly this call in this reply; its result is above. \
Don't repeat it: use that result, or answer now."
                            .into(),
                    tool_call_id: Some(call.id.clone()),
                    tool_name: Some(call.name.clone()),
                    ..Default::default()
                });
                continue;
            }
            let started = tools::ToolActivity::started(call);
            ctx.emit(&started);
            let (activity, output) = tokio::select! {
                _ = cancel.cancelled() => return Err(AppError::Cancelled),
                r = tools::run_any(state, &ctx, call, started) => r,
            };
            ctx.emit(&activity);
            if cancel.is_cancelled() {
                return Err(AppError::Cancelled);
            }
            messages.push(ChatMessage {
                role: "tool".into(),
                content: output,
                tool_call_id: Some(call.id.clone()),
                tool_name: Some(call.name.clone()),
                ..Default::default()
            });
        }
    }
    Ok(used.clone().unwrap_or_default())
}

// --- Files -------------------------------------------------------------------

/// File-name search for @-mentions (starts the index on first use).
#[tauri::command]
pub fn file_search(
    app: AppHandle,
    state: State<'_, AppState>,
    query: String,
) -> Vec<files::FileHit> {
    file_tools::ensure_index(&app);
    files::search(&state.file_index, &query, 12)
}

#[tauri::command]
pub fn index_status(state: State<'_, AppState>) -> files::IndexStatus {
    files::status(&state.file_index)
}

/// Rebuilds the file index in the background.
#[tauri::command]
pub fn rebuild_index(app: AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        files::build_index(&state.file_index);
    });
}

#[derive(Serialize)]
pub struct FileAttachment {
    pub name: String,
    pub path: String,
    pub size: u64,
    /// File bytes as base64 (the frontend decides text vs. image).
    pub base64: String,
}

/// Reads a mentioned file for attaching it to a message.
#[tauri::command]
pub fn read_file_attachment(path: String) -> AppResult<FileAttachment> {
    use base64::Engine;
    let path = files::clean_path(&path)?;
    let meta = std::fs::metadata(&path).map_err(|_| AppError::Other("not found".into()))?;
    if meta.is_dir() {
        return Err(AppError::Other("is a directory".into()));
    }
    if meta.len() > files::MAX_ATTACH_IMAGE_BYTES {
        return Err(AppError::Other("file too large".into()));
    }
    let bytes = std::fs::read(&path)?;
    Ok(FileAttachment {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.display().to_string(),
        size: meta.len(),
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

/// The user's answer to a pending file-tool approval.
#[tauri::command]
pub fn answer_approval(state: State<'_, AppState>, id: String, decision: Decision) {
    if let Some(tx) = lock(&state.approvals).remove(&id) {
        let _ = tx.send(decision);
    }
}
// --- Web search settings ----------------------------------------------------------

#[derive(Serialize)]
pub struct SearchStatus {
    pub has_brave_key: bool,
    /// Searches this calendar month with the current provider.
    pub month_count: i64,
}

#[tauri::command]
pub fn search_status(state: State<'_, AppState>) -> AppResult<SearchStatus> {
    let provider = db::get_settings(&state.db())?.search_provider;
    let name = tools::provider_name(tools::provider_from(&provider));
    Ok(SearchStatus {
        has_brave_key: tools::brave_key().is_some(),
        month_count: db::search_count(&state.db(), &db::current_month(), name)?,
    })
}

/// Stores the Brave key in the Windows Credential Manager (`None` removes it).
#[tauri::command]
pub fn set_brave_key(key: Option<String>) -> AppResult<()> {
    tools::set_brave_key(key.as_deref())
}

/// Runs a real search with the current settings. Errors carry a code in
/// `message` (see `tools::error_code`).
#[tauri::command]
pub async fn test_search(state: State<'_, AppState>) -> AppResult<usize> {
    let provider = tools::search_config(&state).0.provider;
    tools::search(&state, "ZAP local AI chat", 3)
        .await
        .map(|r| r.len())
        .map_err(|e| {
            let code = match (provider, tools::error_code(&e)) {
                (web::SearchProvider::Searxng, "unreachable") => "searxng_unreachable",
                (_, code) => code,
            };
            AppError::Other(code.into())
        })
}

const SEARXNG_PORT: u16 = 8888;
const SEARXNG_IMAGE: &str = "docker.io/searxng/searxng:latest";

#[tauri::command]
pub async fn searxng_container() -> crate::docker::ContainerState {
    crate::docker::container_state().await
}

/// Starts, stops or restarts the SearXNG container ("start" also starts
/// Docker Desktop when needed). Returns the new state. Error codes:
/// docker_missing, searxng_missing, docker_failed.
#[tauri::command]
pub async fn searxng_control(
    state: State<'_, AppState>,
    action: String,
) -> AppResult<crate::docker::ContainerState> {
    use crate::docker::{self, ContainerState};
    let url = db::get_settings(&state.db())?.searxng_url;
    let current = docker::container_state().await;
    match current {
        ContainerState::DockerMissing => return Err(AppError::Other("docker_missing".into())),
        ContainerState::Missing => return Err(AppError::Other("searxng_missing".into())),
        _ => {}
    }
    let ok = match action.as_str() {
        "stop" => {
            current == ContainerState::DockerStopped || docker::container_command("stop").await
        }
        "start" if current == ContainerState::Running => true,
        // Starts Docker Desktop first if needed, then the container, and waits.
        "start" => {
            docker::start_searxng(&state.http, &url, &CancellationToken::new(), |_| {}).await
        }
        "restart" if current == ContainerState::Running => {
            docker::container_command("restart").await
                && docker::wait_until_up(&state.http, &url, 60).await
        }
        "restart" => {
            docker::start_searxng(&state.http, &url, &CancellationToken::new(), |_| {}).await
        }
        _ => return Err(AppError::Other("unknown action".into())),
    };
    if !ok {
        return Err(AppError::Other("docker_failed".into()));
    }
    Ok(docker::container_state().await)
}

/// Sets up SearXNG as a local Docker container (loopback only, JSON
/// enabled), waits until it answers and switches the search provider to it.
/// Error codes: docker_missing, docker_not_running, docker_failed, searxng_timeout.
#[tauri::command]
pub async fn searxng_setup(app: AppHandle, state: State<'_, AppState>) -> AppResult<String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(e.to_string()))?
        .join("searxng");
    let run = tauri::async_runtime::spawn_blocking(move || -> Result<(), &'static str> {
        match docker(&["version", "--format", "{{.Server.Version}}"]) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err("docker_missing"),
            Err(_) => return Err("docker_failed"),
            Ok(out) if !out.status.success() => return Err("docker_not_running"),
            Ok(_) => {}
        }
        std::fs::create_dir_all(&dir).map_err(|_| "docker_failed")?;
        let settings = dir.join("settings.yml");
        if !settings.exists() {
            let secret = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
            let yml = format!(
                "use_default_settings: true\nserver:\n  secret_key: \"{secret}\"\n  limiter: false\n  image_proxy: false\nsearch:\n  formats:\n    - html\n    - json\n"
            );
            std::fs::write(&settings, yml).map_err(|_| "docker_failed")?;
        }
        let _ = docker(&["rm", "-f", SEARXNG_CONTAINER]);
        let mount = format!("{}:/etc/searxng", dir.display());
        let port = format!("127.0.0.1:{SEARXNG_PORT}:8080");
        let out = docker(&[
            "run", "-d", "--name", SEARXNG_CONTAINER, "--restart", "unless-stopped", "-p", &port, "-v", &mount,
            SEARXNG_IMAGE,
        ])
        .map_err(|_| "docker_failed")?;
        if out.status.success() { Ok(()) } else { Err("docker_failed") }
    })
    .await
    .map_err(|_| AppError::Other("docker_failed".into()))?;
    run.map_err(|code| AppError::Other(code.into()))?;

    let url = format!("http://127.0.0.1:{SEARXNG_PORT}");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
    loop {
        let ok = state
            .http
            .get(format!("{url}/search"))
            .query(&[("q", "test"), ("format", "json")])
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success());
        if ok {
            break;
        }
        if std::time::Instant::now() > deadline {
            return Err(AppError::Other("searxng_timeout".into()));
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }

    let mut settings = db::get_settings(&state.db())?;
    settings.searxng_url = url.clone();
    settings.search_provider = "searxng".into();
    db::set_settings(&state.db(), &settings)?;
    Ok(url)
}

// --- Chats & messages ----------------------------------------------------------

#[tauri::command]
pub fn create_chat(state: State<'_, AppState>, model: Option<String>) -> AppResult<Chat> {
    db::create_chat(&state.db(), model)
}

#[tauri::command]
pub fn list_chats(state: State<'_, AppState>) -> AppResult<Vec<Chat>> {
    db::list_chats(&state.db())
}

#[tauri::command]
pub fn search_chats(state: State<'_, AppState>, query: String) -> AppResult<Vec<SearchHit>> {
    db::search_chats(&state.db(), &query, SEARCH_LIMIT)
}

#[tauri::command]
pub fn rename_chat(state: State<'_, AppState>, id: String, title: String) -> AppResult<()> {
    let title = title.trim();
    let title = if title.is_empty() {
        db::DEFAULT_TITLE
    } else {
        title
    };
    db::rename_chat(&state.db(), &id, title)
}

#[tauri::command]
pub fn pin_chat(state: State<'_, AppState>, id: String, pinned: bool) -> AppResult<()> {
    db::pin_chat(&state.db(), &id, pinned)
}

#[tauri::command]
pub fn set_chat_model(state: State<'_, AppState>, id: String, model: String) -> AppResult<()> {
    db::set_chat_model(&state.db(), &id, &model)
}

#[tauri::command]
pub fn delete_chat(state: State<'_, AppState>, id: String) -> AppResult<()> {
    if let Some((_, token)) = lock(&state.chat_tokens).remove(&id) {
        token.cancel();
    }
    db::delete_chat(&state.db(), &id)
}

#[tauri::command]
pub fn set_chat_group(
    state: State<'_, AppState>,
    id: String,
    group_id: Option<String>,
) -> AppResult<()> {
    db::set_chat_group(&state.db(), &id, group_id.as_deref())
}

// --- Chat groups ---------------------------------------------------------------

#[tauri::command]
pub fn list_groups(state: State<'_, AppState>) -> AppResult<Vec<ChatGroup>> {
    db::list_groups(&state.db())
}

#[tauri::command]
pub fn create_group(state: State<'_, AppState>, name: String) -> AppResult<ChatGroup> {
    db::create_group(&state.db(), &name)
}

#[tauri::command]
pub fn rename_group(state: State<'_, AppState>, id: String, name: String) -> AppResult<()> {
    db::rename_group(&state.db(), &id, &name)
}

#[tauri::command]
pub fn set_group_color(
    state: State<'_, AppState>,
    id: String,
    color: Option<String>,
) -> AppResult<()> {
    db::set_group_color(&state.db(), &id, color.as_deref())
}

#[tauri::command]
pub fn set_group_collapsed(
    state: State<'_, AppState>,
    id: String,
    collapsed: bool,
) -> AppResult<()> {
    db::set_group_collapsed(&state.db(), &id, collapsed)
}

#[tauri::command]
pub fn reorder_groups(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<()> {
    db::reorder_groups(&mut state.db(), &ids)
}

#[tauri::command]
pub fn delete_group(state: State<'_, AppState>, id: String, delete_chats: bool) -> AppResult<()> {
    let deleted = db::delete_group(&mut state.db(), &id, delete_chats)?;
    let mut tokens = lock(&state.chat_tokens);
    for chat_id in deleted {
        if let Some((_, token)) = tokens.remove(&chat_id) {
            token.cancel();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn delete_all_chats(state: State<'_, AppState>) -> AppResult<()> {
    for (_, (_, token)) in lock(&state.chat_tokens).drain() {
        token.cancel();
    }
    db::delete_all_chats(&mut state.db())
}

#[tauri::command]
pub fn get_messages(state: State<'_, AppState>, chat_id: String) -> AppResult<Vec<Message>> {
    db::get_messages(&state.db(), &chat_id)
}

#[derive(Deserialize)]
pub struct NewMessage {
    pub id: Option<String>,
    pub chat_id: String,
    pub role: String,
    pub content: String,
    pub created_at: Option<i64>,
    pub model: Option<String>,
    pub stats: Option<ChatStats>,
    /// JSON array of attachments, stored as-is.
    pub attachments: Option<String>,
    /// JSON array of tool activity, stored as-is.
    #[serde(default)]
    pub tools: Option<String>,
}

#[derive(Serialize)]
pub struct SavedMessage {
    pub message: Message,
    pub chat: Option<Chat>,
}

#[tauri::command]
pub fn save_message(state: State<'_, AppState>, message: NewMessage) -> AppResult<SavedMessage> {
    if !matches!(message.role.as_str(), "system" | "user" | "assistant") {
        return Err(AppError::Other("invalid role".into()));
    }
    let msg = Message {
        id: message
            .id
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        chat_id: message.chat_id,
        role: message.role,
        content: message.content,
        created_at: message.created_at.unwrap_or_else(db::now_ms),
        model: message.model,
        stats: message.stats.and_then(|s| serde_json::to_string(&s).ok()),
        attachments: message.attachments.filter(|a| !a.is_empty() && a != "[]"),
        tools: message.tools.filter(|a| !a.is_empty() && a != "[]"),
    };
    let chat = db::save_message(&mut state.db(), &msg)?;
    Ok(SavedMessage { message: msg, chat })
}

#[tauri::command]
pub fn update_message(state: State<'_, AppState>, id: String, content: String) -> AppResult<()> {
    db::update_message(&state.db(), &id, &content)
}

#[tauri::command]
pub fn delete_message(state: State<'_, AppState>, id: String) -> AppResult<()> {
    db::delete_message(&state.db(), &id)
}

#[tauri::command]
pub fn delete_messages_after(
    state: State<'_, AppState>,
    chat_id: String,
    message_id: String,
) -> AppResult<usize> {
    db::delete_messages_after(&state.db(), &chat_id, &message_id)
}

// --- Export / import -----------------------------------------------------------

fn safe_file_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .take(60)
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.').to_string();
    if cleaned.is_empty() {
        "chat".into()
    } else {
        cleaned
    }
}

async fn pick_save_path(
    app: &AppHandle,
    file_name: &str,
    filter: &str,
    ext: &'static [&'static str],
) -> Option<PathBuf> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(file_name)
        .add_filter(filter, ext)
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    rx.await.ok().flatten().and_then(|p| p.into_path().ok())
}

async fn pick_open_path(
    app: &AppHandle,
    filter: &str,
    ext: &'static [&'static str],
) -> Option<PathBuf> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter(filter, ext)
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    rx.await.ok().flatten().and_then(|p| p.into_path().ok())
}

/// Saves one chat as Markdown. Returns `false` when the user cancelled.
#[tauri::command]
pub async fn export_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: String,
) -> AppResult<bool> {
    let (chat, messages, lang) = {
        let conn = state.db();
        let chat = db::get_chat(&conn, &chat_id)?
            .ok_or_else(|| AppError::Other("chat not found".into()))?;
        let messages = db::get_messages(&conn, &chat_id)?;
        (chat, messages, db::get_settings(&conn)?.language)
    };
    let name = format!("{}.md", safe_file_name(&chat.title));
    let Some(path) = pick_save_path(&app, &name, "Markdown", &["md"]).await else {
        return Ok(false);
    };
    std::fs::write(path, db::chat_to_markdown(&chat, &messages, &lang))?;
    Ok(true)
}

/// Saves all chats as versioned JSON. Returns `false` when cancelled.
#[tauri::command]
pub async fn export_all(app: AppHandle, state: State<'_, AppState>) -> AppResult<bool> {
    let file = db::export_chats(&state.db(), None)?;
    let date = chrono_date(file.exported_at);
    let Some(path) =
        pick_save_path(&app, &format!("zap-chats-{date}.json"), "JSON", &["json"]).await
    else {
        return Ok(false);
    };
    let json = serde_json::to_vec_pretty(&file).map_err(|e| AppError::Other(e.to_string()))?;
    std::fs::write(path, json)?;
    Ok(true)
}

/// Imports chats from a ZAP JSON export. Returns the number of imported
/// chats, or `None` when the user cancelled.
#[tauri::command]
pub async fn import_all(app: AppHandle, state: State<'_, AppState>) -> AppResult<Option<usize>> {
    let Some(path) = pick_open_path(&app, "JSON", &["json"]).await else {
        return Ok(None);
    };
    let bytes = std::fs::read(path)?;
    let file: ExportFile = serde_json::from_slice(&bytes)
        .map_err(|_| AppError::InvalidFile("not a ZAP export".into()))?;
    let count = db::import_chats(&mut state.db(), &file).map_err(|e| match e {
        AppError::Other(msg) => AppError::InvalidFile(msg),
        other => other,
    })?;
    Ok(Some(count))
}

/// `YYYY-MM-DD` from a Unix timestamp in ms (UTC).
fn chrono_date(ms: i64) -> String {
    let (y, m, d) = db::ymd(ms);
    format!("{y:04}-{m:02}-{d:02}")
}

// --- Token usage -----------------------------------------------------------------

/// Lifetime token usage per model (sorted by total tokens).
#[tauri::command]
pub fn token_usage(state: State<'_, AppState>) -> AppResult<Vec<db::ModelUsage>> {
    db::usage_by_model(&state.db())
}

/// Tokens used by the replies in one chat.
#[tauri::command]
pub fn chat_usage(state: State<'_, AppState>, chat_id: String) -> AppResult<db::ChatUsage> {
    db::chat_usage(&state.db(), &chat_id)
}

#[tauri::command]
pub fn reset_usage(state: State<'_, AppState>) -> AppResult<()> {
    db::reset_usage(&state.db())
}

// --- Settings ----------------------------------------------------------------

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppResult<Settings> {
    db::get_settings(&state.db())
}

#[tauri::command]
pub fn set_settings(state: State<'_, AppState>, settings: Settings) -> AppResult<()> {
    db::set_settings(&state.db(), &settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimates_prompt_tokens() {
        let msgs = vec![
            ChatMessage::text("system", "a".repeat(400)),
            ChatMessage::text("user", "Hallo"),
        ];
        // 100 + 4 and 2 + 4
        assert_eq!(estimate_tokens(&msgs), 110);
    }

    #[test]
    fn system_messages_become_one_at_the_start() {
        let msgs = vec![
            ChatMessage::text("system", "Tools rules"),
            ChatMessage::text("system", "Date"),
            ChatMessage::text("user", "Hi"),
            ChatMessage::text("system", "  "),
        ];
        let merged = merge_system(msgs);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].role, "system");
        assert_eq!(merged[0].content, "Tools rules\n\nDate");
        assert_eq!(merged[1].content, "Hi");
        assert_eq!(merge_system(vec![ChatMessage::text("user", "x")]).len(), 1);
    }

    #[test]
    fn file_names_are_sanitized() {
        assert_eq!(safe_file_name("a/b:c?"), "a_b_c_");
        assert_eq!(safe_file_name("  ...  "), "chat");
    }

    #[test]
    fn dates_are_formatted() {
        assert_eq!(chrono_date(0), "1970-01-01");
        assert_eq!(chrono_date(1_709_164_800_000), "2024-02-29");
    }
}
