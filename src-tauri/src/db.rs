//! SQLite persistence: chats, messages, settings, full-text search, export.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const TITLE_MAX_CHARS: usize = 40;
const GENERATED_TITLE_MAX_WORDS: usize = 5;
const GENERATED_TITLE_MAX_CHARS: usize = 60;
/// Untitled chats are stored with an empty title; the UI shows "New chat" in
/// the active language. Older versions stored these literal titles.
pub const DEFAULT_TITLE: &str = "";
const LEGACY_DEFAULT_TITLES: [&str; 2] = ["Neuer Chat", "New chat"];

fn is_default_title(title: &str) -> bool {
    title.is_empty() || LEGACY_DEFAULT_TITLES.contains(&title)
}
pub const EXPORT_FORMAT: &str = "zap-export";
pub const EXPORT_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/// Applied in order; index + 1 is the schema version. Never edit a shipped
/// migration, append a new one instead.
const MIGRATIONS: &[&str] = &[
    // 1: base schema (IF NOT EXISTS so pre-migration databases adopt it)
    "CREATE TABLE IF NOT EXISTS chats (
         id TEXT PRIMARY KEY,
         title TEXT,
         model TEXT,
         created_at INTEGER,
         updated_at INTEGER
     );
     CREATE TABLE IF NOT EXISTS messages (
         id TEXT PRIMARY KEY,
         chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
         role TEXT CHECK(role IN ('system','user','assistant')),
         content TEXT,
         created_at INTEGER
     );
     CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
     CREATE TABLE IF NOT EXISTS settings (
         key TEXT PRIMARY KEY,
         value TEXT
     );",
    // 2: pinning, per-chat system prompt, per-message model + stats
    "ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE chats ADD COLUMN system_prompt TEXT;
     ALTER TABLE messages ADD COLUMN model TEXT;
     ALTER TABLE messages ADD COLUMN stats TEXT;",
    // 3: full-text search over titles and messages, kept in sync by triggers
    "CREATE VIRTUAL TABLE search_fts USING fts5(
         chat_id UNINDEXED,
         message_id UNINDEXED,
         kind UNINDEXED,
         body,
         tokenize = 'unicode61 remove_diacritics 2'
     );
     CREATE TRIGGER chats_fts_insert AFTER INSERT ON chats BEGIN
         INSERT INTO search_fts (chat_id, message_id, kind, body) VALUES (new.id, NULL, 'title', new.title);
     END;
     CREATE TRIGGER chats_fts_update AFTER UPDATE OF title ON chats BEGIN
         DELETE FROM search_fts WHERE kind = 'title' AND chat_id = old.id;
         INSERT INTO search_fts (chat_id, message_id, kind, body) VALUES (new.id, NULL, 'title', new.title);
     END;
     CREATE TRIGGER chats_fts_delete AFTER DELETE ON chats BEGIN
         DELETE FROM search_fts WHERE chat_id = old.id;
     END;
     CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
         INSERT INTO search_fts (chat_id, message_id, kind, body) VALUES (new.chat_id, new.id, 'msg', new.content);
     END;
     CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN
         DELETE FROM search_fts WHERE message_id = old.id;
         INSERT INTO search_fts (chat_id, message_id, kind, body) VALUES (new.chat_id, new.id, 'msg', new.content);
     END;
     CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
         DELETE FROM search_fts WHERE message_id = old.id;
     END;
     INSERT INTO search_fts (chat_id, message_id, kind, body)
         SELECT id, NULL, 'title', title FROM chats;
     INSERT INTO search_fts (chat_id, message_id, kind, body)
         SELECT chat_id, id, 'msg', content FROM messages;",
    // 4: language-neutral default title (UI renders "New chat" / "Neuer Chat")
    "UPDATE chats SET title = '' WHERE title IS NULL OR title IN ('Neuer Chat', 'New chat');",
    // 5: file attachments (JSON array, see Attachment in the frontend)
    "ALTER TABLE messages ADD COLUMN attachments TEXT;",
    // 6: lifetime token usage per model (survives deleting chats), seeded
    // from the stats of existing replies
    "CREATE TABLE usage_by_model (
         model TEXT PRIMARY KEY,
         prompt_tokens INTEGER NOT NULL DEFAULT 0,
         completion_tokens INTEGER NOT NULL DEFAULT 0,
         replies INTEGER NOT NULL DEFAULT 0,
         last_used INTEGER NOT NULL DEFAULT 0
     );
     INSERT INTO usage_by_model (model, prompt_tokens, completion_tokens, replies, last_used)
         SELECT model,
                COALESCE(SUM(json_extract(stats, '$.prompt_eval_count')), 0),
                COALESCE(SUM(json_extract(stats, '$.eval_count')), 0),
                COUNT(*),
                MAX(created_at)
         FROM messages
         WHERE role = 'assistant' AND stats IS NOT NULL AND model IS NOT NULL
         GROUP BY model;",
    // 7: web tools: activity per reply (JSON) and monthly search counter
    "ALTER TABLE messages ADD COLUMN tools TEXT;
     CREATE TABLE search_usage (
         month TEXT NOT NULL,
         provider TEXT NOT NULL,
         count INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (month, provider)
     );",
    // 8: user-defined chat groups (folders in the sidebar)
    "CREATE TABLE chat_groups (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         position INTEGER NOT NULL,
         collapsed INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL
     );
     ALTER TABLE chats ADD COLUMN group_id TEXT REFERENCES chat_groups(id) ON DELETE SET NULL;
     CREATE INDEX chats_group ON chats(group_id);",
    // 9: optional color code per group ("#rrggbb")
    "ALTER TABLE chat_groups ADD COLUMN color TEXT;",
];

pub fn schema_version(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |r| r.get(0),
    )?)
}

fn migrate(conn: &mut Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
             version INTEGER PRIMARY KEY,
             applied_at INTEGER NOT NULL
         );",
    )?;
    let current = schema_version(conn)?;
    for (idx, sql) in MIGRATIONS.iter().enumerate() {
        let version = idx as i64 + 1;
        if version <= current {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            params![version, now_ms()],
        )?;
        tx.commit()?;
    }
    Ok(())
}

