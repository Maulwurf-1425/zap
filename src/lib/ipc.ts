// Typed wrappers around Tauri commands and events (see src-tauri/src/commands.rs).
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type ProviderKind = "ollama" | "lmstudio";
export type ProviderStatus = "disabled" | "starting" | "running" | "not_found" | "stopped";
export type Statuses = Record<ProviderKind, ProviderStatus>;
export const PROVIDERS: ProviderKind[] = ["ollama", "lmstudio"];

export type ErrorCode =
  | "provider_unreachable"
  | "model_not_found"
  | "disk_full"
  | "cancelled"
  | "invalid_file"
  | "unsupported"
  | "tool_format"
  | "provider_error"
  | "generic";

export interface AppError {
  code: ErrorCode;
  message: string;
}

export type Role = "system" | "user" | "assistant";
export type ThemeMode = "dark" | "light" | "system";
export type Density = "comfortable" | "compact";

export interface Chat {
  id: string;
  title: string;
  model: string | null;
  created_at: number;
  updated_at: number;
  pinned: boolean;
  system_prompt: string | null;
  /** Sidebar group, `null` when ungrouped. */
  group_id: string | null;
}

export interface ChatGroup {
  id: string;
  name: string;
  position: number;
  collapsed: boolean;
  /** "#rrggbb", `null` for the default look. */
  color: string | null;
}

export interface ChatStats {
  /** Output tokens. */
  eval_count: number;
  /** Input tokens (absent in replies saved before v0.3). */
  prompt_eval_count?: number;
  eval_duration_ns: number;
  total_duration_ns: number;
  tokens_per_sec: number;
}

/** Message as stored. `stats` is the JSON-encoded ChatStats. */
export interface Message {
  id: string;
  chat_id: string;
  role: Role;
  content: string;
  created_at: number;
  model: string | null;
  stats: string | null;
  /** JSON array of attachments (see lib/attachments.ts). */
  attachments: string | null;
  /** JSON array of ToolActivity (web searches, pages read). */
  tools: string | null;
}

export interface NewMessage {
  id: string;
  chat_id: string;
  role: Role;
  content: string;
  created_at: number;
  model?: string | null;
  stats?: ChatStats | null;
  attachments?: string | null;
  tools?: string | null;
}

export type SearchProviderName = "builtin" | "brave" | "searxng";

/** One tool use by the model, shown as a card above the reply. */
export interface ToolActivity {
  id: string;
  /** `web_search` | `fetch_page` | `search_files` | `list_directory` | `read_file` | `write_file` | `edit_file` | `delete_file` */
  name: string;
  /** Search query, URL or file path. */
  input: string;
  /** `pending` waits for the user's approval. */
  status: "pending" | "running" | "done" | "error" | "denied";
  sources: { title: string; url: string }[];
  /** Error code, see tools::error_code / file_tools::code in Rust. */
  error?: string;
  /** Short machine note, e.g. `results:12`, `new`, `overwrite`, `folder:30`. */
  detail?: string;
  /** Diff or new content shown in the approval card. */
  preview?: string;
}

export type ApprovalDecision = "allow" | "deny" | "allow_chat";

export interface FileHit {
  path: string;
  name: string;
  is_dir: boolean;
}

export interface IndexStatus {
  count: number;
  building: boolean;
  built_at: number | null;
  roots: string[];
}

export interface FileAttachmentData {
  name: string;
  path: string;
  size: number;
  base64: string;
}

export interface ToolEvent {
  chat_id: string;
  activity: ToolActivity;
}

export interface SearchStatus {
  has_brave_key: boolean;
  month_count: number;
}

/** A message as sent to the model. `images` are data URLs (vision models only). */
export interface PayloadMessage {
  role: Role;
  content: string;
  images?: string[];
}

export interface ModelUsage {
  /** Model key. */
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  replies: number;
  last_used: number;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  replies: number;
}

export interface ModelCaps {
  vision: boolean;
  /** Can call tools (needed for web search). */
  tools: boolean;
}

export interface SearchHit {
  chat: Chat;
  snippet: string | null;
}

