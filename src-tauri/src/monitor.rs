//! Resource monitor (F5 overlay): CPU, RAM and GPU of everything that
//! belongs to ZAP — the app with its WebView and helper processes, Ollama,
//! LM Studio and the SearXNG container — plus live token numbers.
//!
//! CPU and RAM come from `sysinfo`; GPU load and video memory per process
//! from the Windows performance counters (the numbers Task Manager shows),
//! so it works for every GPU vendor.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Manager, State};

use crate::docker::{docker, SEARXNG_CONTAINER};
use crate::error::AppResult;
use crate::provider::{model_key, parse_model_key, ProviderKind, ProviderStatus};
use crate::state::{lock, AppState};
use crate::{lmstudio, ollama};

/// Docker is slow to ask (1–2 s), so its numbers are refreshed in the
/// background at most this often.
const DOCKER_EVERY: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Group {
    Zap,
    Ollama,
    Lmstudio,
    Searxng,
}

#[derive(Debug, Clone, Serialize)]
pub struct GroupUsage {
    pub group: Group,
    /// Share of the whole machine (all cores), 0–100.
    pub cpu: f32,
    /// Working set in bytes.
    pub memory: u64,
    /// GPU load 0–100, `None` when unknown.
    pub gpu: Option<f32>,
    /// Dedicated video memory in bytes, `None` when unknown.
    pub vram: Option<u64>,
    pub processes: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemUsage {
    pub cpu: f32,
    pub memory_used: u64,
    pub memory_total: u64,
    pub gpu: Option<f32>,
    pub vram_used: Option<u64>,
    pub cores: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct TokenUsage {
    /// Replies and ZAP runs streaming right now.
    pub active: u32,
    /// Of those, ZAP runs.
    pub zap_runs: u32,
    /// Output tokens per second right now (text and thinking).
    pub per_sec: f64,
    /// Since ZAP started (server numbers of finished model turns).
    pub session_prompt: u64,
    pub session_output: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Usage {
    pub groups: Vec<GroupUsage>,
    pub system: SystemUsage,
    pub tokens: TokenUsage,
}

#[derive(Debug, Clone, Copy, Default)]
struct DockerUsage {
    cpu: f32,
    memory: u64,
}

struct Monitor {
    sys: System,
    gpu: Option<gpu::Counters>,
    last_pieces: u64,
    last_at: Instant,
    docker: Option<DockerUsage>,
    docker_at: Option<Instant>,
    docker_busy: bool,
}

static MONITOR: OnceLock<Mutex<Monitor>> = OnceLock::new();

fn monitor() -> &'static Mutex<Monitor> {
    MONITOR.get_or_init(|| {
        Mutex::new(Monitor {
            sys: System::new(),
            gpu: gpu::Counters::open(),
            last_pieces: 0,
            last_at: Instant::now(),
            docker: None,
            docker_at: None,
            docker_busy: false,
        })
    })
}

/// Which group a process belongs to, by its own name or its ancestors.
fn classify(pid: u32, procs: &HashMap<u32, (Option<u32>, String)>, own: u32) -> Option<Group> {
    let mut current = pid;
    // Parent chains can loop when Windows reuses process ids.
    for _ in 0..32 {
        let (parent, name) = procs.get(&current)?;
        if name.starts_with("ollama") {
            return Some(Group::Ollama);
        }
        if name.starts_with("lm studio") || name == "lms.exe" {
            return Some(Group::Lmstudio);
        }
        if current == own {
            return Some(Group::Zap);
        }
        current = (*parent)?;
    }
    None
}

/// Parses "12.5%" and "1.2GiB / 15.5GiB" from `docker stats`.
fn parse_docker(line: &str) -> Option<DockerUsage> {
    let (cpu, mem) = line.trim().split_once('|')?;
    let cpu = cpu.trim().trim_end_matches('%').parse::<f32>().ok()?;
    let used = mem.split('/').next()?.trim();
    let split = used
        .find(|c: char| c.is_ascii_alphabetic())
        .unwrap_or(used.len());
    let (num, unit) = used.split_at(split);
    let num: f64 = num.trim().parse().ok()?;
    let factor = match unit.trim() {
        "B" => 1.0,
        "KiB" | "kB" | "KB" => 1024.0,
        "MiB" | "MB" => 1024.0 * 1024.0,
        "GiB" | "GB" => 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some(DockerUsage {
        cpu,
        memory: (num * factor) as u64,
    })
}

fn refresh_docker() -> Option<DockerUsage> {
    let out = docker(&[
        "stats",
        "--no-stream",
        "--format",
        "{{.CPUPerc}}|{{.MemUsage}}",
        SEARXNG_CONTAINER,
    ])
    .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_docker(String::from_utf8_lossy(&out.stdout).lines().next()?)
}

fn sample(state: &AppState) -> Usage {
    let mut m = lock(monitor());
    let m = &mut *m;
    m.sys.refresh_cpu_usage();
    m.sys.refresh_memory();
    m.sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cpu().with_memory(),
    );
    let cores = m.sys.cpus().len().max(1) as u32;

    let procs: HashMap<u32, (Option<u32>, String)> = m
        .sys
        .processes()
        .iter()
        .map(|(pid, p)| {
            (
                pid.as_u32(),
                (
                    p.parent().map(Pid::as_u32),
                    p.name().to_string_lossy().to_lowercase(),
                ),
            )
        })
        .collect();
    let own = std::process::id();
    let gpu = m.gpu.as_mut().map(gpu::Counters::sample);

    let mut groups: HashMap<Group, GroupUsage> = HashMap::new();
    for (pid, p) in m.sys.processes() {
        let pid = pid.as_u32();
        let Some(group) = classify(pid, &procs, own) else {
            continue;
        };
        let g = groups.entry(group).or_insert_with(|| GroupUsage {
            group,
            cpu: 0.0,
            memory: 0,
            gpu: gpu.as_ref().map(|_| 0.0),
            vram: gpu.as_ref().map(|_| 0),
            processes: 0,
        });
        g.cpu += p.cpu_usage() / cores as f32;
        g.memory += p.memory();
        g.processes += 1;
        if let Some(sample) = &gpu {
            if let Some(v) = sample.vram.get(&pid) {
                g.vram = Some(g.vram.unwrap_or(0) + v);
            }
        }
    }
    // GPU load per group: per engine type, sum the group's processes, then
    // take the busiest engine type (like Task Manager).
    if let Some(sample) = &gpu {
        let mut per_group: HashMap<Group, HashMap<&str, f64>> = HashMap::new();
        for (pid, engines) in &sample.load {
            if let Some(group) = classify(*pid, &procs, own) {
                let entry = per_group.entry(group).or_default();
                for (engine, value) in engines {
                    *entry.entry(engine.as_str()).or_default() += value;
                }
            }
        }
        for (group, engines) in per_group {
            if let Some(g) = groups.get_mut(&group) {
                let busiest = engines.values().copied().fold(0.0, f64::max);
                g.gpu = Some(busiest.min(100.0) as f32);
            }
        }
    }

    // SearXNG runs inside Docker's VM: ask Docker (cached, in the background).
    let stale = m.docker_at.map_or(true, |t| t.elapsed() >= DOCKER_EVERY);
    if stale && !m.docker_busy {
        m.docker_busy = true;
        std::thread::spawn(|| {
            let usage = refresh_docker();
            let mut m = lock(monitor());
            m.docker = usage;
            m.docker_at = Some(Instant::now());
            m.docker_busy = false;
        });
    }
    if let Some(d) = m.docker {
        groups.insert(
            Group::Searxng,
            GroupUsage {
                group: Group::Searxng,
                cpu: d.cpu / cores as f32,
                memory: d.memory,
                gpu: None,
                vram: None,
                processes: 1,
            },
        );
    }

    let mut groups: Vec<GroupUsage> = groups.into_values().collect();
    groups.sort_by_key(|g| g.group as u8);

    // Tokens per second from the streamed pieces since the last sample.
    let pieces = state.stream_pieces.load(Ordering::Relaxed);
    let elapsed = m.last_at.elapsed().as_secs_f64();
    let per_sec = if elapsed > 0.05 && pieces >= m.last_pieces {
        (pieces - m.last_pieces) as f64 / elapsed
    } else {
        0.0
    };
    m.last_pieces = pieces;
    m.last_at = Instant::now();

    let active = lock(&state.chat_tokens).len() as u32;
    let zap_runs = crate::db::active_runs(&state.db()).map_or(0, |r| r.len() as u32);

    Usage {
        groups,
        system: SystemUsage {
            cpu: m.sys.global_cpu_usage(),
            memory_used: m.sys.used_memory(),
            memory_total: m.sys.total_memory(),
            gpu: gpu.as_ref().map(|s| s.total_load),
            vram_used: gpu.as_ref().map(|s| s.total_vram),
            cores,
        },
        tokens: TokenUsage {
            active,
            zap_runs,
            per_sec,
            session_prompt: state.session_prompt.load(Ordering::Relaxed),
            session_output: state.session_output.load(Ordering::Relaxed),
        },
    }
}

/// A model an engine holds in memory.
#[derive(Debug, Clone, Serialize)]
pub struct LoadedModel {
    /// Model key (as everywhere else in ZAP).
    pub id: String,
    pub provider: ProviderKind,
    /// Bytes in memory and of those in video memory; `None` when unknown.
    pub size: Option<u64>,
    pub vram: Option<u64>,
}

async fn loaded(state: &AppState) -> Vec<LoadedModel> {
    let mut out = Vec::new();
    if state.status(ProviderKind::Ollama) == ProviderStatus::Running {
        for m in ollama::loaded_models(&state.http).await {
            out.push(LoadedModel {
                id: model_key(ProviderKind::Ollama, &m.name),
                provider: ProviderKind::Ollama,
                size: Some(m.size),
                vram: Some(m.size_vram),
            });
        }
    }
    if state.status(ProviderKind::Lmstudio) == ProviderStatus::Running {
        let port = crate::db::get_settings(&state.db())
            .map_or(lmstudio::DEFAULT_PORT, |s| s.lmstudio_port);
        for id in lmstudio::loaded_models(&state.http, port).await {
            out.push(LoadedModel {
                id: model_key(ProviderKind::Lmstudio, &id),
                provider: ProviderKind::Lmstudio,
                size: None,
                vram: None,
            });
        }
    }
    out
}

/// Models the engines hold in memory right now.
#[tauri::command]
pub async fn loaded_models(state: State<'_, AppState>) -> AppResult<Vec<LoadedModel>> {
    Ok(loaded(&state).await)
}

/// Frees memory: one model (by key) or every loaded model of both engines.
#[tauri::command]
pub async fn unload_models(state: State<'_, AppState>, model: Option<String>) -> AppResult<bool> {
    let targets: Vec<LoadedModel> = loaded(&state)
        .await
        .into_iter()
        .filter(|m| model.as_ref().map_or(true, |k| *k == m.id))
        .collect();
    let mut ok = true;
    for m in targets {
        let (_, name) = parse_model_key(&m.id);
        ok &= match m.provider {
            ProviderKind::Ollama => ollama::unload(&state.http, name).await,
            ProviderKind::Lmstudio => lmstudio::unload(Some(name)).await,
        };
    }
    Ok(ok)
}

/// One sample for the F5 overlay (call about once per second; the first
/// call has no CPU/GPU history yet and reports low values).
#[tauri::command]
pub async fn system_usage(app: AppHandle) -> AppResult<Usage> {
    tokio::task::spawn_blocking(move || sample(&app.state::<AppState>()))
        .await
        .map_err(|e| crate::error::AppError::Other(e.to_string()))
}

#[cfg(windows)]
mod gpu {
    //! GPU load and video memory per process from the "GPU Engine" and
    //! "GPU Process Memory" performance counters.

    use std::collections::HashMap;

    use windows::core::{w, PCWSTR};
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW,
        PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_FMT_LARGE, PDH_HCOUNTER, PDH_HQUERY,
    };

    const PDH_MORE_DATA: u32 = 0x8000_07D2;

    pub struct Counters {
        query: PDH_HQUERY,
        engine: PDH_HCOUNTER,
        memory: PDH_HCOUNTER,
    }

    // The handles are only used under the monitor's mutex.
    unsafe impl Send for Counters {}

    pub struct Sample {
        /// Per process id: load per engine type ("3D", "Compute_0", …).
        pub load: HashMap<u32, Vec<(String, f64)>>,
        /// Per process id: dedicated video memory in bytes.
        pub vram: HashMap<u32, u64>,
        pub total_load: f32,
        pub total_vram: u64,
    }

    impl Counters {
        pub fn open() -> Option<Self> {
            unsafe {
                let mut query = PDH_HQUERY::default();
                if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
                    return None;
                }
                let mut engine = PDH_HCOUNTER::default();
                let mut memory = PDH_HCOUNTER::default();
                if PdhAddEnglishCounterW(
                    query,
                    w!("\\GPU Engine(*)\\Utilization Percentage"),
                    0,
                    &mut engine,
                ) != 0
                    || PdhAddEnglishCounterW(
                        query,
                        w!("\\GPU Process Memory(*)\\Dedicated Usage"),
                        0,
                        &mut memory,
                    ) != 0
                {
                    return None;
                }
                // Rate counters need a first sample to compare against.
                let _ = PdhCollectQueryData(query);
                Some(Self {
                    query,
                    engine,
                    memory,
                })
            }
        }

        pub fn sample(&mut self) -> Sample {
            let mut out = Sample {
                load: HashMap::new(),
                vram: HashMap::new(),
                total_load: 0.0,
                total_vram: 0,
            };
            unsafe {
                if PdhCollectQueryData(self.query) != 0 {
                    return out;
                }
            }
            let mut per_engine: HashMap<String, f64> = HashMap::new();
            for (name, value) in read(self.engine, false) {
                let Some(pid) = pid_of(&name) else { continue };
                let engine = name.split("engtype_").nth(1).unwrap_or("other").to_string();
                *per_engine.entry(engine.clone()).or_default() += value;
                out.load.entry(pid).or_default().push((engine, value));
            }
            out.total_load = per_engine.values().copied().fold(0.0, f64::max).min(100.0) as f32;
            for (name, value) in read(self.memory, true) {
                if let Some(pid) = pid_of(&name) {
                    let bytes = value.max(0.0) as u64;
                    *out.vram.entry(pid).or_default() += bytes;
                    out.total_vram += bytes;
                }
            }
            out
        }
    }

