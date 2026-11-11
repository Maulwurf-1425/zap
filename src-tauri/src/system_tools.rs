//! System tools for ZAPs: PowerShell commands and opening apps, files and
//! links. With `zap_permission` "ask" every call needs the user's OK; with
//! "full" they run directly, except a short list of destructive commands
//! that always ask.

use std::process::Stdio;
use std::time::Duration;

use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::db;
use crate::provider::{ToolCall, ToolSpec};
use crate::state::{lock, AppState, Decision};
use crate::tools::{ToolActivity, ToolCtx};

pub const RUN: &str = "run_command";
pub const OPEN: &str = "open_app";
pub const NAMES: &[&str] = &[RUN, OPEN];

const DEFAULT_TIMEOUT: u64 = 60;
const MAX_TIMEOUT: u64 = 600;
/// Output given to the model (start and end are kept). Every character is
/// read again in each later step, so keep it lean.
const MAX_OUTPUT_CHARS: usize = 8_000;

pub fn terminal_spec() -> ToolSpec {
    ToolSpec {
        name: RUN,
        description: "Run a Windows PowerShell 5.1 command on the user's PC and get its output (stdout, stderr, exit code). Use it to inspect the system, list or move files, start scripts, query settings, etc. One command or pipeline per call; separate statements with ';'. Never use interactive commands that wait for input.",
        parameters: json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "The PowerShell command, e.g. Get-ChildItem \"$HOME\\Downloads\" | Select-Object Name, Length" },
                "working_directory": { "type": "string", "description": "Absolute folder to run in (default: the user's home folder)" },
                "timeout_seconds": { "type": "integer", "description": "Stop after this many seconds (default 60, max 600)" }
            },
            "required": ["command"]
        }),
    }
}

pub fn apps_spec() -> ToolSpec {
    ToolSpec {
        name: OPEN,
        description: "Open an app, a file, a folder or a web link on the user's PC, like double-clicking it. Accepts app names (notepad, calc, chrome, explorer, code), full paths or URLs.",
        parameters: json!({
            "type": "object",
            "properties": {
                "target": { "type": "string", "description": "App name, absolute path or URL" },
                "arguments": { "type": "string", "description": "Optional arguments for the app" }
            },
            "required": ["target"]
        }),
    }
}

pub fn system_prompt(terminal: bool, apps: bool) -> String {
    let mut parts = Vec::new();
    if terminal {
        parts.push(
            "run_command runs Windows PowerShell 5.1. Look before you change things: inspect with \
read-only commands first, then act. Use absolute paths and quote paths with spaces. Check the exit code \
and output of every command; if one fails, read the error and fix the command instead of guessing. Do \
only what the task needs."
                .to_string(),
        );
    }
    if apps {
        parts.push(
            "open_app opens apps, files, folders and links. It can't click inside apps; for that, use \
run_command (e.g. PowerShell) where possible."
                .to_string(),
        );
    }
    parts.join("\n")
}

/// Commands that always need the user's OK, even with full permission:
/// they can wreck the system or lose data for good.
pub fn is_critical(command: &str) -> bool {
    let c = command.to_ascii_lowercase();
    const PATTERNS: &[&str] = &[
        "format-volume",
        "format ",
        "diskpart",
        "clear-disk",
        "initialize-disk",
        "remove-partition",
        "bcdedit",
        "reg delete hklm",
        "remove-item hklm:",
        "remove-itemproperty hklm:",
        "stop-computer",
        "restart-computer",
        "shutdown",
        "vssadmin delete",
        "cipher /w",
        "set-executionpolicy",
        "\\windows\\system32",
        "c:\\windows",
        "$env:windir",
    ];
    if PATTERNS.iter().any(|p| c.contains(p)) {
        return true;
    }
    // Recursively deleting a whole drive or the user folder.
    let deleting = c.contains("remove-item")
        || c.contains(" rm ")
        || c.starts_with("rm ")
        || c.contains("rd /s")
        || c.contains("rmdir");
    deleting
        && (c.contains("-recurse") || c.contains("/s"))
        && [
            " c:\\ ",
            " c:\\\"",
            "'c:\\'",
            "\"c:\\\"",
            " c:\\*",
            "$home ",
            "$home\"",
            "$env:userprofile ",
        ]
        .iter()
        .any(|p| c.contains(p) || c.ends_with(p.trim_end()))
}

