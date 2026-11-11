import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { Switch } from "./ui/Controls";
import { useProviders } from "../store/providers";
import { LMSTUDIO_DEFAULT_PORT, useSettings } from "../store/settings";
import { EngineInstall } from "./EngineInstall";
import { engineName, t } from "../lib/i18n";
import type { ProviderKind, ProviderStatus } from "../lib/ipc";

const DOT: Record<ProviderStatus, string> = {
  running: "var(--success)",
  starting: "var(--warning)",
  not_found: "var(--danger)",
  stopped: "var(--danger)",
  disabled: "var(--fg-subtle)",
};

const ENABLED_KEY: Record<ProviderKind, "ollama_enabled" | "lmstudio_enabled"> = {
  ollama: "ollama_enabled",
  lmstudio: "lmstudio_enabled",
};

/** Turn an engine on/off and see its status, with install/start actions.
 *  `showPort` adds the LM Studio server port field. */
export function EngineCard({ kind, showPort = false }: { kind: ProviderKind; showPort?: boolean }) {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const status = useProviders((s) => s.statuses[kind]);
  const start = useProviders((s) => s.start);
  const restart = useProviders((s) => s.restart);
  const name = engineName(kind);
  const enabled = settings[ENABLED_KEY[kind]];
  const switchId = `engine-${kind}`;

  const toggle = async (on: boolean) => {
    await update({ [ENABLED_KEY[kind]]: on });
    await start(kind);
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-1 p-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <label htmlFor={switchId} className="text-ui">
            {name}
          </label>
          <div className="mt-0.5 flex items-center gap-2 text-caption text-fg-muted" role="status" aria-live="polite">
            <span
              className={`status-dot ${status === "starting" ? "pulse" : ""}`}
              style={{ background: DOT[status] }}
              aria-hidden="true"
            />
            {t.engines.status[status]}
          </div>
        </div>
        {enabled && status === "stopped" && (
          <button className="btn btn-secondary h-9" onClick={() => void start(kind)}>
            {t.engines.start}
          </button>
        )}
        {enabled && (status === "running" || status === "starting") && (
          <button
            className="btn btn-ghost h-9 text-fg-muted"
            disabled={status === "starting"}
            onClick={() => void restart(kind)}
            title={t.engines.restartHint(name)}
          >
            <RotateCcw
              size={15}
              strokeWidth={1.75}
              className={status === "starting" ? "animate-spin motion-reduce:animate-none" : ""}
              aria-hidden="true"
            />
            {t.engines.restart}
          </button>
        )}
        <Switch id={switchId} label={t.engines.use(name)} checked={enabled} onChange={(on) => void toggle(on)} />
      </div>
      {enabled && status === "not_found" && <EngineInstall kind={kind} />}
      {showPort && enabled && <PortField key={settings.lmstudio_port} saved={settings.lmstudio_port} />}
    </div>
  );
}

function PortField({ saved }: { saved: number }) {
  const update = useSettings((s) => s.update);
  const start = useProviders((s) => s.start);
  const [value, setValue] = useState(String(saved));
  const port = Number(value);
  const valid = Number.isInteger(port) && port >= 1 && port <= 65535;

  const commit = async () => {
    if (!valid) {
      setValue(String(saved || LMSTUDIO_DEFAULT_PORT));
      return;
    }
    if (port === saved) return;
    await update({ lmstudio_port: port });
    await start("lmstudio");
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="lmstudio-port" className="text-caption text-fg-muted">
        {t.engines.port}
      </label>
      <input
        id="lmstudio-port"
        className="input h-10 w-32 tabular-nums"
        inputMode="numeric"
        value={value}
        aria-invalid={!valid}
        aria-describedby="lmstudio-port-hint"
        onChange={(e) => setValue(e.target.value.replace(/\D/g, "").slice(0, 5))}
        onBlur={() => void commit()}
        onKeyDown={(e) => e.key === "Enter" && void commit()}
      />
      <p id="lmstudio-port-hint" className="text-caption text-fg-muted">
        {t.engines.portHint}
      </p>
    </div>
  );
}
