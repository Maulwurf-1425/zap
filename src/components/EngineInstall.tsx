import { useEffect, useState } from "react";
import { Check, Circle, Download, ExternalLink, LoaderCircle } from "lucide-react";
import { useProviders, type EngineInstall as InstallState } from "../store/providers";
import { openEngineDownload } from "../lib/actions";
import { formatBytes, formatSpeed } from "../lib/format";
import { engineName, t } from "../lib/i18n";
import type { InstallPhase, ProviderKind } from "../lib/ipc";

const STEPS: InstallPhase[] = ["preparing", "downloading", "installing", "starting"];

/** "2:05" */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Re-renders every second while `active`, for the timers. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** Install options for a missing engine: automatic (winget) or the vendor's
 *  website. While installing, shows each step with live details.
 *  `centered` for the full-view notice, otherwise left-aligned (settings). */
export function EngineInstall({ kind, centered = false }: { kind: ProviderKind; centered?: boolean }) {
  const canInstall = useProviders((s) => s.canInstall);
  const progress = useProviders((s) => s.installs[kind]);
  const install = useProviders((s) => s.install);
  const name = engineName(kind);
  const e = t.engines;
  const busy = progress !== undefined && progress.phase !== "done" && progress.phase !== "failed";
  const align = centered ? "items-center text-center" : "items-start";

  if (busy) return <InstallProgress kind={kind} state={progress} />;

  return (
    <div className={`flex w-full flex-col gap-2 ${align}`}>
      {progress?.phase === "failed" && (
        <p className="text-caption text-danger" role="alert">
          {e.installFailed(name)}
        </p>
      )}
      <div className={`flex flex-wrap gap-2 ${centered ? "justify-center" : ""}`}>
        {canInstall && (
          <button className="btn btn-primary" onClick={() => void install(kind)}>
            <Download size={18} strokeWidth={1.75} aria-hidden="true" />
            {e.installAuto}
          </button>
        )}
        <button
          className={`btn ${canInstall ? "btn-secondary" : "btn-primary"}`}
          onClick={() => openEngineDownload(kind)}
        >
          <ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />
          {e.installWebsite}
        </button>
      </div>
      {canInstall && <p className="text-caption text-fg-subtle">{e.installHint}</p>}
    </div>
  );
}

function InstallProgress({ kind, state }: { kind: ProviderKind; state: InstallState }) {
  const now = useNow(true);
  const name = engineName(kind);
  const s = t.engines.steps;
  const current = STEPS.indexOf(state.phase);

  const { downloaded, total, speed } = state;
  const pct = downloaded !== null && total ? Math.min(1, downloaded / total) : null;
  const remaining =
    downloaded !== null && total && speed && speed > 0 ? Math.max(0, (total - downloaded) / speed) : null;

  /** Live detail line under the active step. */
  const detail = (phase: InstallPhase): string | null => {
    const since = clock(now - state.phaseAt);
    switch (phase) {
      case "preparing":
        return s.preparingDetail;
      case "downloading": {
        if (downloaded === null) return s.downloadingDetail(since);
        const parts = [total ? s.sizeOf(formatBytes(downloaded), formatBytes(total)) : formatBytes(downloaded)];
        if (speed) parts.push(formatSpeed(speed));
        if (remaining !== null) parts.push(s.left(Math.max(1, Math.round(remaining / 60))));
        return parts.join(" · ");
      }
      case "installing":
        return s.installingDetail(since);
      case "starting":
        return kind === "lmstudio" ? s.startingLmstudio(since) : s.startingDetail(name, since);
      default:
        return null;
    }
  };

  return (
    <div
      className="w-full max-w-md rounded-lg border border-border bg-surface-1 p-4 text-left"
      role="status"
      aria-live="polite"
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <span className="text-ui">{t.engines.installCta(name)}</span>
        <span className="text-caption text-fg-subtle tabular-nums">{s.elapsed(clock(now - state.startedAt))}</span>
      </div>
      <ol className="flex flex-col gap-3">
        {STEPS.map((phase, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li key={phase} className="flex gap-3">
              <span className="mt-0.5 flex size-5 flex-none items-center justify-center">
                {done ? (
                  <Check size={16} strokeWidth={2.25} className="text-[var(--success)]" aria-hidden="true" />
                ) : active ? (
                  <LoaderCircle
                    size={16}
                    strokeWidth={2}
                    className="animate-spin text-coral motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <Circle size={12} strokeWidth={2} className="text-fg-subtle" aria-hidden="true" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <span className={`text-ui ${active ? "text-fg" : done ? "text-fg-muted" : "text-fg-subtle"}`}>
                  {s.labels[phase]}
                </span>
                {active && (
                  <p className="text-caption text-fg-muted tabular-nums" aria-live="off">
                    {detail(phase)}
                  </p>
                )}
                {active && phase === "downloading" && (
                  <div
                    className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3"
                    role="progressbar"
                    aria-label={s.labels.downloading}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct === null ? undefined : Math.round(pct * 100)}
                  >
                    <div
                      className={`h-full rounded-full bg-coral transition-[width] duration-500 ${pct === null ? "w-1/3 animate-pulse" : ""}`}
                      style={pct === null ? undefined : { width: `${pct * 100}%` }}
                    />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-4 text-caption text-fg-subtle">{t.engines.installWait}</p>
    </div>
  );
}