/// Waits for the user's decision unless the permission mode allows it.
async fn approve(
    state: &AppState,
    ctx: &ToolCtx<'_>,
    activity: &mut ToolActivity,
    critical: bool,
) -> bool {
    let full =
        ctx.in_zap && db::get_settings(&state.db()).is_ok_and(|s| s.zap_permission == "full");
    if !critical && (full || lock(&state.chat_grants).contains(ctx.chat_id)) {
        return true;
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    lock(&state.approvals).insert(activity.id.clone(), tx);
    activity.status = "pending".into();
    if critical {
        activity.detail = Some("critical".into());
    }
    ctx.emit(activity);
    let decision = tokio::select! {
        _ = ctx.cancel.cancelled() => None,
        d = rx => d.ok(),
    };
    lock(&state.approvals).remove(&activity.id);
    activity.status = "running".into();
    match decision {
        Some(Decision::Allow) => true,
        // "Allow all" never covers critical commands.
        Some(Decision::AllowChat) => {
            lock(&state.chat_grants).insert(ctx.chat_id.to_string());
            true
        }
        _ => false,
    }
}

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(crate::ollama::CREATE_NO_WINDOW);
    cmd
}

/// Keeps the start and the end of long output.
pub fn truncate_output(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max * 2 / 3).collect();
    let tail: String = text.chars().skip(count - max / 3).collect();
    format!(
        "{head}\n… [{} characters cut] …\n{tail}",
        count - head.chars().count() - tail.chars().count()
    )
}

/// Ends PowerShell and everything it started.
fn kill_tree(pid: u32) {
    let mut cmd = std::process::Command::new("taskkill");
    cmd.args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::ollama::CREATE_NO_WINDOW);
    }
    let _ = cmd.status();
}

pub struct CommandResult {
    pub exit_code: Option<i32>,
    pub output: String,
    pub timed_out: bool,
}

/// Runs one PowerShell command with a timeout; stops it on cancel.
pub async fn run_powershell(
    command: &str,
    cwd: &std::path::Path,
    timeout: Duration,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<CommandResult, String> {
    let script = format!(
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; {command}"
    );
    let mut child = hidden(
        Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true),
    )
    .spawn()
    .map_err(|_| "spawn_failed".to_string())?;
    let pid = child.id();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let read_all = async {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let o = async {
            if let Some(s) = stdout.as_mut() {
                let _ = s.read_to_end(&mut out).await;
            }
        };
        let e = async {
            if let Some(s) = stderr.as_mut() {
                let _ = s.read_to_end(&mut err).await;
            }
        };
        tokio::join!(o, e);
        let status = child.wait().await.ok();
        (out, err, status)
    };
    tokio::select! {
        (out, err, status) = read_all => {
            let mut text = String::from_utf8_lossy(&out).trim_end().to_string();
            let err = String::from_utf8_lossy(&err).trim_end().to_string();
            if !err.is_empty() {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str("[stderr]\n");
                text.push_str(&err);
            }
            Ok(CommandResult { exit_code: status.and_then(|s| s.code()), output: text, timed_out: false })
        }
        _ = tokio::time::sleep(timeout) => {
            if let Some(pid) = pid {
                kill_tree(pid);
            }
            Ok(CommandResult { exit_code: None, output: String::new(), timed_out: true })
        }
        _ = cancel.cancelled() => {
            if let Some(pid) = pid {
                kill_tree(pid);
            }
            Err("cancelled".into())
        }
    }
}

