import { useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  ChevronDown,
  Coins,
  Cpu,
  ListChecks,
  LoaderCircle,
  Pencil,
  Play,
  Square,
  Timer,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { Field, Segmented, Slider, Switch } from "./ui/Controls";
import { Select } from "./ui/Select";
import { IconButton } from "./ui/IconButton";
import { Markdown } from "./Markdown";
import { ToolCards } from "./ToolCards";
import { BLUEPRINT_ICONS, FALLBACK_ICON } from "../lib/blueprints";
import {
  modelLabel,
  parseStats,
  PROVIDERS,
  type Zap,
  type ZapRun,
  type ZapSchedule,
  type ZapScheduleKind,
  type ZapTools,
} from "../lib/ipc";
import { engineName, locale, t } from "../lib/i18n";
import { formatBytes, formatTokens } from "../lib/format";
import { parseTools } from "../store/chats";
import { useVramInfo, vramShortfall } from "../lib/vram";
import { useModels } from "../store/models";
import { useUi } from "../store/ui";
import {
  MAX_STEPS,
  isScheduled,
  liveRunOf,
  liveTokens,
  scheduleText,
  useZaps,
  zapErrorText,
  type LiveRun,
} from "../store/zaps";

/** ZAP colors: the same mid tones as chat groups. */
const ZAP_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899"];
const TOOL_KEYS: (keyof ZapTools)[] = ["web", "files", "terminal", "apps"];
const SCHEDULE_KINDS: ZapScheduleKind[] = ["off", "startup", "interval", "daily"];
/** Minutes between scheduled runs. */
const INTERVALS = [5, 10, 15, 30, 60, 120, 240, 480, 720, 1440];
const TOKEN_BUDGETS = [5_000, 10_000, 25_000, 50_000, 100_000];
/** Minutes. */
const TIME_LIMITS = [2, 5, 10, 15, 30, 60, 120];

/** Rounded icon tile in the ZAP's color (accent when it has none). */
export function ZapBadge({ zap, size = 32 }: { zap: Pick<Zap, "icon" | "color">; size?: number }) {
  const Icon = BLUEPRINT_ICONS[zap.icon] ?? FALLBACK_ICON;
  const color = zap.color ?? "var(--coral)";
  return (
    <span
      className="flex flex-none items-center justify-center rounded-md"
      style={{
        width: size,
        height: size,
        color,
        background: `color-mix(in srgb, ${color} 18%, transparent)`,
      }}
      aria-hidden="true"
    >
      <Icon size={Math.round(size * 0.5)} strokeWidth={1.75} />
    </span>
  );
}

function toolList(tools: ZapTools): string {
  const names = TOOL_KEYS.filter((k) => tools[k]).map((k) => t.zaps.tools[k]);
  return names.length > 0 ? names.join(" · ") : t.zaps.noTools;
}

/** "today 08:00", "tomorrow 08:00" or a date. */
function formatNext(ms: number): string {
  const when = new Date(ms);
  const time = when.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(when) - day(new Date())) / 86_400_000);
  if (diff <= 0) return time;
  if (diff === 1) return `${new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(1, "day")} ${time}`;
  return when.toLocaleString(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/** "42 s", "3:05 min", "1:02 h". */
function formatMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 3600) return `${Math.floor(s / 60)}:${pad(s % 60)} min`;
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))} h`;
}

function formatDuration(run: ZapRun): string | null {
  return run.ended_at ? formatMs(run.ended_at - run.started_at) : null;
}

/** Current time, updated every second while mounted. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Small icon + value pair for the run numbers. */
function Metric({ icon: Icon, label, children }: { icon: typeof Timer; label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 tabular-nums" title={label}>
      <Icon size={14} strokeWidth={1.75} className="flex-none text-fg-subtle" aria-hidden="true" />
      <span className="sr-only">{label}: </span>
      {children}
    </span>
  );
}

/** Lifetime numbers under the ZAP name. */
function Totals({ zapId }: { zapId: string }) {
  const totals = useZaps((s) => s.totals[zapId]);
  if (!totals || totals.runs === 0) return null;
  const tokens = totals.prompt_tokens + totals.completion_tokens;
  return (
    <p className="mt-0.5 text-caption text-fg-subtle tabular-nums">
      {t.zaps.runCount(totals.runs)} · {t.zaps.totalUsage(formatMs(totals.duration_ms), formatTokens(tokens))} ·{" "}
      {t.zaps.average(formatMs(totals.duration_ms / totals.runs), formatTokens(Math.round(tokens / totals.runs)))}
    </p>
  );
}

export function ZapView() {
  const zap = useZaps((s) => s.zaps.find((z) => z.id === s.openId));
  const live = useZaps((s) => (s.openId ? liveRunOf(s.live, s.openId) : undefined));
  const runs = useZaps((s) => (s.openId ? s.runs[s.openId] : undefined));
  const { start, stop, edit, remove } = useZaps.getState();
  const askConfirm = useUi((s) => s.askConfirm);
  const [input, setInput] = useState("");

  if (!zap) return <main className="flex-1" />;
  const history = (runs ?? []).filter((r) => r.id !== live?.run.id);

  const run = () => {
    void start(zap.id, input.trim() || null);
    setInput("");
  };

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[var(--content-w)] flex-col gap-6 px-6 py-8">
          <header className="flex items-start gap-4">
            <ZapBadge zap={zap} size={44} />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-h2">{zap.name}</h1>
              <p className="text-caption text-fg-muted">
                {t.zaps.toolsLabel}: {toolList(zap.tools)} · {zap.model ? modelLabel(zap.model) : t.zaps.modelDefault}
              </p>
              {scheduleText(zap) && (
                <p className="mt-0.5 flex items-center gap-1.5 text-caption text-fg-muted">
                  <CalendarClock size={13} strokeWidth={1.75} className="flex-none text-coral" aria-hidden="true" />
                  {scheduleText(zap)}
                  {zap.next_run && !live && ` · ${t.zaps.nextRun(formatNext(zap.next_run))}`}
                </p>
              )}
              <Totals zapId={zap.id} />
            </div>
            <IconButton label={t.zaps.edit} onClick={() => edit(zap)}>
              <Pencil size={18} strokeWidth={1.75} />
            </IconButton>
            <IconButton
              label={t.zaps.delete}
              onClick={() =>
                askConfirm({
                  title: t.zaps.deleteTitle,
                  message: t.zaps.deleteBody(zap.name),
                  confirmLabel: t.zaps.delete,
                  onConfirm: () => remove(zap.id),
                })
              }
            >
              <Trash2 size={18} strokeWidth={1.75} />
            </IconButton>
          </header>

          <Instructions text={zap.instructions} />

          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!live) run();
            }}
          >
            <input
              className="input h-10 flex-1"
              aria-label={t.zaps.inputLabel}
              placeholder={t.zaps.inputPlaceholder}
              value={input}
              disabled={Boolean(live)}
              onChange={(e) => setInput(e.target.value)}
            />
            {live ? (
              <button type="button" className="btn btn-secondary h-10" onClick={() => stop(live.run.id)}>
                <Square size={16} strokeWidth={1.75} />
                {t.zaps.stop}
              </button>
            ) : (
              <button type="submit" className="btn btn-primary h-10">
                <Play size={16} strokeWidth={1.75} />
                {t.zaps.start}
              </button>
            )}
          </form>

          {live && <LiveRunView live={live} />}

          <section className="flex flex-col gap-2" aria-label={t.zaps.history}>
            {history.length > 0 && <h2 className="text-caption text-fg-subtle">{t.zaps.history}</h2>}
            {runs && runs.length === 0 && !live && <p className="text-ui text-fg-muted">{t.zaps.noRuns}</p>}
            {history.map((r, i) => (
              <RunItem key={r.id} run={r} defaultOpen={i === 0 && !live} />
            ))}
          </section>
        </div>
      </div>
    </main>
  );
}

function Instructions({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 220 || text.split("\n").length > 3;
  return (
    <div className="rounded-lg border border-border bg-surface-1 px-4 py-3">
      <p className={`selectable text-ui whitespace-pre-wrap text-fg-muted ${!open && long ? "line-clamp-3" : ""}`}>
        {text}
      </p>
      {long && (
        <button
          type="button"
          className="mt-1 flex items-center gap-1 text-caption text-fg-subtle hover:text-fg"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <ChevronDown
            size={14}
            strokeWidth={1.75}
            className={`transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
          {open ? t.zaps.showLess : t.zaps.showMore}
        </button>
      )}
    </div>
  );
}

