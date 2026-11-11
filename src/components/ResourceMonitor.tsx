import { useEffect, useState } from "react";
import { Activity, LoaderCircle, X } from "lucide-react";
import { toast } from "sonner";
import { api, modelLabel, type GroupUsage, type LoadedModel, type SystemUsage } from "../lib/ipc";
import { formatBytes, formatTokens } from "../lib/format";
import { engineName, t } from "../lib/i18n";
import { useUi } from "../store/ui";

const POLL_MS = 1000;
/** Samples kept for the sparklines (one per second). */
const HISTORY = 60;

function pct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} %`;
}

function bytes(n: number | null | undefined): string {
  return n === null || n === undefined ? "–" : formatBytes(n);
}

/** Tiny line chart of the last minute. */
function Sparkline({ values, max }: { values: number[]; max?: number }) {
  const w = 120;
  const h = 28;
  const top = Math.max(max ?? 0, ...values, 1);
  const step = w / (HISTORY - 1);
  const offset = HISTORY - values.length;
  const points = values.map(
    (v, i) => `${((offset + i) * step).toFixed(1)},${(h - (v / top) * (h - 2) - 1).toFixed(1)}`,
  );
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="flex-none" aria-hidden="true">
      {points.length > 1 && (
        <polyline
          points={points.join(" ")}
          fill="none"
          stroke="var(--coral)"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

/** Sum of all groups: everything ZAP is responsible for. */
function total(groups: GroupUsage[]): GroupUsage {
  const gpuKnown = groups.some((g) => g.gpu !== null);
  return {
    group: "zap",
    cpu: groups.reduce((s, g) => s + g.cpu, 0),
    memory: groups.reduce((s, g) => s + g.memory, 0),
    // GPU load of parallel engines doesn't add up past 100 %.
    gpu: gpuKnown
      ? Math.min(
          100,
          groups.reduce((s, g) => s + (g.gpu ?? 0), 0),
        )
      : null,
    vram: gpuKnown ? groups.reduce((s, g) => s + (g.vram ?? 0), 0) : null,
    processes: groups.reduce((s, g) => s + g.processes, 0),
  };
}

function Row({ label, usage, title, strong }: { label: string; usage: GroupUsage; title?: string; strong?: boolean }) {
  return (
    <tr className={strong ? "border-t border-border font-medium text-fg" : "text-fg-muted"}>
      <th
        scope="row"
        className={`truncate py-1.5 pr-3 text-left ${strong ? "font-medium" : "font-normal"}`}
        title={title}
      >
        {label}
      </th>
      <td className="py-1.5 pl-2 text-right tabular-nums">{pct(usage.cpu)}</td>
      <td className="py-1.5 pl-2 text-right tabular-nums">{bytes(usage.memory)}</td>
      <td className="py-1.5 pl-2 text-right tabular-nums">{pct(usage.gpu)}</td>
      <td className="py-1.5 pl-2 text-right tabular-nums">{bytes(usage.vram)}</td>
    </tr>
  );
}

/** Floating panel (F5 anywhere): CPU, RAM, GPU and tokens of ZAP and the
 *  engines it uses. Not modal, so work can go on while it's open. */
export function ResourceMonitor() {
  const open = useUi((s) => s.monitorOpen);
  return open ? <Panel /> : null;
}

function Panel() {
  const toggle = useUi((s) => s.toggleMonitor);
  const [usage, setUsage] = useState<SystemUsage | null>(null);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [tokenHistory, setTokenHistory] = useState<number[]>([]);
  const m = t.monitor;

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const next = await api.systemUsage();
        if (!alive) return;
        setUsage(next);
        const all = total(next.groups);
        setCpuHistory((h) => [...h, all.cpu].slice(-HISTORY));
        setTokenHistory((h) => [...h, next.tokens.per_sec].slice(-HISTORY));
      } catch {
        // Keep the last numbers; the next poll tries again.
      }
      if (alive) timer = window.setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  const groups = usage?.groups ?? [];
  const all = total(groups);
  const engines = groups.some((g) => g.group === "ollama" || g.group === "lmstudio");
  const sys = usage?.system;
  const tk = usage?.tokens;

  return (
    <section
      className="popover anim-pop pointer-events-auto fixed top-[calc(var(--titlebar-h)+8px)] right-3 z-[70] flex w-[460px] max-w-[calc(100vw-24px)] flex-col gap-4 rounded-xl p-4 text-caption"
      data-state="open"
      aria-label={m.title}
    >
      <header className="flex items-center gap-2">
        <Activity size={16} strokeWidth={1.75} className="text-coral" aria-hidden="true" />
        <h2 className="flex-1 text-ui font-medium">{m.title}</h2>
        <kbd className="kbd">F5</kbd>
        <button className="btn btn-icon size-7" aria-label={m.close} title={m.close} onClick={toggle}>
          <X size={16} strokeWidth={1.75} />
        </button>
      </header>

      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col />
          <col className="w-[62px]" />
          <col className="w-[76px]" />
          <col className="w-[56px]" />
          <col className="w-[76px]" />
        </colgroup>
        <thead>
          <tr className="text-fg-subtle">
            <th scope="col" className="pb-1 text-left font-normal">
              {m.part}
            </th>
            <th scope="col" className="pb-1 text-right font-normal">
              {m.cpu}
            </th>
            <th scope="col" className="pb-1 text-right font-normal">
              {m.ram}
            </th>
            <th scope="col" className="pb-1 text-right font-normal">
              {m.gpu}
            </th>
            <th scope="col" className="pb-1 text-right font-normal">
              {m.vram}
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Row key={g.group} label={m.groups[g.group] ?? g.group} usage={g} title={m.processes(g.processes)} />
          ))}
          {usage && <Row label={m.total} usage={all} title={m.processes(all.processes)} strong />}
        </tbody>
      </table>
      {usage && !engines && <p className="-mt-2 text-fg-subtle">{m.notRunning}</p>}

      <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-1 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-fg-subtle">{m.system}</div>
          <div className="text-fg-muted tabular-nums">
            {m.cpu} {pct(sys?.cpu)} · {m.ram} {sys ? m.ofTotal(bytes(sys.memory_used), bytes(sys.memory_total)) : "–"}
            {sys?.gpu !== null && sys?.gpu !== undefined && ` · ${m.gpu} ${pct(sys.gpu)}`}
            {sys?.vram_used !== null && sys?.vram_used !== undefined && ` · ${m.vram} ${bytes(sys.vram_used)}`}
          </div>
        </div>
        <Sparkline values={cpuHistory} max={100} />
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-1 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-fg-subtle">{m.tokens}</div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-h2 tabular-nums">{tk ? Math.round(tk.per_sec) : "–"}</span>
            <span className="text-fg-muted">{m.perSec}</span>
          </div>
          <div className="truncate text-fg-muted">{tk ? m.active(tk.active, tk.zap_runs) : "…"}</div>
          {tk && (
            <div className="truncate text-fg-subtle tabular-nums">
              {m.session(formatTokens(tk.session_prompt), formatTokens(tk.session_output))}
            </div>
          )}
        </div>
        <Sparkline values={tokenHistory} />
      </div>

      <LoadedModels />

      <p className="text-fg-subtle">
        {sys && sys.gpu === null ? `${m.noGpu} ` : ""}
        {m.hint}
      </p>
    </section>
  );
}

/** Models the engines hold in memory, each with an unload button. */
function LoadedModels() {
  const [models, setModels] = useState<LoadedModel[] | null>(null);
  // Key being unloaded ("*" = all).
  const [busy, setBusy] = useState<string | null>(null);
  const m = t.monitor;

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const poll = async () => {
      const list = await api.loadedModels().catch(() => null);
      if (!alive) return;
      if (list) setModels(list);
      timer = window.setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  const unload = async (key: string | null) => {
    setBusy(key ?? "*");
    const ok = await api.unloadModels(key).catch(() => false);
    toast(ok ? m.unloaded : m.unloadFailed);
    setModels(await api.loadedModels().catch(() => models));
    setBusy(null);
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-1 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-fg-subtle">{m.loaded}</span>
        {models && models.length > 1 && (
          <button
            className="btn btn-ghost h-7 px-2 text-caption"
            disabled={busy !== null}
            onClick={() => void unload(null)}
          >
            {busy === "*" && <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />}
            {m.unloadAll}
          </button>
        )}
      </div>
      {models === null ? (
        <span className="text-fg-muted">…</span>
      ) : models.length === 0 ? (
        <span className="text-fg-muted">{m.noneLoaded}</span>
      ) : (
        <ul className="flex flex-col gap-1">
          {models.map((model) => (
            <li key={model.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-fg" title={model.id}>
                {modelLabel(model.id)}
              </span>
              <span className="flex-none text-fg-subtle tabular-nums">
                {engineName(model.provider)}
                {model.vram ? ` · ${formatBytes(model.vram)} ${m.vram}` : ""}
              </span>
              <button
                className="btn btn-secondary h-7 flex-none px-2.5 text-caption"
                disabled={busy !== null}
                onClick={() => void unload(model.id)}
              >
                {busy === model.id && <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />}
                {m.unload}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
