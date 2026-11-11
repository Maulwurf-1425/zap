//! Versions of the helper apps (Ollama, LM Studio, Docker Desktop) for the
//! About page, and whether a newer one is out (looked up with winget, which
//! knows the official releases). ZAP doesn't update these apps itself; the
//! user does it in the app, so About offers to open it.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::{docker, lmstudio, ollama};

/// Latest versions change rarely; ask winget at most every few hours.
const LATEST_TTL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tool {
    Ollama,
    Lmstudio,
    Docker,
}

impl Tool {
    const ALL: [Tool; 3] = [Tool::Ollama, Tool::Lmstudio, Tool::Docker];

    fn winget_id(self) -> &'static str {
        match self {
            Tool::Ollama => "Ollama.Ollama",
            Tool::Lmstudio => "ElementLabs.LMStudio",
            Tool::Docker => "Docker.DockerDesktop",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolVersion {
    pub tool: Tool,
    /// `None` when the app isn't installed (or its version can't be read).
    pub installed: Option<String>,
    /// Newest release known to winget; `None` if that couldn't be checked.
    pub latest: Option<String>,
    pub update_available: bool,
    /// ZAP can open the app (where updates are done).
    pub can_open: bool,
}

/// Latest version per tool, with when it was looked up.
type LatestCache = Option<(Instant, Vec<(Tool, Option<String>)>)>;

static LATEST: Mutex<LatestCache> = Mutex::new(None);

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::ollama::CREATE_NO_WINDOW);
    }
    cmd.stdin(Stdio::null()).stderr(Stdio::null())
}

fn ollama_app() -> Option<PathBuf> {
    let exe = PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
        .join("Programs")
        .join("Ollama")
        .join("ollama app.exe");
    exe.is_file().then_some(exe)
}

/// "FileVersion" of Windows executables, read with one PowerShell call.
fn file_versions(paths: &[&Path]) -> Vec<Option<String>> {
    if paths.is_empty() {
        return Vec::new();
    }
    let script = paths
        .iter()
        .map(|p| {
            format!(
                "(Get-Item -LiteralPath '{}').VersionInfo.FileVersion",
                p.display().to_string().replace('\'', "''")
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    let out = hidden(Command::new("powershell").args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &script,
    ]))
    .output();
    let text = out
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let mut lines = text.lines().map(str::trim);
    paths
        .iter()
        .map(|_| lines.next().filter(|l| !l.is_empty()).map(str::to_string))
        .collect()
}

/// Docker Desktop's file version has a build number ("4.98.0.245422");
/// releases are named by the first three parts.
fn short_version(v: &str) -> String {
    v.split('.').take(3).collect::<Vec<_>>().join(".")
}

/// The "Version:" line of `winget show` (same label in English and German).
pub fn parse_winget_version(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("Version:")?;
        let v = rest.trim();
        (!v.is_empty() && v.chars().next().is_some_and(|c| c.is_ascii_digit()))
            .then(|| v.to_string())
    })
}

fn winget_latest(tool: Tool) -> Option<String> {
    let out = hidden(Command::new("winget").args([
        "show",
        "--id",
        tool.winget_id(),
        "--exact",
        "--source",
        "winget",
        "--accept-source-agreements",
        "--disable-interactivity",
    ]))
    .output()
    .ok()?;
    parse_winget_version(&String::from_utf8_lossy(&out.stdout))
}

/// Numeric parts of a version ("0.4.26+4" → [0, 4, 26, 4]).
fn parts(v: &str) -> Vec<u64> {
    v.split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect()
}

/// Whether `latest` is newer than `installed` (missing parts count as 0).
pub fn is_newer(latest: &str, installed: &str) -> bool {
    let (a, b) = (parts(latest), parts(installed));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
}

