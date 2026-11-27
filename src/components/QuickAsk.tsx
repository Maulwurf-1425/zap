import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowUpRight, Copy, Cpu, RotateCcw, ScanText, Square, X } from "lucide-react";
import { Toaster, toast } from "sonner";
import { Bolt, DotBolt } from "./Brand";
import { Markdown } from "./Markdown";
import { IconButton } from "./ui/IconButton";
import { Select } from "./ui/Select";
import { api, events, toAppError, type ChatStats, type ModelInfo, type PayloadMessage } from "../lib/ipc";
import { serializeAttachments } from "../lib/attachments";
import { copyText, uid } from "../lib/format";
import { errorMessage, t } from "../lib/i18n";
import { groupModels } from "../lib/modelGroups";
import { watchSystemTheme } from "../lib/theme";
import { applySettingsAppearance, useSettings } from "../store/settings";
import { dateContext } from "../store/chats";

const MODEL_KEY = "zap.quickModel";
/** Room for the model list, which opens upward. */
const MENU_ROOM = 340;
/** Longest edge of a screenshot handed to the model. */
const SHOT_MAX = 1920;

interface Shot {
  /** JPEG data URL of the picked area. */
  image: string;
  /** Text Windows OCR found on it (null while reading). */
  text: string | null;
}

interface Turn {
  question: string;
  shot: Shot | null;
  answer: string;
  stats: ChatStats | null;
  error: string | null;
  done: boolean;
}

interface Capture {
  image: string;
  width: number;
  height: number;
}

function storedModel(): string | null {
  try {
    return localStorage.getItem(MODEL_KEY);
  } catch {
    return null;
  }
}

/** Crops a rectangle (in image pixels) out of a data URL, scaled down to SHOT_MAX. */
async function crop(src: string, x: number, y: number, w: number, h: number): Promise<string> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const scale = Math.min(1, SHOT_MAX / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext("2d")?.drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.9);
}

/** The window on the global shortcut (see src-tauri/src/quick.rs): ZAP's
 *  chat box at the bottom of the screen, answers above it. */
