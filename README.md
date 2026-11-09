# ZAP

A fast, local-first AI chat app for Windows 10/11. ZAP talks to a local [Ollama](https://ollama.com) server, a local [LM Studio](https://lmstudio.ai) server, or both. There's no cloud, no account and no API key, and your chats stay on your PC.

- Use Ollama, LM Studio or both (Settings → Models). Download and delete Ollama models inside the app; LM Studio models are managed in LM Studio
- Streaming replies with Markdown, code highlighting, and actions to copy, edit, regenerate or delete
- Optional web search (globe button in the composer): tool-capable models can search the web and read pages. Sources: built-in (DuckDuckGo + Wikipedia, no setup), Brave Search API (key in Windows Credential Manager, monthly limit) or SearXNG (one-click setup via Docker)
- File access (folder button in the composer): tool-capable models can search, read, create, edit and delete files on the PC. Each step asks for approval (with a diff preview) unless Settings → Files is set to full permission. Mention any file with `@name` in a chat
- Attachments via the paperclip, drag & drop or paste: text and code files (inlined for every model) and images (PNG, JPEG, WebP, GIF; downscaled to 1568 px; vision models only, the option is greyed out otherwise)
- Dark (default), Light and System themes, without a flash on startup
- Custom title bar. ZAP remembers window size, position and maximized state, and runs as a single instance
- Sidebar with date groups, pinning, full-text search and Markdown export
- Command palette (Ctrl+K), onboarding, settings with tabs, JSON export and import
- English (default) and German UI, switchable in Settings → General. All strings are in `src/lib/i18n/` (`en.ts`, `de.ts`). Built to the spec in [design.md](design.md)

## Prerequisites

| Tool                                                                                   | Notes                                                                                                                                                                            |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Rust](https://rustup.rs) (stable, MSVC toolchain)                                     | `winget install Rustlang.Rustup`                                                                                                                                                 |
| [Node.js](https://nodejs.org) 20+                                                      |                                                                                                                                                                                  |
| Visual Studio 2022 C++ Build Tools                                                     | Workload "Desktop development with C++": `winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` |
| WebView2 Runtime                                                                       | Preinstalled on Windows 11. The installer bootstraps it on Windows 10.                                                                                                           |
| [Ollama](https://ollama.com/download) and/or [LM Studio](https://lmstudio.ai/download) | At least one is needed at runtime. ZAP starts `ollama serve` itself, and asks `lms server start` to start LM Studio's server if it isn't running.                                |

> **Smart App Control:** If Windows Smart App Control is on, it blocks the unsigned Rust toolchain (`cargo.exe`, error _os error 4551_) and unsigned dev builds of ZAP. Turn it off under _Windows-Sicherheit → App- & Browsersteuerung → Smart App Control_ to build locally, or build on a machine or CI runner without it. To distribute ZAP to machines that keep it on, sign the release installer.

## Run & build

```sh
npm install
npm run tauri dev      # dev app with hot reload
npm run tauri build    # installers in src-tauri/target/release/bundle/{nsis,msi}
```

Checks:

```sh
npm run typecheck && npm run lint && npm run format:check && npm test
cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test
```

## Releases & updates

ZAP checks `releases/latest/download/latest.json` of this repository on startup
(can be turned off in Settings → About) and installs signed updates in place.

To publish a new version:

1. Add a `## <version> – <optional name>` section with `### English` and `### Deutsch` notes to
   `CHANGELOG.md`. ZAP shows these notes before and after the update.
2. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
3. Commit, then tag and push: `git tag v0.3.1 && git push origin main --tags`.
4. The `Release` workflow checks versions and notes (`scripts/release-notes.mjs`), builds the
   installers, signs the update and publishes the release with the changelog section.

Updates are signed with a minisign key. The private key never goes into the repo; it lives in the
`TAURI_SIGNING_PRIVATE_KEY` Actions secret (keep a backup — without it, installed copies can't be
updated). The public key is in `tauri.conf.json`. The installers themselves are not code-signed, so
Windows SmartScreen shows a warning on first install ("More info" → "Run anyway").

## Keyboard shortcuts

| Keys                | Action                  |
| ------------------- | ----------------------- |
| Ctrl+N              | New chat                |
| Ctrl+K              | Command palette         |
| Ctrl+B              | Toggle sidebar          |
| Ctrl+,              | Settings                |
| Ctrl+Shift+C        | Copy last reply         |
| Ctrl+↑ / ↓          | Previous / next chat    |
| Esc                 | Stop generating / close |
| Enter / Shift+Enter | Send / new line         |

## How it works

- **Engines** (`engine.rs`): Each engine can be turned on or off. Its status (`disabled`, `starting`, `running`, `not_found`, `stopped`) is sent as `provider://status`, and a health check runs every 4 s. Model keys are the plain Ollama name (`llama3.2:3b`) or `lmstudio::<id>`, and `engine::route` dispatches each chat to the right engine.
- **LM Studio** (`lmstudio.rs`): OpenAI-compatible API on `http://127.0.0.1:<port>/v1` (default port 1234, configurable, always loopback). ZAP lists models (`/api/v0/models` with a fallback to `/v1/models`, skipping embedding models) and streams `/v1/chat/completions` over SSE. If the server is down, ZAP runs `lms server start --port <port>` hidden and waits up to 30 s. ZAP never stops LM Studio.
- **Ollama lifecycle** (`ollama.rs`): At startup ZAP checks `GET /api/version`. If nothing answers, it looks for `ollama.exe` in `%LOCALAPPDATA%\Programs\Ollama\` and on `PATH`, then spawns `ollama serve` hidden (`CREATE_NO_WINDOW`) and waits up to 15 s. A health check runs every 4 s. ZAP stops Ollama on exit only if ZAP started it.
- **Streaming** (`ndjson.rs`, `commands.rs`): Byte-level NDJSON (Ollama) and SSE (LM Studio) decoders reassemble lines split across chunks, including inside multi-byte UTF-8 characters. Events carry the `chat_id`, so several chats can generate at once. The UI batches tokens per animation frame and only replaces the streaming message, so older messages don't re-render. The list is virtualized with react-virtuoso.
- **Attachments** (`src/lib/attachments.ts`): Text files (up to 512 KB) are inlined into the prompt as fenced blocks. Images are sent as data URLs, as Ollama `images` or OpenAI `image_url` parts. Vision support comes from Ollama's `/api/show` capabilities or LM Studio's model type `vlm` (`model_capabilities`). Attachments are stored as JSON in `messages.attachments` (migration 5). Text-only models get `[Image: name]` placeholders for images in the history.
- **Tools / web search** (`commands.rs` `run_agent`, `tools.rs`, `web.rs`): With web search on and a model that reports the `tools` capability, ZAP offers `web_search` and `fetch_page`. It runs requested calls, streams `chat://tool` events for the UI cards and feeds results back, for up to 6 rounds (the last round has no tools, so the model must answer). Pages are fetched only from public hosts (literal and DNS-resolved private, loopback and link-local addresses are blocked, and redirects are checked too). Tool output is marked as untrusted in the system prompt. Live checks: `cargo test live_ -- --ignored --nocapture`.
- **Files** (`files.rs`, `file_tools.rs`): A background index covers all fixed drives (system, program, AppData and dev folders are skipped). On a typical PC, about 250k entries index in about 10 s and a search takes about 25 ms. The tools are `search_files`, `list_directory`, `read_file`, `write_file`, `edit_file` (exact, unique text replacement) and `delete_file` (Recycle Bin). Approval runs through a `pending` activity and the `answer_approval` command (allow, deny or allow for this chat). Windows, program folders, ProgramData and ZAP's own data can never be modified, and every change is backed up to `%APPDATA%\app.zap.chat\backups` first.
- **Titles**: After the first reply, `generate_title` asks the model for a title of at most 5 words. If that fails, the first 40 characters of the first message are used. A manual rename is never overwritten.
- **Storage** (`db.rs`): `zap.db` (SQLite, WAL) lives in `%APPDATA%\app.zap.chat`. Schema changes run as numbered migrations, tracked in `schema_migrations`. Full-text search uses an FTS5 table (`unicode61`, diacritics-insensitive) that triggers keep in sync. Messages are upserted with `ON CONFLICT DO UPDATE`, so the FTS triggers fire correctly.
- **Export/import**: Versioned JSON (`{ "format": "zap-export", "version": 1, … }`). Importing the same file twice is a no-op. File dialogs run on the Rust side, so the web layer needs no file system permission.
- **Themes and language**: `public/theme-init.js` sets `data-theme`, density, font size and `<html lang>` before the first paint, from a mirror in localStorage. The source of truth is the settings table.
- **Security**: Strict CSP with no remote scripts, and minimal capabilities (`src-tauri/capabilities/default.json`). Model servers are local only (Ollama on `127.0.0.1:11434`, LM Studio on `127.0.0.1:<port>`). Internet access happens only when you turn on web search: search terms go to the chosen search service, and pages the model asks for are fetched. Links in replies open in the default browser through the opener plugin, never inside the app. Markdown is rendered without raw HTML and sanitized. Message contents are never logged.
- **Design tokens**: All colors live in `src/styles/tokens.css` (Dark and Light) and are mapped into Tailwind v4 in `globals.css`. Tailwind's default palette is disabled.

## Adding a provider later

`src-tauri/src/provider.rs` defines the `ChatProvider` trait (`list_models`, `chat_stream`, `complete`) and the `AnyProvider` dispatch. Ollama (`ollama.rs`) and LM Studio (`lmstudio.rs`) implement it. A cloud provider such as OpenRouter would:

1. implement `ChatProvider` (enable reqwest's `rustls-tls` feature),
2. store its API key in Windows Credential Manager using the `keyring` crate,
3. get a `ProviderKind` variant and a model-key prefix, routed in `engine.rs`. The event contract (`chat://token|done|error`) stays the same.

## Project layout

```
public/theme-init.js   applies the theme before first paint
src/
  components/          TitleBar, Sidebar, ChatView, Message, Composer, ModelPicker,
                       SettingsDialog, EngineCard, Onboarding, CommandPalette, ui/ (Dialog, IconButton, Controls, Skeleton)
  store/               zustand stores: chats, models, providers, settings, ui (+ tests)
  lib/                 ipc, i18n (en, de), theme, highlight (shiki), format, actions
  styles/              tokens.css, globals.css
src-tauri/src/
  main.rs              plugins (single instance, window state, dialog, opener), setup
  commands.rs          #[tauri::command] handlers
  engine.rs            enabled engines, status, health checks, routing
  ollama.rs            Ollama client, process start, NDJSON streaming, /api/show
  lmstudio.rs          LM Studio client (OpenAI-compatible), lms start, SSE streaming
  ndjson.rs            incremental NDJSON and SSE decoders (+ tests)
  provider.rs          provider trait, model keys, dispatch
  db.rs                SQLite, migrations, FTS5 search, export/import (+ tests)
  state.rs, error.rs   shared state, typed errors ({ code, message })
```
