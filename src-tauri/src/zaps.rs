//! ZAPs: small agents that work on a task by themselves in the background,
//! with the tools the user gave them (web, files, PowerShell, apps). Runs
//! are started from the ZAP view or by the chat model, stream their steps as
//! `chat://token|tool` events keyed by the run id, and end with a stored
//! run log plus a `zap://run` event.
//!
//! Runs go through a channel to one runner task: the chat tool that starts a
//! ZAP lives inside the agent loop, which can't spawn itself directly.

use std::sync::OnceLock;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::commands::{self, AgentTarget, RunLog, MAX_ZAP_ROUNDS};
use crate::db::{self, Zap, ZapRun, ZapTools};
use crate::engine;
use crate::error::{AppError, AppResult};
use crate::provider::{ChatMessage, ChatOptions, ChatProvider, ToolCall, ToolSpec};
use crate::state::{lock, AppState, Decision};
use crate::system_tools::truncate_output;
use crate::tools::{self, ToolActivity, ToolCtx};

pub const LIST: &str = "list_zaps";
pub const CREATE: &str = "create_zap";
pub const START: &str = "start_zap";
pub const STOP: &str = "stop_zap";
pub const STATUS: &str = "zap_status";
pub const DELETE: &str = "delete_zap";
pub const NAMES: &[&str] = &[LIST, CREATE, START, STOP, STATUS, DELETE];

pub const DEFAULT_STEPS: u32 = 20;
const ZAP_TEMPERATURE: f32 = 0.2;
const RUN_HISTORY: u32 = 30;
/// Report text handed back to the chat model.
const STATUS_CHARS: usize = 4000;

struct Job {
    run: ZapRun,
    zap: Zap,
    model: String,
    token: CancellationToken,
}

static JOBS: OnceLock<mpsc::UnboundedSender<Job>> = OnceLock::new();

/// Marks runs interrupted by the last shutdown and starts the runner.
pub fn init(app: &AppHandle) {
    let _ = db::close_stale_runs(&app.state::<AppState>().db());
    let (tx, mut rx) = mpsc::unbounded_channel::<Job>();
    let _ = JOBS.set(tx);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(job) = rx.recv().await {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { execute(&app, job).await });
        }
    });
}

fn emit_run(app: &AppHandle, run: &ZapRun) {
    let _ = app.emit("zap://run", run);
}

fn emit_changed(app: &AppHandle) {
    let _ = app.emit("zap://changed", ());
}

/// The system prompt of a run.
fn task_prompt(zap: &Zap) -> String {
    let t = &zap.tools;
    let has_tools = t.web || t.files || t.terminal || t.apps;
    let mut prompt = format!(
        "You are the ZAP \"{}\", a small agent that works by itself on the user's Windows PC. Today is {}.\n\n\
Your task:\n{}\n\n",
        zap.name,
        tools::today(),
        zap.instructions.trim()
    );
    if has_tools {
        prompt.push_str(
            "How to work:\n\
- Work step by step with your tools until the task is done. Don't stop after making a plan: carry it out \
by calling the tools. Writing a command as text does nothing.\n\
- Never invent results. Report only what your tools actually returned.\n\
- Nobody can answer questions while you run. Decide yourself, pick sensible defaults and mention your \
assumptions in the report.\n\
- If a step fails, read the error and try another way. If the task can't be done, stop and say why.\n\
\n\
Work efficiently, every step costs time and tokens:\n\
- Use as few steps as possible. Do several things in one call where you can (e.g. one PowerShell command \
with ';' or a pipeline instead of several calls).\n\
- Ask only for the output you need: filter and select fields (Select-Object, Where-Object, -First) instead \
of listing everything.\n\
- Don't check again what a tool already told you, and don't repeat calls.\n\
- Stop as soon as the task is done.\n",
        );
    }
    prompt.push_str(
        "\nFinish with a short report in the language of the task: what you did, the results, and anything \
that failed or needs the user. No long explanations.",
    );
    prompt
}

