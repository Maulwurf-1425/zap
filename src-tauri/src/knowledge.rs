//! Knowledge folders: PDFs, Word files and notes the user picks, searchable
//! by meaning. Files are split into passages, each passage gets an embedding
//! from a local Ollama model, and questions find the closest passages.
//! Everything stays on this PC.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db;
use crate::error::{AppError, AppResult};
use crate::ollama::BASE_URL;
use crate::provider::{ToolCall, ToolSpec};
use crate::state::{lock, AppState};
use crate::tools::{Source, ToolActivity, ToolCtx};

pub const SEARCH: &str = "search_knowledge";
pub const DEFAULT_MODEL: &str = "nomic-embed-text";

/// Characters per passage and overlap between neighbours.
const CHUNK_CHARS: usize = 1_000;
const CHUNK_OVERLAP: usize = 150;
const EMBED_BATCH: usize = 16;
const MAX_FILE_BYTES: u64 = 40 * 1024 * 1024;
const RESULTS: usize = 6;
const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "csv", "log", "json", "xml", "html", "htm", "rst", "org",
];
/// Folders that are never indexed (tools, caches, version control).
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "__pycache__",
    ".venv",
    "AppData",
];

// --- Text extraction --------------------------------------------------------------

pub fn supported(path: &Path) -> bool {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    ext == "pdf" || ext == "docx" || TEXT_EXTENSIONS.contains(&ext.as_str())
}

/// Plain text of a .docx (paragraphs from word/document.xml).
fn docx_text(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut xml = String::new();
    // Some zip tools write Windows separators into the entry names.
    let name = if zip.by_name("word/document.xml").is_ok() {
        "word/document.xml"
    } else {
        r"word\document.xml"
    };
    zip.by_name(name)
        .map_err(|e| e.to_string())?
        .read_to_string(&mut xml)
        .map_err(|e| e.to_string())?;
    let xml = xml
        .replace("</w:p>", "\n")
        .replace("<w:tab/>", "\t")
        .replace("<w:br/>", "\n");
    let mut out = String::with_capacity(xml.len() / 3);
    let mut in_tag = false;
    for c in xml.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    Ok(out
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'"))
}

/// Text of a supported file. PDF parsing runs guarded: broken PDFs fail
/// alone instead of taking the indexer down.
pub fn extract_text(path: &Path) -> Result<String, String> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "pdf" => {
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(&bytes))
                .map_err(|_| "pdf_unreadable".to_string())?
                .map_err(|_| "pdf_unreadable".to_string())
        }
        "docx" => docx_text(path),
        _ => std::fs::read(path)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .map_err(|e| e.to_string()),
    }
}

/// Splits text into passages of about `CHUNK_CHARS`, preferring paragraph
/// and sentence ends, with a little overlap so context isn't cut apart.
pub fn chunk(text: &str) -> Vec<String> {
    let clean: String = text
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .replace("\n\n\n", "\n\n");
    let chars: Vec<char> = clean.chars().collect();
    let mut out = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let mut end = (start + CHUNK_CHARS).min(chars.len());
        if end < chars.len() {
            // Back up to a paragraph, then a sentence end in the last third.
            let window: String = chars[start..end].iter().collect();
            let min = window.chars().count() * 2 / 3;
            let cut = window
                .rfind("\n\n")
                .filter(|i| window[..*i].chars().count() > min)
                .or_else(|| {
                    window
                        .rfind(". ")
                        .filter(|i| window[..*i].chars().count() > min)
                        .map(|i| i + 1)
                });
            if let Some(i) = cut {
                end = start + window[..i].chars().count();
            }
        }
        let piece: String = chars[start..end]
            .iter()
            .collect::<String>()
            .trim()
            .to_string();
        if piece.chars().filter(|c| c.is_alphanumeric()).count() > 20 {
            out.push(piece);
        }
        if end >= chars.len() {
            break;
        }
        start = end.saturating_sub(CHUNK_OVERLAP).max(start + 1);
    }
    out
}

// --- Embeddings --------------------------------------------------------------------

