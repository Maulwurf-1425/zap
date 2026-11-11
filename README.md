<div align="center">

<img src="src-tauri/icons/icon.svg" width="96" alt="ZAP logo" />

# ZAP

**A fast, private AI chat for Windows that runs entirely on your PC.**

No cloud, no account, no API key. Your chats never leave your computer.

[**⬇ Download for Windows**](https://github.com/Maulwurf-1425/zap/releases/latest) ·
[What's new](CHANGELOG.md) ·
[Report a problem](https://github.com/Maulwurf-1425/zap/issues)

</div>

---

## What is ZAP?

ZAP is a chat app for AI models that run locally on your own computer. It works with
[Ollama](https://ollama.com) and [LM Studio](https://lmstudio.ai), two free tools that
download and run open models such as Llama, Qwen, Gemma or Mistral. ZAP gives them a clean,
fast chat window, so you can use them the way you'd use ChatGPT, just offline and private.

## Features

- **Private by design:** chats are stored only on your PC. ZAP needs no account and sends nothing
  to a server.
- **Works with Ollama and LM Studio,** or both at once. ZAP starts them for you, and you can
  download Ollama models right inside the app.
- **Fast chat:** answers stream in live, with Markdown, code highlighting, copy, edit, regenerate
  and several chats running at the same time.
- **Files and images:** attach text and code files to any chat, and images for models that can see
  them (drag & drop or paste).
- **Optional web search:** let the model look things up online and read pages, with sources shown
  under each answer. Off by default.
- **Optional file access:** let the model search, read and edit files on your PC. Every change asks
  for your OK first and shows exactly what will change. Mention any file with `@name`.
- **ZAPs:** small agents that do a task by themselves in the background: run PowerShell commands,
  open apps, research the web and work with files. Start them by hand, on a schedule or just ask
  the chat. Every command can require your OK, destructive ones always do.
- **Resource monitor:** press F5 anywhere to see CPU, RAM, graphics card and tokens used by ZAP and
  its engines, and unload models you don't need.
- **Organized:** chat groups with colors, pinning, full-text search across all chats, and Markdown
  or JSON export.
- **Blueprints:** save prompts you use often and start them from the new-chat screen with one
  click.
- **Make it yours:** dark, light or system theme, 8 color themes or your own colors, and full
  control over font, size and spacing.
- **Voice:** dictate instead of typing and let answers be read aloud with natural voices, all
  locally (Whisper and Piper, downloaded on first use).
- **Discord status (optional):** show "Playing ZAP" and what ZAP is doing, never your chats.
- **English and German,** switchable at any time.
- **Automatic updates:** ZAP lets you know when a new version is out and shows what's new.

## Getting started

### 1. Install an AI engine

ZAP needs at least one of these free programs to run the models:

| Engine                                    | Good for                                                           |
| ----------------------------------------- | ------------------------------------------------------------------ |
| [Ollama](https://ollama.com/download)     | The easiest start. ZAP can download models for you.                |
| [LM Studio](https://lmstudio.ai/download) | Browsing and trying lots of models with a graphical model manager. |

Just install it. You don't need to open or configure anything, because ZAP starts the engine
itself.

### 2. Install ZAP

1. Open the [latest release](https://github.com/Maulwurf-1425/zap/releases/latest) and download
   **`ZAP_x.y.z_x64-setup.exe`**.
2. Run it. ZAP installs for your user only, so no admin rights are needed.

> **Windows shows "Windows protected your PC"?** ZAP isn't signed with a paid certificate yet, so
> Windows SmartScreen doesn't know it. Click **More info → Run anyway**. You only need to do this
> once; updates install without the warning.

### 3. Pick a model and start chatting

On first start, ZAP walks you through the setup. With Ollama, you can download a model right
there. Some good first picks:

| Model              | Size    | RAM needed | Notes                                         |
| ------------------ | ------- | ---------- | --------------------------------------------- |
| `llama3.2:3b`      | ~2 GB   | 8 GB       | Fast all-rounder, runs on most PCs            |
| `qwen2.5:7b`       | ~4.7 GB | 16 GB      | Smarter answers, good at web search and files |
| `qwen2.5-coder:7b` | ~4.7 GB | 16 GB      | Best for programming                          |

More models are in Settings → Models, or in the
[Ollama library](https://ollama.com/library).

## Updates

ZAP checks for a new version every time it starts. When one is available, you'll see a message
with **What's new?** and **Update & restart**. Updates are signed, so ZAP only installs versions
that really come from this project. You can turn the automatic check off, or check by hand, under
**Settings → About**.

## Privacy

- Your chats, settings and attachments are stored only on your PC, in
  `%APPDATA%\app.zap.chat`.
- The AI models run locally through Ollama or LM Studio. ZAP only talks to them on your own
  computer.
- ZAP goes online only for:
  - **the update check** (asks GitHub whether there's a new version), which you can turn off;
  - **web search**, only when you turn it on. Your search terms go to the search service you
    pick, and pages the model asks for are downloaded;
  - **links you paste into a message:** ZAP loads that page so the model can read it. You can turn
    this off in Settings → Web search;
  - **one-time downloads** when you set up voice or an engine: speech models, voices and
    installers come from their official sources and are checked before use;
  - **version check of the helper apps** (Ollama, LM Studio, Docker Desktop) via winget, only
    when you open Settings → About;
  - **ZAPs**, only for the tools you give them: a ZAP with web research searches online like web
    search does. ZAP avatars are generated on your PC.
- Dictation and reading aloud run on your PC; your voice is never uploaded. The Discord status
  talks only to the Discord app on your PC.
- No analytics, no tracking, no telemetry.

## Requirements

- Windows 10 or 11 (64-bit)
- Ollama and/or LM Studio
- At least 8 GB RAM; 16 GB or more for 7B models. A graphics card makes answers much faster but
  isn't required.

## Keyboard shortcuts

| Keys                | Action                              |
| ------------------- | ----------------------------------- |
| Ctrl+N              | New chat                            |
| Ctrl+K              | Command palette (search everything) |
| Ctrl+B              | Show or hide the sidebar            |
| Ctrl+,              | Settings                            |
| Ctrl+Shift+C        | Copy the last answer                |
| Ctrl+↑ / ↓          | Previous / next chat                |
| F5                  | Resource monitor                    |
| Esc                 | Stop the answer / close             |
| Enter / Shift+Enter | Send / new line                     |

## Troubleshooting

**ZAP says the engine wasn't found.**
Install [Ollama](https://ollama.com/download) or [LM Studio](https://lmstudio.ai/download), then
restart ZAP. For LM Studio, turn it on under Settings → Models.

**Answers are very slow.**
The model is probably too big for your PC. Try a smaller one such as `llama3.2:3b`, and close
other heavy programs.

**Web search or file access does nothing.**
These need a model that supports tools, for example `qwen2.5`, `qwen3` or `llama3.1`. Fine-tuned
variants often can't use tools reliably; ZAP tells you when that happens.

**How do I uninstall ZAP?**
Windows Settings → Apps → ZAP → Uninstall. Your chats stay in `%APPDATA%\app.zap.chat`; delete
that folder too if you want them gone. You can also delete all chats inside ZAP under
Settings → Data.

Something else? [Open an issue](https://github.com/Maulwurf-1425/zap/issues) and describe what
happened.

## For developers

Want to build ZAP yourself or help out? See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for setup,
architecture and the release process.

## License

[MIT](LICENSE). Free to use, change and share.
