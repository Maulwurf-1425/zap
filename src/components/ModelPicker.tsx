import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Cpu, Download, TriangleAlert } from "lucide-react";
import { CURATED_MODELS, hasOllamaModel, useModels } from "../store/models";
import { useChats } from "../store/chats";
import { anyRunning, useProviders } from "../store/providers";
import { useUi } from "../store/ui";
import { formatBytes } from "../lib/format";
import { engineName, t } from "../lib/i18n";
import { modelLabel, PROVIDERS, type ModelInfo } from "../lib/ipc";
import { PullRow } from "./PullRow";
import { useVramInfo, vramShortfall, type VramInfo } from "../lib/vram";

/** Model chip inside the composer (left). Opens a glass popover with the
 *  models of every running engine, downloads and popular suggestions. */
export function ModelPicker() {
  const installed = useModels((s) => s.installed);
  const selected = useModels((s) => s.selected);
  const pulls = useModels((s) => s.pulls);
  const pull = useModels((s) => s.pull);
  const setChatModel = useChats((s) => s.setChatModel);
  const statuses = useProviders((s) => s.statuses);
  const openSettings = useUi((s) => s.openSettings);
  const [open, setOpen] = useState(false);
  const vram = useVramInfo(open);

  const running = anyRunning(statuses);
  const ollamaRunning = statuses.ollama === "running";
  const lmstudioRunning = statuses.lmstudio === "running";
  const activePulls = Object.values(pulls);
  const suggestions = ollamaRunning
    ? CURATED_MODELS.filter((m) => !hasOllamaModel(installed, m.name) && !pulls[m.name]).slice(0, 3)
    : [];
  const label = selected ? modelLabel(selected) : running ? t.models.choose : t.models.none;
  const groups = PROVIDERS.map((kind) => ({ kind, models: installed.filter((m) => m.provider === kind) })).filter(
    (g) => g.models.length > 0,
  );
  const showHeaders = groups.length > 1 || (lmstudioRunning && ollamaRunning);
  const lmstudioEmpty = lmstudioRunning && !installed.some((m) => m.provider === "lmstudio");

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          className="btn h-8 max-w-[260px] gap-1.5 rounded-full border border-border bg-surface-1 pr-2 pl-3 text-caption font-medium text-fg-muted hover:bg-surface-2 hover:text-fg data-[state=open]:bg-surface-2 data-[state=open]:text-fg"
          disabled={!running}
          aria-label={`${t.models.choose}: ${label}`}
        >
          <Cpu size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="truncate">{label}</span>
          <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          className="popover anim-pop z-50 w-[380px] rounded-lg p-2"
        >
          <div role="listbox" aria-label={t.models.choose} className="max-h-[300px] overflow-y-auto">
            {groups.map(({ kind, models }) => (
              <div key={kind} role="group" aria-label={engineName(kind)}>
                <div className="px-3 pt-1 pb-1.5 text-caption text-fg-subtle">
                  {showHeaders ? engineName(kind) : t.models.installed}
                </div>
                {models.map((m) => (
                  <ModelOption
                    key={m.id}
                    model={m}
                    selected={m.id === selected}
                    vram={vram}
                    onPick={() => {
                      setChatModel(m.id);
                      setOpen(false);
                    }}
                  />
                ))}
              </div>
            ))}
          </div>

          {lmstudioEmpty && <p className="px-3 py-2 text-caption text-fg-muted">{t.engines.lmstudioEmpty}</p>}

          {activePulls.length > 0 && (
            <div className="px-3 pt-1">
              {activePulls.map((p) => (
                <PullRow key={p.name} pull={p} />
              ))}
            </div>
          )}

          {suggestions.length > 0 && (
            <>
              <div className="px-3 pt-2 pb-1.5 text-caption text-fg-subtle">{t.models.popular}</div>
              {suggestions.map((m) => (
                <div key={m.name} className="flex h-10 items-center gap-3 px-3">
                  <span className="w-4 flex-none" />
                  <span className="min-w-0 flex-1 truncate text-ui">{m.name}</span>
                  <span className="text-caption text-fg-muted tabular-nums">~{formatBytes(m.approxBytes)}</span>
                  <button className="btn btn-secondary h-8 px-3" onClick={() => void pull(m.name)}>
                    {t.models.load}
                  </button>
                </div>
              ))}
            </>
          )}

          <div className="mx-1 mt-1 h-px bg-border" aria-hidden="true" />
          <button
            className="menu-item mt-1 h-10 w-full"
            onClick={() => {
              setOpen(false);
              openSettings("models");
            }}
          >
            <Download size={16} strokeWidth={1.75} />
            {t.models.more}
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ModelOption({
  model,
  selected,
  vram,
  onPick,
}: {
  model: ModelInfo;
  selected: boolean;
  vram: VramInfo | null;
  onPick: () => void;
}) {
  const short = vramShortfall(model, vram);
  const hint = short ? t.models.vramShort(formatBytes(short.needed), formatBytes(short.free)) : undefined;
  return (
    <button
      role="option"
      aria-selected={selected}
      className="menu-item h-10 w-full text-left"
      onClick={onPick}
      title={hint}
    >
      <span className="flex w-4 flex-none justify-center">
        {selected && <Check size={16} strokeWidth={1.75} className="text-coral" aria-hidden="true" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{model.name}</span>
      {short && (
        <TriangleAlert size={14} strokeWidth={1.75} className="flex-none text-[var(--warning)]" aria-label={hint} />
      )}
      {model.size_bytes > 0 && (
        <span className="flex-none text-caption text-fg-muted tabular-nums">{formatBytes(model.size_bytes)}</span>
      )}
    </button>
  );
}
