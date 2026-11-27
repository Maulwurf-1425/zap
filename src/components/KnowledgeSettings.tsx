import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Download, FolderOpen, FolderPlus, LoaderCircle, RotateCcw, Trash2, TriangleAlert } from "lucide-react";
import { Section } from "./ui/Controls";
import { IconButton } from "./ui/IconButton";
import { PullRow } from "./PullRow";
import { api, type KnowledgeStatus } from "../lib/ipc";
import { formatTokens } from "../lib/format";
import { t } from "../lib/i18n";
import { useModels } from "../store/models";
import { useProviders } from "../store/providers";
import { useSettings } from "../store/settings";

/** Settings → Knowledge: folders, embedding model and index status. */
export function KnowledgeTab() {
  const folders = useSettings((s) => s.settings.knowledge_folders);
  const update = useSettings((s) => s.update);
  const ollamaUp = useProviders((s) => s.statuses.ollama === "running");
  const pulls = useModels((s) => s.pulls);
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const k = t.knowledge;

  const refresh = useCallback(() => {
    void api
      .knowledgeStatus()
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const un = listen("knowledge://progress", () => refresh());
    return () => {
      void un.then((f) => f());
    };
  }, [refresh]);

  // A finished download of the embedding model: index right away.
  const pull = status ? pulls[status.model] : undefined;
  useEffect(() => {
    if (!pull && status && !status.model_ready && ollamaUp) refresh();
  }, [pull, status, ollamaUp, refresh]);

  const setFolders = async (next: string[]) => {
    await update({ knowledge_folders: next });
    void api.knowledgeIndex();
    refresh();
  };

  const addFolder = async () => {
    const folder = await api.pickFolder();
    if (folder && !folders.includes(folder)) await setFolders([...folders, folder]);
  };

  const progress = status?.progress;
  const indexing = progress?.indexing ?? false;

  return (
    <div className="flex flex-col gap-8">
      <Section title={k.title}>
        <p className="text-ui font-normal text-fg-muted">{k.intro}</p>
        <p className="text-caption text-fg-muted">{k.types}</p>
        {folders.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {folders.map((f) => (
              <li key={f} className="flex items-center gap-3 rounded-lg border border-border bg-surface-1 px-3 py-2">
                <FolderOpen size={16} strokeWidth={1.75} className="flex-none text-coral" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-mono text-caption" title={f}>
                  {f}
                </span>
                <IconButton label={k.removeFolder} onClick={() => void setFolders(folders.filter((x) => x !== f))}>
                  <Trash2 size={16} strokeWidth={1.75} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        <button className="btn btn-secondary w-fit" onClick={() => void addFolder()}>
          <FolderPlus size={16} strokeWidth={1.75} aria-hidden="true" />
          {k.addFolder}
        </button>
      </Section>

      <Section title={k.model}>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-1 p-4">
          <div className="min-w-0">
            <div className="font-mono text-ui">{status?.model ?? "…"}</div>
            <p className="text-caption text-fg-muted">
              {!ollamaUp ? k.needsOllama : status?.model_ready ? k.modelReady : k.modelMissing}
            </p>
          </div>
          {status && !status.model_ready && ollamaUp && !pull && (
            <button className="btn btn-primary flex-none" onClick={() => void useModels.getState().pull(status.model)}>
              <Download size={16} strokeWidth={1.75} aria-hidden="true" />
              {k.download}
            </button>
          )}
        </div>
        {pull && <PullRow pull={pull} />}
      </Section>

      <Section title={k.index}>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-1 p-4">
          <div className="min-w-0 flex-1">
            {indexing ? (
              <>
                <div className="flex items-center gap-2 text-ui">
                  <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  {k.indexing(progress?.done ?? 0, progress?.total ?? 0)}
                </div>
                {progress?.current && <p className="truncate text-caption text-fg-muted">{progress.current}</p>}
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <div
                    className="h-full rounded-full bg-coral transition-[width]"
                    style={{ width: `${progress?.total ? (100 * progress.done) / progress.total : 0}%` }}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="text-ui">
                  {status ? k.indexed(formatTokens(status.files), formatTokens(status.passages)) : "…"}
                </div>
                {progress?.error && (
                  <p className="flex items-center gap-1.5 text-caption text-danger">
                    <TriangleAlert size={12} strokeWidth={1.75} aria-hidden="true" />
                    {k.errors[progress.error] ?? t.errors.generic}
                  </p>
                )}
              </>
            )}
          </div>
          <button
            className="btn btn-secondary flex-none"
            disabled={indexing || folders.length === 0 || !status?.model_ready}
            onClick={() => {
              void api.knowledgeIndex();
              window.setTimeout(refresh, 300);
            }}
          >
            <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
            {k.reindex}
          </button>
        </div>
        {status && status.failed.length > 0 && (
          <details className="text-caption text-fg-muted">
            <summary className="cursor-pointer">{k.failed(status.failed.length)}</summary>
            <ul className="mt-1 flex flex-col gap-0.5">
              {status.failed.map(([path, error]) => (
                <li key={path} className="truncate font-mono" title={path}>
                  {path.split(/[\\/]/).pop()} · {k.fileErrors[error] ?? error}
                </li>
              ))}
            </ul>
          </details>
        )}
        <p className="text-caption text-fg-muted">{k.howToUse}</p>
      </Section>
    </div>
  );
}