export function QuickAsk() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [vision, setVision] = useState(false);
  const [input, setInput] = useState("");
  const [shot, setShot] = useState<Shot | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streamId, setStreamId] = useState<string | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const q = t.quick;

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
      () => {
        applySettingsAppearance(useSettings.getState().settings);
      },
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

  useEffect(() => {
    if (!model) return;
    let alive = true;
    void api
      .modelCapabilities(model)
      .then((c) => alive && setVision(c.vision))
      .catch(() => alive && setVision(false));
    return () => {
      alive = false;
    };
  }, [model]);

  // Keep the window as tall as the cards (bottom-anchored by the backend).
  useLayoutEffect(() => {
    const el = stackRef.current;
    if (!el || capture) return;
    const resize = () => void api.quickResize(el.offsetHeight + 16 + (menuOpen ? MENU_ROOM : 0));
    resize();
    const obs = new ResizeObserver(resize);
    obs.observe(el);
    return () => obs.disconnect();
  }, [capture, menuOpen]);

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

  // --- Screen capture -------------------------------------------------------------

  const startCapture = async () => {
    try {
      setCapture(await api.quickCaptureStart());
    } catch {
      toast(q.captureFailed);
    }
  };

  const finishCapture = async (area: { x: number; y: number; w: number; h: number } | null) => {
    const cap = capture;
    setCapture(null);
    await api.quickCaptureEnd();
    requestAnimationFrame(() => inputRef.current?.focus());
    if (!cap || !area) return;
    const image = await crop(cap.image, area.x, area.y, area.w, area.h);
    setShot({ image, text: null });
    const text = await api.quickOcr(image).catch(() => "");
    setShot((s) => (s && s.image === image ? { ...s, text } : s));
  };

  // --- Asking -----------------------------------------------------------------------

  const ask = async () => {
    const question = input.trim() || (shot ? q.describeShot : "");
    if (!question || !model || streamId) return;
    const history: PayloadMessage[] = turns
      .filter((x) => x.done && !x.error)
      .flatMap((x) => [
        { role: "user" as const, content: x.question },
        { role: "assistant" as const, content: x.answer },
      ]);
    const { temperature, context_length, system_prompt } = useSettings.getState().settings;
    const shotText = shot?.text?.trim() ? `\n\n[${q.shotTextLabel}]\n${shot.text.trim()}` : "";
    const user: PayloadMessage = {
      role: "user",
      content: question + shotText,
      ...(shot && vision ? { images: [shot.image] } : {}),
    };
    const messages: PayloadMessage[] = [
      { role: "system", content: `${dateContext()}\n${q.systemHint}` },
      ...(system_prompt.trim() ? [{ role: "system" as const, content: system_prompt.trim() }] : []),
      ...history,
      user,
    ];
    const id = `quick:${uid()}`;
    setTurns((list) => [...list, { question, shot, answer: "", stats: null, error: null, done: false }]);
    setInput("");
    setShot(null);
    if (inputRef.current) inputRef.current.style.height = "auto";
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
    setShot(null);
    setInput("");
    inputRef.current?.focus();
  };

  /** Saves the exchange as a chat (screenshots as image attachments) and opens it. */
  const openInZap = async () => {
    const finished = turns.filter((x) => x.done && !x.error);
    if (!model || finished.length === 0) return;
    try {
      const chat = await api.createChat(model);
      let at = Date.now() - finished.length * 2;
      for (const x of finished) {
        // The screenshot and its recognized text travel as attachments, so the
        // chat shows the question and the model still gets both.
        const text = x.shot?.text?.trim();
        const attachments = x.shot
          ? serializeAttachments([
              {
                id: uid(),
                name: q.shotName,
                kind: "image",
                mime: "image/jpeg",
                size: Math.round((x.shot.image.length * 3) / 4),
                data: x.shot.image,
              },
              ...(text
                ? [
                    {
                      id: uid(),
                      name: `${q.shotTextLabel}.txt`,
                      kind: "text" as const,
                      mime: "text/plain",
                      size: new Blob([text]).size,
                      data: text,
                    },
                  ]
                : []),
            ])
          : null;
        await api.saveMessage({
          id: uid(),
          chat_id: chat.id,
          role: "user",
          content: x.question,
          created_at: at++,
          attachments,
        });
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
      void api.generateTitle(chat.id, model).catch(() => undefined);
      await api.quickOpenChat(chat.id);
    } catch {
      toast(t.errors.generic);
    }
  };

  if (capture) return <CaptureOverlay capture={capture} onDone={(area) => void finishCapture(area)} />;

  const last = turns.at(-1);
  const canOpen = turns.some((x) => x.done && !x.error) && !streamId;
  const canSend = Boolean(model) && !streamId && (input.trim() !== "" || shot !== null);

  return (
    <div
      className="flex h-screen flex-col justify-end p-2"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          if (streamId) stop();
          else void api.quickHide();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void openInZap();
        }
      }}
    >
      <div ref={stackRef} className="flex flex-col gap-2">
        {turns.length > 0 && (
          <div
            // The window grows with its content, so the cap comes from the screen, not vh.
            style={{ maxHeight: Math.round(window.screen.availHeight * 0.55) }}
            className="flex flex-col overflow-hidden rounded-xl border border-border bg-[var(--bg)] shadow-card"
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="flex flex-col gap-5">
                {turns.map((x, i) => (
                  <div key={i} className="flex gap-3">
                    <div className="mt-0.5 flex w-6 flex-none justify-center">
                      <DotBolt size={24} variant={!x.done ? "loop" : "static"} />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <div className="flex items-center gap-2">
                        {x.shot && (
                          <img
                            src={x.shot.image}
                            alt=""
                            className="h-8 w-12 flex-none rounded border border-border object-cover"
                          />
                        )}
                        <p className="min-w-0 text-caption font-medium text-fg-muted">{x.question}</p>
                      </div>
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
                  </div>
                ))}
                <div ref={endRef} />
              </div>
            </div>
            <div className="flex items-center gap-1 border-t border-border px-3 py-1.5 text-caption text-fg-subtle">
              <span className="min-w-0 flex-1 truncate px-1">{q.hints}</span>
              {last?.answer && !streamId && (
                <button
                  className="btn btn-ghost h-7 px-2 text-caption"
                  onClick={() => void copyText(last.answer).then((ok) => toast(ok ? t.toast.copied : t.errors.generic))}
                >
                  <Copy size={12} strokeWidth={1.75} aria-hidden="true" /> {q.copy}
                </button>
              )}
              {!streamId && (
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
            </div>
          </div>
        )}

        <div className="composer relative flex flex-col gap-1 rounded-xl border border-border bg-[var(--bg)] px-4 pt-3 pb-2.5 shadow-card">
          {shot && (
            <div className="flex items-center gap-3 px-1 pb-2">
              <div className="relative flex-none">
                <img
                  src={shot.image}
                  alt={q.shotName}
                  className="h-14 w-24 rounded-md border border-border object-cover"
                />
                <button
                  className="absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full border border-border bg-surface-2 text-fg-muted hover:text-fg"
                  aria-label={q.removeShot}
                  onClick={() => setShot(null)}
                >
                  <X size={11} strokeWidth={2} />
                </button>
              </div>
              <div className="min-w-0 text-caption text-fg-muted">
                <div className="text-fg">{q.shotName}</div>
                <div>
                  {shot.text === null
                    ? q.readingText
                    : shot.text.trim()
                      ? q.textFound(shot.text.trim().length)
                      : q.noText}
                  {!vision && <span className="text-fg-subtle"> · {q.noVision}</span>}
                </div>
              </div>
            </div>
          )}
          <textarea
            ref={inputRef}
            autoFocus
            rows={1}
            value={input}
            placeholder={turns.length ? q.followUp : q.placeholder}
            className="chat-text max-h-40 w-full resize-none bg-transparent px-1 text-fg outline-none placeholder:text-fg-subtle"
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void ask();
              }
            }}
          />
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-1.5">
              <IconButton label={q.capture} className="size-8 rounded-full" onClick={() => void startCapture()}>
                <ScanText size={16} strokeWidth={1.75} />
              </IconButton>
              <Select
                variant="chip"
                side="top"
                label={q.model}
                value={model ?? ""}
                icon={<Cpu size={14} strokeWidth={1.75} aria-hidden="true" />}
                onOpenChange={setMenuOpen}
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
              {!model && <span className="truncate text-caption text-fg-subtle">{q.noModel}</span>}
            </div>
            {streamId ? (
              <button
                className="btn btn-secondary size-10 flex-none rounded-md p-0"
                onClick={stop}
                aria-label={q.stop}
                title={`${q.stop} (Esc)`}
              >
                <Square size={14} strokeWidth={1.75} fill="currentColor" />
              </button>
            ) : (
              <button
                className="btn btn-primary size-10 flex-none p-0"
                onClick={() => void ask()}
                disabled={!canSend}
                aria-label={t.composer.send}
                title={`${t.composer.send} (Enter)`}
              >
                <Bolt size={18} />
              </button>
            )}
          </div>
        </div>
      </div>
      <Toaster position="top-center" toastOptions={{ unstyled: true, classNames: { toast: "zap-toast" } }} />
    </div>
  );
}

