//! Installs Ollama or LM Studio through winget (Windows Package Manager).
//! winget downloads the official installer and checks its hash before running
//! it, so ZAP never executes an unverified download itself.

use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::provider::ProviderKind;

/// winget exit codes that mean the engine is there after all (count as success):
/// already installed, and installed with no newer version to upgrade to.
const ALREADY_INSTALLED: i32 = 0x8A15_0061_u32 as i32;
const NO_UPGRADE: i32 = 0x8A15_002B_u32 as i32;

fn package_id(kind: ProviderKind) -> &'static str {
    match kind {
        ProviderKind::Ollama => "Ollama.Ollama",
        ProviderKind::Lmstudio => "ElementLabs.LMStudio",
    }
}

fn winget() -> Command {
    let mut cmd = Command::new("winget");
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(crate::ollama::CREATE_NO_WINDOW);
    cmd
}

/// Whether winget is available (it ships with Windows 11 and current Windows 10).
pub async fn available() -> bool {
    winget()
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .is_ok_and(|s| s.success())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Preparing,
    Downloading,
    Installing,
    /// Installed; ZAP is starting the engine (LM Studio: first launch).
    Starting,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallEvent {
    pub provider: ProviderKind,
    pub phase: Phase,
    /// Bytes downloaded so far and the installer's size, while downloading.
    pub downloaded: Option<u64>,
    pub total: Option<u64>,
}

pub fn emit(
    app: &AppHandle,
    provider: ProviderKind,
    phase: Phase,
    downloaded: Option<u64>,
    total: Option<u64>,
) {
    let _ = app.emit(
        "engine://install",
        InstallEvent {
            provider,
            phase,
            downloaded,
            total,
        },
    );
}

/// Size of the installer winget is downloading: the newest file in
/// `%TEMP%\WinGet\<package id>.<version>\` (winget's download folder).
fn downloaded_bytes(kind: ProviderKind) -> Option<u64> {
    let root = std::env::temp_dir().join("WinGet");
    let prefix = format!("{}.", package_id(kind));
    std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter(|d| d.file_name().to_string_lossy().starts_with(&prefix))
        .filter_map(|d| std::fs::read_dir(d.path()).ok())
        .flatten()
        .flatten()
        .filter_map(|f| f.metadata().ok())
        .filter(|m| m.is_file())
        // The file being written, not a leftover from an earlier attempt.
        .max_by_key(|m| m.modified().ok())
        .map(|m| m.len())
}

/// Installer size from the server (HEAD, following redirects).
async fn remote_size(url: &str) -> Option<u64> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .ok()?;
    let res = client.head(url).send().await.ok()?;
    res.status()
        .is_success()
        .then(|| res.content_length())
        .flatten()
        .filter(|n| *n > 0)
}

/// Reports real download progress while `active` is set: winget's own
/// progress bar is missing when its output is piped.
fn watch_download(app: AppHandle, kind: ProviderKind, url: String, active: Arc<AtomicBool>) {
    tauri::async_runtime::spawn(async move {
        let total = remote_size(&url).await;
        while active.load(Ordering::Relaxed) {
            let downloaded = downloaded_bytes(kind);
            if !active.load(Ordering::Relaxed) {
                break;
            }
            emit(&app, kind, Phase::Downloading, downloaded, total);
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    });
}

fn to_bytes(value: f64, unit: &str) -> f64 {
    let factor = match unit.to_ascii_uppercase().as_str() {
        "KB" => 1024.0,
        "MB" => 1024.0 * 1024.0,
        "GB" => 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };
    value * factor
}

/// Reads "12.3 MB / 1.10 GB" (winget's progress line, same in every language)
/// and returns the fraction done.
pub fn parse_progress(line: &str) -> Option<f32> {
    let (left, right) = line.split_once(" / ")?;
    let mut done = left.split_whitespace().rev();
    let done_unit = done.next()?;
    let done_value: f64 = done.next()?.replace(',', ".").parse().ok()?;
    let mut total = right.split_whitespace();
    let total_value: f64 = total.next()?.replace(',', ".").parse().ok()?;
    let total_unit = total.next()?;
    let total_bytes = to_bytes(total_value, total_unit);
    (total_bytes > 0.0).then(|| (to_bytes(done_value, done_unit) / total_bytes).min(1.0) as f32)
}

/// Phase change for one line of winget output. winget's texts are localized,
/// so this only looks at the download URL line, progress sizes and line order:
/// after the URL comes the download, and the next text line (the hash check)
/// starts the install. Piped output usually has no progress bar at all.
pub fn next_phase(phase: &Phase, line: &str) -> Option<(Phase, Option<f32>)> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    match phase {
        Phase::Preparing | Phase::Downloading => {
            if let Some(p) = parse_progress(line) {
                return Some((Phase::Downloading, Some(p)));
            }
            if line.contains("https://") {
                return Some((Phase::Downloading, None));
            }
            (*phase == Phase::Downloading).then_some((Phase::Installing, None))
        }
        _ => None,
    }
}

