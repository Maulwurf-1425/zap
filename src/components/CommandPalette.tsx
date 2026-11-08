import { useEffect, useState } from "react";
import { Command } from "cmdk";
import { Copy, Cpu, Languages, MessageSquare, Monitor, Moon, PanelLeft, Plus, Settings, Sun } from "lucide-react";
import { chatTitle, focusComposer } from "../lib/actions";
import { useChats } from "../store/chats";
import { useModels } from "../store/models";
import { useSettings } from "../store/settings";
import { useUi } from "../store/ui";
import { api, type SearchHit, type ThemeMode } from "../lib/ipc";
import { engineName, t, type Language } from "../lib/i18n";

const ICON = { size: 16, strokeWidth: 1.75, "aria-hidden": true } as const;

/** Ctrl+K: search chats (incl. message content via FTS) and run actions. */
export function CommandPalette({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const openSettings = useUi((s) => s.openSettings);
  const chats = useChats((s) => s.chats);
  const select = useChats((s) => s.select);
  const newChat = useChats((s) => s.newChat);
  const copyLastReply = useChats((s) => s.copyLastReply);
  const setChatModel = useChats((s) => s.setChatModel);
  const installed = useModels((s) => s.installed);
  const update = useSettings((s) => s.update);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const q = query.trim();
  const hits = q.length >= 2 ? results : [];

  useEffect(() => {
    if (q.length < 2) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void api
        .searchChats(q)
        .then((res) => alive && setResults(res))
        .catch(() => undefined);
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [q]);

  const setPaletteOpen = (next: boolean) => {
    if (!next) setQuery("");
    setOpen(next);
  };

  const run = (fn: () => void) => {
    setPaletteOpen(false);
    fn();
  };

  // Message-content hits that the local title filter would not find.
  const contentHits = hits.filter((h) => h.snippet && !chatTitle(h.chat).toLowerCase().includes(q.toLowerCase()));
  const themes: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
    { value: "dark", label: t.settings.appearance.dark, icon: <Moon {...ICON} /> },
    { value: "light", label: t.settings.appearance.light, icon: <Sun {...ICON} /> },
    { value: "system", label: t.settings.appearance.system, icon: <Monitor {...ICON} /> },
  ];
  const languages: { value: Language; label: string }[] = [
    { value: "en", label: t.settings.general.languages.en },
    { value: "de", label: t.settings.general.languages.de },
  ];

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setPaletteOpen}
      label={t.palette.label}
      overlayClassName="anim-fade fixed inset-0 z-50 backdrop-blur-[6px] bg-[var(--scrim)]"
      contentClassName="popover anim-pop fixed top-[14vh] left-1/2 z-50 w-[calc(100vw-48px)] max-w-[600px] -translate-x-1/2 overflow-hidden rounded-xl"
    >
      <Command.Input
        value={query}
        onValueChange={setQuery}
        placeholder={t.palette.placeholder}
        className="h-14 w-full border-b border-border bg-transparent px-5 text-body text-fg outline-none placeholder:text-fg-subtle"
      />
      <Command.List className="max-h-[52vh] overflow-y-auto p-2">
        <Command.Empty className="px-3 py-6 text-center text-ui font-normal text-fg-muted">
          {t.palette.empty}
        </Command.Empty>

        <Command.Group heading={t.palette.actions} className="palette-group">
          <Command.Item
            className="menu-item"
            onSelect={() =>
              run(() => {
                newChat();
                focusComposer();
              })
            }
          >
            <Plus {...ICON} /> {t.palette.newChat}
            <span className="kbd ml-auto">Ctrl+N</span>
          </Command.Item>
          <Command.Item className="menu-item" onSelect={() => run(() => openSettings())}>
            <Settings {...ICON} /> {t.palette.settings}
            <span className="kbd ml-auto">Ctrl+,</span>
          </Command.Item>
          <Command.Item className="menu-item" onSelect={() => run(onToggleSidebar)}>
            <PanelLeft {...ICON} /> {t.palette.toggleSidebar}
            <span className="kbd ml-auto">Ctrl+B</span>
          </Command.Item>
          <Command.Item className="menu-item" onSelect={() => run(() => void copyLastReply())}>
            <Copy {...ICON} /> {t.palette.copyLast}
            <span className="kbd ml-auto">Ctrl+Shift+C</span>
          </Command.Item>
        </Command.Group>

        {installed.length > 0 && (
          <Command.Group heading={t.palette.models} className="palette-group">
            {installed.map((m) => (
              <Command.Item
                key={m.id}
                value={`model ${m.id}`}
                className="menu-item"
                onSelect={() => run(() => setChatModel(m.id))}
              >
                <Cpu {...ICON} /> <span className="min-w-0 flex-1 truncate">{m.name}</span>
                <span className="text-caption font-normal text-fg-muted">{engineName(m.provider)}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        <Command.Group heading={t.palette.themes} className="palette-group">
          {themes.map((th) => (
            <Command.Item
              key={th.value}
              value={`theme ${th.label}`}
              className="menu-item"
              onSelect={() => run(() => void update({ theme: th.value }))}
            >
              {th.icon} {t.palette.theme(th.label)}
            </Command.Item>
          ))}
        </Command.Group>

        <Command.Group heading={t.palette.languages} className="palette-group">
          {languages.map((l) => (
            <Command.Item
              key={l.value}
              value={`language ${l.label}`}
              className="menu-item"
              onSelect={() => run(() => void update({ language: l.value }))}
            >
              <Languages {...ICON} /> {t.palette.language(l.label)}
            </Command.Item>
          ))}
        </Command.Group>

        {chats.length > 0 && (
          <Command.Group heading={t.palette.chats} className="palette-group">
            {chats.slice(0, 50).map((c) => (
              <Command.Item
                key={c.id}
                value={`chat ${c.id} ${chatTitle(c)}`}
                className="menu-item"
                onSelect={() => run(() => void select(c.id))}
              >
                <MessageSquare {...ICON} />
                <span className="truncate">{chatTitle(c)}</span>
              </Command.Item>
            ))}
            {contentHits.map((h) => (
              <Command.Item
                key={`hit-${h.chat.id}`}
                value={`hit ${h.chat.id} ${chatTitle(h.chat)}`}
                keywords={[query]}
                className="menu-item h-auto py-2"
                onSelect={() => run(() => void select(h.chat.id))}
              >
                <MessageSquare {...ICON} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{chatTitle(h.chat)}</span>
                  <span className="truncate text-caption font-normal text-fg-muted">{h.snippet}</span>
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  );
}
