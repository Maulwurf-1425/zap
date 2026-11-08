//! Local files: a background file-name index over all fixed drives, search,
//! and the file operations the model may use (read, list, write, edit,
//! delete to the Recycle Bin). Every modification is backed up first, and
//! system/program folders can never be modified.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use walkdir::WalkDir;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::state::lock;

/// Upper bound for indexed entries (keeps memory around ~150 MB worst case).
const MAX_ENTRIES: usize = 1_500_000;
/// Text handed to the model per read.
pub const MAX_READ_BYTES: u64 = 512 * 1024;
const MAX_READ_CHARS: usize = 60_000;
const MAX_LIST: usize = 300;
const MAX_PREVIEW_CHARS: usize = 8_000;
/// Mentioned files: text up to MAX_READ_BYTES, images up to this size.
pub const MAX_ATTACH_IMAGE_BYTES: u64 = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Entry {
    path: String,
    /// Byte offset of the file name inside `path`.
    name_at: usize,
    is_dir: bool,
}

impl Entry {
    fn name(&self) -> &str {
        &self.path[self.name_at..]
    }
}

#[derive(Default)]
pub struct FileIndex {
    entries: Vec<Entry>,
    pub building: bool,
    pub built_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexStatus {
    pub count: usize,
    pub building: bool,
    pub built_at: Option<i64>,
    pub roots: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FileHit {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

/// Directory names skipped at any depth (system, caches, dev junk).
const SKIP_ANYWHERE: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "__pycache__",
    ".venv",
    "venv",
    ".cache",
    ".gradle",
    ".idea",
    ".vs",
    "appdata",
    "$recycle.bin",
    "system volume information",
    "$windows.~bt",
    "$windows.~ws",
    "$winreagent",
    "config.msi",
    "recovery",
    "windowsapps",
];
/// Directory names skipped directly under a drive root.
const SKIP_AT_ROOT: &[&str] = &[
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
    "perflogs",
    "msocache",
];

fn skip_dir(path: &Path, depth: usize) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = name.to_ascii_lowercase();
    if SKIP_ANYWHERE.contains(&lower.as_str())
        || (depth == 1 && SKIP_AT_ROOT.contains(&lower.as_str()))
    {
        return true;
    }
    // Build output of Rust projects.
    lower == "target" && path.parent().is_some_and(|p| p.join("Cargo.toml").exists())
}

/// Whether a path lies inside a folder the index skips (same rules as the
/// walk in `build_index`).
pub fn is_skipped_path(path: &Path) -> bool {
    let mut depth = 0usize;
    let mut current = PathBuf::new();
    for c in path.components() {
        current.push(c.as_os_str());
        match c {
            Component::Prefix(_) | Component::RootDir => continue,
            _ => depth += 1,
        }
        // Only folders count; the last component may be the file itself.
        if current != path && skip_dir(&current, depth) {
            return true;
        }
        if current == path && path.is_dir() && skip_dir(&current, depth) {
            return true;
        }
    }
    false
}

/// What happened to a path (from the file watcher).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    /// Created or moved in: add it (and a folder's whole subtree).
    Added,
    /// Deleted or moved away: drop it and everything below it.
    Removed,
    /// Content changed: make sure it is listed, nothing else.
    Touched,
}

