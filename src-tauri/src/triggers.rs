//! ZAP triggers: a ZAP with the schedule kind "folder" starts when a new file
//! lands in its folder (e.g. Downloads). Files count once they are complete:
//! no temp extension of a running download and the size stopped changing.
//! Several new files run one after another.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use notify::Watcher;
use tauri::{AppHandle, Manager};

use crate::db::{self, Zap};
use crate::schedule;
use crate::state::{lock, AppState};
use crate::zaps;

const TICK: Duration = Duration::from_secs(2);
/// A file must keep its size this long before it counts as complete.
const SETTLE: Duration = Duration::from_secs(3);
/// Browsers and tools write downloads under these names first.
const TEMP_EXTENSIONS: &[&str] = &[
    "crdownload",
    "part",
    "partial",
    "tmp",
    "download",
    "opdownload",
];

#[derive(Default)]
struct Pending {
    size: u64,
    stable_since: Option<Instant>,
}

#[derive(Default)]
struct Triggers {
    /// Watched folder per ZAP id (the watcher is kept alive here).
    watchers: HashMap<String, (PathBuf, String, notify::RecommendedWatcher)>,
    /// New files per ZAP id, waiting until complete.
    pending: HashMap<String, HashMap<PathBuf, Pending>>,
    /// Complete files per ZAP id, waiting for their run.
    queue: HashMap<String, Vec<PathBuf>>,
    /// Files already handed to a run (events can repeat).
    seen: HashMap<String, HashSet<PathBuf>>,
}

static TRIGGERS: OnceLock<Mutex<Triggers>> = OnceLock::new();

fn triggers() -> &'static Mutex<Triggers> {
    TRIGGERS.get_or_init(|| Mutex::new(Triggers::default()))
}

/// Does a file name match the pattern ("*.pdf; *.jpg", empty = all)?
pub fn matches_pattern(name: &str, pattern: &str) -> bool {
    let name = name.to_lowercase();
    let parts: Vec<String> = pattern
        .split([';', ','])
        .map(|p| p.trim().to_lowercase())
        .filter(|p| !p.is_empty())
        .collect();
    parts.is_empty()
        || parts
            .iter()
            .any(|p| wildcard(p.as_bytes(), name.as_bytes()))
}

/// `*` (any run) and `?` (one char) wildcards.
fn wildcard(pattern: &[u8], text: &[u8]) -> bool {
    match (pattern.first(), text.first()) {
        (None, None) => true,
        (Some(b'*'), _) => {
            wildcard(&pattern[1..], text) || (!text.is_empty() && wildcard(pattern, &text[1..]))
        }
        (Some(b'?'), Some(_)) => wildcard(&pattern[1..], &text[1..]),
        (Some(p), Some(t)) if p == t => wildcard(&pattern[1..], &text[1..]),
        _ => false,
    }
}

fn is_temp(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    name.starts_with("~$")
        || name.starts_with('.')
        || path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .is_some_and(|e| TEMP_EXTENSIONS.contains(&e.as_str()))
}

/// Files that appeared (created, or renamed into place when a download ends).
fn new_files(event: &notify::Event) -> Vec<PathBuf> {
    use notify::event::{CreateKind, ModifyKind, RenameMode};
    use notify::EventKind;
    match event.kind {
        EventKind::Create(CreateKind::File | CreateKind::Any) => event.paths.clone(),
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => event.paths.clone(),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
            event.paths.get(1).cloned().into_iter().collect()
        }
        _ => Vec::new(),
    }
}