/// Runs a system tool call. Returns the activity for the UI and the text for the model.
pub async fn run(
    state: &AppState,
    ctx: &ToolCtx<'_>,
    call: &ToolCall,
    mut activity: ToolActivity,
) -> (ToolActivity, String) {
    match call.name.as_str() {
        RUN => {
            let command = call.arguments["command"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string();
            if command.is_empty() {
                return (activity.failed("failed"), "Error: missing command.".into());
            }
            activity.input = command.clone();
            activity.preview = Some(command.clone());
            if !approve(state, ctx, &mut activity, is_critical(&command)).await {
                activity.status = "denied".into();
                return (
                    activity,
                    "The user did not allow this command. Don't retry it; continue without it or explain what you need.".into(),
                );
            }
            ctx.emit(&activity);
            let cwd = call.arguments["working_directory"]
                .as_str()
                .map(std::path::PathBuf::from)
                .filter(|p| p.is_dir())
                .or_else(dirs::home_dir)
                .unwrap_or_else(|| std::path::PathBuf::from("C:\\"));
            let secs = call.arguments["timeout_seconds"]
                .as_u64()
                .unwrap_or(DEFAULT_TIMEOUT)
                .clamp(1, MAX_TIMEOUT);
            match run_powershell(&command, &cwd, Duration::from_secs(secs), ctx.cancel).await {
                Ok(r) if r.timed_out => {
                    activity.preview = Some(format!("PS> {command}\n\n(timed out after {secs} s)"));
                    (
                        activity.failed("timeout"),
                        format!(
                            "Error: the command did not finish within {secs} s and was stopped."
                        ),
                    )
                }
                Ok(r) => {
                    let output = truncate_output(&r.output, MAX_OUTPUT_CHARS);
                    let code = r.exit_code.unwrap_or(-1);
                    activity.detail = Some(format!("exit:{code}"));
                    activity.preview = Some(format!(
                        "PS> {command}\n\n{}",
                        truncate_output(&r.output, 4000)
                    ));
                    let text = format!(
                        "Exit code: {code}\n{}",
                        if output.is_empty() {
                            "(no output)".to_string()
                        } else {
                            output
                        }
                    );
                    let activity = if code == 0 {
                        activity.done(Vec::new())
                    } else {
                        activity.failed("exit_code")
                    };
                    (activity, text)
                }
                Err(e) if e == "cancelled" => {
                    (activity.failed("cancelled"), "Error: cancelled.".into())
                }
                Err(_) => (
                    activity.failed("failed"),
                    "Error: PowerShell could not be started.".into(),
                ),
            }
        }
        OPEN => {
            let target = call.arguments["target"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string();
            if target.is_empty() {
                return (activity.failed("failed"), "Error: missing target.".into());
            }
            let args = call.arguments["arguments"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string();
            activity.input = target.clone();
            activity.preview = Some(if args.is_empty() {
                target.clone()
            } else {
                format!("{target} {args}")
            });
            if !approve(state, ctx, &mut activity, false).await {
                activity.status = "denied".into();
                return (activity, "The user did not allow opening this.".into());
            }
            ctx.emit(&activity);
            let quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
            let mut ps = format!("Start-Process -FilePath {}", quote(&target));
            if !args.is_empty() {
                ps.push_str(&format!(" -ArgumentList {}", quote(&args)));
            }
            let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("C:\\"));
            match run_powershell(&ps, &home, Duration::from_secs(20), ctx.cancel).await {
                Ok(r) if r.exit_code == Some(0) => {
                    (activity.done(Vec::new()), format!("Opened {target}."))
                }
                Ok(r) => (
                    activity.failed("open_failed"),
                    format!(
                        "Error: could not open {target}. {}",
                        truncate_output(&r.output, 600)
                    ),
                ),
                Err(_) => (
                    activity.failed("open_failed"),
                    format!("Error: could not open {target}."),
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
    fn spots_destructive_commands() {
        assert!(is_critical("Format-Volume -DriveLetter D"));
        assert!(is_critical("Remove-Item C:\\Windows\\Temp\\x -Recurse"));
        assert!(is_critical("Stop-Computer -Force"));
        assert!(is_critical("Remove-Item -Recurse -Force C:\\"));
        assert!(is_critical("rd /s /q C:\\"));
        assert!(!is_critical("Get-ChildItem $HOME\\Downloads"));
        assert!(!is_critical("Remove-Item \"$HOME\\Downloads\\old.zip\""));
        assert!(!is_critical("Move-Item a.txt b.txt"));
    }

    #[test]
    fn keeps_start_and_end_of_long_output() {
        let text = format!("{}{}", "a".repeat(100), "z".repeat(100));
        let out = truncate_output(&text, 60);
        assert!(out.starts_with("aaaa") && out.ends_with("zzzz") && out.contains("cut"));
        assert_eq!(truncate_output("short", 60), "short");
    }

    #[tokio::test]
    async fn runs_powershell_with_exit_code_and_timeout() {
        let cancel = tokio_util::sync::CancellationToken::new();
        let home = std::env::temp_dir();
        let ok = run_powershell(
            "Write-Output 'Hallo ZAP'; exit 3",
            &home,
            Duration::from_secs(30),
            &cancel,
        )
        .await
        .unwrap();
        assert_eq!(ok.exit_code, Some(3));
        assert!(ok.output.contains("Hallo ZAP"), "{}", ok.output);

        let err = run_powershell(
            "Write-Error 'kaputt'",
            &home,
            Duration::from_secs(30),
            &cancel,
        )
        .await
        .unwrap();
        assert!(err.output.contains("[stderr]") && err.output.contains("kaputt"));

        let slow = run_powershell(
            "Start-Sleep -Seconds 20",
            &home,
            Duration::from_secs(2),
            &cancel,
        )
        .await
        .unwrap();
        assert!(slow.timed_out);
    }
}
