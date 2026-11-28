import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Cloud, Coins, Copy, Gauge, LoaderCircle, Play, Plus, Square, Timer, Trophy, X } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "./ui/Controls";
import { Markdown } from "./Markdown";
import { errorMessage, t } from "../lib/i18n";
import { modelLabel, modelProvider } from "../lib/ipc";
import { groupModels } from "../lib/modelGroups";
import { copyText, formatTokens } from "../lib/format";
import { useModels } from "../store/models";
import { MAX_COMPARE, useCompare, type CompareColumn } from "../store/compare";
import { isSendKey } from "../lib/shortcuts";
import { useSendKey } from "../lib/useShortcut";

function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

/** Same question to several models, answers side by side with their numbers. */
export function CompareView() {
  const sendKey = useSendKey();
  const installed = useModels((s) => s.installed);
  const selected = useModels((s) => s.selected);
  const { models, prompt, parallel, columns, running } = useCompare();
  const { toggleModel, setPrompt, setParallel, run, stop, setModels } = useCompare.getState();
  const c = t.compare;

  // Start with the current model so one more click is enough.
  useEffect(() => {
    if (useCompare.getState().models.length === 0 && selected) setModels([selected]);
  }, [selected, setModels]);

  const groups = groupModels(installed);
  const canRun = models.length >= 2 && prompt.trim() !== "" && !running;
  // Fastest finished answer (tokens per second).
  const done = columns.filter((col) => col.status === "done" && col.stats);
  const fastest =
    done.length > 1
      ? done.reduce((a, b) => ((b.stats?.tokens_per_sec ?? 0) > (a.stats?.tokens_per_sec ?? 0) ? b : a)).streamId
      : null;

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 px-6 py-8">
          <header>
            <h1 className="text-h2">{c.title}</h1>
            <p className="text-caption text-fg-muted">{c.intro}</p>
          </header>

          <div className="flex flex-wrap items-center gap-2">
            {models.map((m) => (
              <span
                key={m}
                className="flex h-8 items-center gap-1.5 rounded-full border border-border bg-surface-1 pr-1 pl-3 text-caption"
              >
                {modelProvider(m) === "cloud" && <Cloud size={12} strokeWidth={1.75} aria-hidden="true" />}
                {modelLabel(m)}
                <button
                  className="flex size-6 items-center justify-center rounded-full text-fg-muted hover:bg-surface-2 hover:text-fg"
                  aria-label={c.remove(modelLabel(m))}
                  disabled={running}
                  onClick={() => toggleModel(m)}
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </span>
            ))}
            {models.length < MAX_COMPARE && (
              <DropdownMenu.Root modal={false}>
                <DropdownMenu.Trigger asChild>
                  <button
                    className="btn btn-ghost h-8 rounded-full border border-dashed border-border px-3 text-caption"
                    disabled={running}
                  >
                    <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
                    {c.addModel}
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="start"
                    sideOffset={6}
                    className="popover anim-pop z-[60] max-h-80 w-72 overflow-y-auto rounded-lg p-1.5"
                  >
                    {groups.map((g) => (
                      <DropdownMenu.Group key={g.key}>
                        <DropdownMenu.Label className="flex items-center gap-1.5 px-3 pt-1.5 pb-1 text-caption text-fg-subtle">
                          {g.cloud && <Cloud size={12} strokeWidth={1.75} aria-hidden="true" />}
                          {g.label}
                        </DropdownMenu.Label>
                        {g.models.map((m) => (
                          <DropdownMenu.CheckboxItem
                            key={m.id}
                            checked={models.includes(m.id)}
                            onCheckedChange={() => toggleModel(m.id)}
                            onSelect={(e) => e.preventDefault()}
                            className="menu-item h-9"
                          >
                            <span className="flex w-4 flex-none justify-center">
                              <DropdownMenu.ItemIndicator>
                                <Check size={14} strokeWidth={2} className="text-coral" />
                              </DropdownMenu.ItemIndicator>
                            </span>
                            <span className="min-w-0 flex-1 truncate">{m.name}</span>
                          </DropdownMenu.CheckboxItem>
                        ))}
                      </DropdownMenu.Group>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
            <label className="ml-auto flex items-center gap-2 text-caption text-fg-muted">
              <Switch label={c.parallel} checked={parallel} onChange={setParallel} />
              <span title={c.parallelHint}>{c.parallel}</span>
            </label>
          </div>

          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (canRun) void run();
            }}
          >
            <textarea
              className="input h-auto min-h-[72px] flex-1 resize-y py-3 leading-[22px]"
              aria-label={c.prompt}
              placeholder={c.promptPlaceholder}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (isSendKey({ ...e, isComposing: e.nativeEvent.isComposing }, sendKey)) {
                  e.preventDefault();
                  if (canRun) void run();
                }
              }}
            />
            {running ? (
              <button type="button" className="btn btn-secondary h-11" onClick={stop}>
                <Square size={16} strokeWidth={1.75} />
                {c.stop}
              </button>
            ) : (
              <button type="submit" className="btn btn-primary h-11" disabled={!canRun}>
                <Play size={16} strokeWidth={1.75} />
                {c.run}
              </button>
            )}
          </form>
          {models.length < 2 && <p className="-mt-3 text-caption text-fg-subtle">{c.pickTwo}</p>}

          {columns.length > 0 && (
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 280px), 1fr))` }}
            >
              {columns.map((col) => (
                <Column key={col.streamId} col={col} fastest={col.streamId === fastest} />
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function Column({ col, fastest }: { col: CompareColumn; fastest: boolean }) {
  const c = t.compare;
  const [now, setNow] = useState(() => Date.now());
  const live = col.status === "running";
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [live]);

  const end = col.endedAt ?? now;
  const total = col.startedAt ? end - col.startedAt : null;
  const firstToken = col.startedAt && col.firstTokenAt ? col.firstTokenAt - col.startedAt : null;
  const tokensIn = col.stats?.prompt_eval_count ?? 0;
  const tokensOut = col.stats?.eval_count ?? 0;
  const speed = col.stats?.tokens_per_sec ?? 0;

  return (
    <section
      className={`flex min-h-48 flex-col gap-3 rounded-lg border bg-surface-1 p-4 ${
        fastest ? "border-[var(--coral-ring)]" : "border-border"
      }`}
      aria-label={modelLabel(col.model)}
    >
      <header className="flex items-center gap-2">
        {modelProvider(col.model) === "cloud" && <Cloud size={14} strokeWidth={1.75} className="text-fg-muted" />}
        <h2 className="min-w-0 flex-1 truncate text-ui font-medium">{modelLabel(col.model)}</h2>
        {fastest && (
          <span className="flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-caption text-coral">
            <Trophy size={12} strokeWidth={1.75} aria-hidden="true" />
            {c.fastest}
          </span>
        )}
        {col.text && (
          <button
            className="btn btn-icon size-7"
            aria-label={c.copy}
            title={c.copy}
            onClick={() => void copyText(col.text).then((ok) => toast(ok ? t.toast.copied : t.errors.generic))}
          >
            <Copy size={14} strokeWidth={1.75} />
          </button>
        )}
      </header>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-caption text-fg-muted tabular-nums">
        <span className="flex items-center gap-1" title={c.totalTime}>
          <Timer size={13} strokeWidth={1.75} className="text-fg-subtle" aria-hidden="true" />
          {total !== null ? seconds(total) : "–"}
          {firstToken !== null && <span className="text-fg-subtle">({c.firstWord(seconds(firstToken))})</span>}
        </span>
        <span className="flex items-center gap-1" title={c.speed}>
          <Gauge size={13} strokeWidth={1.75} className="text-fg-subtle" aria-hidden="true" />
          {speed > 0 ? c.perSec(speed.toFixed(1)) : "–"}
        </span>
        <span className="flex items-center gap-1" title={c.tokens}>
          <Coins size={13} strokeWidth={1.75} className="text-fg-subtle" aria-hidden="true" />
          {col.stats ? c.inOut(formatTokens(tokensIn), formatTokens(tokensOut)) : "–"}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        {col.status === "waiting" && <p className="text-ui text-fg-subtle">{c.waiting}</p>}
        {col.status === "running" && !col.text && (
          <p className="flex items-center gap-2 text-ui text-fg-subtle">
            <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {c.thinking}
          </p>
        )}
        {col.text && (
          <div className={`markdown selectable ${live ? "streaming" : ""}`}>
            <Markdown content={col.text} />
          </div>
        )}
        {col.status === "error" && col.error && <p className="text-ui text-danger">{errorMessage(col.error)}</p>}
        {col.status === "stopped" && !col.text && <p className="text-ui text-fg-subtle">{c.stopped}</p>}
      </div>
    </section>
  );
}