/// Starts a run in the background and returns it (status "running").
pub fn start(
    app: &AppHandle,
    state: &AppState,
    zap_id: &str,
    input: Option<String>,
    source: &str,
    fallback_model: Option<&str>,
) -> AppResult<ZapRun> {
    let zap =
        db::get_zap(&state.db(), zap_id)?.ok_or_else(|| AppError::Other("zap_not_found".into()))?;
    let model = zap
        .model
        .clone()
        .filter(|m| !m.trim().is_empty())
        .or_else(|| fallback_model.map(str::to_string))
        .filter(|m| !m.trim().is_empty())
        .ok_or_else(|| AppError::Other("no_model".into()))?;
    let jobs = JOBS
        .get()
        .ok_or_else(|| AppError::Other("runner not ready".into()))?;
    let run = ZapRun {
        id: uuid::Uuid::new_v4().to_string(),
        zap_id: zap.id.clone(),
        input: input
            .map(|i| i.trim().to_string())
            .filter(|i| !i.is_empty()),
        source: source.into(),
        status: "running".into(),
        output: String::new(),
        activities: None,
        stats: None,
        error: None,
        started_at: db::now_ms(),
        ended_at: None,
        model: Some(model.clone()),
    };
    db::save_run(&state.db(), &run)?;
    let token = CancellationToken::new();
    let generation = state
        .next_generation
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    lock(&state.chat_tokens).insert(run.id.clone(), (generation, token.clone()));
    emit_run(app, &run);
    jobs.send(Job {
        run: run.clone(),
        zap,
        model,
        token,
    })
    .map_err(|_| AppError::Other("runner not ready".into()))?;
    Ok(run)
}

/// Stops a run (no-op when it already ended).
pub fn stop(state: &AppState, run_id: &str) {
    if let Some((_, token)) = lock(&state.chat_tokens).remove(run_id) {
        token.cancel();
    }
}

async fn execute(app: &AppHandle, job: Job) {
    let state = app.state::<AppState>();
    let Job {
        mut run,
        zap,
        model,
        token,
    } = job;
    let input = run
        .input
        .clone()
        .unwrap_or_else(|| "Start the task now.".into());
    let messages = vec![
        ChatMessage::text("system", task_prompt(&zap)),
        ChatMessage::text("user", input),
    ];
    let t = &zap.tools;
    // The chat's context size: a different one makes Ollama reload the model.
    let num_ctx = db::get_settings(&state.db())
        .ok()
        .and_then(|s| s.context_length);
    let options = ChatOptions {
        // Low temperature: steady tool calls, fewer detours.
        temperature: Some(ZAP_TEMPERATURE),
        num_ctx,
        web: t.web,
        files: t.files,
        terminal: t.terminal,
        apps: t.apps,
        max_rounds: Some(zap.max_steps),
        ..Default::default()
    };
    let (provider, model_name) = engine::route(&state, &model);
    let mut used = None;
    let mut log = RunLog::default();
    let needs_tools = t.web || t.files || t.terminal || t.apps;
    let result = if needs_tools
        && !provider
            .capabilities(model_name)
            .await
            .is_ok_and(|c| c.tools)
    {
        Err(AppError::Other("no_tools".into()))
    } else {
        commands::run_agent(
            app,
            &state,
            &provider,
            AgentTarget {
                model: &model,
                chat_id: &run.id,
                in_zap: true,
            },
            model_name,
            messages,
            &options,
            &token,
            &mut used,
            &mut log,
        )
        .await
        .map(|_| ())
    };

    lock(&state.chat_tokens).remove(&run.id);
    lock(&state.chat_grants).remove(&run.id);
    run.output = log.text.trim().to_string();
    run.activities = serde_json::to_string(&log.activities).ok();
    run.stats = used.and_then(|s| serde_json::to_string(&s).ok());
    run.ended_at = Some(db::now_ms());
    // ZAP tokens count in the usage overview like chat replies.
    if let Some(stats) = &run.stats {
        let _ = db::record_usage(&state.db(), &model, stats, db::now_ms());
    }
    match result {
        Ok(()) => run.status = "done".into(),
        Err(AppError::Cancelled) => run.status = "stopped".into(),
        Err(err) => {
            run.status = "failed".into();
            run.error = Some(match &err {
                AppError::Other(code) if code == "no_tools" => code.clone(),
                _ => err.code().into(),
            });
        }
    }
    let _ = db::save_run(&state.db(), &run);
    emit_run(app, &run);
}

