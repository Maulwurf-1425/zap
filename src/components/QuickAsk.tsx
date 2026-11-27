import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowUpRight, Copy, CornerDownLeft, RotateCcw, Square } from "lucide-react";
import { Toaster, toast } from "sonner";
import { DotBolt } from "./Brand";
import { Markdown } from "./Markdown";
import { Select } from "./ui/Select";
import { api, events, modelLabel, toAppError, type ChatStats, type ModelInfo, type PayloadMessage } from "../lib/ipc";
import { copyText, uid } from "../lib/format";
import { errorMessage, t } from "../lib/i18n";
import { groupModels } from "../lib/modelGroups";
import { watchSystemTheme } from "../lib/theme";
import { applySettingsAppearance, useSettings } from "../store/settings";
import { dateContext } from "../store/chats";

const MODEL_KEY = "zap.quickModel";

interface Turn {
  question: string;
  answer: string;
  stats: ChatStats | null;
  error: string | null;
  done: boolean;
}

function storedModel(): string | null {
  try {
    return localStorage.getItem(MODEL_KEY);
  } catch {
    return null;
  }
}

/** The small window on the global shortcut (see src-tauri/src/quick.rs). */
export function QuickAsk() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streamId, setStreamId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const q = t.quick;

  // Settings, theme and models; refreshed each time the window shows.
  const refresh = useCallback(async () => {
    await useSettings.getState().load();
    applySettingsAppearance(useSettings.getState().settings);
    const list = await api.listModels().catch(() => [] as ModelInfo[]);
    setModels(list);
    const preferred = storedModel() ?? (await api.quickModel().catch(() => null));
    setModel((current) => {
      const keep = [current, preferred].find((m) => m && list.some((x) => x.id === m));
      return keep ?? list[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    void refresh();
    const unTheme = watchSystemTheme(
      () => useSettings.getState().settings.theme,
      () => applySettingsAppearance(useSettings.getState().settings),
    );
    const unShow = listen("quick://show", () => {
      void refresh();
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    });
    return () => {
      unTheme();
      void unShow.then((f) => f());
    };
  }, [refresh]);

  // Streaming answers for this window's question ids.
  useEffect(() => {
    const mine = (id: string) => id.startsWith("quick:");
    const updateLast = (f: (t: Turn) => Turn) =>
      setTurns((list) => list.map((x, i) => (i === list.length - 1 ? f(x) : x)));
    const subs = [
      events.onToken(({ chat_id, content }) => {
        if (mine(chat_id)) updateLast((x) => ({ ...x, answer: x.answer + content }));
      }),
      events.onDone(({ chat_id, stats }) => {
        if (!mine(chat_id)) return;
        updateLast((x) => ({ ...x, stats, done: true }));
        setStreamId(null);
      }),
      events.onError(({ chat_id, error }) => {
        if (!mine(chat_id)) return;
        updateLast((x) => ({ ...x, error: errorMessage(error.code), done: true }));
        setStreamId(null);
      }),
    ];
    return () => {
      for (const s of subs) void s.then((f) => f());
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const ask = async () => {
    const question = input.trim();
    if (!question || !model || streamId) return;
    const history: PayloadMessage[] = turns
      .filter((x) => x.done && !x.error)
      .flatMap((x) => [
        { role: "user" as const, content: x.question },
        { role: "assistant" as const, content: x.answer },
      ]);
    const { temperature, context_length, system_prompt } = useSettings.getState().settings;
    const messages: PayloadMessage[] = [
      { role: "system", content: `${dateContext()}\n${q.systemHint}` },
      ...(system_prompt.trim() ? [{ role: "system" as const, content: system_prompt.trim() }] : []),
      ...history,
      { role: "user", content: question },
    ];
    const id = `quick:${uid()}`;
    setTurns((list) => [...list, { question, answer: "", stats: null, error: null, done: false }]);
    setInput("");
    setStreamId(id);
    try {
      await api.chatStream(id, model, messages, { temperature, num_ctx: context_length });
    } catch (err) {
      setTurns((list) =>
        list.map((x, i) =>
          i === list.length - 1 ? { ...x, error: errorMessage(toAppError(err).code), done: true } : x,
        ),
      );
      setStreamId(null);
    }
  };

  const stop = () => {
    if (streamId) void api.stopGeneration(streamId);
  };

  const reset = () => {
    stop();
    setTurns([]);
    setInput("");
    inputRef.current?.focus();
  };

  /** Saves the exchange as a chat and opens it in ZAP. */
  const openInZap = async () => {
    const finished = turns.filter((x) => x.done && !x.error);
    if (!model || finished.length === 0) return;
    try {
      const chat = await api.createChat(model);
      let at = Date.now() - finished.length * 2;
      for (const x of finished) {
        await api.saveMessage({ id: uid(), chat_id: chat.id, role: "user", content: x.question, created_at: at++ });
        await api.saveMessage({
          id: uid(),
          chat_id: chat.id,
          role: "assistant",
          content: x.answer,
          created_at: at++,
          model,
          stats: x.stats,
        });
      }
      setTurns([]);
      // A title like any other chat (the model writes it in the background).
      void api.generateTitle(chat.id, model).catch(() => undefined);
      await api.quickOpenChat(chat.id);
    } catch {
      toast(t.errors.generic);
    }
  };

  const last = turns.at(-1);
  const canOpen = turns.some((x) => x.done && !x.error) && !streamId;

  return (
    <div
      className="flex h-full flex-col overflow-hidden border border-border bg-[var(--bg)] text-fg"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          void api.quickHide();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void openInZap();
        }
      }}
    >
      <div className="flex items-start gap-3 border-b border-border px-4 py-3" data-tauri-drag-region>
        <div className="mt-1 flex-none">
          <DotBolt size={26} variant={streamId ? "loop" : "static"} />
        </div>
        <textarea
          ref={inputRef}
          autoFocus
          rows={1}
          className="min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[17px] leading-6 outline-none placeholder:text-fg-subtle"
          placeholder={turns.length ? q.followUp : q.placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              void ask();
            }
          }}
        />
        <div className="w-48 flex-none">
          <Select
            label={q.model}
            value={model ?? ""}
            onChange={(v) => {
              setModel(v);
              try {
                localStorage.setItem(MODEL_KEY, v);
              } catch {
                // Only a convenience.
              }
            }}
            options={groupModels(models).map((g) => ({
              label: g.label,
              options: g.models.map((m) => ({ value: m.id, label: m.name })),
            }))}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {turns.length === 0 ? (
          <p className="text-ui text-fg-subtle">{model ? q.empty : q.noModel}</p>
        ) : (
          <div className="flex flex-col gap-5">
            {turns.map((x, i) => (
              <div key={i} className="flex flex-col gap-2">
                <p className="text-caption font-medium text-fg-muted">{x.question}</p>
                {x.error ? (
                  <p className="text-ui text-danger">{x.error}</p>
                ) : x.answer ? (
                  <div className={`markdown selectable ${!x.done ? "streaming" : ""}`}>
                    <Markdown content={x.answer} />
                  </div>
                ) : (
                  <p className="text-ui text-fg-subtle">{q.thinking}</p>
                )}
              </div>
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-4 py-2 text-caption text-fg-subtle">
        <span className="flex items-center gap-1">
          <CornerDownLeft size={12} aria-hidden="true" /> {q.hintAsk}
        </span>
        <span>· {q.hintClose}</span>
        <span className="min-w-0 flex-1 truncate">{model ? `· ${modelLabel(model)}` : ""}</span>
        {streamId ? (
          <button className="btn btn-ghost h-7 px-2 text-caption" onClick={stop}>
            <Square size={12} strokeWidth={2} aria-hidden="true" /> {q.stop}
          </button>
        ) : (
          <>
            {last?.answer && (
              <button
                className="btn btn-ghost h-7 px-2 text-caption"
                onClick={() => void copyText(last.answer).then((ok) => toast(ok ? t.toast.copied : t.errors.generic))}
              >
                <Copy size={12} strokeWidth={1.75} aria-hidden="true" /> {q.copy}
              </button>
            )}
            {turns.length > 0 && (
              <button className="btn btn-ghost h-7 px-2 text-caption" onClick={reset}>
                <RotateCcw size={12} strokeWidth={1.75} aria-hidden="true" /> {q.newQuestion}
              </button>
            )}
            <button
              className="btn btn-secondary h-7 px-2.5 text-caption"
              disabled={!canOpen}
              onClick={() => void openInZap()}
            >
              <ArrowUpRight size={12} strokeWidth={1.75} aria-hidden="true" /> {q.openInZap}
            </button>
          </>
        )}
      </div>
      <Toaster position="bottom-center" toastOptions={{ unstyled: true, classNames: { toast: "zap-toast" } }} />
    </div>
  );
}
