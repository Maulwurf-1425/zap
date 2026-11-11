//! Docker Desktop and the local SearXNG container (`zap-searxng`).

use std::path::PathBuf;
use std::time::{Duration, Instant};

pub const SEARXNG_CONTAINER: &str = "zap-searxng";

/// Runs the docker CLI hidden.
pub fn docker(args: &[&str]) -> std::io::Result<std::process::Output> {
    let mut cmd = std::process::Command::new("docker");
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::ollama::CREATE_NO_WINDOW);
    }
    cmd.output()
}

pub fn desktop_exe() -> Option<PathBuf> {
    let program_files = std::env::var_os("ProgramFiles")?;
    let exe = PathBuf::from(program_files)
        .join("Docker")
        .join("Docker")
        .join("Docker Desktop.exe");
    exe.is_file().then_some(exe)
}

/// What stands between ZAP and a running SearXNG.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DockerState {
    /// Neither Docker Desktop nor the docker CLI is installed.
    Missing,
    /// Installed, but the Docker engine isn't running.
    Stopped,
    /// Docker runs; the SearXNG container is stopped or still starting.
    Running,
}

impl DockerState {
    pub fn code(self) -> &'static str {
        match self {
            DockerState::Missing => "missing",
            DockerState::Stopped => "stopped",
            DockerState::Running => "running",
        }
    }
}

fn engine_running() -> bool {
    docker(&["version", "--format", "{{.Server.Version}}"]).is_ok_and(|o| o.status.success())
}

pub async fn state() -> DockerState {
    tauri::async_runtime::spawn_blocking(|| {
        if engine_running() {
            DockerState::Running
        } else if desktop_exe().is_some() || docker(&["--version"]).is_ok() {
            DockerState::Stopped
        } else {
            DockerState::Missing
        }
    })
    .await
    .unwrap_or(DockerState::Missing)
}

/// The SearXNG container as the settings show it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContainerState {
    /// Docker isn't installed.
    DockerMissing,
    /// Docker is installed but its engine isn't running.
    DockerStopped,
    /// Docker runs, but ZAP's SearXNG container doesn't exist (not set up).
    Missing,
    Stopped,
    Running,
}

pub async fn container_state() -> ContainerState {
    match state().await {
        DockerState::Missing => ContainerState::DockerMissing,
        DockerState::Stopped => ContainerState::DockerStopped,
        DockerState::Running => tauri::async_runtime::spawn_blocking(|| {
            match docker(&["inspect", "-f", "{{.State.Running}}", SEARXNG_CONTAINER]) {
                Ok(out) if out.status.success() => {
                    if String::from_utf8_lossy(&out.stdout).trim() == "true" {
                        ContainerState::Running
                    } else {
                        ContainerState::Stopped
                    }
                }
                _ => ContainerState::Missing,
            }
        })
        .await
        .unwrap_or(ContainerState::Missing),
    }
}

/// Runs `docker <action> zap-searxng` ("stop" | "restart").
pub async fn container_command(action: &'static str) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        docker(&[action, SEARXNG_CONTAINER]).is_ok_and(|o| o.status.success())
    })
    .await
    .unwrap_or(false)
}

/// Waits up to `secs` until SearXNG answers.
pub async fn wait_until_up(http: &reqwest::Client, url: &str, secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if searxng_up(http, url).await {
            return true;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    false
}

pub async fn searxng_up(http: &reqwest::Client, url: &str) -> bool {
    http.get(format!("{}/search", url.trim_end_matches('/')))
        .query(&[("q", "test"), ("format", "json")])
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}

/// Starting progress for the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartStep {
    Docker,
    Searxng,
}

/// Starts Docker Desktop if needed, then the SearXNG container, and waits
/// up to two minutes until SearXNG answers. `on_step` reports progress.
pub async fn start_searxng(
    http: &reqwest::Client,
    url: &str,
    cancel: &tokio_util::sync::CancellationToken,
    mut on_step: impl FnMut(StartStep),
) -> bool {
    let deadline = Instant::now() + Duration::from_secs(120);
    let blocking = |f: fn() -> bool| async move {
        tauri::async_runtime::spawn_blocking(f)
            .await
            .unwrap_or(false)
    };

    if !blocking(engine_running).await {
        on_step(StartStep::Docker);
        let Some(exe) = desktop_exe() else {
            return false;
        };
        if std::process::Command::new(exe).spawn().is_err() {
            return false;
        }
        while !blocking(engine_running).await {
            if Instant::now() > deadline || cancel.is_cancelled() {
                return false;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    on_step(StartStep::Searxng);
    // The container has restart=unless-stopped, but start it in case it was stopped.
    let _ =
        blocking(|| docker(&["start", SEARXNG_CONTAINER]).is_ok_and(|o| o.status.success())).await;
    while !searxng_up(http, url).await {
        if Instant::now() > deadline || cancel.is_cancelled() {
            return false;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs Docker with a `zap-searxng` container on port 8888:
    /// `cargo test live_searxng_restart -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_searxng_restart() {
        let http = reqwest::Client::new();
        let url = "http://127.0.0.1:8888";
        assert!(docker(&["stop", SEARXNG_CONTAINER])
            .unwrap()
            .status
            .success());
        assert!(!searxng_up(&http, url).await, "container should be down");
        assert_eq!(state().await, DockerState::Running);

        let mut steps = Vec::new();
        let cancel = tokio_util::sync::CancellationToken::new();
        let started = Instant::now();
        assert!(start_searxng(&http, url, &cancel, |s| steps.push(s)).await);
        println!(
            "SearXNG back after {:?}, steps {steps:?}",
            started.elapsed()
        );
        assert_eq!(steps, vec![StartStep::Searxng]);
        assert!(searxng_up(&http, url).await);
    }
}