export interface ModelInfo {
  /** Model key: Ollama name, or `lmstudio::<id>`. */
  id: string;
  name: string;
  provider: ProviderKind;
  /** 0 when the provider does not report a size. */
  size_bytes: number;
  modified_at: string | null;
}

const LMSTUDIO_PREFIX = "lmstudio::";

/** Provider of a model key (mirrors provider::parse_model_key in Rust). */
export function modelProvider(key: string): ProviderKind {
  return key.startsWith(LMSTUDIO_PREFIX) ? "lmstudio" : "ollama";
}

/** Human-readable model name without the provider prefix. */
export function modelLabel(key: string): string {
  return key.startsWith(LMSTUDIO_PREFIX) ? key.slice(LMSTUDIO_PREFIX.length) : key;
}

export interface ModelDetails {
  name: string;
  family: string | null;
  parameter_size: string | null;
  quantization: string | null;
  context_length: number | null;
}

export interface Settings {
  default_model: string | null;
  system_prompt: string;
  temperature: number;
  context_length: number | null;
  theme: ThemeMode;
  font_size: number;
  density: Density;
  onboarding_done: boolean;
  sidebar_width: number;
  sidebar_collapsed: boolean;
  language: "en" | "de";
  ollama_enabled: boolean;
  lmstudio_enabled: boolean;
  lmstudio_port: number;
  web_search_enabled: boolean;
  search_provider: SearchProviderName;
  searxng_url: string;
  search_monthly_limit: number;
  file_tools_enabled: boolean;
  /** `ask` = approve every step, `full` = no questions. */
  file_permission: "ask" | "full";
  /** Look for a new ZAP version on startup. */
  auto_update: boolean;
  /** Preset id from lib/palettes.ts, or "custom". */
  palette: string;
  custom_accent: string;
  custom_tint: string;
  font_family: FontFamily;
  /** Multiple of the chat font size. */
  line_height: number;
  /** em */
  letter_spacing: number;
  /** em */
  paragraph_spacing: number;
  /** New-chat cards; `null` shows the built-in suggestions. */
  blueprints: Blueprint[] | null;
  /** App version whose "What's new" the user has seen. */
  last_seen_version: string | null;
  /** Read web pages linked in a message and give their text to the model. */
  read_links: boolean;
  /** Whisper model for dictation. */
  voice_model: "base" | "small";
  /** Dictation language: "auto" | "de" | "en". */
  voice_language: "auto" | "de" | "en";
  /** Microphone name; null = Windows default. */
  mic_device: string | null;
  /** Piper voice ids for German and English answers. */
  voice_de: string;
  voice_en: string;
  /** Reading speed 0.5–2.0. */
  speech_rate: number;
  /** Read every new answer aloud. */
  auto_read: boolean;
  /** Show "Playing ZAP" in Discord. */
  discord_presence: boolean;
  /** Include the model name in the Discord status. */
  discord_show_model: boolean;
  /** ZAP commands and app launches: `ask` = approve each, `full` = run freely (destructive ones still ask). */
  zap_permission: "ask" | "full";
  /** Let the chat model list, create, start, stop and delete ZAPs. */
  zaps_in_chat: boolean;
  /** Closing the window keeps ZAP running in the tray. */
  close_to_tray: boolean;
  /** Start ZAP hidden in the tray when Windows starts. */
  autostart: boolean;
  /** Windows notifications when a ZAP finishes or waits for an OK. */
  zap_notifications: boolean;
  /** Unload models after this many idle minutes; null = engine default. */
  model_idle_minutes: number | null;
}

/** Tool families a ZAP may use. */
export interface ZapTools {
  web: boolean;
  files: boolean;
  /** PowerShell commands. */
  terminal: boolean;
  /** Open apps, files and links. */
  apps: boolean;
}

export type ZapScheduleKind = "off" | "startup" | "interval" | "daily";

