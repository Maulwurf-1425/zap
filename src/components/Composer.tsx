import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { File as FileIcon, Folder, FolderSearch, Globe, Square } from "lucide-react";
import { toast } from "sonner";
import { Bolt } from "./Brand";
import { ModelPicker } from "./ModelPicker";
import { AttachMenu, AttachmentChip } from "./Attachments";
import { NEW_CHAT_DRAFT, useChats } from "../store/chats";
import { useModels } from "../store/models";
import { useSettings } from "../store/settings";
import { IconButton } from "./ui/IconButton";
import { AttachmentError, attachmentFromBase64, readAttachment, type Attachment } from "../lib/attachments";
import { api, toAppError, type FileHit } from "../lib/ipc";
import { t } from "../lib/i18n";

const MAX_LINES = 8;
const NO_ATTACHMENTS: Attachment[] = [];

export interface ComposerHandle {
  setText: (text: string) => void;
  focus: () => void;
  addFiles: (files: File[]) => void;
}

interface ComposerProps {
  generating: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

function attachmentErrorText(err: AttachmentError): string {
  switch (err.code) {
    case "no_vision":
      return t.attach.noVision;
    case "too_large":
      return t.attach.tooLarge(err.fileName);
    case "unreadable":
      return t.attach.unreadable(err.fileName);
    default:
      return t.attach.unsupported(err.fileName);
  }
}

/** Glass composer (design.md §6.2): grows 1–8 lines, attachments and model
 *  chip left, coral send / glass stop right. Drafts are kept per chat. */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { generating, disabled, onSend, onStop },
  ref,
) {
  const draftKey = useChats((s) => s.activeId ?? NEW_CHAT_DRAFT);
  const text = useChats((s) => s.drafts[draftKey] ?? "");
  const attachments = useChats((s) => s.pendingAttachments[draftKey] ?? NO_ATTACHMENTS);
  const setDraft = useChats((s) => s.setDraft);
  const addAttachments = useChats((s) => s.addAttachments);
  const removeAttachment = useChats((s) => s.removeAttachment);
  const selected = useModels((s) => s.selected);
  const vision = useModels((s) => (s.selected ? (s.caps[s.selected]?.vision ?? false) : false));
  const ensureCaps = useModels((s) => s.ensureCaps);
  const canUseTools = useModels((s) => (s.selected ? (s.caps[s.selected]?.tools ?? false) : false));
  const webEnabled = useSettings((s) => s.settings.web_search_enabled);
  const updateSettings = useSettings((s) => s.update);
  const webActive = webEnabled && canUseTools;
  const filesEnabled = useSettings((s) => s.settings.file_tools_enabled);
  const fullPermission = useSettings((s) => s.settings.file_permission === "full");
  const filesActive = filesEnabled && canUseTools;
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // @-mentions: "@part" before the caret opens a file search popover.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [results, setResults] = useState<FileHit[]>([]);
  const [activeHit, setActiveHit] = useState(0);
  const [indexing, setIndexing] = useState(false);
  const hits = mention && mention.query ? results : [];

  const updateMention = (value: string, caret: number) => {
    const m = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
    setMention(m ? { start: caret - (m[2]?.length ?? 0) - 1, query: m[2] ?? "" } : null);
  };

  useEffect(() => {
    const q = mention?.query;
    if (!q) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void api
        .fileSearch(q)
        .then(async (found) => {
          if (!alive) return;
          setResults(found);
          setActiveHit(0);
          if (found.length === 0) {
            const status = await api.indexStatus().catch(() => null);
            if (alive) setIndexing(Boolean(status?.building));
          }
        })
        .catch(() => alive && setResults([]));
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [mention?.query]);

  // Keep the keyboard choice visible in longer lists.
  useEffect(() => {
    document.getElementById(`mention-${activeHit}`)?.scrollIntoView({ block: "nearest" });
  }, [activeHit]);

  const pickHit = async (hit: FileHit) => {
    if (!mention) return;
    const end = mention.start + 1 + mention.query.length;
    // Folders are written into the text (the AI can look inside with file
    // access); files become attachments with their full path.
    const insert = hit.is_dir ? `${hit.path} ` : "";
    setDraft(draftKey, text.slice(0, mention.start) + insert + text.slice(end));
    setMention(null);
    areaRef.current?.focus();
    if (hit.is_dir) return;
    try {
      const data = await api.readFileAttachment(hit.path);
      addAttachments(draftKey, [await attachmentFromBase64(data, vision)]);
    } catch (err) {
      if (err instanceof AttachmentError) toast(attachmentErrorText(err));
      else if (toAppError(err).message === "file too large") toast(t.attach.tooLarge(hit.name));
      else toast(t.attach.unreadable(hit.name));
    }
  };

  // Know whether the selected model can see images before anything is attached.
  useEffect(() => {
    if (selected) void ensureCaps(selected);
  }, [selected, ensureCaps]);

  const addFiles = async (files: File[]) => {
    if (disabled) return;
    const results = await Promise.allSettled(files.map((f) => readAttachment(f, vision)));
    const ok: Attachment[] = [];
    const shown = new Set<string>();
    for (const r of results) {
      if (r.status === "fulfilled") ok.push(r.value);
      else if (r.reason instanceof AttachmentError) {
        const msg = attachmentErrorText(r.reason);
        // One toast per distinct message (e.g. a single "needs vision" for 5 images).
        if (!shown.has(msg)) toast(msg);
        shown.add(msg);
      }
    }
    if (ok.length > 0) addAttachments(draftKey, ok);
  };

  useImperativeHandle(ref, () => ({
    setText: (value) => {
      setDraft(draftKey, value);
      requestAnimationFrame(() => {
        const el = areaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(value.length, value.length);
      });
    },
    focus: () => areaRef.current?.focus(),
    addFiles: (files) => void addFiles(files),
  }));

  // Auto-grow between 1 and 8 lines (line height follows the chat font size).
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const line = parseFloat(getComputedStyle(el).lineHeight) || 26;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_LINES)}px`;
  }, [text]);

  // Images stay attached when switching to a text-only model, but can't be sent.
  const blocked = !vision && attachments.some((a) => a.kind === "image");
  const hasContent = text.trim().length > 0 || attachments.length > 0;
  const canSend = !disabled && !generating && hasContent && !blocked;

  const send = () => {
    if (!canSend) return;
    onSend(text);
  };

  return (
    <div className="composer glass relative flex flex-col gap-1 rounded-xl px-4 pt-3 pb-2.5">
      {mention && (
        <div
          id="mention-list"
          role="listbox"
          aria-label={t.files.mentionLabel}
          className="popover anim-pop absolute right-0 bottom-full left-0 z-40 mb-2 rounded-lg p-1.5"
          data-state="open"
        >
          <div className="px-2.5 pt-1 pb-1.5 text-caption text-fg-subtle">{t.files.mentionLabel}</div>
          {hits.length === 0 ? (
            <p className="px-2.5 py-2 text-caption text-fg-muted">
              {mention.query ? (indexing ? t.files.mentionIndexing : t.files.mentionEmpty) : t.files.mentionHint}
            </p>
          ) : (
            hits.map((hit, i) => (
              <button
                key={hit.path}
                id={`mention-${i}`}
                type="button"
                role="option"
                aria-selected={i === activeHit}
                data-selected={i === activeHit}
                className="menu-item h-auto w-full py-1.5 text-left"
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => i !== activeHit && setActiveHit(i)}
                onClick={() => void pickHit(hit)}
              >
                {hit.is_dir ? (
                  <Folder size={16} strokeWidth={1.75} className="flex-none text-fg-muted" aria-hidden="true" />
                ) : (
                  <FileIcon size={16} strokeWidth={1.75} className="flex-none text-fg-muted" aria-hidden="true" />
                )}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{hit.name}</span>
                  <span className="truncate text-caption font-normal text-fg-subtle" title={hit.path}>
                    {hit.path}
                  </span>
                </span>
              </button>
            ))
          )}
          {hits.length > 0 && <div className="px-2.5 pt-1 text-caption text-fg-subtle">{t.files.mentionHint}</div>}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="flex flex-col gap-2 px-1 pt-1 pb-2">
          <div className="flex flex-wrap gap-2" aria-label={t.attach.label}>
            {attachments.map((a) => (
              <AttachmentChip
                key={a.id}
                attachment={a}
                blocked={!vision && a.kind === "image"}
                onRemove={() => removeAttachment(draftKey, a.id)}
              />
            ))}
          </div>
          {blocked && (
            <p className="text-caption text-fg-muted" role="alert">
              {t.attach.blockedHint}
            </p>
          )}
        </div>
      )}
      <label htmlFor="composer-input" className="sr-only">
        {t.composer.label}
      </label>
      <textarea
        id="composer-input"
        ref={areaRef}
        rows={1}
        value={text}
        placeholder={t.composer.placeholder}
        className="w-full resize-none bg-transparent px-1 text-fg outline-none placeholder:text-fg-subtle focus-visible:outline-none"
        style={{ fontSize: "var(--chat-font-size)", lineHeight: "var(--chat-line-height)" }}
        aria-autocomplete="list"
        aria-controls={mention ? "mention-list" : undefined}
        aria-activedescendant={mention && hits.length > 0 ? `mention-${activeHit}` : undefined}
        onChange={(e) => {
          setDraft(draftKey, e.target.value);
          updateMention(e.target.value, e.target.selectionStart);
        }}
        onSelect={(e) => updateMention(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => window.setTimeout(() => setMention(null), 150)}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (files.length === 0) return;
          e.preventDefault();
          void addFiles(files);
        }}
        onKeyDown={(e) => {
          if (mention) {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setMention(null);
              return;
            }
            if (hits.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              const dir = e.key === "ArrowDown" ? 1 : -1;
              setActiveHit((i) => (i + dir + hits.length) % hits.length);
              return;
            }
            const hit = hits[activeHit];
            if (hit && (e.key === "Enter" || e.key === "Tab")) {
              e.preventDefault();
              void pickHit(hit);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <AttachMenu vision={vision} disabled={disabled} onFiles={(files) => void addFiles(files)} />
          <IconButton
            label={!canUseTools ? t.web.needsTools : webActive ? t.web.on : t.web.off}
            aria-pressed={webActive}
            className={`size-8 rounded-full ${webActive ? "bg-surface-2 text-coral" : ""}`}
            disabled={disabled || !canUseTools}
            onClick={() => void updateSettings({ web_search_enabled: !webEnabled })}
          >
            <Globe size={16} strokeWidth={1.75} />
          </IconButton>
          <IconButton
            label={
              !canUseTools
                ? t.web.needsTools
                : filesActive
                  ? fullPermission
                    ? t.files.onFull
                    : t.files.on
                  : t.files.off
            }
            aria-pressed={filesActive}
            className={`size-8 rounded-full ${filesActive ? "bg-surface-2 text-coral" : ""}`}
            disabled={disabled || !canUseTools}
            onClick={() => void updateSettings({ file_tools_enabled: !filesEnabled })}
          >
            <FolderSearch size={16} strokeWidth={1.75} />
          </IconButton>
          <ModelPicker />
        </div>
        {generating ? (
          <button
            className="btn btn-secondary size-10 flex-none rounded-md p-0"
            onClick={onStop}
            aria-label={t.composer.stop}
            title={`${t.composer.stop} (Esc)`}
          >
            <Square size={14} strokeWidth={1.75} fill="currentColor" />
          </button>
        ) : (
          <button
            className="btn btn-primary size-10 flex-none p-0"
            onClick={send}
            disabled={!canSend}
            aria-label={t.composer.send}
            title={`${t.composer.send} (Enter)`}
          >
            <Bolt size={18} />
          </button>
        )}
      </div>
    </div>
  );
});
