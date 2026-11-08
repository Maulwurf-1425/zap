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
};

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  /** Applies immediately; persists unless `persist` is false (e.g. while dragging). */
  update: (patch: Partial<Settings>, persist?: boolean) => Promise<void>;
}

function apply(s: Settings) {
  applyAppearance({ theme: s.theme, fontSize: s.font_size, density: s.density, language: s.language });
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
      apply(settings);
    } catch {
      set({ loaded: true });
    }
  },

  update: async (patch, persist = true) => {
    const settings = { ...get().settings, ...patch };
    if (patch.language) setLanguage(patch.language);
    set({ settings });
    if ("theme" in patch || "font_size" in patch || "density" in patch || "language" in patch) apply(settings);
    if (persist) await api.setSettings(settings);
  },
}));