    /// "pid_1234_luid_…" → 1234
    fn pid_of(instance: &str) -> Option<u32> {
        instance
            .strip_prefix("pid_")?
            .split('_')
            .next()?
            .parse()
            .ok()
    }

    /// All instances of a wildcard counter as (instance name, value).
    fn read(counter: PDH_HCOUNTER, large: bool) -> Vec<(String, f64)> {
        let format = if large { PDH_FMT_LARGE } else { PDH_FMT_DOUBLE };
        unsafe {
            let mut size = 0u32;
            let mut count = 0u32;
            let status = PdhGetFormattedCounterArrayW(counter, format, &mut size, &mut count, None);
            if status != PDH_MORE_DATA || size == 0 {
                return Vec::new();
            }
            // The buffer holds the items followed by their name strings.
            let words = (size as usize).div_ceil(std::mem::size_of::<u64>());
            let mut buf = vec![0u64; words];
            let items = buf.as_mut_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>();
            if PdhGetFormattedCounterArrayW(counter, format, &mut size, &mut count, Some(items))
                != 0
            {
                return Vec::new();
            }
            (0..count as usize)
                .filter_map(|i| {
                    let item = &*items.add(i);
                    if item.FmtValue.CStatus != 0 {
                        return None;
                    }
                    let name = item.szName.to_string().ok()?;
                    let value = if large {
                        item.FmtValue.Anonymous.largeValue as f64
                    } else {
                        item.FmtValue.Anonymous.doubleValue
                    };
                    Some((name, value))
                })
                .collect()
        }
    }
}