/// Starts or stops folder watchers to match the ZAPs (call after changes).
pub fn sync(app: &AppHandle) {
    let state = app.state::<AppState>();
    let wanted: Vec<Zap> = db::list_zaps(&state.db())
        .unwrap_or_default()
        .into_iter()
        .filter(|z| z.schedule.kind == "folder" && Path::new(&z.schedule.folder).is_dir())
        .collect();
    let mut t = lock(triggers());
    let keep: HashSet<&str> = wanted.iter().map(|z| z.id.as_str()).collect();
    t.watchers.retain(|id, _| keep.contains(id.as_str()));
    let ids: Vec<String> = t.pending.keys().chain(t.queue.keys()).cloned().collect();
    for id in ids {
        if !keep.contains(id.as_str()) {
            t.pending.remove(&id);
            t.queue.remove(&id);
            t.seen.remove(&id);
        }
    }
    for zap in wanted {
        let folder = PathBuf::from(&zap.schedule.folder);
        let pattern = zap.schedule.pattern.clone();
        if t.watchers
            .get(&zap.id)
            .is_some_and(|(f, p, _)| *f == folder && *p == pattern)
        {
            continue;
        }
        let zap_id = zap.id.clone();
        let watch_pattern = pattern.clone();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else { return };
            let files = new_files(&event);
            if files.is_empty() {
                return;
            }
            let mut t = lock(triggers());
            for path in files {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                if is_temp(&path) || !matches_pattern(&name, &watch_pattern) {
                    continue;
                }
                if t.seen.get(&zap_id).is_some_and(|s| s.contains(&path)) {
                    continue;
                }
                t.pending
                    .entry(zap_id.clone())
                    .or_default()
                    .entry(path)
                    .or_default();
            }
        });
        let Ok(mut watcher) = watcher else { continue };
        if watcher
            .watch(&folder, notify::RecursiveMode::NonRecursive)
            .is_ok()
        {
            t.watchers
                .insert(zap.id.clone(), (folder, pattern, watcher));
        }
    }
}

/// Moves complete files to the queue and starts runs for queued files.
fn tick(app: &AppHandle) {
    let state = app.state::<AppState>();
    let now = Instant::now();
    let mut to_start: Vec<(String, PathBuf)> = Vec::new();
    {
        let mut t = lock(triggers());
        let mut ready: Vec<(String, PathBuf)> = Vec::new();
        for (zap_id, files) in t.pending.iter_mut() {
            files.retain(|path, p| {
                let Ok(meta) = std::fs::metadata(path) else {
                    return false; // gone again (temp file, moved away)
                };
                if !meta.is_file() {
                    return false;
                }
                if meta.len() != p.size || p.stable_since.is_none() {
                    p.size = meta.len();
                    p.stable_since = Some(now);
                    return true;
                }
                if p.stable_since
                    .is_some_and(|s| now.duration_since(s) >= SETTLE)
                {
                    ready.push((zap_id.clone(), path.clone()));
                    return false;
                }
                true
            });
        }
        for (zap_id, path) in ready {
            t.seen
                .entry(zap_id.clone())
                .or_default()
                .insert(path.clone());
            t.queue.entry(zap_id).or_default().push(path);
        }
        let running: HashSet<String> = db::active_runs(&state.db())
            .unwrap_or_default()
            .into_iter()
            .map(|r| r.zap_id)
            .collect();
        for (zap_id, queue) in t.queue.iter_mut() {
            if !queue.is_empty() && !running.contains(zap_id) {
                to_start.push((zap_id.clone(), queue.remove(0)));
            }
        }
    }
    for (zap_id, path) in to_start {
        let Ok(Some(zap)) = db::get_zap(&state.db(), &zap_id) else {
            continue;
        };
        let Some(model) = schedule::model_for(&state, &zap) else {
            zaps::notify_failed_start(app, &zap, "no_model");
            continue;
        };
        // Windows paths with one kind of slash (the folder may use "/").
        let shown = path.display().to_string().replace('/', "\\");
        let input = format!("A new file arrived: {shown}");
        if let Err(err) = zaps::start(app, &state, &zap.id, Some(input), "trigger", Some(&model)) {
            zaps::notify_failed_start(app, &zap, &err.to_string());
        }
    }
}

/// Watches the folders of "new file" ZAPs from now on.
pub fn init(app: &AppHandle) {
    sync(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(TICK).await;
            tick(&app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns() {
        assert!(matches_pattern("Rechnung.PDF", "*.pdf"));
        assert!(matches_pattern("photo.jpg", "*.pdf; *.jpg"));
        assert!(!matches_pattern("notes.txt", "*.pdf, *.jpg"));
        assert!(matches_pattern("anything.bin", ""));
        assert!(matches_pattern("report-2026.xlsx", "report-*.xlsx"));
        assert!(matches_pattern("a1.txt", "a?.txt"));
        assert!(!matches_pattern("a12.txt", "a?.txt"));
    }

    #[test]
    fn temp_downloads_are_skipped() {
        assert!(is_temp(Path::new("C:/Downloads/setup.exe.crdownload")));
        assert!(is_temp(Path::new("C:/Downloads/video.mp4.part")));
        assert!(is_temp(Path::new("C:/Docs/~$brief.docx")));
        assert!(!is_temp(Path::new("C:/Downloads/setup.exe")));
    }
}