async fn installed_versions(state: &AppState) -> [(Tool, Option<String>); 3] {
    let ollama_api = ollama::version(&state.http).await;
    let (lm, dd) = tauri::async_runtime::spawn_blocking(|| {
        let lm = lmstudio::app_exe();
        let dd = docker::desktop_exe();
        let paths: Vec<&Path> = [lm.as_deref(), dd.as_deref()]
            .into_iter()
            .flatten()
            .collect();
        let mut found = file_versions(&paths).into_iter();
        let lm_v = lm.as_ref().and_then(|_| found.next().flatten());
        let dd_v = dd
            .as_ref()
            .and_then(|_| found.next().flatten())
            .map(|v| short_version(&v));
        (lm_v, dd_v)
    })
    .await
    .unwrap_or((None, None));
    let ollama = match ollama_api {
        Some(v) => Some(v),
        // Ollama not running: ask the CLI ("ollama version is 0.40.16").
        None => tauri::async_runtime::spawn_blocking(|| {
            let exe = ollama::find_executable()?;
            let out = hidden(Command::new(exe).arg("--version")).output().ok()?;
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.split_whitespace()
                .last()
                .filter(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit()))
                .map(str::to_string)
        })
        .await
        .ok()
        .flatten(),
    };
    [
        (Tool::Ollama, ollama),
        (Tool::Lmstudio, lm),
        (Tool::Docker, dd),
    ]
}

async fn latest_versions(refresh: bool) -> Vec<(Tool, Option<String>)> {
    if !refresh {
        if let Some((at, cached)) = LATEST.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            if at.elapsed() < LATEST_TTL {
                return cached.clone();
            }
        }
    }
    let handles: Vec<_> = Tool::ALL
        .iter()
        .map(|&tool| tauri::async_runtime::spawn_blocking(move || (tool, winget_latest(tool))))
        .collect();
    let mut found = Vec::new();
    for h in handles {
        if let Ok(pair) = h.await {
            found.push(pair);
        }
    }
    // Only cache a useful answer (winget missing or offline: try again later).
    if found.iter().any(|(_, v)| v.is_some()) {
        *LATEST.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), found.clone()));
    }
    found
}

/// Installed and latest versions of Ollama, LM Studio and Docker Desktop.
/// `check_updates` false skips the (slower) winget lookup.
#[tauri::command]
pub async fn tool_versions(
    state: State<'_, AppState>,
    check_updates: bool,
    refresh: Option<bool>,
) -> AppResult<Vec<ToolVersion>> {
    let installed = installed_versions(&state).await;
    let latest = if check_updates {
        latest_versions(refresh.unwrap_or(false)).await
    } else {
        Vec::new()
    };
    Ok(installed
        .into_iter()
        .map(|(tool, installed)| {
            let latest = latest
                .iter()
                .find(|(t, _)| *t == tool)
                .and_then(|(_, v)| v.clone());
            let update_available =
                matches!((&latest, &installed), (Some(l), Some(i)) if is_newer(l, i));
            let can_open = match tool {
                Tool::Ollama => ollama_app().is_some(),
                Tool::Lmstudio => lmstudio::app_exe().is_some(),
                Tool::Docker => docker::desktop_exe().is_some(),
            };
            ToolVersion {
                tool,
                installed,
                latest,
                update_available,
                can_open,
            }
        })
        .collect())
}

/// Opens the app so the user can update it there.
#[tauri::command]
pub fn open_tool(tool: Tool) -> AppResult<()> {
    let exe = match tool {
        Tool::Ollama => ollama_app(),
        Tool::Lmstudio => lmstudio::app_exe(),
        Tool::Docker => docker::desktop_exe(),
    }
    .ok_or_else(|| AppError::Other("not_installed".into()))?;
    Command::new(exe)
        .spawn()
        .map(|_| ())
        .map_err(|_| AppError::Other("open_failed".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert!(is_newer("0.4.28+2", "0.4.26+4"));
        assert!(is_newer("4.99.0", "4.98.0"));
        assert!(!is_newer("0.40.16", "0.40.16"));
        assert!(!is_newer("4.98", "4.98.0"));
        assert!(is_newer("0.41.0", "0.40.16"));
        assert!(!is_newer("0.4.26", "0.4.26+4"));
    }

    #[test]
    fn reads_winget_and_file_versions() {
        let out =
            "Found LM Studio [ElementLabs.LMStudio]\nVersion: 0.4.28+2\nPublisher: LM Studio\n";
        assert_eq!(parse_winget_version(out).as_deref(), Some("0.4.28+2"));
        assert_eq!(
            parse_winget_version("Gefunden Docker\n  Version: 4.99.0\n").as_deref(),
            Some("4.99.0")
        );
        assert_eq!(parse_winget_version("No package found"), None);
        assert_eq!(short_version("4.98.0.245422"), "4.98.0");
    }
}
