import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PanelLeft } from "lucide-react";
import { AppIcon } from "./Brand";
import { IconButton } from "./ui/IconButton";
import { useChats } from "../store/chats";
import { t } from "../lib/i18n";
import { chatTitle } from "../lib/actions";

// Resolved lazily: outside the Tauri webview (e.g. a browser tab on the dev
// server) there is no window handle, and the UI must still render.
let cached: ReturnType<typeof getCurrentWindow> | null = null;
const appWindow = {
  get handle() {
    try {
      cached ??= getCurrentWindow();
    } catch {
      return null;
    }
    return cached;
  },
  isMaximized: () => appWindow.handle?.isMaximized() ?? Promise.resolve(false),
  onResized: (cb: () => void) => appWindow.handle?.onResized(cb) ?? Promise.resolve(() => {}),
  minimize: () => appWindow.handle?.minimize() ?? Promise.resolve(),
  toggleMaximize: () => appWindow.handle?.toggleMaximize() ?? Promise.resolve(),
  close: () => appWindow.handle?.close() ?? Promise.resolve(),
};

/** Custom 40 px Windows title bar over the chat area: chat title, drag
 *  region, minimize / maximize / close. Double-click maximizes (Tauri handles
 *  data-tauri-drag-region). With the sidebar docked, the sidebar's own header
 *  holds logo and toggle, so `showBrand` is false and they are not repeated. */
export function TitleBar({ onToggleSidebar, showBrand }: { onToggleSidebar: () => void; showBrand: boolean }) {
  const chat = useChats((s) => s.chats.find((c) => c.id === s.activeId));
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const sync = () =>
      void appWindow
        .isMaximized()
        .then(setMaximized)
        .catch(() => undefined);
    sync();
    void appWindow.onResized(sync).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, []);

  return (
    <header
      className="relative z-40 flex h-[var(--titlebar-h)] flex-none items-center select-none"
      data-tauri-drag-region
    >
      {showBrand && (
        <div className="flex items-center gap-1 pl-2" data-tauri-drag-region>
          <IconButton
            label={t.window.toggleSidebar}
            shortcut="Ctrl+B"
            side="bottom"
            className="size-8"
            onClick={onToggleSidebar}
          >
            <PanelLeft size={16} strokeWidth={1.75} />
          </IconButton>
          <AppIcon size={18} className="pointer-events-none ml-1" />
        </div>
      )}
      <div
        className={`min-w-0 flex-1 truncate text-ui text-fg-muted ${showBrand ? "px-3" : "px-6"}`}
        data-tauri-drag-region
      >
        {chat ? chatTitle(chat) : t.app.name}
      </div>
      <div className="flex h-full items-stretch">
        <button
          className="caption-btn"
          aria-label={t.window.minimize}
          title={t.window.minimize}
          onClick={() => void appWindow.minimize()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          className="caption-btn"
          aria-label={maximized ? t.window.restore : t.window.maximize}
          title={maximized ? t.window.restore : t.window.maximize}
          onClick={() => void appWindow.toggleMaximize()}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <rect x=".5" y=".5" width="9" height="9" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button
          className="caption-btn close"
          aria-label={t.window.close}
          title={t.window.close}
          onClick={() => void appWindow.close()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </header>
  );
}