async fn embed(http: &reqwest::Client, model: &str, input: &[String]) -> AppResult<Vec<Vec<f32>>> {
    let resp = http
        .post(format!("{BASE_URL}/api/embed"))
        .timeout(Duration::from_secs(120))
        .json(&json!({ "model": model, "input": input }))
        .send()
        .await?;
    if !resp.status().is_success() {
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        let msg = body["error"]
            .as_str()
            .unwrap_or("embedding failed")
            .to_string();
        return Err(if msg.contains("not found") {
            AppError::ModelNotFound(model.into())
        } else {
            AppError::Provider(msg)
        });
    }
    let body: Value = resp.json().await?;
    let list = body["embeddings"]
        .as_array()
        .ok_or_else(|| AppError::Provider("no embeddings".into()))?;
    Ok(list
        .iter()
        .map(|v| {
            v.as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_f64)
                        .map(|f| f as f32)
                        .collect()
                })
                .unwrap_or_default()
        })
        .collect())
}

fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

fn from_blob(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Cosine similarity (0 for vectors of different length).
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let (mut dot, mut na, mut nb) = (0.0f32, 0.0f32, 0.0f32);
    for (x, y) in a.iter().zip(b) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na.sqrt() * nb.sqrt())
    }
}

// --- Index -------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Default)]
pub struct Progress {
    pub indexing: bool,
    pub done: usize,
    pub total: usize,
    pub current: Option<String>,
    /// Error code of the last run ("model_missing", "ollama_down", …).
    pub error: Option<String>,
}

static RUNNING: AtomicBool = AtomicBool::new(false);
static PROGRESS: Mutex<Progress> = Mutex::new(Progress {
    indexing: false,
    done: 0,
    total: 0,
    current: None,
    error: None,
});

/// In-memory copy of all passages for fast search; cleared after indexing.
struct Passage {
    path: String,
    idx: i64,
    text: String,
    vector: Vec<f32>,
}
static CACHE: OnceLock<Mutex<Option<Vec<Passage>>>> = OnceLock::new();

fn cache() -> &'static Mutex<Option<Vec<Passage>>> {
    CACHE.get_or_init(|| Mutex::new(None))
}

fn emit(app: &AppHandle) {
    let p = lock(&PROGRESS).clone();
    let _ = app.emit("knowledge://progress", p);
}

fn settings_of(state: &AppState) -> (Vec<String>, String) {
    let s = db::get_settings(&state.db()).unwrap_or_default();
    let model = if s.knowledge_model.trim().is_empty() {
        DEFAULT_MODEL.to_string()
    } else {
        s.knowledge_model
    };
    (s.knowledge_folders, model)
}

/// Supported files under the folders (recursive, hidden and tool folders skipped).
fn collect_files(folders: &[String]) -> Vec<(PathBuf, String, i64, u64)> {
    let mut out = Vec::new();
    for folder in folders {
        for entry in walkdir::WalkDir::new(folder)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name().to_string_lossy();
                !(e.depth() > 0 && (name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref())))
            })
            .filter_map(Result::ok)
        {
            let path = entry.path();
            if !entry.file_type().is_file() || !supported(path) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() == 0 || meta.len() > MAX_FILE_BYTES {
                continue;
            }
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as i64);
            out.push((path.to_path_buf(), folder.clone(), mtime, meta.len()));
        }
    }
    out
}