/** When a ZAP starts by itself (see src-tauri/src/schedule.rs). */
export interface ZapSchedule {
  kind: ZapScheduleKind;
  /** "interval": minutes between runs. */
  every_min: number;
  /** "daily": local time "HH:MM". */
  time: string;
  /** "daily": 0 = Monday … 6 = Sunday; empty = every day. */
  days: number[];
}

/** A small agent that works on a task by itself (see src-tauri/src/zaps.rs). */
export interface Zap {
  /** Empty for a new ZAP (the backend assigns one). */
  id: string;
  name: string;
  /** Key from lib/blueprints BLUEPRINT_ICONS. */
  icon: string;
  /** "#rrggbb", `null` for the accent. */
  color: string | null;
  instructions: string;
  /** Model key; `null` uses the model selected in the app. */
  model: string | null;
  tools: ZapTools;
  max_steps: number;
  created_at: number;
  updated_at: number;
  schedule: ZapSchedule;
  /** Let thinking models reason (slower, more tokens). */
  thinking: boolean;
  /** Stop a run after this many tokens; null = no limit. */
  token_budget: number | null;
  /** Stop a run after this many minutes; null = no limit. */
  time_limit: number | null;
  /** Next scheduled start (Unix ms), from the backend. */
  next_run?: number | null;
}

export type ZapRunStatus = "running" | "done" | "failed" | "stopped";

export interface ZapRun {
  id: string;
  zap_id: string;
  input: string | null;
  source: "manual" | "chat" | "schedule";
  status: ZapRunStatus;
  /** Everything the ZAP wrote (its report). */
  output: string;
  /** JSON array of ToolActivity. */
  activities: string | null;
  /** JSON-encoded ChatStats. */
  stats: string | null;
  /** Error code: an ErrorCode, or "no_tools" / "no_model". */
  error: string | null;
  started_at: number;
  ended_at: number | null;
  /** Model key the run used (null for runs before v0.5). */
  model?: string | null;
}

export type UsageGroup = "zap" | "ollama" | "lmstudio" | "searxng";

/** Resources of one part of ZAP (see src-tauri/src/monitor.rs). */
export interface GroupUsage {
  group: UsageGroup;
  /** Share of the whole machine, 0–100. */
  cpu: number;
  memory: number;
  /** null when the GPU counters are unavailable. */
  gpu: number | null;
  vram: number | null;
  processes: number;
}

export interface SystemUsage {
  groups: GroupUsage[];
  system: {
    cpu: number;
    memory_used: number;
    memory_total: number;
    gpu: number | null;
    vram_used: number | null;
    cores: number;
  };
  tokens: {
    active: number;
    zap_runs: number;
    per_sec: number;
    session_prompt: number;
    session_output: number;
  };
}

/** A model an engine holds in memory. */
export interface LoadedModel {
  id: string;
  provider: ProviderKind;
  size: number | null;
  vram: number | null;
}

/** Lifetime numbers of a ZAP (finished runs). */
export interface ZapTotals {
  runs: number;
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
}

export interface UsageEvent {
  chat_id: string;
  stats: ChatStats;
}

export interface DiscordPresence {
  details: string;
  state: string | null;
  /** Session start, Unix ms. */
  start: number;
  image_text: string;
  button: string;
}

export interface VoiceInfo {
  id: string;
  name: string;
  lang: "de" | "en";
  gender: "female" | "male";
  size: number;
  installed: boolean;
}

export interface VoiceStatus {
  whisper: boolean;
  whisper_size: number;
  piper: boolean;
  piper_size: number;
  models: { id: "base" | "small"; size: number; installed: boolean }[];
  voices: VoiceInfo[];
  microphones: { id: string; name: string; is_default: boolean }[];
}

export interface VoiceDownloadEvent {
  /** "dictation:<model>" | "voice:<id>" */
  item: string;
  /** "whisper" | "model" | "piper" | "voice" */
  part: string;
  downloaded: number;
  /** 0 when unknown (small files). */
  total: number;
}

export interface SpeakingEvent {
  id: string;
  active: boolean;
  error: string | null;
}

export type FontFamily = "inter" | "system" | "serif" | "mono";