// --- Tauri commands ----------------------------------------------------------

#[tauri::command]
pub fn zaps_list(state: State<'_, AppState>) -> AppResult<Vec<Zap>> {
    db::list_zaps(&state.db())
}

fn validate(zap: &mut Zap) -> AppResult<()> {
    zap.name = zap.name.trim().chars().take(60).collect();
    zap.instructions = zap.instructions.trim().to_string();
    if zap.name.is_empty() || zap.instructions.is_empty() {
        return Err(AppError::Other("name and instructions are required".into()));
    }
    if zap.icon.trim().is_empty() {
        zap.icon = "sparkles".into();
    }
    zap.max_steps = zap.max_steps.clamp(2, MAX_ZAP_ROUNDS as u32);
    Ok(())
}

/// Creates (empty id) or updates a ZAP.
#[tauri::command]
pub fn zap_save(app: AppHandle, state: State<'_, AppState>, mut zap: Zap) -> AppResult<Zap> {
    validate(&mut zap)?;
    let now = db::now_ms();
    if zap.id.is_empty() {
        zap.id = uuid::Uuid::new_v4().to_string();
        zap.created_at = now;
    }
    zap.updated_at = now;
    db::save_zap(&state.db(), &zap)?;
    emit_changed(&app);
    Ok(zap)
}

fn delete(app: &AppHandle, state: &AppState, id: &str) -> AppResult<()> {
    for run in db::active_runs(&state.db())? {
        if run.zap_id == id {
            stop(state, &run.id);
        }
    }
    db::delete_zap(&state.db(), id)?;
    emit_changed(app);
    Ok(())
}

#[tauri::command]
pub fn zap_delete(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    delete(&app, &state, &id)
}

/// Lifetime runs, tokens and runtime of a ZAP.
#[tauri::command]
pub fn zap_totals(state: State<'_, AppState>, zap_id: String) -> AppResult<db::ZapTotals> {
    db::zap_totals(&state.db(), &zap_id)
}

/// Recent runs of a ZAP, newest first.
#[tauri::command]
pub fn zap_runs(state: State<'_, AppState>, zap_id: String) -> AppResult<Vec<ZapRun>> {
    db::list_runs(&state.db(), &zap_id, RUN_HISTORY)
}

/// Runs still in progress (all ZAPs).
#[tauri::command]
pub fn zap_active_runs(state: State<'_, AppState>) -> AppResult<Vec<ZapRun>> {
    db::active_runs(&state.db())
}

#[tauri::command]
pub fn zap_start(
    app: AppHandle,
    state: State<'_, AppState>,
    zap_id: String,
    input: Option<String>,
    model: Option<String>,
) -> AppResult<ZapRun> {
    start(&app, &state, &zap_id, input, "manual", model.as_deref())
}

#[tauri::command]
pub fn zap_stop(state: State<'_, AppState>, run_id: String) {
    stop(&state, &run_id);
}

// --- Chat tools --------------------------------------------------------------

