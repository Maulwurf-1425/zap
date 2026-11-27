import { create } from "zustand";
import { api, events, toAppError, type ChatStats, type ErrorCode } from "../lib/ipc";
import { useSettings } from "./settings";

export const MAX_COMPARE = 4;

export interface CompareColumn {
  /** Model key. */
  model: string;
  /** Stream id (`compare:<run>:<i>`). */
  streamId: string;
  status: "waiting" | "running" | "done" | "stopped" | "error";
  text: string;
  error: ErrorCode | null;
  stats: ChatStats | null;
  /** Wall-clock times (ms since epoch). */
  startedAt: number | null;
  firstTokenAt: number | null;
  endedAt: number | null;
}

interface CompareState {
  /** Chosen models, in column order. */
  models: string[];
  prompt: string;
  /** Run the models at the same time (otherwise one after another). */
  parallel: boolean;
  columns: CompareColumn[];
  running: boolean;

  init: () => Promise<void>;
  setModels: (models: string[]) => void;
  toggleModel: (model: string) => void;
  setPrompt: (prompt: string) => void;
  setParallel: (parallel: boolean) => void;
  run: () => Promise<void>;
  stop: () => void;
}

/** Resolvers waiting for a stream to end, by stream id. */
const waiters = new Map<string, () => void>();
// Tokens arrive fast: commit once per frame.
const pending = new Map<string, string>();
let frame = 0;

export const useCompare = create<CompareState>((set, get) => {
  const patch = (streamId: string, p: Partial<CompareColumn>) =>
    set({ columns: get().columns.map((c) => (c.streamId === streamId ? { ...c, ...p } : c)) });

  function flush() {
    frame = 0;
    if (pending.size === 0) return;
    const now = Date.now();
    set({
      columns: get().columns.map((c) => {
        const add = pending.get(c.streamId);
        return add ? { ...c, text: c.text + add, firstTokenAt: c.firstTokenAt ?? now } : c;
      }),
    });
    pending.clear();
  }

  function finish(streamId: string, p: Partial<CompareColumn>) {
    if (frame) cancelAnimationFrame(frame);
    flush();
    patch(streamId, { ...p, endedAt: Date.now() });
    waiters.get(streamId)?.();
    waiters.delete(streamId);
  }

  async function runOne(col: CompareColumn, prompt: string) {
    const { temperature, context_length } = useSettings.getState().settings;
    patch(col.streamId, { status: "running", startedAt: Date.now() });
    const ended = new Promise<void>((resolve) => waiters.set(col.streamId, resolve));
    try {
      // No tools: a fair comparison of the models themselves.
      await api.chatStream(col.streamId, col.model, [{ role: "user", content: prompt }], {
        temperature,
        num_ctx: context_length,
      });
    } catch (err) {
      finish(col.streamId, { status: "error", error: toAppError(err).code });
    }
    await ended;
  }

  return {
    models: [],
    prompt: "",
    parallel: false,
    columns: [],
    running: false,

    init: async () => {
      const mine = (id: string) => id.startsWith("compare:");
      await Promise.all([
        events.onToken(({ chat_id, content }) => {
          if (!mine(chat_id)) return;
          pending.set(chat_id, (pending.get(chat_id) ?? "") + content);
          if (!frame) frame = requestAnimationFrame(flush);
        }),
        events.onDone(({ chat_id, stats, stopped }) => {
          if (mine(chat_id)) finish(chat_id, { status: stopped ? "stopped" : "done", stats });
        }),
        events.onError(({ chat_id, error, stats }) => {
          if (mine(chat_id)) finish(chat_id, { status: "error", error: error.code, stats: stats ?? null });
        }),
      ]);
    },

    setModels: (models) => set({ models: models.slice(0, MAX_COMPARE) }),
    toggleModel: (model) => {
      const models = get().models;
      if (models.includes(model)) set({ models: models.filter((m) => m !== model) });
      else if (models.length < MAX_COMPARE) set({ models: [...models, model] });
    },
    setPrompt: (prompt) => set({ prompt }),
    setParallel: (parallel) => set({ parallel }),

    run: async () => {
      const { models, prompt, parallel, running } = get();
      const text = prompt.trim();
      if (running || models.length < 2 || !text) return;
      const runId = Math.random().toString(36).slice(2, 8);
      const columns: CompareColumn[] = models.map((model, i) => ({
        model,
        streamId: `compare:${runId}:${i}`,
        status: "waiting",
        text: "",
        error: null,
        stats: null,
        startedAt: null,
        firstTokenAt: null,
        endedAt: null,
      }));
      set({ columns, running: true });
      if (parallel) {
        await Promise.all(columns.map((c) => runOne(c, text)));
      } else {
        for (const c of columns) {
          // Stopped while waiting: the rest stays "stopped".
          if (!get().running) break;
          await runOne(c, text);
        }
      }
      set({ running: false });
    },

    stop: () => {
      set({ running: false });
      for (const c of get().columns) {
        if (c.status === "running") void api.stopGeneration(c.streamId);
        if (c.status === "waiting") patch(c.streamId, { status: "stopped" });
      }
    },
  };
});