/// Applies a batch of file-system changes to the index.
pub fn apply_changes(index: &Mutex<FileIndex>, changes: &[(PathBuf, Change)]) {
    let mut remove: HashSet<String> = HashSet::new();
    let mut add: Vec<Entry> = Vec::new();
    let mut touched: Vec<Entry> = Vec::new();

    let entry_for = |path: &Path, is_dir: bool| -> Option<Entry> {
        let s = path.to_str()?.to_string();
        let name_len = path.file_name()?.len();
        Some(Entry {
            name_at: s.len() - name_len,
            path: s,
            is_dir,
        })
    };

    for (path, change) in changes {
        if is_skipped_path(path) {
            continue;
        }
        let Some(key) = path.to_str().map(str::to_string) else {
            continue;
        };
        let meta = std::fs::symlink_metadata(path).ok();
        match (change, meta) {
            (Change::Removed, _) | (_, None) => {
                remove.insert(key);
            }
            (Change::Added, Some(meta)) => {
                // Replace whatever was there (also below it) with the fresh state.
                remove.insert(key);
                add.extend(entry_for(path, meta.is_dir()));
                if meta.is_dir() {
                    let walker = WalkDir::new(path)
                        .min_depth(1)
                        .follow_links(false)
                        .into_iter()
                        .filter_entry(|e| !(e.file_type().is_dir() && is_skipped_path(e.path())));
                    for e in walker.filter_map(Result::ok) {
                        add.extend(entry_for(e.path(), e.file_type().is_dir()));
                    }
                }
            }
            (Change::Touched, Some(meta)) => touched.extend(entry_for(path, meta.is_dir())),
        }
    }

    let mut idx = lock(index);
    if !remove.is_empty() {
        let prefixes: Vec<String> = remove.iter().map(|r| format!("{r}\\")).collect();
        idx.entries.retain(|e| {
            !remove.contains(&e.path) && !prefixes.iter().any(|p| e.path.starts_with(p.as_str()))
        });
    }
    if !touched.is_empty() {
        let known: HashSet<&str> = idx.entries.iter().map(|e| e.path.as_str()).collect();
        let missing: Vec<Entry> = touched
            .into_iter()
            .filter(|e| !known.contains(e.path.as_str()))
            .collect();
        add.extend(missing);
    }
    if idx.entries.len() + add.len() <= MAX_ENTRIES {
        idx.entries.extend(add);
    }
}

/// Fixed local drives (no network, removable or optical drives).
pub fn index_roots() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetDriveTypeW(root: *const u16) -> u32;
        }
        const DRIVE_FIXED: u32 = 3;
        (b'A'..=b'Z')
            .filter_map(|letter| {
                let root = format!("{}:\\", letter as char);
                let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
                // SAFETY: `wide` is a valid, NUL-terminated UTF-16 string.
                let kind = unsafe { GetDriveTypeW(wide.as_ptr()) };
                (kind == DRIVE_FIXED).then(|| PathBuf::from(root))
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .into_iter()
            .collect()
    }
}

/// Walks all roots and fills the index in batches, so searches already
/// work while it is still building. Blocking: run on a worker thread.
pub fn build_index(index: &Mutex<FileIndex>) {
    {
        let mut idx = lock(index);
        if idx.building {
            return;
        }
        idx.building = true;
    }
    let mut fresh: Vec<Entry> = Vec::with_capacity(200_000);
    let mut published = 0usize;
    'roots: for root in index_roots() {
        let walker = WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                !(e.file_type().is_dir() && e.depth() > 0 && skip_dir(e.path(), e.depth()))
            });
        for entry in walker.filter_map(Result::ok) {
            if entry.depth() == 0 {
                continue;
            }
            let Some(path) = entry.path().to_str() else {
                continue;
            };
            let name_at = path.len() - entry.file_name().len();
            fresh.push(Entry {
                path: path.to_string(),
                name_at,
                is_dir: entry.file_type().is_dir(),
            });
            if fresh.len() >= MAX_ENTRIES {
                break 'roots;
            }
            // Publish progress every 20k entries (first build only).
            if fresh.len() - published >= 20_000 && lock(index).built_at.is_none() {
                lock(index).entries = fresh.clone();
                published = fresh.len();
            }
        }
    }
    let mut idx = lock(index);
    idx.entries = fresh;
    idx.building = false;
    idx.built_at = Some(db::now_ms());
}

pub fn status(index: &Mutex<FileIndex>) -> IndexStatus {
    let idx = lock(index);
    IndexStatus {
        count: idx.entries.len(),
        building: idx.building,
        built_at: idx.built_at,
        roots: index_roots()
            .iter()
            .map(|r| r.display().to_string())
            .collect(),
    }
}

