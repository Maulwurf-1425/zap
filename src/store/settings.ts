import { create } from "zustand";
import { api, type Settings } from "../lib/ipc";
import { applyAppearance } from "../lib/theme";
import { normalizeLanguage, setLanguage } from "../lib/i18n";

export const SIDEBAR_MIN = 240;
export const SIDEBAR_MAX = 360;
export const LMSTUDIO_DEFAULT_PORT = 1234;

export const DEFAULT_SETTINGS: Settings = {
  default_model: null,
  system_prompt: "",
  temperature: 0.7,
  context_length: null,
  theme: "dark",
  font_size: 16,
  density: "comfortable",
  onboarding_done: false,
  sidebar_width: 280,
  sidebar_collapsed: false,
  language: "en",
  ollama_enabled: true,
  lmstudio_enabled: false,
  lmstudio_port: LMSTUDIO_DEFAULT_PORT,
  web_search_enabled: false,
  search_provider: "builtin",
  searxng_url: "http://127.0.0.1:8888",
  search_monthly_limit: 900,
  file_tools_enabled: false,
  file_permission: "ask",
  auto_update: true,
  palette: "zap",
  custom_accent: "#fd614b",
  custom_tint: "#3283be",
  font_family: "inter",
  line_height: 1.625,
  letter_spacing: 0,
  paragraph_spacing: 0.875,
  blueprints: null,
  last_seen_version: null,
  read_links: true,
  voice_model: "base",
  voice_language: "auto",
  mic_device: null,
  voice_de: "de_DE-thorsten-medium",
  voice_en: "en_US-amy-medium",
  speech_rate: 1,
  auto_read: false,
  discord_presence: false,
  discord_show_model: true,
  zap_permission: "ask",
  zaps_in_chat: true,
  close_to_tray: true,
  autostart: false,
  zap_notifications: true,
  model_idle_minutes: null,
};

/** Fields the appearance tab's reset button restores. */
export const TYPOGRAPHY_KEYS = [
  "font_family",
  "font_size",
  "line_height",
  "letter_spacing",
  "paragraph_spacing",
] as const;

const APPEARANCE_KEYS: (keyof Settings)[] = [
  "theme",
  "density",
  "language",
  "palette",
  "custom_accent",
  "custom_tint",
  ...TYPOGRAPHY_KEYS,
];

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  /** Applies immediately; persists unless `persist` is false (e.g. while dragging). */
  update: (patch: Partial<Settings>, persist?: boolean) => Promise<void>;
}

export function applySettingsAppearance(s: Settings): void {
  applyAppearance({
    theme: s.theme,
    fontSize: s.font_size,
    density: s.density,
    language: s.language,
    palette: s.palette,
    customAccent: s.custom_accent,
    customTint: s.custom_tint,
    fontFamily: s.font_family,
    lineHeight: s.line_height,
    letterSpacing: s.letter_spacing,
    paragraphSpacing: s.paragraph_spacing,
  });
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  load: async () => {
    try {
      const loaded = { ...DEFAULT_SETTINGS, ...(await api.getSettings()) };
      const settings = { ...loaded, language: normalizeLanguage(loaded.language) };
      // Switch strings before React re-renders with the loaded settings.
      setLanguage(settings.language);
      set({ settings, loaded: true });
      applySettingsAppearance(settings);
    } catch {
      set({ loaded: true });
    }
  },

  update: async (patch, persist = true) => {
    const settings = { ...get().settings, ...patch };
    if (patch.language) setLanguage(patch.language);
    set({ settings });
    if (APPEARANCE_KEYS.some((k) => k in patch)) applySettingsAppearance(settings);
    if (persist) await api.setSettings(settings);
  },
}));