export interface Blueprint {
  title: string;
  prompt: string;
  /** Key from components/EmptyState BLUEPRINT_ICONS. */
  icon: string;
  /** Send right away instead of filling the composer. */
  send: boolean;
}

export type ToolName = "ollama" | "lmstudio" | "docker";

export interface ToolVersion {
  tool: ToolName;
  /** null = not installed (or unreadable). */
  installed: string | null;
  /** Newest release (via winget); null if unknown. */
  latest: string | null;
  update_available: boolean;
  can_open: boolean;
}

/** SearXNG container as reported by Docker. */
export type ContainerState = "docker_missing" | "docker_stopped" | "missing" | "stopped" | "running";

export interface LinkResult {
  page: { title: string; url: string; text: string } | null;
  /** Same codes as the fetch_page tool (t.web.errors). */
  error: string | null;
}

export type InstallPhase = "preparing" | "downloading" | "installing" | "starting" | "done" | "failed";

export interface EngineInstallEvent {
  provider: ProviderKind;
  phase: InstallPhase;
  /** Bytes downloaded and installer size, while downloading (null if unknown). */
  downloaded: number | null;
  total: number | null;
}

export interface StatusEvent {
  provider: ProviderKind;
  status: ProviderStatus;
}

export interface AppInfo {
  version: string;
  ollama_version: string | null;
}

export interface PullProgress {
  name: string;
  status: string;
  completed: number;
  total: number;
  speed_bps: number;
}

export interface ChatOptions {
  temperature?: number;
  num_ctx?: number | null;
  /** Offer web search / page reading to the model. */
  web?: boolean;
  /** Offer file tools (search, read, write, edit, delete). */
  files?: boolean;
  /** Offer the ZAP management tools. */
  zaps?: boolean;
}

export interface TokenEvent {
  chat_id: string;
  content: string;
}

export interface DoneEvent {
  chat_id: string;
  stats: ChatStats | null;
  stopped: boolean;
}

export interface ErrorEvent {
  chat_id: string;
  error: AppError;
  /** Tokens used before the error, so a partial reply is still counted. */
  stats?: ChatStats | null;
}

/** Normalizes anything thrown by `invoke` into an AppError. */
export function toAppError(err: unknown): AppError {
  if (err && typeof err === "object" && "code" in err) {
    return err as AppError;
  }
  return { code: "generic", message: String(err) };
}