pub fn open(path: &Path) -> AppResult<Connection> {
    let mut conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;",
    )?;
    migrate(&mut conn)?;
    Ok(conn)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chat {
    pub id: String,
    pub title: String,
    pub model: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Sidebar group; not carried over by import (groups aren't exported).
    #[serde(default)]
    pub group_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatGroup {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub collapsed: bool,
    /// "#rrggbb", `None` for the default look.
    pub color: Option<String>,
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|c| c.is_ascii_hexdigit())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub chat_id: String,
    pub role: String,
    pub content: String,
    pub created_at: i64,
    #[serde(default)]
    pub model: Option<String>,
    /// JSON-encoded generation stats (see `provider::ChatStats`).
    #[serde(default)]
    pub stats: Option<String>,
    /// JSON array of attachments (name, kind, mime, size, data). Opaque here.
    #[serde(default)]
    pub attachments: Option<String>,
    /// JSON array of tool activity (searches, pages read). Opaque here.
    #[serde(default)]
    pub tools: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub default_model: Option<String>,
    pub system_prompt: String,
    pub temperature: f32,
    /// Ollama `num_ctx`; `None` keeps the model default.
    pub context_length: Option<u32>,
    /// "dark" | "light" | "system"
    pub theme: String,
    pub font_size: u8,
    /// "comfortable" | "compact"
    pub density: String,
    pub onboarding_done: bool,
    pub sidebar_width: u32,
    pub sidebar_collapsed: bool,
    /// UI language: "en" (default) | "de"
    pub language: String,
    pub ollama_enabled: bool,
    pub lmstudio_enabled: bool,
    pub lmstudio_port: u16,
    /// Offer web search to tool-capable models (opt-in).
    pub web_search_enabled: bool,
    /// "builtin" | "brave" | "searxng"
    pub search_provider: String,
    pub searxng_url: String,
    /// Brave searches per calendar month before ZAP stops searching.
    pub search_monthly_limit: u32,
    /// Offer file tools (search, read, write, edit, delete) to tool-capable models.
    pub file_tools_enabled: bool,
    /// "ask" (approve every step) | "full" (no questions)
    pub file_permission: String,
    /// Look for a new ZAP version on startup.
    pub auto_update: bool,
    /// Color preset id, or "custom" for `custom_accent` / `custom_tint`.
    pub palette: String,
    /// "#rrggbb" accent for the custom palette.
    pub custom_accent: String,
    /// "#rrggbb" background tint for the custom palette.
    pub custom_tint: String,
    /// Chat font: "inter" | "system" | "serif" | "mono"
    pub font_family: String,
    /// Chat line height as a multiple of the font size.
    pub line_height: f32,
    /// Chat letter spacing in em.
    pub letter_spacing: f32,
    /// Space between chat paragraphs in em.
    pub paragraph_spacing: f32,
    /// Cards on the new-chat screen; `None` shows the built-in suggestions.
    pub blueprints: Option<Vec<Blueprint>>,
    /// App version whose "What's new" the user has seen.
    pub last_seen_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Blueprint {
    pub title: String,
    pub prompt: String,
    pub icon: String,
    /// Send right away instead of putting the text into the composer.
    #[serde(default)]
    pub send: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            default_model: None,
            system_prompt: String::new(),
            temperature: 0.7,
            context_length: None,
            theme: "dark".into(),
            font_size: 16,
            density: "comfortable".into(),
            onboarding_done: false,
            sidebar_width: 280,
            sidebar_collapsed: false,
            language: "en".into(),
            ollama_enabled: true,
            lmstudio_enabled: false,
            lmstudio_port: 1234,
            web_search_enabled: false,
            search_provider: "builtin".into(),
            searxng_url: "http://127.0.0.1:8888".into(),
            search_monthly_limit: 900,
            file_tools_enabled: false,
            file_permission: "ask".into(),
            auto_update: true,
            palette: "zap".into(),
            custom_accent: "#fd614b".into(),
            custom_tint: "#3283be".into(),
            font_family: "inter".into(),
            line_height: 1.625,
            letter_spacing: 0.0,
            paragraph_spacing: 0.875,
            blueprints: None,
            last_seen_version: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub chat: Chat,
    /// Matching message excerpt; `None` when only the title matched.
    pub snippet: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportedChat {
    #[serde(flatten)]
    pub chat: Chat,
    pub messages: Vec<Message>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportFile {
    pub format: String,
    pub version: u32,
    pub exported_at: i64,
    pub chats: Vec<ExportedChat>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

const CHAT_COLUMNS: &str =
    "id, title, model, created_at, updated_at, pinned, system_prompt, group_id";

fn row_to_chat(row: &rusqlite::Row<'_>) -> rusqlite::Result<Chat> {
    Ok(Chat {
        id: row.get(0)?,
        title: row
            .get::<_, Option<String>>(1)?
            .unwrap_or_else(|| DEFAULT_TITLE.into()),
        model: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        pinned: row.get::<_, i64>(5)? != 0,
        system_prompt: row.get(6)?,
        group_id: row.get(7)?,
    })
}

pub fn get_chat(conn: &Connection, id: &str) -> AppResult<Option<Chat>> {
    Ok(conn
        .query_row(
            &format!("SELECT {CHAT_COLUMNS} FROM chats WHERE id = ?1"),
            [id],
            row_to_chat,
        )
        .optional()?)
}

pub fn create_chat(conn: &Connection, model: Option<String>) -> AppResult<Chat> {
    let now = now_ms();
    let chat = Chat {
        id: uuid::Uuid::new_v4().to_string(),
        title: DEFAULT_TITLE.into(),
        model,
        created_at: now,
        updated_at: now,
        pinned: false,
        system_prompt: None,
        group_id: None,
    };
    conn.execute(
        "INSERT INTO chats (id, title, model, created_at, updated_at, pinned) VALUES (?1, ?2, ?3, ?4, ?5, 0)",
        params![chat.id, chat.title, chat.model, chat.created_at, chat.updated_at],
    )?;
    Ok(chat)
}

pub fn list_chats(conn: &Connection) -> AppResult<Vec<Chat>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {CHAT_COLUMNS} FROM chats ORDER BY pinned DESC, updated_at DESC"
    ))?;
    let chats = stmt
        .query_map([], row_to_chat)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(chats)
}

pub fn rename_chat(conn: &Connection, id: &str, title: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE chats SET title = ?1 WHERE id = ?2",
        params![title, id],
    )?;
    Ok(())
}

pub fn pin_chat(conn: &Connection, id: &str, pinned: bool) -> AppResult<()> {
    conn.execute(
        "UPDATE chats SET pinned = ?1 WHERE id = ?2",
        params![pinned as i64, id],
    )?;
    Ok(())
}

/// Moves a chat into a group, or out of all groups with `None`.
pub fn set_chat_group(conn: &Connection, id: &str, group_id: Option<&str>) -> AppResult<()> {
    conn.execute(
        "UPDATE chats SET group_id = ?1 WHERE id = ?2",
        params![group_id, id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Chat groups
// ---------------------------------------------------------------------------

pub fn list_groups(conn: &Connection) -> AppResult<Vec<ChatGroup>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, position, collapsed, color FROM chat_groups ORDER BY position, created_at",
    )?;
    let groups = stmt
        .query_map([], |r| {
            Ok(ChatGroup {
                id: r.get(0)?,
                name: r.get(1)?,
                position: r.get(2)?,
                collapsed: r.get::<_, i64>(3)? != 0,
                color: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(groups)
}

/// New groups go to the end of the list.
pub fn create_group(conn: &Connection, name: &str) -> AppResult<ChatGroup> {
    let position: i64 = conn.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM chat_groups",
        [],
        |r| r.get(0),
    )?;
    let group = ChatGroup {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.trim().to_string(),
        position,
        collapsed: false,
        color: None,
    };
    conn.execute(
        "INSERT INTO chat_groups (id, name, position, collapsed, created_at) VALUES (?1, ?2, ?3, 0, ?4)",
        params![group.id, group.name, group.position, now_ms()],
    )?;
    Ok(group)
}

pub fn rename_group(conn: &Connection, id: &str, name: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE chat_groups SET name = ?1 WHERE id = ?2",
        params![name.trim(), id],
    )?;
    Ok(())
}

/// Sets or clears the group's color; anything but "#rrggbb" clears it.
pub fn set_group_color(conn: &Connection, id: &str, color: Option<&str>) -> AppResult<()> {
    let color = color
        .filter(|c| is_hex_color(c))
        .map(str::to_ascii_lowercase);
    conn.execute(
        "UPDATE chat_groups SET color = ?1 WHERE id = ?2",
        params![color, id],
    )?;
    Ok(())
}

pub fn set_group_collapsed(conn: &Connection, id: &str, collapsed: bool) -> AppResult<()> {
    conn.execute(
        "UPDATE chat_groups SET collapsed = ?1 WHERE id = ?2",
        params![collapsed as i64, id],
    )?;
    Ok(())
}

/// Stores the given order; ids not in the list keep their position.
pub fn reorder_groups(conn: &mut Connection, ids: &[String]) -> AppResult<()> {
    let tx = conn.transaction()?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE chat_groups SET position = ?1 WHERE id = ?2",
            params![i as i64, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Deletes a group; with `delete_chats` its chats go too, otherwise they
/// become ungrouped (FK `ON DELETE SET NULL`). Returns the deleted chat ids.
pub fn delete_group(conn: &mut Connection, id: &str, delete_chats: bool) -> AppResult<Vec<String>> {
    let tx = conn.transaction()?;
    let mut deleted = Vec::new();
    if delete_chats {
        let mut stmt = tx.prepare("SELECT id FROM chats WHERE group_id = ?1")?;
        deleted = stmt
            .query_map([id], |r| r.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        drop(stmt);
        tx.execute("DELETE FROM chats WHERE group_id = ?1", [id])?;
    }
    tx.execute("DELETE FROM chat_groups WHERE id = ?1", [id])?;
    tx.commit()?;
    Ok(deleted)
}

pub fn set_chat_model(conn: &Connection, id: &str, model: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE chats SET model = ?1 WHERE id = ?2",
        params![model, id],
    )?;
    Ok(())
}

pub fn delete_chat(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM chats WHERE id = ?1", [id])?;
    Ok(())
}

pub fn delete_all_chats(conn: &mut Connection) -> AppResult<()> {
    let tx = conn.transaction()?;
    tx.execute_batch("DELETE FROM messages; DELETE FROM chats; DELETE FROM search_fts;")?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const MESSAGE_COLUMNS: &str =
    "id, chat_id, role, content, created_at, model, stats, attachments, tools";

fn row_to_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<Message> {
    Ok(Message {
        id: row.get(0)?,
        chat_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        created_at: row.get(4)?,
        model: row.get(5)?,
        stats: row.get(6)?,
        attachments: row.get(7)?,
        tools: row.get(8)?,
    })
}

pub fn get_messages(conn: &Connection, chat_id: &str) -> AppResult<Vec<Message>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {MESSAGE_COLUMNS} FROM messages WHERE chat_id = ?1 ORDER BY created_at ASC, rowid ASC"
    ))?;
    let messages = stmt
        .query_map([chat_id], row_to_message)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(messages)
}

/// Builds the fallback chat title from the first user message.
pub fn title_from(content: &str) -> String {
    let flat = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= TITLE_MAX_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(TITLE_MAX_CHARS).collect();
    let trimmed = match cut.rfind(' ') {
        Some(idx) if idx > TITLE_MAX_CHARS / 2 => &cut[..idx],
        _ => cut.as_str(),
    };
    format!("{}…", trimmed.trim_end())
}

/// Upserts a message (UPDATE on conflict, so FTS triggers stay correct),
/// bumps the chat and sets the fallback title from the first user message.
pub fn save_message(conn: &mut Connection, msg: &Message) -> AppResult<Option<Chat>> {
    let tx = conn.transaction()?;
    let is_new: bool = tx
        .query_row(
            "SELECT 1 FROM messages WHERE id = ?1",
            [&msg.id],
            |_| Ok(()),
        )
        .optional()?
        .is_none();
    tx.execute(
        "INSERT INTO messages (id, chat_id, role, content, created_at, model, stats, attachments, tools)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
             content = excluded.content,
             model = excluded.model,
             stats = excluded.stats,
             attachments = excluded.attachments,
             tools = excluded.tools",
        params![
            msg.id,
            msg.chat_id,
            msg.role,
            msg.content,
            msg.created_at,
            msg.model,
            msg.stats,
            msg.attachments,
            msg.tools
        ],
    )?;
    tx.execute(
        "UPDATE chats SET updated_at = ?1 WHERE id = ?2",
        params![now_ms(), msg.chat_id],
    )?;
    // Count each generated reply once (re-saving the same id doesn't add up).
    if is_new && msg.role == "assistant" {
        if let (Some(model), Some(stats)) = (&msg.model, &msg.stats) {
            record_usage(&tx, model, stats, msg.created_at)?;
        }
    }
    if msg.role == "user" {
        let title = title_from(&msg.content);
        if !title.is_empty() {
            tx.execute(
                "UPDATE chats SET title = ?1
                 WHERE id = ?2 AND (title IS NULL OR title IN ('', ?3, ?4))",
                params![
                    title,
                    msg.chat_id,
                    LEGACY_DEFAULT_TITLES[0],
                    LEGACY_DEFAULT_TITLES[1]
                ],
            )?;
        }
    }
    tx.commit()?;
    get_chat(conn, &msg.chat_id)
}

pub fn update_message(conn: &Connection, id: &str, content: &str) -> AppResult<()> {
    let changed = conn.execute(
        "UPDATE messages SET content = ?1 WHERE id = ?2",
        params![content, id],
    )?;
    if changed == 0 {
        return Err(AppError::Other("message not found".into()));
    }
    conn.execute(
        "UPDATE chats SET updated_at = ?1 WHERE id = (SELECT chat_id FROM messages WHERE id = ?2)",
        params![now_ms(), id],
    )?;
    Ok(())
}

pub fn delete_message(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM messages WHERE id = ?1", [id])?;
    Ok(())
}

/// Deletes every message of `chat_id` that comes after `message_id`
/// (the message itself is kept). Returns the number of deleted rows.
pub fn delete_messages_after(
    conn: &Connection,
    chat_id: &str,
    message_id: &str,
) -> AppResult<usize> {
    let anchor: Option<(i64, i64)> = conn
        .query_row(
            "SELECT created_at, rowid FROM messages WHERE id = ?1 AND chat_id = ?2",
            params![message_id, chat_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((created_at, rowid)) = anchor else {
        return Err(AppError::Other("message not found".into()));
    };
    Ok(conn.execute(
        "DELETE FROM messages
         WHERE chat_id = ?1 AND (created_at > ?2 OR (created_at = ?2 AND rowid > ?3))",
        params![chat_id, created_at, rowid],
    )?)
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

/// First user message and first assistant reply of a chat.
pub fn first_exchange(
    conn: &Connection,
    chat_id: &str,
) -> AppResult<(Option<String>, Option<String>)> {
    let first = |role: &str| -> AppResult<Option<String>> {
        Ok(conn
            .query_row(
                "SELECT content FROM messages WHERE chat_id = ?1 AND role = ?2
                 ORDER BY created_at ASC, rowid ASC LIMIT 1",
                params![chat_id, role],
                |r| r.get(0),
            )
            .optional()?)
    };
    Ok((first("user")?, first("assistant")?))
}

/// Normalizes a model-generated title: drops reasoning blocks, quotes,
/// prefixes and trailing punctuation; at most 5 words / 60 chars.
pub fn clean_generated_title(raw: &str) -> Option<String> {
    let mut text = raw.to_string();
    while let (Some(start), Some(end)) = (text.find("<think>"), text.find("</think>")) {
        if end < start {
            break;
        }
        text.replace_range(start..end + "</think>".len(), "");
    }
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let line = ["Titel:", "Title:", "titel:", "title:"]
        .iter()
        .find_map(|p| line.strip_prefix(*p))
        .unwrap_or(line);
    let trimmed = line.trim_matches(|c: char| {
        c.is_whitespace()
            || matches!(
                c,
                '"' | '\'' | '*' | '#' | '`' | '“' | '”' | '„' | '«' | '»' | '.' | ':' | '!'
            )
    });
    let words: Vec<&str> = trimmed
        .split_whitespace()
        .take(GENERATED_TITLE_MAX_WORDS)
        .collect();
    let mut title = words.join(" ");
    if title.chars().count() > GENERATED_TITLE_MAX_CHARS {
        title = title
            .chars()
            .take(GENERATED_TITLE_MAX_CHARS)
            .collect::<String>()
            .trim_end()
            .to_string();
    }
    let title = title
        .trim_end_matches([',', ';', '-', '–'])
        .trim()
        .to_string();
    (!title.is_empty()).then_some(title)
}

/// Replaces the title only while it is still automatic (default or the
/// first-message fallback), so a manual rename always wins.
pub fn apply_generated_title(
    conn: &Connection,
    chat_id: &str,
    title: &str,
) -> AppResult<Option<Chat>> {
    let Some(chat) = get_chat(conn, chat_id)? else {
        return Ok(None);
    };
    let (first_user, _) = first_exchange(conn, chat_id)?;
    let fallback = first_user.as_deref().map(title_from).unwrap_or_default();
    if is_default_title(&chat.title) || chat.title == fallback {
        rename_chat(conn, chat_id, title)?;
    }
    get_chat(conn, chat_id)
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/// Turns free text into a safe FTS5 query: every word becomes a quoted
/// prefix term, all terms must match.
pub fn fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split_whitespace()
        .map(|w| w.replace('"', ""))
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .map(|w| format!("\"{w}\"*"))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

pub fn search_chats(conn: &Connection, query: &str, limit: usize) -> AppResult<Vec<SearchHit>> {
    let Some(fts) = fts_query(query) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT c.id, c.title, c.model, c.created_at, c.updated_at, c.pinned, c.system_prompt,
                search_fts.kind, snippet(search_fts, 3, '', '', '…', 12)
         FROM search_fts
         JOIN chats c ON c.id = search_fts.chat_id
         WHERE search_fts MATCH ?1
         ORDER BY rank
         LIMIT 500",
    )?;
    let rows = stmt.query_map([fts], |row| {
        let chat = row_to_chat(row)?;
        let kind: String = row.get(7)?;
        let snippet: String = row.get(8)?;
        Ok((chat, kind, snippet))
    })?;

    let mut hits: Vec<SearchHit> = Vec::new();
    for row in rows {
        let (chat, kind, snippet) = row?;
        let snippet =
            (kind == "msg").then(|| snippet.split_whitespace().collect::<Vec<_>>().join(" "));
        if let Some(hit) = hits.iter_mut().find(|h| h.chat.id == chat.id) {
            if hit.snippet.is_none() {
                hit.snippet = snippet;
            }
        } else if hits.len() < limit {
            hits.push(SearchHit { chat, snippet });
        }
    }
    Ok(hits)
}

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ModelUsage {
    pub model: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub replies: i64,
    pub last_used: i64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct ChatUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub replies: i64,
}

/// Adds one reply's tokens (from its stats JSON) to the per-model totals.
fn record_usage(conn: &Connection, model: &str, stats: &str, at: i64) -> AppResult<()> {
    let stats: serde_json::Value = serde_json::from_str(stats).unwrap_or_default();
    let count = |key: &str| {
        stats
            .get(key)
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0)
    };
    conn.execute(
        "INSERT INTO usage_by_model (model, prompt_tokens, completion_tokens, replies, last_used)
         VALUES (?1, ?2, ?3, 1, ?4)
         ON CONFLICT(model) DO UPDATE SET
             prompt_tokens = prompt_tokens + excluded.prompt_tokens,
             completion_tokens = completion_tokens + excluded.completion_tokens,
             replies = replies + 1,
             last_used = MAX(last_used, excluded.last_used)",
        params![model, count("prompt_eval_count"), count("eval_count"), at],
    )?;
    Ok(())
}

/// Lifetime usage per model, most tokens first.
pub fn usage_by_model(conn: &Connection) -> AppResult<Vec<ModelUsage>> {
    let mut stmt = conn.prepare(
        "SELECT model, prompt_tokens, completion_tokens, replies, last_used FROM usage_by_model
         ORDER BY prompt_tokens + completion_tokens DESC, model ASC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ModelUsage {
                model: r.get(0)?,
                prompt_tokens: r.get(1)?,
                completion_tokens: r.get(2)?,
                replies: r.get(3)?,
                last_used: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Tokens used by the replies currently in one chat.
pub fn chat_usage(conn: &Connection, chat_id: &str) -> AppResult<ChatUsage> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(json_extract(stats, '$.prompt_eval_count')), 0),
                COALESCE(SUM(json_extract(stats, '$.eval_count')), 0),
                COUNT(*)
         FROM messages WHERE chat_id = ?1 AND role = 'assistant' AND stats IS NOT NULL",
        [chat_id],
        |r| {
            Ok(ChatUsage {
                prompt_tokens: r.get(0)?,
                completion_tokens: r.get(1)?,
                replies: r.get(2)?,
            })
        },
    )?)
}

pub fn reset_usage(conn: &Connection) -> AppResult<()> {
    conn.execute("DELETE FROM usage_by_model", [])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Search usage (for the Brave monthly limit and the settings display)
// ---------------------------------------------------------------------------

/// `(year, month, day)` of a Unix timestamp in ms (UTC, civil calendar).
pub fn ymd(ms: i64) -> (i64, i64, i64) {
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

pub fn current_month() -> String {
    let (y, m, _) = ymd(now_ms());
    format!("{y:04}-{m:02}")
}

pub fn search_count(conn: &Connection, month: &str, provider: &str) -> AppResult<i64> {
    Ok(conn
        .query_row(
            "SELECT count FROM search_usage WHERE month = ?1 AND provider = ?2",
            params![month, provider],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0))
}

pub fn record_search(conn: &Connection, month: &str, provider: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO search_usage (month, provider, count) VALUES (?1, ?2, 1)
         ON CONFLICT(month, provider) DO UPDATE SET count = count + 1",
        params![month, provider],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

pub fn get_settings(conn: &Connection) -> AppResult<Settings> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = 'app'", [], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default())
}

pub fn set_settings(conn: &Connection, settings: &Settings) -> AppResult<()> {
    let value = serde_json::to_string(settings).unwrap_or_default();
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('app', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [value],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

pub fn export_chats(conn: &Connection, only: Option<&str>) -> AppResult<ExportFile> {
    let chats = match only {
        Some(id) => get_chat(conn, id)?.into_iter().collect(),
        None => list_chats(conn)?,
    };
    let chats = chats
        .into_iter()
        .map(|chat| {
            Ok(ExportedChat {
                messages: get_messages(conn, &chat.id)?,
                chat,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(ExportFile {
        format: EXPORT_FORMAT.into(),
        version: EXPORT_VERSION,
        exported_at: now_ms(),
        chats,
    })
}

/// File names from a message's attachments JSON (for the Markdown export).
fn attachment_names(json: Option<&str>) -> Vec<String> {
    json.and_then(|s| serde_json::from_str::<Vec<serde_json::Value>>(s).ok())
        .unwrap_or_default()
        .iter()
        .filter_map(|a| {
            a.get("name")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

/// Markdown export with headings in the UI language (`"de"` or English).
pub fn chat_to_markdown(chat: &Chat, messages: &[Message], lang: &str) -> String {
    let german = lang == "de";
    let (untitled, model_label, you, attachments_label) = if german {
        ("Neuer Chat", "Modell", "Du", "Anhänge")
    } else {
        ("New chat", "Model", "You", "Attachments")
    };
    let title = if is_default_title(&chat.title) {
        untitled
    } else {
        chat.title.as_str()
    };
    let mut out = format!("# {title}\n\n");
    if let Some(model) = &chat.model {
        let model = crate::provider::parse_model_key(model).1;
        out.push_str(&format!("_{model_label}: {model}_\n\n"));
    }
    for msg in messages {
        let who = match msg.role.as_str() {
            "user" => you,
            "assistant" => "ZAP",
            _ => "System",
        };
        out.push_str(&format!("## {who}\n\n"));
        let names = attachment_names(msg.attachments.as_deref());
        if !names.is_empty() {
            out.push_str(&format!("_{attachments_label}: {}_\n\n", names.join(", ")));
        }
        out.push_str(&format!("{}\n\n", msg.content.trim_end()));
    }
    out
}

/// Imports chats from an export file. Chats whose id already exists are
/// skipped, so importing the same file twice is harmless. Returns the number
/// of imported chats.
pub fn import_chats(conn: &mut Connection, file: &ExportFile) -> AppResult<usize> {
    if file.format != EXPORT_FORMAT {
        return Err(AppError::Other("not a ZAP export".into()));
    }
    if file.version > EXPORT_VERSION {
        return Err(AppError::Other(format!(
            "unsupported export version {}",
            file.version
        )));
    }
    let tx = conn.transaction()?;
    let mut imported = 0;
    for entry in &file.chats {
        let c = &entry.chat;
        let inserted = tx.execute(
            "INSERT INTO chats (id, title, model, created_at, updated_at, pinned, system_prompt)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(id) DO NOTHING",
            params![
                c.id,
                c.title,
                c.model,
                c.created_at,
                c.updated_at,
                c.pinned as i64,
                c.system_prompt
            ],
        )?;
        if inserted == 0 {
            continue;
        }
        for m in &entry.messages {
            if !matches!(m.role.as_str(), "system" | "user" | "assistant") {
                continue;
            }
            tx.execute(
                "INSERT INTO messages (id, chat_id, role, content, created_at, model, stats, attachments, tools)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(id) DO NOTHING",
                params![m.id, c.id, m.role, m.content, m.created_at, m.model, m.stats, m.attachments, m.tools],
            )?;
        }
        imported += 1;
    }
    tx.commit()?;
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        open(Path::new(":memory:")).unwrap()
    }

    #[test]
    fn chat_groups_lifecycle() {
        let mut conn = mem();
        let work = create_group(&conn, "  Work ").unwrap();
        let home = create_group(&conn, "Home").unwrap();
        assert_eq!(work.name, "Work");
        assert_eq!((work.position, home.position), (0, 1));

        let a = create_chat(&conn, None).unwrap();
        let b = create_chat(&conn, None).unwrap();
        set_chat_group(&conn, &a.id, Some(&work.id)).unwrap();
        set_chat_group(&conn, &b.id, Some(&home.id)).unwrap();
        assert_eq!(
            get_chat(&conn, &a.id).unwrap().unwrap().group_id,
            Some(work.id.clone())
        );

        rename_group(&conn, &work.id, "Job").unwrap();
        set_group_color(&conn, &home.id, Some("#3B82F6")).unwrap();
        set_group_color(&conn, &work.id, Some("red")).unwrap();
        let colors: Vec<_> = list_groups(&conn)
            .unwrap()
            .into_iter()
            .map(|g| g.color)
            .collect();
        assert_eq!(colors, vec![None, Some("#3b82f6".to_string())]);
        set_group_collapsed(&conn, &work.id, true).unwrap();
        reorder_groups(&mut conn, &[home.id.clone(), work.id.clone()]).unwrap();
        let groups = list_groups(&conn).unwrap();
        assert_eq!(groups[0].id, home.id);
        assert_eq!(
            (groups[1].name.as_str(), groups[1].collapsed),
            ("Job", true)
        );

        // Keeping chats ungroups them; deleting chats removes them.
        assert!(delete_group(&mut conn, &work.id, false).unwrap().is_empty());
        assert_eq!(get_chat(&conn, &a.id).unwrap().unwrap().group_id, None);
        assert_eq!(
            delete_group(&mut conn, &home.id, true).unwrap(),
            vec![b.id.clone()]
        );
        assert!(get_chat(&conn, &b.id).unwrap().is_none());
        assert!(list_groups(&conn).unwrap().is_empty());
    }

    #[test]
    fn settings_keep_appearance_and_blueprints() {
        let conn = mem();
        // Settings saved before these fields existed load with defaults.
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('app', '{\"theme\":\"light\"}')",
            [],
        )
        .unwrap();
        let old = get_settings(&conn).unwrap();
        assert_eq!(old.theme, "light");
        assert_eq!(old.palette, "zap");
        assert!(old.blueprints.is_none());

        let mut s = old;
        s.palette = "custom".into();
        s.custom_accent = "#00ff88".into();
        s.line_height = 1.9;
        s.blueprints = Some(vec![Blueprint {
            title: "Summarize".into(),
            prompt: "Summarize:\n\n".into(),
            icon: "list".into(),
            send: true,
        }]);
        set_settings(&conn, &s).unwrap();
        let back = get_settings(&conn).unwrap();
        assert_eq!(back.palette, "custom");
        assert_eq!(back.custom_accent, "#00ff88");
        assert!((back.line_height - 1.9).abs() < f32::EPSILON);
        assert_eq!(back.blueprints, s.blueprints);
    }

    fn msg(id: &str, chat_id: &str, role: &str, content: &str, at: i64) -> Message {
        Message {
            id: id.into(),
            chat_id: chat_id.into(),
            role: role.into(),
            content: content.into(),
            created_at: at,
            model: None,
            stats: None,
            attachments: None,
            tools: None,
        }
    }

    #[test]
    fn attachments_roundtrip_and_export() {
        let mut conn = mem();
        let chat = create_chat(&conn, None).unwrap();
        let mut m = msg("m1", &chat.id, "user", "Look at this", 1);
        m.attachments = Some(
            r#"[{"name":"cat.jpg","kind":"image"},{"name":"notes.txt","kind":"text"}]"#.into(),
        );
        save_message(&mut conn, &m).unwrap();
        let stored = &get_messages(&conn, &chat.id).unwrap()[0];
        assert_eq!(stored.attachments, m.attachments);
        let md = chat_to_markdown(
            &get_chat(&conn, &chat.id).unwrap().unwrap(),
            std::slice::from_ref(stored),
            "en",
        );
        assert!(md.contains("_Attachments: cat.jpg, notes.txt_"));
        assert_eq!(attachment_names(Some("not json")), Vec::<String>::new());
    }

    #[test]
    fn title_fallback_is_trimmed_and_shortened() {
        assert_eq!(title_from("  Hallo   Welt \n"), "Hallo Welt");
        let t = title_from("Erkläre mir bitte ausführlich wie ein Verbrennungsmotor funktioniert");
        assert!(t.ends_with('…'));
        assert!(t.chars().count() <= TITLE_MAX_CHARS + 1);
        // Multi-byte characters must never be cut mid-codepoint.
        let t = title_from(&"ä".repeat(80));
        assert_eq!(t.chars().count(), TITLE_MAX_CHARS + 1);
    }

    #[test]
    fn generated_titles_are_cleaned() {
        assert_eq!(
            clean_generated_title("\"Rezept für Pfannkuchen.\"").as_deref(),
            Some("Rezept für Pfannkuchen")
        );
        assert_eq!(
            clean_generated_title("Titel: **Rust Lifetimes erklärt**").as_deref(),
            Some("Rust Lifetimes erklärt")
        );
        assert_eq!(
            clean_generated_title(
                "<think>hmm</think>\n\nEin sehr langer Titel mit vielen Wörtern hier"
            )
            .as_deref(),
            Some("Ein sehr langer Titel mit")
        );
        assert_eq!(clean_generated_title("  \n  "), None);
    }

    #[test]
    fn migrations_are_idempotent() {
        let mut conn = mem();
        let v = schema_version(&conn).unwrap();
        assert_eq!(v, MIGRATIONS.len() as i64);
        migrate(&mut conn).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), v);
        // New columns exist.
        conn.execute_batch(
            "SELECT pinned, system_prompt FROM chats; SELECT model, stats FROM messages;",
        )
        .unwrap();
    }

    #[test]
    fn migrates_a_pre_migration_database() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATIONS[0]).unwrap();
        conn.execute(
            "INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c', 'Alt', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES ('m', 'c', 'user', 'Kartoffelsalat', 1)",
            [],
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        let hits = search_chats(&conn, "kartoffel", 10).unwrap();
        assert_eq!(hits.len(), 1, "backfill must index old messages");
    }

    #[test]
    fn crud_and_auto_title() {
        let mut conn = mem();
        let chat = create_chat(&conn, Some("llama3.2:3b".into())).unwrap();
        let updated = save_message(
            &mut conn,
            &msg("m1", &chat.id, "user", "Wie spät ist es?", 1),
        )
        .unwrap()
        .unwrap();
        assert_eq!(updated.title, "Wie spät ist es?");
        assert_eq!(get_messages(&conn, &chat.id).unwrap().len(), 1);
        delete_chat(&conn, &chat.id).unwrap();
        assert!(get_messages(&conn, &chat.id).unwrap().is_empty());
    }

    #[test]
    fn generated_title_respects_manual_rename() {
        let mut conn = mem();
        let chat = create_chat(&conn, None).unwrap();
        save_message(&mut conn, &msg("m1", &chat.id, "user", "Hallo", 1)).unwrap();
        let c = apply_generated_title(&conn, &chat.id, "Begrüßung")
            .unwrap()
            .unwrap();
        assert_eq!(c.title, "Begrüßung");
        rename_chat(&conn, &chat.id, "Mein Name").unwrap();
        // "Mein Name" is neither default nor fallback anymore → untouched.
        let c = apply_generated_title(&conn, &chat.id, "Anders")
            .unwrap()
            .unwrap();
        assert_eq!(c.title, "Mein Name");
    }

    #[test]
    fn token_usage_per_model_and_chat() {
        let mut conn = mem();
        let chat = create_chat(&conn, None).unwrap();
        let reply = |id: &str, model: &str, prompt: u64, out: u64, at: i64| {
            let mut m = msg(id, &chat.id, "assistant", "x", at);
            m.model = Some(model.into());
            m.stats = Some(format!(
                r#"{{"eval_count":{out},"prompt_eval_count":{prompt},"eval_duration_ns":1,"total_duration_ns":1,"tokens_per_sec":1.0}}"#
            ));
            m
        };
        save_message(&mut conn, &reply("a1", "llama3.2:3b", 10, 5, 1)).unwrap();
        save_message(&mut conn, &reply("a2", "lmstudio::qwen", 100, 50, 2)).unwrap();
        save_message(&mut conn, &reply("a3", "llama3.2:3b", 20, 7, 3)).unwrap();
        // Re-saving the same reply must not count twice.
        save_message(&mut conn, &reply("a3", "llama3.2:3b", 20, 7, 3)).unwrap();

        let usage = usage_by_model(&conn).unwrap();
        assert_eq!(usage[0].model, "lmstudio::qwen", "sorted by total tokens");
        assert_eq!(
            usage[1],
            ModelUsage {
                model: "llama3.2:3b".into(),
                prompt_tokens: 30,
                completion_tokens: 12,
                replies: 2,
                last_used: 3
            }
        );
        assert_eq!(
            chat_usage(&conn, &chat.id).unwrap(),
            ChatUsage {
                prompt_tokens: 130,
                completion_tokens: 62,
                replies: 3
            }
        );

        // Deleting the chat keeps the lifetime totals; reset clears them.
        delete_chat(&conn, &chat.id).unwrap();
        assert_eq!(chat_usage(&conn, &chat.id).unwrap(), ChatUsage::default());
        assert_eq!(usage_by_model(&conn).unwrap().len(), 2);
        reset_usage(&conn).unwrap();
        assert!(usage_by_model(&conn).unwrap().is_empty());
    }

    #[test]
    fn usage_is_seeded_from_existing_replies() {
        let mut conn = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..5] {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute_batch(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
             INSERT INTO schema_migrations VALUES (1,0),(2,0),(3,0),(4,0),(5,0);
             INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c', '', 1, 1);
             INSERT INTO messages (id, chat_id, role, content, created_at, model, stats)
                 VALUES ('m', 'c', 'assistant', 'x', 5, 'gemma2:2b', '{\"eval_count\": 9}');",
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        let usage = usage_by_model(&conn).unwrap();
        assert_eq!(usage.len(), 1);
        assert_eq!(
            (
                usage[0].completion_tokens,
                usage[0].prompt_tokens,
                usage[0].replies
            ),
            (9, 0, 1)
        );
    }

    #[test]
    fn counts_searches_per_month_and_provider() {
        let conn = mem();
        assert_eq!(search_count(&conn, "2026-11", "brave").unwrap(), 0);
        record_search(&conn, "2026-11", "brave").unwrap();
        record_search(&conn, "2026-11", "brave").unwrap();
        record_search(&conn, "2026-11", "builtin").unwrap();
        record_search(&conn, "2026-12", "brave").unwrap();
        assert_eq!(search_count(&conn, "2026-11", "brave").unwrap(), 2);
        assert_eq!(ymd(1_709_164_800_000), (2024, 2, 29));
        assert_eq!(current_month().len(), 7);
    }

    #[test]
    fn legacy_default_titles_are_migrated_and_replaced() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATIONS[0]).unwrap();
        conn.execute("INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c', 'Neuer Chat', 1, 1)", [])
            .unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(get_chat(&conn, "c").unwrap().unwrap().title, "");
        let chat = save_message(&mut conn, &msg("m", "c", "user", "Hello there", 2))
            .unwrap()
            .unwrap();
        assert_eq!(chat.title, "Hello there");
    }

    #[test]
    fn markdown_export_follows_language() {
        let chat = Chat {
            id: "c".into(),
            title: String::new(),
            model: Some("lmstudio::qwen".into()),
            created_at: 0,
            updated_at: 0,
            pinned: false,
            system_prompt: None,
            group_id: None,
        };
        let messages = [msg("m", "c", "user", "Hi", 1)];
        let en = chat_to_markdown(&chat, &messages, "en");
        assert!(
            en.starts_with("# New chat") && en.contains("_Model: qwen_") && en.contains("## You")
        );
        let de = chat_to_markdown(&chat, &messages, "de");
        assert!(
            de.starts_with("# Neuer Chat") && de.contains("_Modell: qwen_") && de.contains("## Du")
        );
    }

    #[test]
    fn fts_tracks_inserts_updates_and_deletes() {
        let mut conn = mem();
        let chat = create_chat(&conn, None).unwrap();
        save_message(
            &mut conn,
            &msg("m1", &chat.id, "user", "Wie backe ich Brötchen?", 1),
        )
        .unwrap();
        save_message(
            &mut conn,
            &msg("m2", &chat.id, "assistant", "Mit Mehl, Hefe und Geduld.", 2),
        )
        .unwrap();

        // Diacritics-insensitive prefix match on message content.
        let hits = search_chats(&conn, "brotchen", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0]
            .snippet
            .as_deref()
            .unwrap_or("")
            .contains("Brötchen"));

        // Title match (auto title = first message).
        assert_eq!(search_chats(&conn, "backe", 10).unwrap().len(), 1);

        // Upsert of the same id updates the index instead of duplicating.
        save_message(
            &mut conn,
            &msg("m2", &chat.id, "assistant", "Mit Sauerteig.", 2),
        )
        .unwrap();
        assert!(search_chats(&conn, "hefe", 10).unwrap().is_empty());
        assert_eq!(search_chats(&conn, "sauerteig", 10).unwrap().len(), 1);

        update_message(&conn, "m2", "Mit Dinkel.").unwrap();
        assert!(search_chats(&conn, "sauerteig", 10).unwrap().is_empty());
        assert_eq!(search_chats(&conn, "dinkel", 10).unwrap().len(), 1);

        rename_chat(&conn, &chat.id, "Bäckerei").unwrap();
        assert_eq!(search_chats(&conn, "backerei", 10).unwrap().len(), 1);

        delete_message(&conn, "m2").unwrap();
        assert!(search_chats(&conn, "dinkel", 10).unwrap().is_empty());

        delete_chat(&conn, &chat.id).unwrap();
        assert!(search_chats(&conn, "brotchen", 10).unwrap().is_empty());
    }

    #[test]
    fn fts_query_is_injection_safe() {
        assert_eq!(fts_query("  "), None);
        assert_eq!(
            fts_query("a\"b OR c").as_deref(),
            Some("\"ab\"* \"OR\"* \"c\"*")
        );
        let conn = mem();
        // Operators and quotes must not cause syntax errors.
        assert!(search_chats(&conn, "\"NEAR( AND *", 10).is_ok());
    }

    #[test]
    fn delete_messages_after_keeps_anchor() {
        let mut conn = mem();
        let chat = create_chat(&conn, None).unwrap();
        for (i, role) in ["user", "assistant", "user", "assistant"]
            .iter()
            .enumerate()
        {
            save_message(
                &mut conn,
                &msg(&format!("m{i}"), &chat.id, role, "x", i as i64),
            )
            .unwrap();
        }
        assert_eq!(delete_messages_after(&conn, &chat.id, "m1").unwrap(), 2);
        let ids: Vec<String> = get_messages(&conn, &chat.id)
            .unwrap()
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(ids, vec!["m0", "m1"]);
    }

    #[test]
    fn export_import_roundtrip() {
        let mut src = mem();
        let chat = create_chat(&src, Some("m".into())).unwrap();
        save_message(&mut src, &msg("m1", &chat.id, "user", "Hallo ⚡", 1)).unwrap();
        pin_chat(&src, &chat.id, true).unwrap();
        let file = export_chats(&src, None).unwrap();
        let json = serde_json::to_string(&file).unwrap();

        let mut dst = mem();
        let parsed: ExportFile = serde_json::from_str(&json).unwrap();
        assert_eq!(import_chats(&mut dst, &parsed).unwrap(), 1);
        assert_eq!(
            import_chats(&mut dst, &parsed).unwrap(),
            0,
            "second import is a no-op"
        );
        let chats = list_chats(&dst).unwrap();
        assert!(chats[0].pinned);
        assert_eq!(get_messages(&dst, &chat.id).unwrap()[0].content, "Hallo ⚡");
        assert_eq!(search_chats(&dst, "hallo", 10).unwrap().len(), 1);

        let bad = ExportFile {
            format: "x".into(),
            version: 1,
            exported_at: 0,
            chats: vec![],
        };
        assert!(import_chats(&mut dst, &bad).is_err());
    }
}