/// Runs `winget install` for the engine and reports progress as
/// `engine://install` events. Returns whether the install succeeded.
pub async fn install(app: &AppHandle, kind: ProviderKind) -> bool {
    let send = |phase: Phase| emit(app, kind, phase, None, None);
    send(Phase::Preparing);
    let downloading = Arc::new(AtomicBool::new(false));

    let child = winget()
        .args([
            "install",
            "--id",
            package_id(kind),
            "--exact",
            "--source",
            "winget",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--disable-interactivity",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        send(Phase::Failed);
        return false;
    };

    // A progress bar (if any) is redrawn with '\r', so split on both line ends.
    if let Some(mut out) = child.stdout.take() {
        let mut buf = [0u8; 4096];
        let mut line = Vec::new();
        let mut phase = Phase::Preparing;
        while let Ok(n) = out.read(&mut buf).await {
            if n == 0 {
                break;
            }
            for &b in &buf[..n] {
                if b != b'\r' && b != b'\n' {
                    line.push(b);
                    continue;
                }
                let text = String::from_utf8_lossy(&line);
                if let Some((next, _)) = next_phase(&phase, &text) {
                    if next == Phase::Downloading && phase == Phase::Preparing {
                        // First download line: start measuring the file.
                        if let Some(url) =
                            text.split_whitespace().find(|w| w.starts_with("https://"))
                        {
                            downloading.store(true, Ordering::Relaxed);
                            watch_download(app.clone(), kind, url.to_string(), downloading.clone());
                        }
                        send(Phase::Downloading);
                    } else if next == Phase::Installing {
                        downloading.store(false, Ordering::Relaxed);
                        send(Phase::Installing);
                    }
                    phase = next;
                }
                line.clear();
            }
        }
    }

    let ok = child
        .wait()
        .await
        .is_ok_and(|s| s.success() || matches!(s.code(), Some(ALREADY_INSTALLED | NO_UPGRADE)));
    downloading.store(false, Ordering::Relaxed);
    // On success the caller reports Starting / Done once the engine is up.
    send(if ok { Phase::Starting } else { Phase::Failed });
    ok
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_winget_progress() {
        let line = "  ██████████▒▒▒▒▒▒▒▒▒▒  512 MB / 1.00 GB";
        assert!((parse_progress(line).unwrap() - 0.5).abs() < 0.01);
        assert_eq!(parse_progress("  1,5 KB / 3 KB"), Some(0.5));
        assert_eq!(parse_progress("  2.0 GB / 1.0 GB"), Some(1.0));
        assert_eq!(parse_progress("Downloading https://ollama.com/x.exe"), None);
        assert_eq!(parse_progress("Found Ollama [Ollama.Ollama]"), None);
    }

    #[test]
    fn follows_winget_output_in_any_language() {
        // Real piped output (no progress bar); German texts behave the same.
        let lines = [
            "Gefunden Ollama [Ollama.Ollama] Version 0.40.15",
            "Diese Anwendung wird von ihrem Besitzer an Sie lizenziert.",
            "",
            "Wird heruntergeladen https://ollama.com/download/OllamaSetup.exe",
            "  ██████  50 MB / 100 MB",
            "Der Installer-Hash wurde erfolgreich überprüft",
            "Paketinstallation wird gestartet...",
            "Erfolgreich installiert",
        ];
        let mut phase = Phase::Preparing;
        let mut seen = Vec::new();
        for line in lines {
            if let Some((next, progress)) = next_phase(&phase, line) {
                seen.push((next.clone(), progress));
                phase = next;
            }
        }
        assert_eq!(
            seen,
            vec![
                (Phase::Downloading, None),
                (Phase::Downloading, Some(0.5)),
                (Phase::Installing, None),
            ]
        );
    }
}