/// Searches file and folder names. All words must appear in the name (or in
/// the path for words containing a slash). Exact and prefix matches rank
/// first, then files before folders, then shorter paths.
pub fn search(index: &Mutex<FileIndex>, query: &str, limit: usize) -> Vec<FileHit> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|t| t.to_lowercase().replace('/', "\\"))
        .collect();
    if terms.is_empty() {
        return Vec::new();
    }
    let full = query.trim().to_lowercase();
    let idx = lock(index);
    let mut scored: Vec<(u8, bool, usize, &Entry)> = idx
        .entries
        .iter()
        .filter_map(|e| {
            let name = e.name().to_lowercase();
            let all = terms.iter().all(|t| {
                if t.contains('\\') {
                    e.path.to_lowercase().contains(t.as_str())
                } else {
                    name.contains(t.as_str())
                }
            });
            if !all {
                return None;
            }
            let stem = name.rsplit_once('.').map_or(name.as_str(), |(s, _)| s);
            let rank = if name == full || stem == full {
                0
            } else if terms.first().is_some_and(|t| name.starts_with(t.as_str())) {
                1
            } else {
                2
            };
            Some((rank, e.is_dir, e.path.len(), e))
        })
        .collect();
    scored.sort_by_key(|s| (s.0, s.1, s.2));
    scored
        .into_iter()
        .take(limit)
        .map(|(_, _, _, e)| FileHit {
            path: e.path.clone(),
            name: e.name().to_string(),
            is_dir: e.is_dir,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Paths and protection
// ---------------------------------------------------------------------------

/// Absolute path without `.`/`..` tricks; rejects relative paths.
pub fn clean_path(raw: &str) -> AppResult<PathBuf> {
    let raw = raw.trim().trim_matches('"');
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(AppError::Other("path must be absolute".into()));
    }
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => return Err(AppError::Other("path must not contain ..".into())),
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    Ok(out)
}

/// Folders that can never be modified, whatever the permission mode.
pub fn protected_roots(app_data: Option<&Path>) -> Vec<String> {
    let env = |k: &str| std::env::var(k).ok().map(|v| v.to_lowercase());
    let mut roots: Vec<String> = [
        env("SystemRoot").or_else(|| Some("c:\\windows".into())),
        env("ProgramFiles"),
        env("ProgramFiles(x86)"),
        env("ProgramData"),
    ]
    .into_iter()
    .flatten()
    .collect();
    if let Some(dir) = app_data {
        roots.push(dir.to_string_lossy().to_lowercase());
    }
    roots
}

pub fn ensure_modifiable(path: &Path, protected: &[String]) -> AppResult<()> {
    let lower = path.to_string_lossy().to_lowercase();
    // A drive root itself ("C:\") or anything in system folders.
    if path.parent().is_none() || path.components().count() <= 1 {
        return Err(AppError::Other("protected path".into()));
    }
    let in_protected = protected.iter().any(|root| {
        let root = root.trim_end_matches('\\');
        lower == root || lower.starts_with(&format!("{root}\\"))
    });
    if in_protected
        || lower.contains("\\$recycle.bin")
        || lower.contains("\\system volume information")
    {
        return Err(AppError::Other("protected path".into()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Decodes text files: UTF-8 (with or without BOM) and UTF-16 LE/BE.
/// Returns None for binary content.
pub fn decode_text(bytes: &[u8]) -> Option<String> {
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return Some(String::from_utf16_lossy(&units));
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return Some(String::from_utf16_lossy(&units));
    }
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return None;
    }
    Some(String::from_utf8_lossy(bytes).into_owned())
}

pub fn read_text(path: &Path) -> AppResult<String> {
    let meta = std::fs::metadata(path).map_err(|_| AppError::Other("not found".into()))?;
    if meta.is_dir() {
        return Err(AppError::Other("is a directory".into()));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(AppError::Other("file too large".into()));
    }
    let bytes = std::fs::read(path)?;
    decode_text(&bytes).ok_or_else(|| AppError::Other("binary file".into()))
}

/// Text for the model: optional line window, capped in size, with a note
/// when more lines follow.
pub fn read_for_model(
    path: &Path,
    start_line: usize,
    max_lines: usize,
) -> AppResult<(String, usize)> {
    let text = read_text(path)?;
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    let start = start_line.saturating_sub(1).min(total);
    let mut out = String::new();
    let mut end = start;
    for line in &lines[start..] {
        if end - start >= max_lines || out.len() + line.len() > MAX_READ_CHARS {
            break;
        }
        out.push_str(line);
        out.push('\n');
        end += 1;
    }
    if end < total {
        out.push_str(&format!(
            "\n[… {} more lines. Call read_file again with start_line={} to continue.]",
            total - end,
            end + 1
        ));
    }
    Ok((out, total))
}

#[derive(Debug, Clone, Serialize)]
pub struct DirEntryInfo {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

pub fn list_dir(path: &Path) -> AppResult<Vec<DirEntryInfo>> {
    let mut entries: Vec<DirEntryInfo> = std::fs::read_dir(path)
        .map_err(|_| AppError::Other("not found".into()))?
        .filter_map(Result::ok)
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some(DirEntryInfo {
                name: e.file_name().to_string_lossy().into_owned(),
                is_dir: meta.is_dir(),
                size: if meta.is_dir() { 0 } else { meta.len() },
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

pub fn format_listing(path: &Path, entries: &[DirEntryInfo]) -> String {
    let mut out = format!(
        "Contents of {} ({} entries):\n",
        path.display(),
        entries.len()
    );
    for e in entries.iter().take(MAX_LIST) {
        if e.is_dir {
            out.push_str(&format!("[dir]  {}\n", e.name));
        } else {
            out.push_str(&format!("       {} ({} bytes)\n", e.name, e.size));
        }
    }
    if entries.len() > MAX_LIST {
        out.push_str(&format!("… {} more\n", entries.len() - MAX_LIST));
    }
    out
}

pub fn format_hits(query: &str, hits: &[FileHit], indexing: bool) -> String {
    let mut out = format!("Files matching \"{query}\":\n");
    for h in hits {
        out.push_str(&format!(
            "{}{}\n",
            if h.is_dir { "[dir] " } else { "" },
            h.path
        ));
    }
    if hits.is_empty() {
        out.push_str("No matches.\n");
    }
    if indexing {
        out.push_str("(The file index is still being built; results may be incomplete.)\n");
    }
    out
}

// ---------------------------------------------------------------------------
// Modifying (only after approval; callers check `ensure_modifiable`)
// ---------------------------------------------------------------------------

/// Applies a text replacement. `old` must match exactly once unless
/// `replace_all`. Falls back to CRLF line endings for Windows files.
pub fn apply_edit(content: &str, old: &str, new: &str, replace_all: bool) -> AppResult<String> {
    if old.is_empty() {
        return Err(AppError::Other("old_text is empty".into()));
    }
    let (old, new) = if !content.contains(old) && content.contains("\r\n") {
        (old.replace('\n', "\r\n"), new.replace('\n', "\r\n"))
    } else {
        (old.to_string(), new.to_string())
    };
    match content.matches(old.as_str()).count() {
        0 => Err(AppError::Other("old_text not found".into())),
        1 => Ok(content.replacen(old.as_str(), &new, 1)),
        _ if replace_all => Ok(content.replace(old.as_str(), &new)),
        n => Err(AppError::Other(format!("old_text matches {n} places"))),
    }
}

/// Unified diff for the approval card.
pub fn diff_preview(path: &Path, old: &str, new: &str) -> String {
    let name = path.display().to_string();
    let diff = similar::TextDiff::from_lines(old, new)
        .unified_diff()
        .context_radius(2)
        .header(&name, &name)
        .to_string();
    truncate(&diff, MAX_PREVIEW_CHARS)
}

pub fn new_file_preview(content: &str) -> String {
    let mut out = String::new();
    for line in content.lines() {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    truncate(&out, MAX_PREVIEW_CHARS)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut cut: String = s.chars().take(max).collect();
    cut.push_str("\n…");
    cut
}

/// Copies a file into ZAP's backup folder before it is changed.
pub fn backup(path: &Path, backup_dir: &Path) -> AppResult<Option<PathBuf>> {
    if !path.is_file() {
        return Ok(None);
    }
    std::fs::create_dir_all(backup_dir)?;
    let (y, m, d) = db::ymd(db::now_ms());
    let stamp = format!("{y:04}{m:02}{d:02}-{}", db::now_ms() % 86_400_000);
    let flat: String = path
        .to_string_lossy()
        .chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | ':') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let target = backup_dir.join(format!("{stamp}_{flat}"));
    std::fs::copy(path, &target)?;
    Ok(Some(target))
}

pub fn write_file(path: &Path, content: &str) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)?;
    Ok(())
}

/// Moves or renames a file or folder; creates missing parent folders.
/// Files can also move across drives (copy + delete); folders cannot.
pub fn move_path(from: &Path, to: &Path) -> AppResult<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) if from.is_file() => {
            std::fs::copy(from, to)?;
            std::fs::remove_file(from)?;
            Ok(())
        }
        Err(_) => Err(AppError::Other("cross volume".into())),
    }
}

pub fn move_to_trash(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::Other("not found".into()));
    }
    trash::delete(path).map_err(|_| AppError::Other("could not move to recycle bin".into()))
}

