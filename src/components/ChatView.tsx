import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ArrowDown } from "lucide-react";
import { Composer, type ComposerHandle } from "./Composer";
import { EmptyState } from "./EmptyState";
import { MessageItem } from "./Message";
import { ErrorCard, NoModelNotice, EngineNotice } from "./Notice";
import { MessagesSkeleton } from "./ui/Skeleton";
import { useChats, type UiMessage } from "../store/chats";
import { useModels } from "../store/models";
import { anyRunning, primaryProvider, useProviders } from "../store/providers";
import { useUi } from "../store/ui";
import { engineName, t } from "../lib/i18n";
import { modelProvider } from "../lib/ipc";

const EMPTY: UiMessage[] = [];
const BOTTOM_THRESHOLD = 80;

export interface ChatViewHandle {
  focusComposer: () => void;
}

export const ChatView = forwardRef<ChatViewHandle>(function ChatView(_props, ref) {
  const activeId = useChats((s) => s.activeId);
  const messages = useChats((s) => (s.activeId ? (s.messages[s.activeId] ?? EMPTY) : EMPTY));
  const loading = useChats((s) => (s.activeId ? Boolean(s.loadingMessages[s.activeId]) : false));
  const generating = useChats((s) => (s.activeId ? Boolean(s.generating[s.activeId]) : false));
  const error = useChats((s) => (s.activeId ? s.errors[s.activeId] : undefined));
  const send = useChats((s) => s.send);
  const stop = useChats((s) => s.stop);
  const statuses = useProviders((s) => s.statuses);
  const modelsLoaded = useModels((s) => s.loaded);
  const hasModels = useModels((s) => s.installed.length > 0);
  const selected = useModels((s) => s.selected);
  const announcement = useUi((s) => s.announcement);

  const composerRef = useRef<ComposerHandle>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const stickRef = useRef(true);

  useImperativeHandle(ref, () => ({ focusComposer: () => composerRef.current?.focus() }));

  useEffect(() => {
    stickRef.current = true;
    composerRef.current?.focus();
  }, [activeId]);

  const onSend = useCallback(
    (text: string) => {
      stickRef.current = true;
      void send(text);
    },
    [send],
  );

  const running = anyRunning(statuses);
  // Ready when the selected model's own engine is up.
  const ready = selected !== null && statuses[modelProvider(selected)] === "running";
  const showChat = activeId !== null && (messages.length > 0 || loading);

  let body: React.ReactNode;
  if (!showChat && !running) body = <EngineNotice />;
  else if (!showChat && modelsLoaded && !hasModels) body = <NoModelNotice />;
  else if (!showChat) body = <EmptyState onPick={(p) => composerRef.current?.setText(p)} />;
  else if (loading && messages.length === 0)
    body = (
      <div className="min-h-0 flex-1">
        <MessagesSkeleton />
      </div>
    );
  else
    body = (
      <MessageList key={activeId} messages={messages} generating={generating} error={error?.code} stickRef={stickRef} />
    );

  let hint: string = t.composer.hint;
  const primary = primaryProvider(statuses);
  if (!running) {
    if (!primary) hint = t.engines.noneBody;
    else if (primary.status === "starting") hint = t.engines.starting(engineName(primary.kind));
    else if (primary.status === "not_found") hint = t.engines.missing(engineName(primary.kind));
    else hint = t.engines.stoppedLong(engineName(primary.kind));
  } else if (modelsLoaded && !selected) hint = t.models.noModel;
  else if (selected && !ready) hint = t.engines.stoppedLong(engineName(modelProvider(selected)));
  else if (generating) hint = t.composer.hintGenerating;

  // Drag & drop files anywhere over the chat area. The counter handles
  // dragenter/dragleave firing for every child element.
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  const onDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e) || !ready) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (ready) composerRef.current?.addFiles(Array.from(e.dataTransfer.files));
  };

  return (
    <main
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={(e) => hasFiles(e) && e.preventDefault()}
      onDrop={onDrop}
    >
      {dragging && (
        <div
          className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-[var(--coral-ring)] backdrop-blur-[2px]"
          style={{ background: "var(--scrim)" }}
          aria-hidden="true"
        >
          <span className="popover rounded-full px-5 py-2.5 text-ui">{t.attach.drop}</span>
        </div>
      )}
      {body}
      <div className="relative mx-auto w-full max-w-[var(--content-w)] px-6 pb-4">
        <Composer ref={composerRef} generating={generating} disabled={!ready} onSend={onSend} onStop={() => stop()} />
        <p className="mt-2 truncate text-center text-caption text-fg-subtle">{hint}</p>
      </div>
      {/* Screen readers hear start/finish of a reply, not every token. */}
      <div className="sr-only" aria-live="polite" role="status">
        {announcement}
      </div>
    </main>
  );
});