function LiveRunView({ live }: { live: LiveRun }) {
  const now = useNow();
  const tokens = liveTokens(live);
  const steps = live.activities.filter((a) => a.status !== "pending").length;
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-[var(--coral-ring)] bg-surface-1 p-4"
      aria-label={t.zaps.current}
    >
      <div className="flex items-center gap-2 text-caption text-fg-muted">
        <LoaderCircle
          size={14}
          strokeWidth={1.75}
          className="animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        <span>{t.zaps.current}</span>
        <span className="text-fg-subtle">· {t.zaps.source[live.run.source]}</span>
        {live.run.input && <span className="min-w-0 truncate text-fg-subtle">· {live.run.input}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-fg-muted" aria-live="off">
        <Metric icon={Timer} label={t.zaps.runtime}>
          {formatMs(now - live.run.started_at)}
        </Metric>
        <Metric icon={Coins} label="Tokens">
          {t.zaps.tokens(formatTokens(tokens.input + tokens.output))}
          <span className="text-fg-subtle">
            ({t.zaps.tokensSplit(formatTokens(tokens.input), formatTokens(tokens.output))})
          </span>
        </Metric>
        <Metric icon={ListChecks} label={t.zaps.toolsLabel}>
          {t.zaps.steps(steps)}
        </Metric>
      </div>
      <ToolCards activities={live.activities} scope="run" />
      {live.output.trim() ? (
        <div className="markdown selectable">
          <Markdown content={live.output} />
        </div>
      ) : (
        <p className="text-ui text-fg-subtle">{t.zaps.working}</p>
      )}
    </section>
  );
}

