# Developing ZAP

ZAP is a Tauri 2 app: a React + TypeScript + Vite frontend (Tailwind v4, Zustand) and a Rust
backend. It's built to the spec in [design.md](../design.md). UI strings live in
`src/lib/i18n/` (`en.ts`, `de.ts`).

## Prerequisites

| Tool                                                                                   | Notes                                                                                                                                                                            |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Rust](https://rustup.rs) (stable, MSVC toolchain)                                     | `winget install Rustlang.Rustup`                                                                                                                                                 |
| [Node.js](https://nodejs.org) 20+                                                      |                                                                                                                                                                                  |
| Visual Studio 2022 C++ Build Tools                                                     | Workload "Desktop development with C++": `winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` |
| WebView2 Runtime                                                                       | Preinstalled on Windows 11. The installer bootstraps it on Windows 10.                                                                                                           |
| [Ollama](https://ollama.com/download) and/or [LM Studio](https://lmstudio.ai/download) | At least one is needed at runtime. ZAP starts `ollama serve` itself, and asks `lms server start` to start LM Studio's server if it isn't running.                                |

> **Smart App Control:** If Windows Smart App Control is on, it blocks the unsigned Rust toolchain
> (`cargo.exe`, error _os error 4551_) and unsigned dev builds of ZAP. Turn it off under
> _Windows Security → App & browser control → Smart App Control_ to build locally, or build on a
> machine or CI runner without it.

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

Live tests against real engines and the web: `cargo test live_ -- --ignored --nocapture`.

## Releases & updates

ZAP checks `releases/latest/download/latest.json` of this repository on startup (can be turned
off in Settings → About) and installs signed updates in place.

To publish a new version:

1. Add a `## <version> – <optional name>` section with `### English` and `### Deutsch` notes to
   [CHANGELOG.md](../CHANGELOG.md). ZAP shows these notes before and after the update.
2. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
3. Commit, then tag and push: `git tag v0.3.1 && git push origin main --tags`.
4. The `Release` workflow checks versions and notes (`scripts/release-notes.mjs`), builds the
   installers, signs the update and publishes the release with the changelog section.

Updates are signed with a minisign key. The private key never goes into the repo; it lives in the
`TAURI_SIGNING_PRIVATE_KEY` Actions secret (keep a backup: without it, installed copies can't be
updated). The public key is in `tauri.conf.json`. The installers themselves are not code-signed, so
Windows SmartScreen shows a warning on first install.

## How it works

- **Engines** (`engine.rs`): Each engine can be turned on or off. Its status (`disabled`, `starting`, `running`, `not_found`, `stopped`) is sent as `provider://status`, and a health check runs every 4 s. Model keys are the plain Ollama name (`llama3.2:3b`) or `lmstudio::<id>`, and `engine::route` dispatches each chat to the right engine.
- **LM Studio** (`lmstudio.rs`): OpenAI-compatible API on `http://127.0.0.1:<port>/v1` (default port 1234, configurable, always loopback). ZAP lists models (`/api/v0/models` with a fallback to `/v1/models`, skipping embedding models) and streams `/v1/chat/completions` over SSE. If the server is down, ZAP runs `lms server start --port <port>` hidden and waits up to 30 s. ZAP never stops LM Studio.
- **Ollama lifecycle** (`ollama.rs`): At startup ZAP checks `GET /api/version`. If nothing answers, it looks for `ollama.exe` in `%LOCALAPPDATA%\Programs\Ollama\` and on `PATH`, then spawns `ollama serve` hidden (`CREATE_NO_WINDOW`) and waits up to 15 s. ZAP stops Ollama on exit only if ZAP started it.
- **Streaming** (`ndjson.rs`, `commands.rs`): Byte-level NDJSON (Ollama) and SSE (LM Studio) decoders reassemble lines split across chunks, including inside multi-byte UTF-8 characters. Events carry the `chat_id`, so several chats can generate at once. The UI batches tokens per animation frame and only replaces the streaming message, so older messages don't re-render. The list is virtualized with react-virtuoso.
- **Attachments** (`src/lib/attachments.ts`): Text files (up to 512 KB) are inlined into the prompt as fenced blocks. Images are sent as data URLs, as Ollama `images` or OpenAI `image_url` parts. Vision support comes from Ollama's `/api/show` capabilities or LM Studio's model type `vlm` (`model_capabilities`). Text-only models get `[Image: name]` placeholders for images in the history.
- **Tools** (`commands.rs` `run_agent`, `tools.rs`, `web.rs`, `file_tools.rs`): With web search or file access on and a model that reports the `tools` capability, ZAP offers the matching tools, runs requested calls, streams `chat://tool` events for the UI cards and feeds results back, for up to 12 rounds (the last round has no tools, so the model must answer). Pages are fetched only from public hosts (literal and DNS-resolved private, loopback and link-local addresses are blocked, and redirects are checked too). Tool output is marked as untrusted in the system prompt.
- **Files** (`files.rs`, `file_tools.rs`): A background index covers all fixed drives (system, program, AppData and dev folders are skipped) and a watcher keeps it current. The tools are `search_files`, `list_directory`, `read_file`, `write_file`, `edit_file` (exact, unique text replacement), `create_folder`, `move_path` and `delete_file` (Recycle Bin). Approval runs through a `pending` activity and the `answer_approval` command (allow, deny or allow for this chat). Windows, program folders, ProgramData and ZAP's own data can never be modified, and every change is backed up to `%APPDATA%\app.zap.chat\backups` first.
- **Titles**: After the first reply, `generate_title` asks the model for a title of at most 5 words. If that fails, the first 40 characters of the first message are used. A manual rename is never overwritten.
- **Storage** (`db.rs`): `zap.db` (SQLite, WAL) lives in `%APPDATA%\app.zap.chat`. Schema changes run as numbered migrations, tracked in `schema_migrations`. Full-text search uses an FTS5 table (`unicode61`, diacritics-insensitive) that triggers keep in sync. Chat groups live in `chat_groups`; chats point to them with `group_id`.
- **Export/import**: Versioned JSON (`{ "format": "zap-export", "version": 1, … }`). Importing the same file twice is a no-op. File dialogs run on the Rust side, so the web layer needs no file system permission.
- **Appearance** (`src/lib/theme.ts`, `src/lib/palettes.ts`): Color palettes are an accent plus a background tint; all surface and text tokens are derived for dark and light. `public/theme-init.js` applies the stored theme, colors and typography before the first paint, from a mirror in localStorage. The source of truth is the settings table.
- **Release notes** (`src/lib/changelog.ts`): `CHANGELOG.md` is bundled into the app and is also the release body, so one parser serves both the "What's new" dialog before an update and the greeting after one.
- **Security**: Strict CSP with no remote scripts, and minimal capabilities (`src-tauri/capabilities/default.json`). Model servers are local only. Internet access happens only for the update check and when you turn on web search. Links in replies open in the default browser through the opener plugin, never inside the app. Markdown is rendered without raw HTML and sanitized. Message contents are never logged.
- **Design tokens**: All base colors live in `src/styles/tokens.css` (Dark and Light) and are mapped into Tailwind v4 in `globals.css`. Tailwind's default palette is disabled.

## Adding a provider

`src-tauri/src/provider.rs` defines the `ChatProvider` trait (`list_models`, `chat_stream`, `complete`) and the `AnyProvider` dispatch. Ollama (`ollama.rs`) and LM Studio (`lmstudio.rs`) implement it. A cloud provider such as OpenRouter would:

1. implement `ChatProvider`,
2. store its API key in Windows Credential Manager using the `keyring` crate,
3. get a `ProviderKind` variant and a model-key prefix, routed in `engine.rs`. The event contract (`chat://token|done|error`) stays the same.

## Project layout

```
public/theme-init.js   applies theme, colors and typography before first paint
scripts/               release-notes.mjs (release workflow helper)
src/
  components/          TitleBar, Sidebar, ChatView, Message, Composer, ModelPicker, SettingsDialog,
                       EngineCard, Onboarding, CommandPalette, WhatsNewDialog, ToolCards, ui/
  store/               zustand stores: chats, models, providers, settings, updates, ui (+ tests)
  lib/                 ipc, i18n (en, de), theme, palettes, blueprints, changelog, attachments,
                       highlight (shiki), format, actions
  styles/              tokens.css, globals.css
src-tauri/src/
  main.rs              plugins (single instance, window state, dialog, opener, updater), setup
  commands.rs          #[tauri::command] handlers and the tool loop
  engine.rs            enabled engines, status, health checks, routing
  ollama.rs            Ollama client, process start, NDJSON streaming, /api/show
  lmstudio.rs          LM Studio client (OpenAI-compatible), lms start, SSE streaming
  ndjson.rs            incremental NDJSON and SSE decoders (+ tests)
  provider.rs          provider trait, model keys, dispatch
  tools.rs, web.rs     web search and page fetch tools
  files.rs, file_tools.rs  file index, watcher and file tools
  db.rs                SQLite, migrations, FTS5 search, groups, export/import (+ tests)
  state.rs, error.rs   shared state, typed errors ({ code, message })
```