/// Counts files below a folder (for the delete approval card), capped.
pub fn count_files(path: &Path) -> usize {
    WalkDir::new(path)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .take(100_000)
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index_of(paths: &[(&str, bool)]) -> Mutex<FileIndex> {
        let entries = paths
            .iter()
            .map(|(p, is_dir)| Entry {
                path: (*p).to_string(),
                name_at: p.rfind('\\').map_or(0, |i| i + 1),
                is_dir: *is_dir,
            })
            .collect();
        Mutex::new(FileIndex {
            entries,
            building: false,
            built_at: Some(1),
        })
    }

    #[test]
    fn search_ranks_exact_prefix_files_short() {
        let idx = index_of(&[
            (r"C:\Users\me\Projects\old\budget-2025.xlsx", false),
            (r"C:\Users\me\Documents\budget.xlsx", false),
            (r"C:\Users\me\Documents\Budget", true),
            (r"C:\Users\me\Documents\my budget notes.txt", false),
            (r"C:\Users\me\Pictures\cat.png", false),
        ]);
        let hits = search(&idx, "budget", 10);
        assert_eq!(
            hits[0].path, r"C:\Users\me\Documents\budget.xlsx",
            "exact stem first"
        );
        assert!(hits[1].is_dir, "exact folder name next");
        assert_eq!(hits.len(), 4);
        assert!(search(&idx, "nothing", 10).is_empty());
        // Words with a slash match the path.
        let hits = search(&idx, "projects/ budget", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "budget-2025.xlsx");
    }

    #[test]
    fn watcher_changes_update_the_index() {
        // Not under %TEMP%: that lives in AppData, which the index skips.
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("zap-watch-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("proj").join("node_modules")).unwrap();
        std::fs::write(dir.join("proj").join("plan.md"), "x").unwrap();
        std::fs::write(dir.join("proj").join("node_modules").join("junk.js"), "x").unwrap();
        let idx = Mutex::new(FileIndex {
            entries: Vec::new(),
            building: false,
            built_at: Some(1),
        });

        // A folder moved in: whole subtree is added, skipped folders stay out.
        apply_changes(&idx, &[(dir.join("proj"), Change::Added)]);
        let names: Vec<String> = search(&idx, "plan", 10)
            .into_iter()
            .map(|h| h.name)
            .collect();
        assert_eq!(names, vec!["plan.md"]);
        assert!(search(&idx, "junk", 10).is_empty());

        // New file appears, deleted folder removes everything below it.
        std::fs::write(dir.join("proj").join("new note.txt"), "x").unwrap();
        apply_changes(
            &idx,
            &[(dir.join("proj").join("new note.txt"), Change::Added)],
        );
        assert_eq!(search(&idx, "new note", 10).len(), 1);
        apply_changes(&idx, &[(dir.join("proj").join("plan.md"), Change::Touched)]);
        assert_eq!(
            search(&idx, "plan", 10).len(),
            1,
            "touch does not duplicate"
        );
        std::fs::remove_dir_all(&dir).unwrap();
        apply_changes(&idx, &[(dir.join("proj"), Change::Removed)]);
        assert!(search(&idx, "note", 10).is_empty() && search(&idx, "plan", 10).is_empty());
    }

    #[test]
    fn skips_system_and_junk_folders() {
        assert!(skip_dir(Path::new(r"C:\Windows"), 1));
        assert!(
            !skip_dir(Path::new(r"C:\Users\me\Windows"), 3),
            "only at drive root"
        );
        assert!(skip_dir(Path::new(r"C:\Users\me\AppData"), 3));
        assert!(skip_dir(Path::new(r"D:\code\app\node_modules"), 4));
        assert!(!skip_dir(Path::new(r"C:\Users\me\Documents"), 3));
    }

    #[test]
    fn cleans_and_protects_paths() {
        assert!(clean_path("relative\\file.txt").is_err());
        if cfg!(windows) {
            assert!(clean_path(r"C:\Users\me\..\x").is_err());
            assert_eq!(
                clean_path(r#""C:\Users\me\.\a.txt""#).unwrap(),
                PathBuf::from(r"C:\Users\me\a.txt")
            );
            let protected = vec![r"c:\windows".to_string(), r"c:\program files".to_string()];
            assert!(ensure_modifiable(
                Path::new(r"C:\Windows\System32\drivers\etc\hosts"),
                &protected
            )
            .is_err());
            assert!(
                ensure_modifiable(Path::new(r"C:\Program Files\App\a.dll"), &protected).is_err()
            );
            assert!(ensure_modifiable(Path::new(r"C:\"), &protected).is_err());
            assert!(
                ensure_modifiable(Path::new(r"C:\Users\me\Documents\a.txt"), &protected).is_ok()
            );
            assert!(
                ensure_modifiable(Path::new(r"C:\WindowsApps2\a.txt"), &protected).is_ok(),
                "prefix only per folder"
            );
        }
    }

    #[test]
    fn decodes_text_encodings_and_rejects_binary() {
        assert_eq!(decode_text(b"\xEF\xBB\xBFhello").as_deref(), Some("hello"));
        assert_eq!(
            decode_text(&[0xFF, 0xFE, b'h', 0, b'i', 0]).as_deref(),
            Some("hi")
        );
        assert_eq!(decode_text("Grüße".as_bytes()).as_deref(), Some("Grüße"));
        assert_eq!(decode_text(&[0x89, b'P', b'N', b'G', 0, 0, 1]), None);
    }

    #[test]
    fn edits_exactly_once_and_handles_crlf() {
        assert_eq!(apply_edit("a b c", "b", "B", false).unwrap(), "a B c");
        assert!(apply_edit("x x", "x", "y", false)
            .unwrap_err()
            .to_string()
            .contains("2 places"));
        assert_eq!(apply_edit("x x", "x", "y", true).unwrap(), "y y");
        assert!(apply_edit("abc", "zzz", "y", false).is_err());
        assert_eq!(
            apply_edit("one\r\ntwo\r\n", "one\ntwo", "1\n2", false).unwrap(),
            "1\r\n2\r\n"
        );
    }

    #[test]
    fn previews_changes() {
        let diff = diff_preview(Path::new(r"C:\a.txt"), "one\ntwo\n", "one\n2\n");
        assert!(diff.contains("-two") && diff.contains("+2"));
        assert_eq!(new_file_preview("a\nb"), "+a\n+b\n");
    }

    #[test]
    fn file_roundtrip_with_backup_and_read_window() {
        let dir = std::env::temp_dir().join(format!("zap-files-test-{}", uuid::Uuid::new_v4()));
        let file = dir.join("sub").join("note.txt");
        write_file(&file, "l1\nl2\nl3\n").unwrap();
        let (text, total) = read_for_model(&file, 2, 1).unwrap();
        assert_eq!(total, 3);
        assert!(text.starts_with("l2\n") && text.contains("start_line=3"));
        let backup_dir = dir.join("backups");
        let copy = backup(&file, &backup_dir).unwrap().unwrap();
        assert_eq!(std::fs::read_to_string(copy).unwrap(), "l1\nl2\nl3\n");
        let listing = list_dir(&dir).unwrap();
        assert_eq!(listing[0].name, "backups");
        assert!(listing[0].is_dir);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // Live check on this PC: `cargo test live_index -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_index() {
        let idx = Mutex::new(FileIndex::default());
        let started = std::time::Instant::now();
        build_index(&idx);
        let status = status(&idx);
        println!(
            "roots {:?}: {} entries in {:.1?}",
            status.roots,
            status.count,
            started.elapsed()
        );
        let t = std::time::Instant::now();
        let hits = search(&idx, "design md", 5);
        println!(
            "search in {:.1?}: {:?}",
            t.elapsed(),
            hits.iter().map(|h| &h.path).collect::<Vec<_>>()
        );
        assert!(status.count > 0);
    }
}
