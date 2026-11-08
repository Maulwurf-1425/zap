import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as ScrollArea from "@radix-ui/react-scroll-area";
import {
  Ellipsis,
  FileDown,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { Logo } from "./Brand";
import { EngineStatus } from "./StatusPill";
import { IconButton } from "./ui/IconButton";
import { ChatListSkeleton } from "./ui/Skeleton";
import { useChats } from "../store/chats";
import { SIDEBAR_MAX, SIDEBAR_MIN, useSettings } from "../store/settings";
import { useUi } from "../store/ui";
import { api, type Chat, type ChatUsage, type SearchHit } from "../lib/ipc";
import { formatTokens, groupChats, type ChatGroups } from "../lib/format";
import { chatTitle, focusComposer } from "../lib/actions";
import { t } from "../lib/i18n";

const GROUP_ORDER: (keyof ChatGroups)[] = ["pinned", "today", "yesterday", "week", "older"];
const SEARCH_DEBOUNCE = 150;

interface SidebarProps {
  overlay: boolean;
  onNavigate: () => void;
  onToggle: () => void;
}

export function Sidebar({ overlay, onNavigate, onToggle }: SidebarProps) {
  const chats = useChats((s) => s.chats);
  const loaded = useChats((s) => s.chatsLoaded);
  const newChat = useChats((s) => s.newChat);
  const width = useSettings((s) => s.settings.sidebar_width);
  const openSettings = useUi((s) => s.openSettings);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const q = query.trim();
  // An empty query shows the grouped list; results of the previous query stay
  // visible while the next one is being fetched (no flicker).
  const hits = q ? results : null;

  // Full-text search over titles and messages (debounced).
  useEffect(() => {
    if (!q) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      api
        .searchChats(q)
        .then((res) => alive && setResults(res))
        .catch(() => alive && setResults([]));
    }, SEARCH_DEBOUNCE);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [q, chats]);

  const groups = useMemo(() => groupChats(chats), [chats]);

  return (
    <aside
      className={`relative flex h-full flex-none flex-col gap-3 bg-sidebar px-3 pb-3 backdrop-blur-[var(--glass-blur)] ${
        overlay ? "shadow-pop" : ""
      }`}
      style={{ width: overlay ? 280 : width, borderRight: "1px solid var(--border)" }}
      aria-label={t.sidebar.label}
    >
      {/* Same height as the title bar, and a drag region like it, so the
          window's top edge reads as one continuous bar. */}
      <div
        className="-mx-1 flex h-[var(--titlebar-h)] flex-none items-center justify-between pl-3"
        data-tauri-drag-region
      >
        <Logo />
        <IconButton label={t.sidebar.collapse} shortcut="Ctrl+B" side="bottom" className="size-8" onClick={onToggle}>
          <PanelLeftClose size={16} strokeWidth={1.75} />
        </IconButton>
      </div>

      <button
        className="btn btn-primary w-full"
        onClick={() => {
          newChat();
          onNavigate();
          focusComposer();
        }}
      >
        <Plus size={20} strokeWidth={1.75} />
        {t.chat.newChat}
      </button>

      <label className="relative block">
        <span className="sr-only">{t.sidebar.searchLabel}</span>
        <Search
          size={16}
          strokeWidth={1.75}
          className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-fg-subtle"
        />
        <input
          className="input h-10 pr-9 pl-10"
          placeholder={t.sidebar.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            }
          }}
        />
        {query && (
          <button
            className="absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-sm text-fg-subtle hover:bg-surface-2 hover:text-fg"
            aria-label={t.chat.cancel}
            onClick={() => setQuery("")}
          >
            <X size={14} strokeWidth={1.75} />
          </button>
        )}
      </label>

      <ScrollArea.Root className="-mx-1 min-h-0 flex-1 overflow-hidden" type="hover">
        <ScrollArea.Viewport className="h-full w-full px-1 [&>div]:!block">
          <nav aria-label={t.sidebar.label}>
            {!loaded ? (
              <ChatListSkeleton />
            ) : hits ? (
              <SearchResults hits={hits} onNavigate={onNavigate} />
            ) : chats.length === 0 ? (
              <p className="px-3 py-2 text-caption text-fg-muted">{t.sidebar.noChats}</p>
            ) : (
              GROUP_ORDER.map((key) =>
                groups[key].length > 0 ? (
                  <section key={key} className="mb-3" aria-label={t.sidebar.groups[key]}>
                    <h3 className="px-3 pt-1 pb-1.5 text-caption text-fg-subtle">{t.sidebar.groups[key]}</h3>
                    <ul className="flex flex-col gap-0.5">
                      {groups[key].map((chat) => (
                        <ChatItem key={chat.id} chat={chat} onNavigate={onNavigate} />
                      ))}
                    </ul>
                  </section>
                ) : null,
              )
            )}
          </nav>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical" className="flex w-2 touch-none p-0.5 select-none">
          <ScrollArea.Thumb className="relative flex-1 rounded-full bg-surface-3" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>

      <div className="flex items-end gap-2 border-t border-border pt-3">
        <div className="min-w-0 flex-1">
          <EngineStatus />
        </div>
        <IconButton label={t.sidebar.settings} shortcut="Ctrl+," onClick={() => openSettings()}>
          <Settings size={20} strokeWidth={1.75} />
        </IconButton>
      </div>

      {!overlay && <ResizeHandle />}
    </aside>
  );
}