export function parseStats(raw: string | null): ChatStats | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ChatStats;
  } catch {
    return null;
  }
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),

  providerStatus: () => invoke<Statuses>("provider_status"),
  providerStart: (provider: ProviderKind) => invoke<ProviderStatus>("provider_start", { provider }),
  providerRestart: (provider: ProviderKind) => invoke<ProviderStatus>("provider_restart", { provider }),
  toolVersions: (checkUpdates: boolean, refresh = false) =>
    invoke<ToolVersion[]>("tool_versions", { checkUpdates, refresh }),
  openTool: (tool: ToolName) => invoke<void>("open_tool", { tool }),
  readLink: (url: string) => invoke<LinkResult>("read_link", { url }),
  discordAvailable: () => invoke<boolean>("discord_available"),
  discordUpdate: (presence: DiscordPresence) => invoke<void>("discord_update", { presence }),
  discordClear: () => invoke<void>("discord_clear"),
  voiceStatus: () => invoke<VoiceStatus>("voice_status"),
  voiceInstall: (item: string) => invoke<void>("voice_install", { item }),
  voiceRemove: (item: string) => invoke<void>("voice_remove", { item }),
  recordStart: () => invoke<void>("record_start"),
  recordStop: () => invoke<string>("record_stop"),
  recordCancel: () => invoke<void>("record_cancel"),
  speakStart: (id: string, voiceId: string) => invoke<void>("speak_start", { id, voiceId }),
  speakPush: (id: string, text: string) => invoke<void>("speak_push", { id, text }),
  speakEnd: (id: string) => invoke<void>("speak_end", { id }),
  speakStop: () => invoke<void>("speak_stop"),
  engineInstallSupported: () => invoke<boolean>("engine_install_supported"),
  installEngine: (provider: ProviderKind) => invoke<ProviderStatus>("install_engine", { provider }),

  listModels: () => invoke<ModelInfo[]>("list_models"),
  modelCapabilities: (model: string) => invoke<ModelCaps>("model_capabilities", { model }),
  showModel: (name: string) => invoke<ModelDetails>("show_model", { name }),
  pullModel: (name: string) => invoke<void>("pull_model", { name }),
  cancelPull: (name: string) => invoke<void>("cancel_pull", { name }),
  deleteModel: (name: string) => invoke<void>("delete_model", { name }),

  chatStream: (chatId: string, model: string, messages: PayloadMessage[], options: ChatOptions) =>
    invoke<void>("chat_stream", { chatId, model, messages, options }),
  stopGeneration: (chatId: string) => invoke<void>("stop_generation", { chatId }),
  generateTitle: (chatId: string, model: string) => invoke<Chat | null>("generate_title", { chatId, model }),

  createChat: (model: string | null) => invoke<Chat>("create_chat", { model }),
  listChats: () => invoke<Chat[]>("list_chats"),
  searchChats: (query: string) => invoke<SearchHit[]>("search_chats", { query }),
  renameChat: (id: string, title: string) => invoke<void>("rename_chat", { id, title }),
  pinChat: (id: string, pinned: boolean) => invoke<void>("pin_chat", { id, pinned }),
  setChatModel: (id: string, model: string) => invoke<void>("set_chat_model", { id, model }),
  setChatGroup: (id: string, groupId: string | null) => invoke<void>("set_chat_group", { id, groupId }),
  listGroups: () => invoke<ChatGroup[]>("list_groups"),
  createGroup: (name: string) => invoke<ChatGroup>("create_group", { name }),
  renameGroup: (id: string, name: string) => invoke<void>("rename_group", { id, name }),
  setGroupColor: (id: string, color: string | null) => invoke<void>("set_group_color", { id, color }),
  setGroupCollapsed: (id: string, collapsed: boolean) => invoke<void>("set_group_collapsed", { id, collapsed }),
  reorderGroups: (ids: string[]) => invoke<void>("reorder_groups", { ids }),
  deleteGroup: (id: string, deleteChats: boolean) => invoke<void>("delete_group", { id, deleteChats }),
  deleteChat: (id: string) => invoke<void>("delete_chat", { id }),
  deleteAllChats: () => invoke<void>("delete_all_chats"),

  getMessages: (chatId: string) => invoke<Message[]>("get_messages", { chatId }),
  saveMessage: (message: NewMessage) => invoke<{ message: Message; chat: Chat | null }>("save_message", { message }),
  updateMessage: (id: string, content: string) => invoke<void>("update_message", { id, content }),
  deleteMessage: (id: string) => invoke<void>("delete_message", { id }),
  deleteMessagesAfter: (chatId: string, messageId: string) =>
    invoke<number>("delete_messages_after", { chatId, messageId }),

  exportChat: (chatId: string) => invoke<boolean>("export_chat", { chatId }),
  exportAll: () => invoke<boolean>("export_all"),
  importAll: () => invoke<number | null>("import_all"),

  tokenUsage: () => invoke<ModelUsage[]>("token_usage"),
  chatUsage: (chatId: string) => invoke<ChatUsage>("chat_usage", { chatId }),
  resetUsage: () => invoke<void>("reset_usage"),

  searchStatus: () => invoke<SearchStatus>("search_status"),
  setBraveKey: (key: string | null) => invoke<void>("set_brave_key", { key }),
  testSearch: () => invoke<number>("test_search"),
  searxngSetup: () => invoke<string>("searxng_setup"),
  searxngContainer: () => invoke<ContainerState>("searxng_container"),
  searxngControl: (action: "start" | "stop" | "restart") => invoke<ContainerState>("searxng_control", { action }),

  fileSearch: (query: string) => invoke<FileHit[]>("file_search", { query }),
  indexStatus: () => invoke<IndexStatus>("index_status"),
  rebuildIndex: () => invoke<void>("rebuild_index"),
  readFileAttachment: (path: string) => invoke<FileAttachmentData>("read_file_attachment", { path }),
  answerApproval: (id: string, decision: ApprovalDecision) => invoke<void>("answer_approval", { id, decision }),

  systemUsage: () => invoke<SystemUsage>("system_usage"),
  loadedModels: () => invoke<LoadedModel[]>("loaded_models"),
  unloadModels: (model: string | null) => invoke<boolean>("unload_models", { model }),
  zapsList: () => invoke<Zap[]>("zaps_list"),
  zapSave: (zap: Zap) => invoke<Zap>("zap_save", { zap }),
  zapDelete: (id: string) => invoke<void>("zap_delete", { id }),
  zapRuns: (zapId: string) => invoke<ZapRun[]>("zap_runs", { zapId }),
  zapTotals: (zapId: string) => invoke<ZapTotals>("zap_totals", { zapId }),
  zapActiveRuns: () => invoke<ZapRun[]>("zap_active_runs"),
  zapStart: (zapId: string, input: string | null, model: string | null) =>
    invoke<ZapRun>("zap_start", { zapId, input, model }),
  zapStop: (runId: string) => invoke<void>("zap_stop", { runId }),

  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (settings: Settings) => invoke<void>("set_settings", { settings }),
};

