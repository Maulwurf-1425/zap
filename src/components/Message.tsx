import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { DotBolt } from "./Brand";
import { Markdown } from "./Markdown";
import { IconButton } from "./ui/IconButton";
import { parseTools, useChats, type UiMessage } from "../store/chats";
import { ToolCards } from "./ToolCards";
import { useUi } from "../store/ui";
import { copyText } from "../lib/format";
import { modelLabel, parseStats } from "../lib/ipc";
import { parseAttachments } from "../lib/attachments";
import { MessageAttachments } from "./Attachments";
import { t } from "../lib/i18n";

interface MessageItemProps {
  message: UiMessage;
  isLastAssistant: boolean;
  hasLaterMessages: boolean;
  busy: boolean;
}

/** One message. Memoized: while streaming, only the streaming message gets
 *  a new object, so all older messages skip re-rendering. */
export const MessageItem = memo(function MessageItem({
  message,
  isLastAssistant,
  hasLaterMessages,
  busy,
}: MessageItemProps) {
  const isUser = message.role === "user";
  const [editing, setEditing] = useState(false);
  const attachments = useMemo(() => parseAttachments(message.attachments), [message.attachments]);
  const tools = useMemo(() => parseTools(message.tools), [message.tools]);

  if (isUser) {
    return (
      <article className="group flex flex-col items-end gap-2" aria-label={t.chat.you}>
        {attachments.length > 0 && <MessageAttachments attachments={attachments} />}
        {editing ? (
          <EditBox message={message} hasLaterMessages={hasLaterMessages} onDone={() => setEditing(false)} />
        ) : (
          <>
            {message.content.trim() !== "" && (
              <div
                className="selectable max-w-[80%] rounded-lg rounded-br-sm bg-surface-2 px-4 py-2.5 break-words whitespace-pre-wrap"
                style={{ fontSize: "var(--chat-font-size)", lineHeight: "var(--chat-line-height)" }}
              >
                {message.content}
              </div>
            )}
            <Actions align="end">
              <CopyAction text={message.content} />
              <IconButton label={t.chat.edit} disabled={busy} onClick={() => setEditing(true)}>
                <Pencil size={16} strokeWidth={1.75} />
              </IconButton>
              <DeleteAction id={message.id} busy={busy} />
            </Actions>
          </>
        )}
      </article>
    );
  }

  const stats = message.streaming ? null : parseStats(message.stats);
  return (
    <article className="group flex gap-3" aria-label={t.chat.assistant}>
      {/* The dot bolt is the avatar: it builds up and breaks down while ZAP
          thinks and writes, and stays as the finished bolt afterwards. */}
      <div className="flex w-6 flex-none justify-center">
        <DotBolt size={28} variant={message.streaming ? "loop" : "static"} />
      </div>
      <div className="min-w-0 flex-1">
        <ToolCards activities={tools} />
        {message.content !== "" && (
          <div className={`markdown selectable ${message.streaming && !message.working ? "streaming" : ""}`}>
            <Markdown content={message.content} />
          </div>
        )}
        {/* Thinking before the first word and between tool steps, but not
            while an approval card waits for the user. */}
        {message.streaming &&
          (message.content === "" || message.working) &&
          !tools.some((a) => a.status === "pending") && <Thinking />}
        {!message.streaming && (
          // Stats first so they align with the text; hover actions follow.
          <div className="mt-1.5 flex min-h-9 items-center gap-3">
            {(message.model || stats) && (
              <p className="text-caption text-fg-subtle">
                {[
                  message.model ? modelLabel(message.model) : null,
                  stats && stats.tokens_per_sec > 0 ? t.chat.tokensPerSec(stats.tokens_per_sec) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
            <Actions align="start">
              <CopyAction text={message.content} />
              {isLastAssistant && <RegenerateAction id={message.id} busy={busy} />}
              <DeleteAction id={message.id} busy={busy} />
            </Actions>
          </div>
        )}
      </div>
    </article>
  );
});

function Thinking() {
  return (
    <div className="flex h-7 items-center">
      <span className="text-caption text-fg-muted">{t.chat.generating}</span>
    </div>
  );
}

function Actions({ align, children }: { align: "start" | "end"; children: ReactNode }) {
  return (
    <div
      className={`flex gap-0.5 opacity-0 transition-opacity duration-[var(--dur-hover)] group-hover:opacity-100 focus-within:opacity-100 ${
        align === "end" ? "-mt-1 justify-end" : "-ml-2"
      }`}
    >
      {children}
    </div>
  );
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <IconButton label={copied ? t.chat.copied : t.chat.copy} onClick={async () => setCopied(await copyText(text))}>
      {copied ? <Check size={16} strokeWidth={1.75} /> : <Copy size={16} strokeWidth={1.75} />}
    </IconButton>
  );
}

function RegenerateAction({ id, busy }: { id: string; busy: boolean }) {
  const regenerate = useChats((s) => s.regenerate);
  return (
    <IconButton label={t.chat.regenerate} disabled={busy} onClick={() => void regenerate(id)}>
      <RotateCcw size={16} strokeWidth={1.75} />
    </IconButton>
  );
}

function DeleteAction({ id, busy }: { id: string; busy: boolean }) {
  const deleteMessage = useChats((s) => s.deleteMessage);
  return (
    <IconButton label={t.chat.delete} disabled={busy} onClick={() => void deleteMessage(id)}>
      <Trash2 size={16} strokeWidth={1.75} />
    </IconButton>
  );
}

/** Inline editor for a user message: change and resend. Later messages are
 *  discarded after confirmation. */
function EditBox({
  message,
  hasLaterMessages,
  onDone,
}: {
  message: UiMessage;
  hasLaterMessages: boolean;
  onDone: () => void;
}) {
  const editMessage = useChats((s) => s.editMessage);
  const askConfirm = useUi((s) => s.askConfirm);
  const [text, setText] = useState(message.content);
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [text]);

  useEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    if (value === message.content.trim() && !hasLaterMessages) {
      onDone();
      return;
    }
    const run = async () => {
      onDone();
      await editMessage(message.id, value);
    };
    if (hasLaterMessages) {
      askConfirm({
        title: t.chat.editDiscardTitle,
        message: t.chat.editDiscardBody,
        confirmLabel: t.chat.editDiscardConfirm,
        onConfirm: run,
      });
    } else {
      void run();
    }
  };

  return (
    <div className="composer w-full max-w-[80%] rounded-lg border border-border bg-surface-2 p-3">
      <textarea
        ref={ref}
        value={text}
        aria-label={t.chat.edit}
        className="w-full resize-none bg-transparent text-fg outline-none focus-visible:outline-none"
        style={{ fontSize: "var(--chat-font-size)", lineHeight: "var(--chat-line-height)" }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            onDone();
          }
        }}
      />
      <div className="mt-2 flex justify-end gap-2">
        <button className="btn btn-ghost h-9" onClick={onDone}>
          {t.chat.cancel}
        </button>
        <button className="btn btn-secondary h-9" onClick={submit} disabled={!text.trim()}>
          {t.chat.save}
        </button>
      </div>
    </div>
  );
}