/** Frozen screenshot over the whole monitor: drag an area, or click for all. */
function CaptureOverlay({
  capture,
  onDone,
}: {
  capture: Capture;
  onDone: (area: { x: number; y: number; w: number; h: number } | null) => void;
}) {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [end, setEnd] = useState<{ x: number; y: number } | null>(null);
  const q = t.quick;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone(null);
      if (e.key === "Enter") onDone({ x: 0, y: 0, w: capture.width, h: capture.height });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [capture, onDone]);

  const rect =
    start && end
      ? {
          left: Math.min(start.x, end.x),
          top: Math.min(start.y, end.y),
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y),
        }
      : null;

  const finish = () => {
    // Window pixels → screenshot pixels.
    const sx = capture.width / window.innerWidth;
    const sy = capture.height / window.innerHeight;
    if (!rect || rect.width < 8 || rect.height < 8) {
      onDone({ x: 0, y: 0, w: capture.width, h: capture.height });
    } else {
      onDone({
        x: Math.round(rect.left * sx),
        y: Math.round(rect.top * sy),
        w: Math.round(rect.width * sx),
        h: Math.round(rect.height * sy),
      });
    }
  };

  return (
    <div
      className="fixed inset-0 cursor-crosshair select-none"
      onMouseDown={(e) => {
        setStart({ x: e.clientX, y: e.clientY });
        setEnd({ x: e.clientX, y: e.clientY });
      }}
      onMouseMove={(e) => start && setEnd({ x: e.clientX, y: e.clientY })}
      onMouseUp={finish}
    >
      <img
        src={capture.image}
        alt=""
        draggable={false}
        className="pointer-events-none absolute inset-0 h-full w-full"
      />
      {rect ? (
        <div
          className="pointer-events-none absolute border-2 border-[var(--coral)]"
          style={{ ...rect, boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.45)" }}
        />
      ) : (
        <div className="pointer-events-none absolute inset-0 bg-[rgba(0,0,0,0.35)]" />
      )}
      <div className="popover pointer-events-none absolute top-6 left-1/2 -translate-x-1/2 rounded-full px-5 py-2.5 text-ui">
        {q.captureHint}
      </div>
    </div>
  );
}