pub fn tool_specs() -> Vec<ToolSpec> {
    let zap_arg = json!({
        "type": "object",
        "properties": { "zap": { "type": "string", "description": "Name or id of the ZAP" } },
        "required": ["zap"]
    });
    vec![
        ToolSpec {
            name: LIST,
            description: "List the user's ZAPs (small background agents) with their tools and last run.",
            parameters: json!({ "type": "object", "properties": {} }),
        },
        ToolSpec {
            name: CREATE,
            description: "Create a new ZAP: a small agent that later does a task by itself on the user's PC. The user confirms it first. Only when the user asks for one.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Short name, e.g. \"Downloads Sorter\"" },
                    "instructions": { "type": "string", "description": "The task, written as clear instructions for the agent: goal, steps, rules, what to report. In the user's language." },
                    "tools": {
                        "type": "array",
                        "items": { "type": "string", "enum": ["web", "files", "terminal", "apps"] },
                        "description": "What it may use: web (search and read pages), files (search/read/write files), terminal (PowerShell commands), apps (open apps, files and links). Only what the task needs."
                    },
                    "max_steps": { "type": "integer", "description": "Upper bound for its steps (default 20, max 60)" }
                },
                "required": ["name", "instructions", "tools"]
            }),
        },
        ToolSpec {
            name: START,
            description: "Start a ZAP in the background. Returns right away; use zap_status later for the result.",
            parameters: json!({
                "type": "object",
                "properties": {
                    "zap": { "type": "string", "description": "Name or id of the ZAP" },
                    "input": { "type": "string", "description": "Optional extra details for this run" }
                },
                "required": ["zap"]
            }),
        },
        ToolSpec {
            name: STOP,
            description: "Stop a running ZAP.",
            parameters: zap_arg.clone(),
        },
        ToolSpec {
            name: STATUS,
            description: "Status and report of a ZAP's latest run.",
            parameters: zap_arg.clone(),
        },
        ToolSpec {
            name: DELETE,
            description: "Delete a ZAP and its run history. The user confirms it first. Only when the user asks for it.",
            parameters: zap_arg,
        },
    ]
}

pub fn chat_prompt() -> String {
    "You can manage the user's ZAPs: small agents that do tasks by themselves in the background on this PC \
(with web research, files, PowerShell and opening apps, as configured). Use the ZAP tools only when the user \
asks about ZAPs or wants one created, started, stopped or deleted. When creating one, write precise \
instructions and give it only the tools the task needs. A started ZAP runs on its own; tell the user it is \
running and that they can follow it in the ZAPs section."
        .into()
}

/// Finds a ZAP by id or (case-insensitive) name; a unique partial name match counts too.
fn resolve(state: &AppState, query: &str) -> AppResult<Option<Zap>> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(None);
    }
    let zaps = db::list_zaps(&state.db())?;
    if let Some(z) = zaps
        .iter()
        .find(|z| z.id == query.trim() || z.name.to_lowercase() == q)
    {
        return Ok(Some(z.clone()));
    }
    let mut partial = zaps
        .into_iter()
        .filter(|z| z.name.to_lowercase().contains(&q));
    Ok(match (partial.next(), partial.next()) {
        (Some(z), None) => Some(z),
        _ => None,
    })
}

fn tool_names(t: &ZapTools) -> String {
    let names: Vec<&str> = [
        (t.web, "web"),
        (t.files, "files"),
        (t.terminal, "terminal"),
        (t.apps, "apps"),
    ]
    .into_iter()
    .filter_map(|(on, n)| on.then_some(n))
    .collect();
    if names.is_empty() {
        "none".into()
    } else {
        names.join(", ")
    }
}

/// Asks the user to confirm creating or deleting a ZAP.
async fn confirm(state: &AppState, ctx: &ToolCtx<'_>, activity: &mut ToolActivity) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    lock(&state.approvals).insert(activity.id.clone(), tx);
    activity.status = "pending".into();
    ctx.emit(activity);
    let decision = tokio::select! {
        _ = ctx.cancel.cancelled() => None,
        d = rx => d.ok(),
    };
    lock(&state.approvals).remove(&activity.id);
    activity.status = "running".into();
    matches!(decision, Some(Decision::Allow | Decision::AllowChat))
}

#[derive(Serialize)]
struct Draft<'a> {
    name: &'a str,
    tools: String,
    max_steps: u32,
    instructions: &'a str,
}