const STATUS_TONE: Record<string, string> = {
  done: "text-[var(--success)]",
  failed: "text-danger",
  stopped: "text-fg-subtle",
  running: "text-coral",
};

function RunItem({ run, defaultOpen }: { run: ZapRun; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const activities = useMemo(() => parseTools(run.activities), [run.activities]);
  const stats = parseStats(run.stats);
  const duration = formatDuration(run);
  const tokensIn = stats?.prompt_eval_count ?? 0;
  const tokensOut = stats?.eval_count ?? 0;
  const tokens = tokensIn + tokensOut;

  return (
    <div className="rounded-lg border border-border bg-surface-1">
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-left hover:bg-surface-2"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={`flex-none text-ui font-medium ${STATUS_TONE[run.status] ?? ""}`}>
          {t.zaps.status[run.status]}
        </span>
        <span className="min-w-0 flex-1 truncate text-caption text-fg-muted">
          {formatWhen(run.started_at)} · {t.zaps.source[run.source]}
        </span>
        <span className="flex flex-none items-center gap-3 text-caption text-fg-muted">
          {duration && (
            <Metric icon={Timer} label={t.zaps.runtime}>
              {duration}
            </Metric>
          )}
          {tokens > 0 && (
            <span title={t.zaps.tokensSplit(formatTokens(tokensIn), formatTokens(tokensOut))}>
              <Metric icon={Coins} label="Tokens">
                {formatTokens(tokens)}
              </Metric>
            </span>
          )}
          {activities.length > 0 && (
            <Metric icon={ListChecks} label={t.zaps.toolsLabel}>
              {activities.length}
            </Metric>
          )}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          className={`flex-none text-fg-muted transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
          <p className="flex flex-wrap gap-x-3 text-caption text-fg-subtle">
            {run.model && <span>{t.zaps.model(modelLabel(run.model))}</span>}
            {tokens > 0 && <span>{t.zaps.tokensSplit(formatTokens(tokensIn), formatTokens(tokensOut))}</span>}
            {activities.length > 0 && <span>{t.zaps.steps(activities.length)}</span>}
          </p>
          {run.input && <p className="text-caption text-fg-subtle">„{run.input}“</p>}
          <ToolCards activities={activities} scope="run" />
          {run.error && <p className="text-ui text-danger">{zapErrorText(run.error)}</p>}
          {run.output.trim() ? (
            <div className="markdown selectable">
              <Markdown content={run.output} />
            </div>
          ) : (
            !run.error && <p className="text-ui text-fg-subtle">{t.zaps.noReport}</p>
          )}
        </div>
      )}
    </div>
  );
}

// --- Editor --------------------------------------------------------------------

export function ZapEditor() {
  const editing = useZaps((s) => s.editing);
  const close = () => useZaps.getState().edit(null);
  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(o) => !o && close()}
      title={editing?.id ? t.zaps.editor.editTitle : t.zaps.editor.newTitle}
      width={620}
    >
      {editing && <EditorForm key={editing.id || "new"} initial={editing} onClose={close} />}
    </Dialog>
  );
}

function EditorForm({ initial, onClose }: { initial: Zap; onClose: () => void }) {
  // Older ZAPs may have no schedule kind yet: show them as "only by hand".
  const [zap, setZap] = useState<Zap>(() =>
    isScheduled(initial) ? initial : { ...initial, schedule: { ...initial.schedule, kind: "off" } },
  );
  const [busy, setBusy] = useState(false);
  const installed = useModels((s) => s.installed);
  const e = t.zaps.editor;
  const patch = (p: Partial<Zap>) => setZap((z) => ({ ...z, ...p }));
  const valid = zap.name.trim() !== "" && zap.instructions.trim() !== "";

  // A ZAP whose model was removed falls back to the selected one.
  const model = zap.model && installed.length > 0 && !installed.some((m) => m.id === zap.model) ? null : zap.model;
  const selected = useModels((s) => s.selected);
  const effectiveModel = model ?? selected;
  const usesTools = TOOL_KEYS.some((k) => zap.tools[k]);
  // Warn before saving a ZAP whose model can't call tools.
  const [toolsOk, setToolsOk] = useState<Record<string, boolean>>({});
  const [nativeTools, setNativeTools] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!effectiveModel || effectiveModel in toolsOk) return;
    let alive = true;
    void useModels
      .getState()
      .ensureCaps(effectiveModel)
      .then((caps) => {
        if (!alive) return;
        setToolsOk((m) => ({ ...m, [effectiveModel]: caps.tools }));
        setNativeTools((m) => ({ ...m, [effectiveModel]: caps.native_tools }));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [effectiveModel, toolsOk]);
  const noTools = usesTools && effectiveModel !== null && toolsOk[effectiveModel] === false;
  const weakTools = usesTools && effectiveModel !== null && nativeTools[effectiveModel] === false;
  const vram = useVramInfo();
  const modelInfo = installed.find((m) => m.id === effectiveModel);
  const short = modelInfo ? vramShortfall(modelInfo, vram) : null;
  const schedule = zap.schedule;
  // Functional updates: quick clicks must build on each other.
  const setSchedule = (p: Partial<ZapSchedule>) => setZap((z) => ({ ...z, schedule: { ...z.schedule, ...p } }));
  const toggleDay = (day: number) =>
    setZap((z) => {
      const days = z.schedule.days.includes(day)
        ? z.schedule.days.filter((d) => d !== day)
        : [...z.schedule.days, day].sort((a, b) => a - b);
      return { ...z, schedule: { ...z.schedule, days } };
    });

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const saved = await useZaps.getState().save({ ...zap, model });
    setBusy(false);
    if (saved) {
      onClose();
      useZaps.getState().open(saved.id);
    }
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(ev) => {
        ev.preventDefault();
        void submit();
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pt-1 pb-4">
        <Field label={e.name} htmlFor="zap-name">
          <input
            id="zap-name"
            className="input"
            value={zap.name}
            maxLength={60}
            placeholder={e.namePlaceholder}
            onChange={(ev) => patch({ name: ev.target.value })}
            autoFocus={!zap.id}
          />
        </Field>

        <Field label={e.instructions} htmlFor="zap-instructions">
          <textarea
            id="zap-instructions"
            className="input h-auto min-h-[140px] resize-y py-3 leading-[22px]"
            value={zap.instructions}
            placeholder={e.instructionsPlaceholder}
            onChange={(ev) => patch({ instructions: ev.target.value })}
          />
        </Field>

        <div className="flex flex-col gap-2">
          <span className="text-ui">{e.tools}</span>
          <div className="flex flex-col divide-y divide-[var(--border)] rounded-lg border border-border">
            {TOOL_KEYS.map((key) => (
              <div key={key} className="flex items-center justify-between gap-4 px-4 py-2.5">
                <div>
                  <label htmlFor={`zap-tool-${key}`} className="text-ui">
                    {t.zaps.tools[key]}
                  </label>
                  <p className="text-caption text-fg-muted">{t.zaps.tools[`${key}Hint`]}</p>
                </div>
                <Switch
                  id={`zap-tool-${key}`}
                  label={t.zaps.tools[key]}
                  checked={zap.tools[key]}
                  onChange={(on) => patch({ tools: { ...zap.tools, [key]: on } })}
                />
              </div>
            ))}
          </div>
          <p className="text-caption text-fg-muted">{e.toolsHint}</p>
        </div>

        <Field label={e.model} htmlFor="zap-model">
          <Select
            id="zap-model"
            value={model ?? ""}
            onChange={(v) => patch({ model: v || null })}
            icon={<Cpu size={16} strokeWidth={1.75} className="flex-none text-fg-muted" aria-hidden="true" />}
            options={[
              { options: [{ value: "", label: e.modelDefault }] },
              ...PROVIDERS.map((kind) => ({
                label: engineName(kind),
                options: installed
                  .filter((m) => m.provider === kind)
                  .map((m) => ({
                    value: m.id,
                    label: m.name,
                    hint: m.size_bytes > 0 ? formatBytes(m.size_bytes) : undefined,
                  })),
              })).filter((g) => g.options.length > 0),
            ]}
          />
        </Field>

        {noTools && (
          <p className="-mt-3 flex items-start gap-2 text-caption text-danger">
            <TriangleAlert size={14} strokeWidth={1.75} className="mt-0.5 flex-none" aria-hidden="true" />
            {e.noToolsModel}
          </p>
        )}
        {weakTools && !noTools && (
          <p className="-mt-3 flex items-start gap-2 text-caption text-[var(--warning)]">
            <TriangleAlert size={14} strokeWidth={1.75} className="mt-0.5 flex-none" aria-hidden="true" />
            {e.weakToolsModel}
          </p>
        )}
        {short && (
          <p className="-mt-3 flex items-start gap-2 text-caption text-[var(--warning)]">
            <TriangleAlert size={14} strokeWidth={1.75} className="mt-0.5 flex-none" aria-hidden="true" />
            {t.models.vramShort(formatBytes(short.needed), formatBytes(short.free))}
          </p>
        )}

        <div className="flex flex-col gap-3">
          <span className="text-ui">{e.schedule}</span>
          <Segmented
            label={e.schedule}
            value={schedule.kind}
            onChange={(kind) => setSchedule({ kind })}
            options={SCHEDULE_KINDS.map((k) => ({ value: k, label: e.scheduleKinds[k] ?? k }))}
          />
          {schedule.kind === "interval" && (
            <Field label={e.every} htmlFor="zap-every">
              <Select
                id="zap-every"
                value={String(schedule.every_min)}
                onChange={(v) => setSchedule({ every_min: Number(v) })}
                options={INTERVALS.map((m) => ({ value: String(m), label: t.zaps.duration(m) }))}
              />
            </Field>
          )}
          {schedule.kind === "daily" && (
            <div className="flex flex-wrap items-end gap-4">
              <Field label={e.time} htmlFor="zap-time">
                <input
                  id="zap-time"
                  type="time"
                  className="input w-32"
                  value={schedule.time}
                  onChange={(ev) => ev.target.value && setSchedule({ time: ev.target.value })}
                />
              </Field>
              <div className="flex flex-col gap-2">
                <span className="text-ui">{e.days}</span>
                <div className="flex gap-1" role="group" aria-label={e.days}>
                  {t.zaps.dayNames.map((name, day) => {
                    const on = schedule.days.includes(day);
                    return (
                      <button
                        key={name}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleDay(day)}
                        className={`h-11 w-10 rounded-md border text-caption transition-colors ${
                          on
                            ? "border-[var(--coral-ring)] bg-surface-2 text-fg"
                            : "border-border text-fg-muted hover:bg-surface-2 hover:text-fg"
                        }`}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          {schedule.kind === "daily" && <p className="-mt-1 text-caption text-fg-muted">{e.daysHint}</p>}
          {schedule.kind !== "off" && <p className="text-caption text-fg-muted">{e.scheduleHint}</p>}
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3">
          <div>
            <label htmlFor="zap-thinking" className="text-ui">
              {e.thinking}
            </label>
            <p className="text-caption text-fg-muted">{e.thinkingHint}</p>
          </div>
          <Switch
            id="zap-thinking"
            label={e.thinking}
            checked={zap.thinking}
            onChange={(thinking) => patch({ thinking })}
          />
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-ui">{e.limits}</span>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={e.tokenLimit} htmlFor="zap-tokens">
              <Select
                id="zap-tokens"
                value={String(zap.token_budget ?? "")}
                onChange={(v) => patch({ token_budget: v ? Number(v) : null })}
                options={[
                  { value: "", label: e.noLimit },
                  ...TOKEN_BUDGETS.map((n) => ({ value: String(n), label: e.tokens(formatTokens(n)) })),
                ]}
              />
            </Field>
            <Field label={e.timeLimit} htmlFor="zap-time-limit">
              <Select
                id="zap-time-limit"
                value={String(zap.time_limit ?? "")}
                onChange={(v) => patch({ time_limit: v ? Number(v) : null })}
                options={[
                  { value: "", label: e.noLimit },
                  ...TIME_LIMITS.map((m) => ({ value: String(m), label: t.zaps.duration(m) })),
                ]}
              />
            </Field>
          </div>
        </div>

        <Field label={`${e.maxSteps}: ${zap.max_steps}`} hint={e.maxStepsHint}>
          <Slider
            label={e.maxSteps}
            value={zap.max_steps}
            min={2}
            max={MAX_STEPS}
            step={1}
            valueText={String(zap.max_steps)}
            onChange={(max_steps) => patch({ max_steps })}
          />
        </Field>

        <div className="flex flex-col gap-2">
          <span className="text-ui">{e.icon}</span>
          <div role="radiogroup" aria-label={e.icon} className="flex flex-wrap gap-1">
            {Object.entries(BLUEPRINT_ICONS).map(([name, Icon]) => {
              const checked = zap.icon === name;
              return (
                <button
                  key={name}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={name}
                  onClick={() => patch({ icon: name })}
                  className={`flex size-9 items-center justify-center rounded-md border transition-colors ${
                    checked
                      ? "border-[var(--coral-ring)] bg-surface-2 text-fg"
                      : "border-transparent text-fg-muted hover:bg-surface-2 hover:text-fg"
                  }`}
                >
                  <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-ui">{e.color}</span>
          <div role="radiogroup" aria-label={e.color} className="flex flex-wrap items-center gap-2">
            {[null, ...ZAP_COLORS].map((c) => {
              const checked = zap.color === c;
              return (
                <button
                  key={c ?? "none"}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={c ? (t.sidebar.folders.colors[c] ?? c) : e.noColor}
                  title={c ? (t.sidebar.folders.colors[c] ?? c) : e.noColor}
                  onClick={() => patch({ color: c })}
                  className={`size-7 rounded-full border-2 transition-transform hover:scale-110 ${
                    checked ? "border-fg" : "border-transparent"
                  }`}
                  style={{ background: c ?? "var(--coral)" }}
                />
              );
            })}
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-3 border-t border-border px-6 pt-4 pb-6">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {e.cancel}
        </button>
        <button type="submit" className="btn btn-primary" disabled={!valid || busy}>
          {zap.id ? e.save : e.create}
        </button>
      </div>
    </form>
  );
}
