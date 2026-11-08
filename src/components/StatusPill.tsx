import { enabledProviders, useProviders } from "../store/providers";
import { openEngineDownload } from "../lib/actions";
import { engineName, t } from "../lib/i18n";
import type { ProviderKind, ProviderStatus } from "../lib/ipc";

const DOT: Record<ProviderStatus, string> = {
  running: "var(--success)",
  starting: "var(--warning)",
  not_found: "var(--danger)",
  stopped: "var(--danger)",
  disabled: "var(--fg-subtle)",
};

const linkClass =
  "ml-auto flex-none rounded-sm px-1 text-ui underline decoration-[var(--link-underline)] underline-offset-[3px] hover:decoration-[var(--link)]";

/** Status of one engine (design.md §6.7). Color is always paired with text. */
export function StatusPill({ kind }: { kind: ProviderKind }) {
  const status = useProviders((s) => s.statuses[kind]);
  const start = useProviders((s) => s.start);
  const name = engineName(kind);

  return (
    <div
      className="flex h-9 min-w-0 items-center gap-2 rounded-full border border-border bg-surface-1 px-3.5 text-ui"
      role="status"
      aria-live="polite"
    >
      <span
        className={`status-dot ${status === "starting" ? "pulse" : ""}`}
        style={{ background: DOT[status] }}
        aria-hidden="true"
      />
      <span className="truncate">{t.engines.pill[status](name)}</span>
      {status === "not_found" && (
        <button className={linkClass} onClick={() => openEngineDownload(kind)}>
          {t.engines.install}
        </button>
      )}
      {status === "stopped" && (
        <button className={linkClass} onClick={() => void start(kind)}>
          {t.engines.start}
        </button>
      )}
    </div>
  );
}

/** One pill per enabled engine (sidebar footer). */
export function EngineStatus() {
  const statuses = useProviders((s) => s.statuses);
  const enabled = enabledProviders(statuses);
  if (enabled.length === 0) {
    return (
      <div className="flex h-9 items-center gap-2 rounded-full border border-border bg-surface-1 px-3.5 text-ui">
        <span className="status-dot" style={{ background: DOT.disabled }} aria-hidden="true" />
        <span className="truncate">{t.engines.noneTitle}</span>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {enabled.map((kind) => (
        <StatusPill key={kind} kind={kind} />
      ))}
    </div>
  );
}