pub async fn run_tool(
    state: &AppState,
    ctx: &ToolCtx<'_>,
    call: &ToolCall,
    mut activity: ToolActivity,
) -> (ToolActivity, String) {
    let args = &call.arguments;
    let not_found = |activity: ToolActivity, q: &str| {
        (
            activity.failed("zap_not_found"),
            format!("Error: no ZAP named \"{q}\". Use list_zaps to see the names."),
        )
    };
    match call.name.as_str() {
        LIST => {
            let zaps = db::list_zaps(&state.db()).unwrap_or_default();
            activity.detail = Some(format!("count:{}", zaps.len()));
            if zaps.is_empty() {
                return (
                    activity.done(Vec::new()),
                    "The user has no ZAPs yet.".into(),
                );
            }
            let mut text = String::new();
            for z in &zaps {
                let last = db::list_runs(&state.db(), &z.id, 1)
                    .ok()
                    .and_then(|r| r.into_iter().next())
                    .map_or("never run".to_string(), |r| {
                        format!("last run: {}", r.status)
                    });
                text.push_str(&format!(
                    "- {} (id {}; tools: {}; {})\n  Task: {}\n",
                    z.name,
                    z.id,
                    tool_names(&z.tools),
                    last,
                    truncate_output(&z.instructions, 300).replace('\n', " ")
                ));
            }
            (activity.done(Vec::new()), text)
        }
        CREATE => {
            let name = args["name"].as_str().unwrap_or_default().trim().to_string();
            let instructions = args["instructions"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string();
            if name.is_empty() || instructions.is_empty() {
                return (
                    activity.failed("failed"),
                    "Error: name and instructions are required.".into(),
                );
            }
            let list: Vec<String> = args["tools"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_lowercase))
                        .collect()
                })
                .unwrap_or_default();
            let has = |n: &str| list.iter().any(|t| t == n);
            let now = db::now_ms();
            let mut zap = Zap {
                id: uuid::Uuid::new_v4().to_string(),
                name,
                icon: if has("terminal") {
                    "terminal".into()
                } else if has("web") {
                    "globe".into()
                } else {
                    "sparkles".into()
                },
                color: None,
                instructions,
                model: None,
                tools: ZapTools {
                    web: has("web"),
                    files: has("files"),
                    terminal: has("terminal"),
                    apps: has("apps"),
                },
                max_steps: args["max_steps"]
                    .as_u64()
                    .map_or(DEFAULT_STEPS, |n| n as u32),
                created_at: now,
                updated_at: now,
            };
            if let Err(e) = validate(&mut zap) {
                return (activity.failed("failed"), format!("Error: {e}"));
            }
            activity.input = zap.name.clone();
            activity.preview = serde_json::to_string(&Draft {
                name: &zap.name,
                tools: tool_names(&zap.tools),
                max_steps: zap.max_steps,
                instructions: &zap.instructions,
            })
            .ok();
            if !confirm(state, ctx, &mut activity).await {
                activity.status = "denied".into();
                return (
                    activity,
                    "The user did not want this ZAP. Don't create it again unless they ask.".into(),
                );
            }
            if db::save_zap(&state.db(), &zap).is_err() {
                return (
                    activity.failed("failed"),
                    "Error: could not save the ZAP.".into(),
                );
            }
            emit_changed(ctx.app);
            (
                activity.done(Vec::new()),
                format!(
                    "Created the ZAP \"{}\" (id {}). It has not run yet; start it with start_zap if the user wants that.",
                    zap.name, zap.id
                ),
            )
        }
        START => {
            let q = args["zap"].as_str().unwrap_or_default();
            let Some(zap) = resolve(state, q).ok().flatten() else {
                return not_found(activity, q);
            };
            activity.input = zap.name.clone();
            let input = args["input"].as_str().map(str::to_string);
            match start(ctx.app, state, &zap.id, input, "chat", Some(ctx.model)) {
                Ok(run) => {
                    activity.detail = Some(format!("run:{}:{}", zap.id, run.id));
                    (
                        activity.done(Vec::new()),
                        format!(
                            "The ZAP \"{}\" is now running in the background (run id {}). The user can follow it in the ZAPs section.",
                            zap.name, run.id
                        ),
                    )
                }
                Err(e) => (
                    activity.failed("failed"),
                    format!("Error: could not start the ZAP ({e})."),
                ),
            }
        }
        STOP => {
            let q = args["zap"].as_str().unwrap_or_default();
            let Some(zap) = resolve(state, q).ok().flatten() else {
                return not_found(activity, q);
            };
            activity.input = zap.name.clone();
            let runs: Vec<ZapRun> = db::active_runs(&state.db())
                .unwrap_or_default()
                .into_iter()
                .filter(|r| r.zap_id == zap.id)
                .collect();
            for run in &runs {
                stop(state, &run.id);
            }
            let text = if runs.is_empty() {
                format!("The ZAP \"{}\" was not running.", zap.name)
            } else {
                format!("Stopped the ZAP \"{}\".", zap.name)
            };
            (activity.done(Vec::new()), text)
        }
        STATUS => {
            let q = args["zap"].as_str().unwrap_or_default();
            let Some(zap) = resolve(state, q).ok().flatten() else {
                return not_found(activity, q);
            };
            activity.input = zap.name.clone();
            let last = db::list_runs(&state.db(), &zap.id, 1)
                .ok()
                .and_then(|r| r.into_iter().next());
            let text = match last {
                None => format!("The ZAP \"{}\" has never run.", zap.name),
                Some(run) if run.status == "running" => {
                    format!("The ZAP \"{}\" is still running.", zap.name)
                }
                Some(run) => {
                    let mut text = format!("Latest run of \"{}\": {}", zap.name, run.status);
                    if let Some(err) = &run.error {
                        text.push_str(&format!(" (error: {err})"));
                    }
                    text.push_str(".\n\nReport:\n");
                    text.push_str(if run.output.is_empty() {
                        "(none)"
                    } else {
                        &run.output
                    });
                    truncate_output(&text, STATUS_CHARS)
                }
            };
            (activity.done(Vec::new()), text)
        }
        DELETE => {
            let q = args["zap"].as_str().unwrap_or_default();
            let Some(zap) = resolve(state, q).ok().flatten() else {
                return not_found(activity, q);
            };
            activity.input = zap.name.clone();
            if !confirm(state, ctx, &mut activity).await {
                activity.status = "denied".into();
                return (activity, "The user did not want to delete this ZAP.".into());
            }
            match delete(ctx.app, state, &zap.id) {
                Ok(()) => (
                    activity.done(Vec::new()),
                    format!("Deleted the ZAP \"{}\".", zap.name),
                ),
                Err(_) => (
                    activity.failed("failed"),
                    "Error: could not delete the ZAP.".into(),
                ),
            }
        }
        other => (
            activity.failed("unknown_tool"),
            format!("Error: unknown tool \"{other}\"."),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_names_task_and_rules() {
        let zap = Zap {
            id: "z".into(),
            name: "Sorter".into(),
            icon: "sparkles".into(),
            color: None,
            instructions: "Sort my downloads.".into(),
            model: None,
            tools: ZapTools {
                terminal: true,
                ..Default::default()
            },
            max_steps: 20,
            created_at: 0,
            updated_at: 0,
        };
        let p = task_prompt(&zap);
        assert!(p.contains("\"Sorter\""));
        assert!(p.contains("Sort my downloads."));
        assert!(p.contains("Nobody can answer"));
        assert_eq!(tool_names(&zap.tools), "terminal");
        assert_eq!(tool_names(&ZapTools::default()), "none");
    }

    #[test]
    fn tool_names_match_specs() {
        let specs = tool_specs();
        assert_eq!(specs.len(), NAMES.len());
        assert!(specs.iter().all(|s| NAMES.contains(&s.name)));
    }
}
