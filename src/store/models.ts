import { create } from "zustand";
import { toast } from "sonner";
import { api, events, toAppError, type ErrorCode, type ModelCaps, type ModelInfo } from "../lib/ipc";
import { t } from "../lib/i18n";

export interface CuratedModel {
  /** Ollama model name; the description lives in the strings (models.descriptions). */
  name: string;
  approxBytes: number;
  /** Recommended system RAM in GB. */
  ramGb: number;
  tier: "small" | "medium";
}

/** Small, popular Ollama models that run well on typical PCs. */
export const CURATED_MODELS: CuratedModel[] = [
  { name: "llama3.2:3b", approxBytes: 2.0e9, ramGb: 8, tier: "small" },
  { name: "gemma2:2b", approxBytes: 1.6e9, ramGb: 8, tier: "small" },
  { name: "llama3.2:1b", approxBytes: 1.3e9, ramGb: 4, tier: "small" },
  { name: "qwen2.5:7b", approxBytes: 4.7e9, ramGb: 16, tier: "medium" },
  { name: "mistral:7b", approxBytes: 4.1e9, ramGb: 16, tier: "medium" },
  { name: "qwen2.5-coder:7b", approxBytes: 4.7e9, ramGb: 16, tier: "medium" },
];

export function curatedDescription(name: string): string {
  return t.models.descriptions[name] ?? "";
}

export interface PullState {
  name: string;
  status: string;
  completed: number;
  total: number;
  speedBps: number;
  error: ErrorCode | null;
}

interface ModelsState {
  /** Models of all enabled, running providers. */
  installed: ModelInfo[];
  loaded: boolean;
  /** Selected model key (see ModelInfo.id). */
  selected: string | null;
  pulls: Record<string, PullState>;
  /** Input capabilities per model key, fetched lazily. */
  caps: Record<string, ModelCaps>;
  ensureCaps: (key: string) => Promise<ModelCaps>;
  init: () => Promise<void>;
  refresh: () => Promise<void>;
  select: (key: string | null) => void;
  pull: (name: string) => Promise<boolean>;
  cancelPull: (name: string) => Promise<void>;
  dismissPull: (name: string) => void;
  remove: (name: string) => Promise<void>;
}

/** Ollama lists "llama3.2:3b" but users may type "llama3.2" (= ":latest"). */
export function sameModel(a: string, b: string): boolean {
  const norm = (n: string) => (n.includes(":") ? n : `${n}:latest`);
  return norm(a.trim()) === norm(b.trim());
}

/** Whether an Ollama model with this name is installed. */
export function hasOllamaModel(installed: ModelInfo[], name: string): boolean {
  return installed.some((m) => m.provider === "ollama" && sameModel(m.name, name));
}

export const MODEL_NAME = /^[\w.\-/]+(:[\w.-]+)?$/;

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

export const useModels = create<ModelsState>((set, get) => ({
  installed: [],
  loaded: false,
  selected: null,
  pulls: {},
  caps: {},

  ensureCaps: async (key) => {
    const known = get().caps[key];
    if (known) return known;
    let caps: ModelCaps = { vision: false, tools: false };
    try {
      caps = await api.modelCapabilities(key);
    } catch {
      // Unknown capabilities: treat as text-only.
    }
    set({ caps: { ...get().caps, [key]: caps } });
    return caps;
  },

  init: async () => {
    await events.onPullProgress((p) => {
      const current = get().pulls[p.name];
      if (!current || current.error) return;
      set({
        pulls: {
          ...get().pulls,
          [p.name]: { ...current, status: p.status, completed: p.completed, total: p.total, speedBps: p.speed_bps },
        },
      });
    });
  },

  refresh: async () => {
    try {
      const installed = await api.listModels();
      const { selected } = get();
      const stillThere = selected !== null && installed.some((m) => m.id === selected);
      set({ installed, loaded: true, selected: stillThere ? selected : (installed[0]?.id ?? null) });
    } catch {
      set({ loaded: true });
    }
  },

  select: (selected) => set({ selected }),

  // Downloads are Ollama-only (LM Studio manages its own models).
  pull: async (rawName) => {
    const name = rawName.trim();
    if (!name || get().pulls[name]?.error === null) return false;
    set({
      pulls: {
        ...get().pulls,
        [name]: { name, status: "pulling manifest", completed: 0, total: 0, speedBps: 0, error: null },
      },
    });
    try {
      await api.pullModel(name);
      set({ pulls: without(get().pulls, name) });
      await get().refresh();
      if (!get().selected) set({ selected: name });
      toast(t.models.ready(name));
      return true;
    } catch (err) {
      const { code } = toAppError(err);
      if (code === "cancelled") {
        set({ pulls: without(get().pulls, name) });
        toast(t.models.downloadCancelled);
        return false;
      }
      const current = get().pulls[name];
      if (current) set({ pulls: { ...get().pulls, [name]: { ...current, error: code } } });
      return false;
    }
  },

  cancelPull: async (name) => {
    await api.cancelPull(name);
  },

  dismissPull: (name) => set({ pulls: without(get().pulls, name) }),

  remove: async (name) => {
    try {
      await api.deleteModel(name);
      toast(t.models.deleted(name));
    } catch {
      toast(t.errors.generic);
    }
    await get().refresh();
  },
}));
