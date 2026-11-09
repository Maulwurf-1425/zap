import { useState } from "react";
import {
  Ban,
  ChevronDown,
  FilePen,
  FilePlus,
  FileSearch,
  FileText,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Globe,
  LoaderCircle,
  Search,
  ShieldQuestion,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api, type ApprovalDecision, type ToolActivity } from "../lib/ipc";
import { openExternal } from "../lib/format";
import { t } from "../lib/i18n";

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Last two path segments for compact labels (full path in the tooltip). */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…\\${parts.slice(-2).join("\\")}` : path;
}

const ICONS: Record<string, LucideIcon> = {
  web_search: Search,
  fetch_page: Globe,
  search_files: FileSearch,
  list_directory: FolderOpen,
  read_file: FileText,
  write_file: FilePlus,
  edit_file: FilePen,
  create_folder: FolderPlus,
  move_path: FolderInput,
  delete_file: Trash2,
};

function label(a: ToolActivity): string {
  const done = a.status === "done";
  const p = shortPath(a.input);
  const f = t.files;
  switch (a.name) {
    case "fetch_page": {
      const h = host(a.sources[0]?.url ?? a.input);
      return done ? t.web.read(h) : t.web.reading(h);
    }
    case "web_search":
      return done ? t.web.searched(a.input) : t.web.searching(a.input);
    case "search_files":
      return done ? f.searched(a.input) : f.searching(a.input);
    case "list_directory":
      return done ? f.listed(p) : f.listing(p);
    case "read_file":
      return done ? f.read(p) : f.reading(p);
    case "write_file":
      if (a.detail === "overwrite") return done ? f.overwrote(p) : f.overwriting(p);
      return done ? f.created(p) : f.creating(p);
    case "edit_file":
      return done ? f.edited(p) : f.editing(p);
    case "create_folder":
      return done ? f.createdFolder(p) : f.creatingFolder(p);
    case "move_path": {
      const to = shortPath((a.detail ?? "").replace(/^to:/, ""));
      return done ? f.moved(p, to) : f.moving(p, to);
    }
    case "delete_file":
      return done ? f.deleted(p) : f.deleting(p);
    default:
      return a.name;
  }
}

function errorText(code: string | undefined): string {
  if (!code) return t.errors.generic;
  return t.files.errors[code] ?? t.web.errors[code] ?? t.errors.generic;
}

/** Extra info after the label, from status and the machine-readable `detail`. */
function note(a: ToolActivity): string | null {
  if (a.status === "denied") return t.files.denied;
  if (a.status === "pending") return t.files.waiting;
  if (a.status === "error") return errorText(a.error);
  const [kind, value] = (a.detail ?? "").split(":");
  if (a.name === "web_search") {
    if (kind === "starting") return value === "docker" ? t.web.startingDocker : t.web.startingSearxng;
    const parts = a.sources.length > 0 ? [t.web.sources(a.sources.length)] : [];
    // Another service failed; the built-in search stepped in.
    if (kind === "fallback") parts.push(value === "brave" ? t.web.fallbackBrave : t.web.fallbackSearxng);
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  const n = Number(value);
  if (kind === "results") return t.files.results(n);
  if (kind === "entries") return t.files.entries(n);
  if (kind === "lines") return t.files.lines(n);
  if (kind === "folder") return t.files.folderFiles(n);
  return null;
}

/** Compact cards for the tools a reply used. Searches expand to their
 *  sources, file changes to their diff; pending file actions show the
 *  approval card. */
export function ToolCards({ activities }: { activities: ToolActivity[] }) {
  if (activities.length === 0) return null;
  return (
    <div className="mb-3 flex flex-col gap-1.5" aria-live="polite">
      {activities.map((a) =>
        a.status !== "pending" ? (
          <ToolCard key={a.id} activity={a} />
        ) : a.detail?.startsWith("searxng_down:") ? (
          <SearxngDownCard key={a.id} activity={a} />
        ) : (
          <ApprovalCard key={a.id} activity={a} />
        ),
      )}
    </div>
  );
}

function StatusIcon({ activity: a }: { activity: ToolActivity }) {
  const Icon = ICONS[a.name] ?? FileText;
  if (a.status === "running") {
    return (
      <LoaderCircle
        size={14}
        strokeWidth={1.75}
        className="flex-none animate-spin motion-reduce:animate-none"
        aria-hidden="true"
      />
    );
  }
  if (a.status === "error") {
    return <TriangleAlert size={14} strokeWidth={1.75} className="flex-none text-danger" aria-hidden="true" />;
  }
  if (a.status === "denied") return <Ban size={14} strokeWidth={1.75} className="flex-none" aria-hidden="true" />;
  return <Icon size={14} strokeWidth={1.75} className="flex-none" aria-hidden="true" />;
}

function ToolCard({ activity: a }: { activity: ToolActivity }) {
  const [open, setOpen] = useState(false);
  const showSources = a.sources.length > 0 && a.name === "web_search";
  const showPreview = Boolean(a.preview) && a.status === "done";
  const expandable = showSources || showPreview;
  const extra = note(a);

  return (
    <div className="w-fit max-w-full rounded-md border border-border bg-surface-1 text-caption">
      <button
        type="button"
        className="flex min-h-8 w-full max-w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-fg-muted enabled:hover:text-fg"
        onClick={() => setOpen((o) => !o)}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        title={a.input}
      >
        <StatusIcon activity={a} />
        <span className="min-w-0 truncate">{label(a)}</span>
        {extra && <span className="flex-none text-fg-subtle">· {extra}</span>}
        {expandable && (
          <ChevronDown
            size={14}
            strokeWidth={1.75}
            className={`flex-none transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        )}
      </button>
      {open && showSources && (
        <ul className="flex flex-col gap-0.5 border-t border-border px-2.5 py-2">
          {a.sources.map((s) => (
            <li key={s.url}>
              <a
                href={s.url}
                title={s.url}
                className="flex min-w-0 items-baseline gap-2 rounded-sm py-0.5 text-fg hover:underline hover:decoration-[var(--link)]"
                onClick={async (e) => {
                  e.preventDefault();
                  if (!(await openExternal(s.url))) toast(t.chat.linkFailed);
                }}
              >
                <span className="flex-none text-fg-subtle">{host(s.url)}</span>
                <span className="min-w-0 truncate">{s.title}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {open && showPreview && <DiffView text={a.preview ?? ""} />}
    </div>
  );
}

/** Colored unified diff / new-file preview. */
function DiffView({ text }: { text: string }) {
  return (
    <pre className="selectable max-h-72 overflow-auto border-t border-border px-3 py-2 font-mono text-[12px] leading-[18px]">
      {text.split("\n").map((line, i) => {
        const tone =
          line.startsWith("+") && !line.startsWith("+++")
            ? "bg-[var(--diff-add)]"
            : line.startsWith("-") && !line.startsWith("---")
              ? "bg-[var(--diff-del)]"
              : line.startsWith("@@")
                ? "text-fg-subtle"
                : "";
        return (
          <div key={i} className={`whitespace-pre ${tone}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

/** SearXNG didn't answer during a search: start Docker, or use the built-in
 *  search for the rest of this session. */
function SearxngDownCard({ activity: a }: { activity: ToolActivity }) {
  const [busy, setBusy] = useState(false);
  const w = t.web;
  // "searxng_down:stopped" (Docker Desktop off) | "searxng_down:running" (container off)
  const dockerRunning = a.detail === "searxng_down:running";

  const answer = async (decision: ApprovalDecision) => {
    setBusy(true);
    try {
      await api.answerApproval(a.id, decision);
    } catch {
      setBusy(false);
      toast(t.errors.generic);
    }
  };

  return (
    <div
      className="w-full max-w-full rounded-lg border border-[var(--coral-ring)] bg-surface-2 text-ui shadow-card"
      role="alertdialog"
      aria-label={w.searxngDown}
    >
      <div className="flex items-start gap-3 px-4 pt-3">
        <TriangleAlert size={18} strokeWidth={1.75} className="mt-0.5 flex-none text-coral" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div>{w.searxngDown}</div>
          <p className="text-caption text-fg-muted">{dockerRunning ? w.searxngContainerOff : w.searxngDockerOff}</p>
          <p className="mt-1 text-caption text-fg-subtle">{w.searxngQuestion(a.input)}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button className="btn btn-secondary" disabled={busy} onClick={() => void answer("allow")} autoFocus>
          {dockerRunning ? w.startSearxng : w.startDocker}
        </button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => void answer("deny")}>
          {w.useBuiltin}
        </button>
      </div>
      {!dockerRunning && <p className="px-4 pb-3 text-caption text-fg-subtle">{w.dockerAutostartTip}</p>}
    </div>
  );
}

/** A file action waiting for the user's OK (permission mode "ask"). */
function ApprovalCard({ activity: a }: { activity: ToolActivity }) {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const Icon = ICONS[a.name] ?? FileText;
  const extra = note({ ...a, status: "done" });

  const answer = async (decision: ApprovalDecision) => {
    setBusy(true);
    try {
      await api.answerApproval(a.id, decision);
    } catch {
      setBusy(false);
      toast(t.errors.generic);
    }
  };

  return (
    <div
      className="w-full max-w-full rounded-lg border border-[var(--coral-ring)] bg-surface-2 text-ui shadow-card"
      role="alertdialog"
      aria-label={`${t.files.approvalTitle}: ${label(a)}`}
    >
      <div className="flex items-start gap-3 px-4 pt-3">
        <ShieldQuestion size={18} strokeWidth={1.75} className="mt-0.5 flex-none text-coral" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-caption text-fg-muted">{t.files.approvalTitle}</div>
          <div className="flex items-center gap-2">
            <Icon size={14} strokeWidth={1.75} className="flex-none" aria-hidden="true" />
            <span className="min-w-0 truncate">{label(a)}</span>
          </div>
          <div className="selectable truncate font-mono text-caption text-fg-subtle" title={a.input}>
            {a.input}
            {extra && ` · ${extra}`}
          </div>
        </div>
      </div>
      {a.preview && (
        <div className="mx-4 mt-2 overflow-hidden rounded-md border border-border bg-code">
          <button
            type="button"
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-caption text-fg-muted hover:text-fg"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            <ChevronDown
              size={14}
              strokeWidth={1.75}
              className={`transition-transform ${open ? "rotate-180" : ""}`}
              aria-hidden="true"
            />
            {open ? t.files.hideChanges : t.files.showChanges}
          </button>
          {open && <DiffView text={a.preview} />}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button className="btn btn-secondary" disabled={busy} onClick={() => void answer("allow")} autoFocus>
          {t.files.allow}
        </button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => void answer("deny")}>
          {t.files.deny}
        </button>
        <button
          className="btn btn-ghost ml-auto text-fg-muted"
          disabled={busy}
          onClick={() => void answer("allow_chat")}
        >
          {t.files.allowChat}
        </button>
      </div>
    </div>
  );
}
