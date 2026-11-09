import type { ReactNode } from "react";
import { Download, TriangleAlert } from "lucide-react";
import { DotField } from "./EmptyState";
import { EngineInstall } from "./EngineInstall";
import { primaryProvider, useProviders } from "../store/providers";
import { useUi } from "../store/ui";
import { engineName, errorMessage, t } from "../lib/i18n";
import type { ErrorCode } from "../lib/ipc";

function Hero({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6 pb-8">
      <DotField />
      <div className="relative w-full max-w-[560px] text-center motion-safe:animate-[fade-in_260ms_var(--ease-enter)]">
        <h1 className="text-h1">{title}</h1>
        <p className="mt-3 text-body text-fg-muted">{body}</p>
        {children && <div className="mt-8 flex justify-center gap-3">{children}</div>}
      </div>
    </div>
  );
}

/** Full-view state while no engine is running. */
export function EngineNotice() {
  const statuses = useProviders((s) => s.statuses);
  const start = useProviders((s) => s.start);
  const openSettings = useUi((s) => s.openSettings);
  const primary = primaryProvider(statuses);

  if (!primary) {
    return (
      <Hero title={t.engines.noneTitle} body={t.engines.noneBody}>
        <button className="btn btn-primary" onClick={() => openSettings("models")}>
          {t.engines.chooseCta}
        </button>
      </Hero>
    );
  }

  const { kind, status } = primary;
  const name = engineName(kind);

  if (status === "starting") {
    return (
      <Hero title={t.engines.startingTitle} body={t.engines.starting(name)}>
        <span className="flex items-center gap-1" aria-hidden="true">
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
        </span>
      </Hero>
    );
  }
  if (status === "not_found") {
    return (
      <Hero title={t.engines.missingTitle(name)} body={t.engines.missing(name)}>
        <div className="flex flex-col items-center gap-4">
          <EngineInstall kind={kind} centered />
          <button className="btn btn-ghost text-fg-muted" onClick={() => void start(kind)}>
            {t.engines.recheck}
          </button>
        </div>
      </Hero>
    );
  }
  return (
    <Hero title={t.engines.stoppedTitle(name)} body={t.engines.stoppedLong(name)}>
      <button className="btn btn-primary" onClick={() => void start(kind)}>
        {t.engines.startCta(name)}
      </button>
    </Hero>
  );
}

export function NoModelNotice() {
  const openSettings = useUi((s) => s.openSettings);
  const ollamaRunning = useProviders((s) => s.statuses.ollama === "running");
  return (
    <Hero title={t.empty.title} body={ollamaRunning ? t.models.noModel : t.engines.lmstudioEmpty}>
      {ollamaRunning && (
        <button className="btn btn-primary" onClick={() => openSettings("models")}>
          <Download size={20} strokeWidth={1.75} />
          {t.models.loadCta}
        </button>
      )}
    </Hero>
  );
}

/** Inline error card in the chat (design.md §9). */
export function ErrorCard({ code, onRetry }: { code: ErrorCode; onRetry: () => void }) {
  return (
    <div className="glass flex items-center gap-3 rounded-lg px-4 py-3" role="alert">
      <TriangleAlert size={20} strokeWidth={1.75} className="flex-none text-danger" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-ui font-normal">{errorMessage(code)}</p>
      <button className="btn btn-secondary flex-none" onClick={onRetry}>
        {t.errors.retry}
      </button>
    </div>
  );
}