export const events = {
  onProviderStatus: (cb: (e: StatusEvent) => void): Promise<UnlistenFn> =>
    listen<StatusEvent>("provider://status", (e) => cb(e.payload)),
  onDiscordStatus: (cb: (connected: boolean) => void): Promise<UnlistenFn> =>
    listen<{ connected: boolean }>("discord://status", (e) => cb(e.payload.connected)),
  onVoiceDownload: (cb: (e: VoiceDownloadEvent) => void): Promise<UnlistenFn> =>
    listen<VoiceDownloadEvent>("voice://download", (e) => cb(e.payload)),
  onVoiceLevel: (cb: (level: number) => void): Promise<UnlistenFn> =>
    listen<{ level: number }>("voice://level", (e) => cb(e.payload.level)),
  onSpeaking: (cb: (e: SpeakingEvent) => void): Promise<UnlistenFn> =>
    listen<SpeakingEvent>("voice://speaking", (e) => cb(e.payload)),
  onEngineInstall: (cb: (e: EngineInstallEvent) => void): Promise<UnlistenFn> =>
    listen<EngineInstallEvent>("engine://install", (e) => cb(e.payload)),
  onPullProgress: (cb: (p: PullProgress) => void): Promise<UnlistenFn> =>
    listen<PullProgress>("model://progress", (e) => cb(e.payload)),
  onToken: (cb: (e: TokenEvent) => void): Promise<UnlistenFn> =>
    listen<TokenEvent>("chat://token", (e) => cb(e.payload)),
  onDone: (cb: (e: DoneEvent) => void): Promise<UnlistenFn> => listen<DoneEvent>("chat://done", (e) => cb(e.payload)),
  onTool: (cb: (e: ToolEvent) => void): Promise<UnlistenFn> => listen<ToolEvent>("chat://tool", (e) => cb(e.payload)),
  onError: (cb: (e: ErrorEvent) => void): Promise<UnlistenFn> =>
    listen<ErrorEvent>("chat://error", (e) => cb(e.payload)),
  onUsage: (cb: (e: UsageEvent) => void): Promise<UnlistenFn> =>
    listen<UsageEvent>("chat://usage", (e) => cb(e.payload)),
  /** A thinking model is reasoning (`tokens` more pieces, batched). */
  onThinking: (cb: (e: { chat_id: string; tokens: number }) => void): Promise<UnlistenFn> =>
    listen<{ chat_id: string; tokens: number }>("chat://thinking", (e) => cb(e.payload)),
  onZapRun: (cb: (run: ZapRun) => void): Promise<UnlistenFn> => listen<ZapRun>("zap://run", (e) => cb(e.payload)),
  onZapsChanged: (cb: () => void): Promise<UnlistenFn> => listen("zap://changed", () => cb()),
};