interface MessageListProps {
  messages: UiMessage[];
  generating: boolean;
  error: import("../lib/ipc").ErrorCode | undefined;
  stickRef: React.MutableRefObject<boolean>;
}

function MessageList({ messages, generating, error, stickRef }: MessageListProps) {
  const retry = useChats((s) => s.retry);
  const virtuoso = useRef<VirtuosoHandle>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const lastAssistantId = findLast(messages, (m) => m.role === "assistant")?.id;
  const lastMessage = messages.at(-1);

  // Auto-scroll stops as soon as the user scrolls up (wheel, keys, drag).
  useEffect(() => {
    if (!scroller) return;
    const release = () => {
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 4) stickRef.current = false;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) stickRef.current = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(e.key)) stickRef.current = false;
    };
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("keydown", onKey);
    scroller.addEventListener("pointerdown", release);
    return () => {
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("keydown", onKey);
      scroller.removeEventListener("pointerdown", release);
    };
  }, [scroller, stickRef]);

  // Follow the growing reply while sticking to the bottom.
  useEffect(() => {
    if (stickRef.current) virtuoso.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER });
  }, [lastMessage?.content, lastMessage?.id, error, stickRef]);

  const jumpToEnd = () => {
    stickRef.current = true;
    virtuoso.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "smooth" });
  };

  return (
    <div className="relative min-h-0 flex-1">
      <Virtuoso
        ref={virtuoso}
        scrollerRef={(el) => setScroller(el instanceof HTMLElement ? el : null)}
        className="h-full"
        data={messages}
        initialTopMostItemIndex={{ index: "LAST", align: "end" }}
        computeItemKey={(_, m) => m.id}
        atBottomThreshold={BOTTOM_THRESHOLD}
        atBottomStateChange={(bottom) => {
          setAtBottom(bottom);
          if (bottom) stickRef.current = true;
        }}
        followOutput={() => (stickRef.current ? "auto" : false)}
        increaseViewportBy={{ top: 600, bottom: 300 }}
        tabIndex={0}
        aria-label={t.chat.listLabel}
        components={{
          Header: () => <div className="h-6" />,
          Footer: () => (
            <div className="mx-auto w-full max-w-[var(--content-w)] px-6 pb-6">
              {error && <ErrorCard code={error} onRetry={() => void retry()} />}
            </div>
          ),
        }}
        itemContent={(index, m) => (
          <div className="mx-auto w-full max-w-[var(--content-w)] px-6" style={{ paddingBottom: "var(--message-gap)" }}>
            <MessageItem
              message={m}
              isLastAssistant={m.id === lastAssistantId}
              hasLaterMessages={index < messages.length - 1}
              busy={generating}
            />
          </div>
        )}
      />
      {!atBottom && (
        <button
          className="popover anim-pop absolute bottom-3 left-1/2 z-10 flex h-9 -translate-x-1/2 items-center gap-2 rounded-full px-4 text-ui"
          onClick={jumpToEnd}
        >
          <ArrowDown size={16} strokeWidth={1.75} aria-hidden="true" />
          {t.chat.jumpToEnd}
        </button>
      )}
    </div>
  );
}

function findLast<T>(list: T[], pred: (item: T) => boolean): T | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (item !== undefined && pred(item)) return item;
  }
  return undefined;
}
