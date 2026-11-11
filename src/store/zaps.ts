import { create } from "zustand";
import { toast } from "sonner";
import {
  api,
  events,
  toAppError,
  type ChatStats,
  type ToolActivity,
  type Zap,
  type ZapRun,
  type ZapTotals,
} from "../lib/ipc";
import { t } from "../lib/i18n";
import { useModels } from "./models";

/** A run in progress: the report so far and its tool steps. */
export interface LiveRun {
  run: ZapRun;
  output: string;
  activities: ToolActivity[];
  /** Tokens of the finished model turns (from the server). */
  stats: ChatStats | null;
  /** Streamed pieces of the current turn, about one token each. */
  streamed: number;
}

/** Tokens of a live run so far: finished turns plus the streaming one. */
export function liveTokens(l: LiveRun): { input: number; output: number } {
  return { input: l.stats?.prompt_eval_count ?? 0, output: (l.stats?.eval_count ?? 0) + l.streamed };
}

interface ZapsState {
  zaps: Zap[];
  loaded: boolean;
  /** ZAP shown in the main area (instead of the chat), or null. */
  openId: string | null;
  /** Runs in progress, by run id. */
  live: Record<string, LiveRun>;
  /** Run history per ZAP, newest first (loaded when a ZAP is opened). */
  runs: Record<string, ZapRun[]>;
  /** Lifetime numbers per ZAP (loaded when a ZAP is opened). */
  totals: Record<string, ZapTotals>;
  /** ZAP in the editor; an empty id means a new one. */
  editing: Zap | null;

  init: () => Promise<void>;
  reload: () => Promise<void>;
  open: (id: string | null) => void;
  loadRuns: (zapId: string) => Promise<void>;
  save: (zap: Zap) => Promise<Zap | null>;
  remove: (id: string) => Promise<void>;
  start: (zapId: string, input: string | null) => Promise<void>;
  stop: (runId: string) => void;
  edit: (zap: Zap | null) => void;
}

export const DEFAULT_STEPS = 20;
export const MAX_STEPS = 60;

export function blankZap(): Zap {
  return {
    id: "",
    name: "",
    icon: "sparkles",
    color: null,
    instructions: "",
    model: null,
    tools: { web: true, files: false, terminal: false, apps: false },
    max_steps: DEFAULT_STEPS,
    created_at: 0,
    updated_at: 0,
  };
}

/** Running run of a ZAP, if any. */
export function liveRunOf(live: Record<string, LiveRun>, zapId: string): LiveRun | undefined {
  return Object.values(live).find((l) => l.run.zap_id === zapId);
}

export function zapErrorText(code: string | null): string {
  if (!code) return t.errors.generic;
  return t.zaps.errors[code] ?? t.errors.generic;
}

// Tokens arrive far faster than the screen refreshes: commit once per frame.
const pending = new Map<string, string>();
const pendingChunks = new Map<string, number>();
let frame = 0;