function SearchResults({ hits, onNavigate }: { hits: SearchHit[]; onNavigate: () => void }) {
  const select = useChats((s) => s.select);
  const activeId = useChats((s) => s.activeId);
  if (hits.length === 0) return <p className="px-3 py-2 text-caption text-fg-muted">{t.sidebar.noResults}</p>;
  return (
    <section aria-label={t.sidebar.groups.results}>
      <h3 className="px-3 pt-1 pb-1.5 text-caption text-fg-subtle">{t.sidebar.groups.results}</h3>
      <ul className="flex flex-col gap-0.5">
        {hits.map(({ chat, snippet }) => (
          <li key={chat.id}>
            <button
              className={`flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors ${
                chat.id === activeId ? "bg-surface-3" : "hover:bg-surface-2"
              }`}
              onClick={() => {
                void select(chat.id);
                onNavigate();
              }}
            >
              <span className="truncate text-ui">{chatTitle(chat)}</span>
              {snippet && <span className="line-clamp-2 text-caption text-fg-muted">{snippet}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Drag (or arrow keys) to resize between 240 and 360 px. */
function ResizeHandle() {
  const width = useSettings((s) => s.settings.sidebar_width);
  const update = useSettings((s) => s.update);
  const [active, setActive] = useState(false);

  const clamp = (w: number) => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)));

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    setActive(true);
    const move = (ev: PointerEvent) => void update({ sidebar_width: clamp(startW + ev.clientX - startX) }, false);
    const up = () => {
      setActive(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      void update({}, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 40 : 10;
    if (e.key === "ArrowLeft") void update({ sidebar_width: clamp(width - step) });
    else if (e.key === "ArrowRight") void update({ sidebar_width: clamp(width + step) });
    else return;
    e.preventDefault();
  };

  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={t.sidebar.resize}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width}
      tabIndex={0}
      data-active={active}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => void update({ sidebar_width: 280 })}
    />
  );
}

const ChatItem = memo(function ChatItem({ chat, onNavigate }: { chat: Chat; onNavigate: () => void }) {
  const active = useChats((s) => s.activeId === chat.id);
  const generating = useChats((s) => Boolean(s.generating[chat.id]));
  const select = useChats((s) => s.select);
  const rename = useChats((s) => s.rename);
  const pin = useChats((s) => s.pin);
  const exportChat = useChats((s) => s.exportChat);
  const remove = useChats((s) => s.remove);
  const askConfirm = useUi((s) => s.askConfirm);
  const [menuOpen, setMenuOpen] = useState(false);
  const [usage, setUsage] = useState<ChatUsage | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chat.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // Fresh token count each time the menu opens (also via right-click).
  useEffect(() => {
    if (!menuOpen) return;
    let alive = true;
    void api
      .chatUsage(chat.id)
      .then((u) => alive && setUsage(u))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [menuOpen, chat.id]);
  const commitRename = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== chat.title) void rename(chat.id, draft);
  };

  if (editing) {
    return (
      <li>
        <input
          ref={inputRef}
          className="input h-[var(--chat-item-h)]"
          value={draft}
          aria-label={t.sidebar.renameLabel}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(chat.title);
              setEditing(false);
            }
          }}
        />
      </li>
    );
  }

  return (
    <li>
      <div
        className={`group relative flex h-[var(--chat-item-h)] items-center rounded-md transition-colors duration-[var(--dur-hover)] ${
          active ? "bg-surface-3" : "hover:bg-surface-2"
        }`}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
      >
        {active && (
          <span className="absolute top-2.5 bottom-2.5 left-0 w-[3px] rounded-full bg-coral" aria-hidden="true" />
        )}
        <button
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pr-10 pl-3.5 text-left text-ui"
          onClick={() => {
            void select(chat.id);
            onNavigate();
          }}
          aria-current={active ? "page" : undefined}
        >
          {chat.pinned && <Pin size={13} strokeWidth={1.75} className="flex-none text-fg-subtle" aria-hidden="true" />}
          <span className="truncate">{chatTitle(chat)}</span>
          {generating && (
            <span className="status-dot pulse ml-auto bg-coral" role="img" aria-label={t.sidebar.generating} />
          )}
        </button>

        <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <button
              className={`btn btn-icon absolute right-1 size-9 ${
                menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              }`}
              aria-label={t.sidebar.options(chatTitle(chat))}
            >
              <Ellipsis size={16} strokeWidth={1.75} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={4} className="popover anim-pop z-50 w-60 rounded-md p-1">
              <ChatUsageLabel usage={usage} />
              <DropdownMenu.Separator className="mx-1 my-1 h-px bg-border" />
              <DropdownMenu.Item
                className="menu-item"
                onSelect={() => {
                  setDraft(chat.title);
                  // Let the menu close (and return focus) before focusing the input.
                  window.setTimeout(() => setEditing(true), 0);
                }}
              >
                <Pencil size={16} strokeWidth={1.75} /> {t.sidebar.rename}
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" onSelect={() => void pin(chat.id, !chat.pinned)}>
                {chat.pinned ? <PinOff size={16} strokeWidth={1.75} /> : <Pin size={16} strokeWidth={1.75} />}
                {chat.pinned ? t.sidebar.unpin : t.sidebar.pin}
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" onSelect={() => void exportChat(chat.id)}>
                <FileDown size={16} strokeWidth={1.75} /> {t.sidebar.exportMd}
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="mx-1 my-1 h-px bg-border" />
              <DropdownMenu.Item
                className="menu-item"
                onSelect={() =>
                  askConfirm({
                    title: t.sidebar.deleteTitle,
                    message: t.sidebar.deleteBody,
                    confirmLabel: t.sidebar.deleteConfirm,
                    onConfirm: () => remove(chat.id),
                  })
                }
              >
                <Trash2 size={16} strokeWidth={1.75} className="text-danger" /> {t.sidebar.delete}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </li>
  );
});

/** Token usage of one chat, shown at the top of its "…" menu. */
function ChatUsageLabel({ usage }: { usage: ChatUsage | null }) {
  const total = usage ? usage.prompt_tokens + usage.completion_tokens : 0;
  return (
    <DropdownMenu.Label className="flex flex-col gap-0.5 px-2.5 py-2" aria-live="polite">
      {usage === null ? (
        <span className="skeleton h-4 w-32" aria-hidden="true" />
      ) : total === 0 ? (
        <span className="text-caption text-fg-muted">{t.usage.chatNone}</span>
      ) : (
        <>
          <span className="text-ui">{t.usage.chat(formatTokens(total))}</span>
          <span className="text-caption text-fg-muted">
            {t.usage.chatDetail(formatTokens(usage.prompt_tokens), formatTokens(usage.completion_tokens))}
          </span>
        </>
      )}
    </DropdownMenu.Label>
  );
}