#[cfg(not(windows))]
mod gpu {
    use std::collections::HashMap;

    pub struct Counters;

    pub struct Sample {
        pub load: HashMap<u32, Vec<(String, f64)>>,
        pub vram: HashMap<u32, u64>,
        pub total_load: f32,
        pub total_vram: u64,
    }

    impl Counters {
        pub fn open() -> Option<Self> {
            None
        }

        pub fn sample(&mut self) -> Sample {
            unreachable!()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_docker_stats() {
        let d = parse_docker("0.35%|152.4MiB / 15.53GiB").unwrap();
        assert!((d.cpu - 0.35).abs() < 1e-6);
        assert_eq!(d.memory, (152.4 * 1024.0 * 1024.0) as u64);
        assert!(parse_docker("garbage").is_none());
    }

    #[test]
    fn groups_by_name_and_ancestry() {
        let mut procs = HashMap::new();
        procs.insert(1, (None, "explorer.exe".to_string()));
        procs.insert(10, (Some(1), "zap.exe".to_string()));
        procs.insert(11, (Some(10), "msedgewebview2.exe".to_string()));
        // `ollama serve` started by ZAP still counts as Ollama.
        procs.insert(12, (Some(10), "ollama.exe".to_string()));
        procs.insert(13, (Some(12), "ollama_llama_server.exe".to_string()));
        procs.insert(20, (Some(1), "lm studio.exe".to_string()));
        procs.insert(21, (Some(20), "node.exe".to_string()));
        procs.insert(30, (Some(1), "chrome.exe".to_string()));
        assert_eq!(classify(11, &procs, 10), Some(Group::Zap));
        assert_eq!(classify(13, &procs, 10), Some(Group::Ollama));
        assert_eq!(classify(21, &procs, 10), Some(Group::Lmstudio));
        assert_eq!(classify(30, &procs, 10), None);
    }
}