function flush() {
  frame = 0;
  if (pending.size === 0) return;
  const live = { ...useZaps.getState().live };
  for (const [runId, text] of pending) {
    const entry = live[runId];
    if (entry) {
      live[runId] = {
        ...entry,
        output: entry.output + text,
        streamed: entry.streamed + (pendingChunks.get(runId) ?? 0),
      };
    }
  }
  pending.clear();
  pendingChunks.clear();
  useZaps.setState({ live });
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

export const useZaps = create<ZapsState>((set, get) => {
  function onToken(runId: string, content: string) {
    if (!get().live[runId]) return;
    pending.set(runId, (pending.get(runId) ?? "") + content);
    pendingChunks.set(runId, (pendingChunks.get(runId) ?? 0) + 1);
    if (!frame) frame = requestAnimationFrame(flush);
  }

  function onTool(runId: string, activity: ToolActivity) {
    const entry = get().live[runId];
    if (!entry) return;
    const idx = entry.activities.findIndex((a) => a.id === activity.id);
    const activities =
      idx >= 0 ? entry.activities.map((a, i) => (i === idx ? activity : a)) : [...entry.activities, activity];
    set({ live: { ...get().live, [runId]: { ...entry, activities } } });
    // A ZAP waiting for approval while the user looks elsewhere.
    if (activity.status === "pending" && get().openId !== entry.run.zap_id) {
      const name = get().zaps.find((z) => z.id === entry.run.zap_id)?.name ?? "ZAP";
      toast(t.zaps.waiting(name), {
        action: { label: t.zaps.show, onClick: () => get().open(entry.run.zap_id) },
      });
    }
  }

  function onThinking(runId: string, tokens: number) {
    const entry = get().live[runId];
    if (entry) set({ live: { ...get().live, [runId]: { ...entry, streamed: entry.streamed + tokens } } });
  }

  function onUsage(runId: string, stats: ChatStats) {
    const entry = get().live[runId];
    if (!entry) return;
    if (frame) cancelAnimationFrame(frame);
    flush();
    // The server numbers replace the streamed estimate of that turn.
    set({ live: { ...get().live, [runId]: { ...get().live[runId]!, stats, streamed: 0 } } });
  }

  async function loadTotals(zapId: string) {
    const totals = await api.zapTotals(zapId).catch(() => null);
    if (totals) set({ totals: { ...get().totals, [zapId]: totals } });
  }

  function onRun(run: ZapRun) {
    if (run.status === "running") {
      if (!get().live[run.id]) {
        set({ live: { ...get().live, [run.id]: { run, output: "", activities: [], stats: null, streamed: 0 } } });
      }
    } else {
      if (frame) cancelAnimationFrame(frame);
      flush();
      set({ live: withoutKey(get().live, run.id) });
      void loadTotals(run.zap_id);
      const zap = get().zaps.find((z) => z.id === run.zap_id);
      if (zap && run.status !== "stopped") {
        const text = run.status === "done" ? t.zaps.finished(zap.name) : t.zaps.failedToast(zap.name);
        toast(
          text,
          get().openId === zap.id ? undefined : { action: { label: t.zaps.show, onClick: () => get().open(zap.id) } },
        );
      }
    }
    const list = get().runs[run.zap_id];
    if (list) {
      const rest = list.filter((r) => r.id !== run.id);
      set({ runs: { ...get().runs, [run.zap_id]: [run, ...rest] } });
    }
  }

  return {
    zaps: [],
    loaded: false,
    openId: null,
    live: {},
    runs: {},
    totals: {},
    editing: null,

    init: async () => {
      await Promise.all([
        events.onToken(({ chat_id, content }) => onToken(chat_id, content)),
        events.onTool(({ chat_id, activity }) => onTool(chat_id, activity)),
        events.onUsage(({ chat_id, stats }) => onUsage(chat_id, stats)),
        events.onThinking(({ chat_id, tokens }) => onThinking(chat_id, tokens)),
        events.onZapRun(onRun),
        events.onZapsChanged(() => void get().reload()),
      ]);
      await get().reload();
      const active = await api.zapActiveRuns().catch(() => []);
      const live = { ...get().live };
      for (const run of active) live[run.id] ??= { run, output: "", activities: [], stats: null, streamed: 0 };
      set({ live });
    },

    reload: async () => {
      try {
        const zaps = await api.zapsList();
        const ids = new Set(zaps.map((z) => z.id));
        set({ zaps, loaded: true, openId: ids.has(get().openId ?? "") ? get().openId : null });
      } catch {
        set({ loaded: true });
      }
    },

    open: (id) => {
      set({ openId: id });
      if (id) {
        void get().loadRuns(id);
        void loadTotals(id);
      }
    },

    loadRuns: async (zapId) => {
      try {
        const runs = await api.zapRuns(zapId);
        set({ runs: { ...get().runs, [zapId]: runs } });
      } catch {
        toast(t.errors.generic);
      }
    },

    save: async (zap) => {
      try {
        const saved = await api.zapSave(zap);
        const exists = get().zaps.some((z) => z.id === saved.id);
        set({ zaps: exists ? get().zaps.map((z) => (z.id === saved.id ? saved : z)) : [...get().zaps, saved] });
        return saved;
      } catch {
        toast(t.errors.generic);
        return null;
      }
    },

    remove: async (id) => {
      try {
        await api.zapDelete(id);
      } catch {
        toast(t.errors.generic);
        return;
      }
      set({
        zaps: get().zaps.filter((z) => z.id !== id),
        runs: withoutKey(get().runs, id),
        openId: get().openId === id ? null : get().openId,
      });
    },

    start: async (zapId, input) => {
      try {
        const run = await api.zapStart(zapId, input, useModels.getState().selected);
        onRun(run);
      } catch (err) {
        const code = toAppError(err).message;
        toast(t.zaps.errors[code] ?? t.errors.generic);
      }
    },

    stop: (runId) => void api.zapStop(runId).catch(() => undefined),

    edit: (zap) => set({ editing: zap }),
  };
});