fn file_unchanged(conn: &Connection, path: &str, mtime: i64, size: u64) -> bool {
    conn.query_row(
        "SELECT mtime = ?2 AND size = ?3 AND status = 'ok' FROM knowledge_files WHERE path = ?1",
        params![path, mtime, size as i64],
        |r| r.get::<_, bool>(0),
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or(false)
}

fn forget_file(conn: &Connection, path: &str) {
    let _ = conn.execute("DELETE FROM knowledge_chunks WHERE path = ?1", [path]);
    let _ = conn.execute("DELETE FROM knowledge_files WHERE path = ?1", [path]);
}

/// Brings the index up to date: new and changed files are read and
/// embedded, removed ones dropped. Runs one at a time.
pub async fn index(app: &AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let state = app.state::<AppState>();
    let (folders, model) = settings_of(&state);
    *lock(&PROGRESS) = Progress {
        indexing: true,
        ..Default::default()
    };
    emit(app);

    let files = tokio::task::spawn_blocking({
        let folders = folders.clone();
        move || collect_files(&folders)
    })
    .await
    .unwrap_or_default();

    // Files that are gone or no longer in a knowledge folder.
    {
        let conn = state.db();
        let wanted: std::collections::HashSet<String> =
            files.iter().map(|f| f.0.display().to_string()).collect();
        let known: Vec<String> = conn
            .prepare("SELECT path FROM knowledge_files")
            .and_then(|mut s| s.query_map([], |r| r.get(0))?.collect())
            .unwrap_or_default();
        for path in known.iter().filter(|p| !wanted.contains(*p)) {
            forget_file(&conn, path);
        }
    }

    let todo: Vec<_> = files
        .into_iter()
        .filter(|(path, _, mtime, size)| {
            !file_unchanged(&state.db(), &path.display().to_string(), *mtime, *size)
        })
        .collect();
    lock(&PROGRESS).total = todo.len();
    emit(app);

    let mut error: Option<String> = None;
    for (n, (path, folder, mtime, size)) in todo.into_iter().enumerate() {
        let shown = path.display().to_string();
        {
            let mut p = lock(&PROGRESS);
            p.done = n;
            p.current = path.file_name().map(|f| f.to_string_lossy().into_owned());
        }
        emit(app);
        let text = tokio::task::spawn_blocking({
            let path = path.clone();
            move || extract_text(&path)
        })
        .await
        .unwrap_or_else(|_| Err("failed".into()));
        let (status, file_error, chunks) = match text {
            Err(e) => ("error", Some(e), Vec::new()),
            Ok(text) => {
                let pieces = chunk(&text);
                let mut vectors = Vec::with_capacity(pieces.len());
                let mut failed = None;
                for batch in pieces.chunks(EMBED_BATCH) {
                    match embed(&state.http, &model, batch).await {
                        Ok(v) => vectors.extend(v),
                        Err(e) => {
                            failed = Some(e);
                            break;
                        }
                    }
                }
                match failed {
                    // The model or Ollama is missing: stop, every file would fail.
                    Some(AppError::ModelNotFound(_)) => {
                        error = Some("model_missing".into());
                        break;
                    }
                    Some(AppError::Unreachable) => {
                        error = Some("ollama_down".into());
                        break;
                    }
                    Some(e) => ("error", Some(e.code().to_string()), Vec::new()),
                    None => (
                        "ok",
                        None,
                        pieces.into_iter().zip(vectors).collect::<Vec<_>>(),
                    ),
                }
            }
        };
        let conn = state.db();
        forget_file(&conn, &shown);
        let _ = conn.execute(
            "INSERT INTO knowledge_files (path, folder, mtime, size, chunks, status, error, indexed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![shown, folder, mtime, size as i64, chunks.len() as i64, status, file_error, db::now_ms()],
        );
        for (i, (text, vector)) in chunks.iter().enumerate() {
            let _ = conn.execute(
                "INSERT INTO knowledge_chunks (path, idx, text, embedding, model) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![shown, i as i64, text, to_blob(vector), model],
            );
        }
    }

    *lock(cache()) = None;
    {
        let mut p = lock(&PROGRESS);
        p.indexing = false;
        p.done = p.total;
        p.current = None;
        p.error = error;
    }
    emit(app);
    RUNNING.store(false, Ordering::SeqCst);
}

fn load_cache(conn: &Connection, model: &str) -> Vec<Passage> {
    conn.prepare("SELECT path, idx, text, embedding FROM knowledge_chunks WHERE model = ?1")
        .and_then(|mut s| {
            s.query_map([model], |r| {
                Ok(Passage {
                    path: r.get(0)?,
                    idx: r.get(1)?,
                    text: r.get(2)?,
                    vector: from_blob(&r.get::<_, Vec<u8>>(3)?),
                })
            })?
            .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
pub struct Hit {
    pub path: String,
    pub name: String,
    /// Position of the passage in its file (0-based).
    pub part: i64,
    pub text: String,
    pub score: f32,
}

/// The passages closest in meaning to the query.
pub async fn search(state: &AppState, query: &str, limit: usize) -> AppResult<Vec<Hit>> {
    let (_, model) = settings_of(state);
    let q = embed(&state.http, &model, &[query.to_string()])
        .await?
        .into_iter()
        .next()
        .unwrap_or_default();
    let mut guard = lock(cache());
    if guard.is_none() {
        *guard = Some(load_cache(&state.db(), &model));
    }
    let passages = guard.as_ref().map(Vec::as_slice).unwrap_or_default();
    let mut scored: Vec<(f32, &Passage)> = passages
        .iter()
        .map(|p| (cosine(&q, &p.vector), p))
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    Ok(scored
        .into_iter()
        .take(limit)
        .filter(|(s, _)| *s > 0.3)
        .map(|(score, p)| Hit {
            name: Path::new(&p.path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: p.path.clone(),
            part: p.idx,
            text: p.text.clone(),
            score,
        })
        .collect())
}

/// Hits as numbered excerpts for the model.
pub fn hits_text(hits: &[Hit]) -> String {
    let mut out = String::new();
    for (i, h) in hits.iter().enumerate() {
        out.push_str(&format!(
            "[{}] {} (part {})\n{}\n\n",
            i + 1,
            h.name,
            h.part + 1,
            h.text.trim()
        ));
    }
    out
}

// --- Chat tool ---------------------------------------------------------------------

pub fn tool_spec() -> ToolSpec {
    ToolSpec {
        name: SEARCH,
        description: "Search the user's knowledge folders (their PDFs, documents and notes) by meaning. Returns numbered excerpts with file names.",
        parameters: json!({
            "type": "object",
            "properties": { "query": { "type": "string", "description": "What to look for, as a short question or keywords" } },
            "required": ["query"]
        }),
    }
}

pub fn system_prompt() -> String {
    "The user has knowledge folders with their own documents. For questions about their documents, notes or \
anything they may have stored, call search_knowledge first and answer from the excerpts. Cite the excerpts you \
use as [1], [2] with the file name. If the excerpts don't contain the answer, say so instead of guessing."
        .into()
}

pub async fn run_tool(
    state: &AppState,
    _ctx: &ToolCtx<'_>,
    call: &ToolCall,
    mut activity: ToolActivity,
) -> (ToolActivity, String) {
    let query = call.arguments["query"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string();
    if query.is_empty() {
        return (activity.failed("failed"), "Error: missing query.".into());
    }
    activity.input = query.clone();
    match search(state, &query, RESULTS).await {
        Ok(hits) if hits.is_empty() => {
            activity.detail = Some("results:0".into());
            (
                activity.done(Vec::new()),
                "No matching passages in the knowledge folders.".into(),
            )
        }
        Ok(hits) => {
            activity.detail = Some(format!("results:{}", hits.len()));
            let mut seen = std::collections::HashSet::new();
            let sources = hits
                .iter()
                .filter(|h| seen.insert(h.path.clone()))
                .map(|h| Source {
                    title: h.name.clone(),
                    url: h.path.clone(),
                })
                .collect();
            let text = hits_text(&hits);
            (activity.done(sources), text)
        }
        Err(AppError::ModelNotFound(_)) => (
            activity.failed("knowledge_model_missing"),
            "Error: the embedding model for the knowledge folders is not installed.".into(),
        ),
        Err(_) => (
            activity.failed("failed"),
            "Error: the knowledge search failed (is Ollama running?).".into(),
        ),
    }
}

// --- Tauri commands ----------------------------------------------------------------

#[derive(Serialize)]
pub struct KnowledgeStatus {
    pub files: i64,
    pub passages: i64,
    pub failed: Vec<(String, String)>,
    pub progress: Progress,
    pub model: String,
    /// Whether the embedding model is installed in Ollama.
    pub model_ready: bool,
}

async fn model_installed(http: &reqwest::Client, model: &str) -> bool {
    crate::ollama::is_installed(http, model).await
}

#[tauri::command]
pub async fn knowledge_status(state: State<'_, AppState>) -> AppResult<KnowledgeStatus> {
    let (_, model) = settings_of(&state);
    let (files, passages, failed) = {
        let conn = state.db();
        let files: i64 = conn.query_row(
            "SELECT COUNT(*) FROM knowledge_files WHERE status = 'ok'",
            [],
            |r| r.get(0),
        )?;
        let passages: i64 =
            conn.query_row("SELECT COUNT(*) FROM knowledge_chunks", [], |r| r.get(0))?;
        let failed: Vec<(String, String)> = conn
            .prepare("SELECT path, COALESCE(error, '') FROM knowledge_files WHERE status = 'error' LIMIT 20")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        (files, passages, failed)
    };
    let progress = lock(&PROGRESS).clone();
    let model_ready = model_installed(&state.http, &model).await;
    Ok(KnowledgeStatus {
        files,
        passages,
        failed,
        progress,
        model_ready,
        model,
    })
}

/// Starts (re)indexing in the background.
#[tauri::command]
pub fn knowledge_index(app: AppHandle) {
    tauri::async_runtime::spawn(async move { index(&app).await });
}

/// Search for the composer (models without tools get the hits as context).
#[tauri::command]
pub async fn knowledge_search(state: State<'_, AppState>, query: String) -> AppResult<Vec<Hit>> {
    search(&state, &query, RESULTS).await
}

/// Whether `path` is an existing file inside one of the folders. Both sides
/// are resolved first, so ".." or links can't point outside.
fn inside_folders(path: &str, folders: &[String]) -> bool {
    let Ok(target) = std::fs::canonicalize(path) else {
        return false;
    };
    target.is_file()
        && folders
            .iter()
            .filter_map(|f| std::fs::canonicalize(f).ok())
            .any(|f| target.starts_with(f))
}

/// Opens a source file, only when it lies in a knowledge folder.
#[tauri::command]
pub fn knowledge_open(app: AppHandle, state: State<'_, AppState>, path: String) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let (folders, _) = settings_of(&state);
    if !inside_folders(&path, &folders) {
        return Err(AppError::Other("not in a knowledge folder".into()));
    }
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| AppError::Other(e.to_string()))
}

/// Indexes once Ollama is up, when knowledge folders are set.
pub fn init(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        if settings_of(&state).0.is_empty() {
            return;
        }
        for _ in 0..60 {
            if state.status(crate::provider::ProviderKind::Ollama)
                == crate::provider::ProviderStatus::Running
            {
                index(&app).await;
                return;
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_cover_the_text_with_overlap() {
        let para = "Sentence number one is here. ".repeat(20);
        let text = format!("{para}\n\n{para}\n\n{para}");
        let chunks = chunk(&text);
        assert!(chunks.len() >= 2);
        assert!(chunks.iter().all(|c| c.chars().count() <= CHUNK_CHARS));
        // Tiny or empty texts give nothing.
        assert!(chunk("   \n\n ").is_empty());
        assert_eq!(chunk("A short note about the garden shed key.").len(), 1);
    }

    #[test]
    fn vectors_roundtrip_and_compare() {
        let v = vec![0.5f32, -1.25, 3.0];
        assert_eq!(from_blob(&to_blob(&v)), v);
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
        assert_eq!(cosine(&[1.0], &[1.0, 2.0]), 0.0);
    }

    #[test]
    fn only_files_inside_the_folders_open() {
        let dir = std::env::temp_dir().join(format!("zap-kb-test-{}", std::process::id()));
        let inner = dir.join("docs");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(inner.join("a.md"), "x").unwrap();
        std::fs::write(dir.join("secret.txt"), "x").unwrap();
        let folders = vec![inner.display().to_string()];
        assert!(inside_folders(
            &inner.join("a.md").display().to_string(),
            &folders
        ));
        assert!(!inside_folders(
            &inner.join("..").join("secret.txt").display().to_string(),
            &folders
        ));
        assert!(!inside_folders(
            &dir.join("secret.txt").display().to_string(),
            &folders
        ));
        assert!(
            !inside_folders(&inner.display().to_string(), &folders),
            "folders themselves don't open"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn supported_types() {
        assert!(supported(Path::new("C:/x/Rechnung.PDF")));
        assert!(supported(Path::new("notes.md")));
        assert!(supported(Path::new("brief.docx")));
        assert!(!supported(Path::new("photo.jpg")));
        assert!(!supported(Path::new("setup.exe")));
    }
}
