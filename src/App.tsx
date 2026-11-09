import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Toaster } from "sonner";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { focusComposer } from "./lib/actions";
import { ChatView, type ChatViewHandle } from "./components/ChatView";
import { SettingsDialog } from "./components/SettingsDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { WhatsNewDialog } from "./components/WhatsNewDialog";
import { Onboarding } from "./components/Onboarding";
import { CommandPalette } from "./components/CommandPalette";
import { useChats } from "./store/chats";
import { sameModel, useModels } from "./store/models";
import { useProviders } from "./store/providers";
import { applySettingsAppearance, useSettings } from "./store/settings";
import { isOverlayOpen, useUi } from "./store/ui";
import { useUpdates } from "./store/updates";
import { watchSystemTheme } from "./lib/theme";

const COLLAPSE_BELOW = 1000;
let booted = false;

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < COLLAPSE_BELOW);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${COLLAPSE_BELOW - 1}px)`);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

export default function App() {
  const statusKey = useProviders((s) => `${s.statuses.ollama}|${s.statuses.lmstudio}`);
  const language = useSettings((s) => s.settings.language);
  const collapsed = useSettings((s) => s.settings.sidebar_collapsed);
  const updateSettings = useSettings((s) => s.update);
  const drawerOpen = useUi((s) => s.drawerOpen);
  const setDrawerOpen = useUi((s) => s.setDrawerOpen);
  const narrow = useNarrow();
  const chatView = useRef<ChatViewHandle>(null);

  // Boot once (guarded so StrictMode can't register listeners twice).
  useEffect(() => {
    if (booted) return;
    booted = true;
    void (async () => {
      await useSettings.getState().load();
      await Promise.all([useProviders.getState().init(), useModels.getState().init(), useChats.getState().init()]);
      if (!useSettings.getState().settings.onboarding_done) useUi.getState().setOnboardingOpen(true);
      void useUpdates
        .getState()
        .greetNewVersion()
        .catch(() => undefined);
      if (useSettings.getState().settings.auto_update && !import.meta.env.DEV) {
        void useUpdates.getState().check(true);
      }
    })();
  }, []);

  // Follow Windows light/dark while in System mode.
  useEffect(
    () =>
      watchSystemTheme(
        () => useSettings.getState().settings.theme,
        () => {
          applySettingsAppearance(useSettings.getState().settings);
        },
      ),
    [],
  );

  // Whenever an engine comes up or goes away, refresh the model list and
  // apply the default model.
  useEffect(() => {
    void (async () => {
      await useModels.getState().refresh();
      const preferred = useSettings.getState().settings.default_model;
      const match =
        preferred &&
        useModels
          .getState()
          .installed.find((m) => m.id === preferred || (m.provider === "ollama" && sameModel(m.name, preferred)));
      if (match && !useChats.getState().activeId) useModels.getState().select(match.id);
    })();
  }, [statusKey]);

  useEffect(() => {
    if (!narrow) setDrawerOpen(false);
  }, [narrow, setDrawerOpen]);

  const toggleSidebar = useCallback(() => {
    if (narrow) setDrawerOpen(!useUi.getState().drawerOpen);
    else void updateSettings({ sidebar_collapsed: !useSettings.getState().settings.sidebar_collapsed });
  }, [narrow, setDrawerOpen, updateSettings]);

  useShortcuts(toggleSidebar);

  const closeOnNavigate = () => {
    if (narrow) setDrawerOpen(false);
  };
  const showDocked = !narrow && !collapsed;

  return (
    <Tooltip.Provider delayDuration={500} skipDelayDuration={200}>
      {/* Remount on language change so every string re-renders; app state
          lives in the stores and survives. */}
      <Fragment key={language}>
        {/* Docked: the sidebar runs to the top edge and its header is the
            title bar's left part. Otherwise the title bar spans the window. */}
        <div className="relative flex h-full">
          {showDocked && <Sidebar overlay={false} onNavigate={closeOnNavigate} onToggle={toggleSidebar} />}
          <div className="relative flex min-w-0 flex-1 flex-col">
            <TitleBar onToggleSidebar={toggleSidebar} showBrand={!showDocked} />
            <div className="relative flex min-h-0 flex-1">
              {narrow && drawerOpen && (
                <>
                  <div
                    className="anim-fade fixed inset-0 top-[var(--titlebar-h)] z-30"
                    data-state="open"
                    style={{ background: "var(--scrim)" }}
                    onClick={() => setDrawerOpen(false)}
                    aria-hidden="true"
                  />
                  <div className="anim-pop fixed bottom-0 left-0 top-[var(--titlebar-h)] z-30" data-state="open">
                    <Sidebar overlay onNavigate={closeOnNavigate} onToggle={toggleSidebar} />
                  </div>
                </>
              )}

              <ChatView ref={chatView} />
            </div>
          </div>
        </div>

        <SettingsDialog />
        <ConfirmDialog />
        <WhatsNewDialog />
        <Onboarding />
        <CommandPalette onToggleSidebar={toggleSidebar} />
      </Fragment>
      <Toaster
        position="bottom-center"
        duration={4000}
        offset={96}
        toastOptions={{ unstyled: true, classNames: { toast: "zap-toast" } }}
      />
    </Tooltip.Provider>
  );
}

/** Global keyboard shortcuts (see lib/i18n → shortcuts). */
function useShortcuts(toggleSidebar: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      const chats = useChats.getState();
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (ctrl && key === "k") {
        e.preventDefault();
        ui.setPaletteOpen(!ui.paletteOpen);
        return;
      }
      // Everything else backs off while a dialog owns the keyboard.
      if (isOverlayOpen()) return;

      if (ctrl && !e.shiftKey && key === "n") {
        e.preventDefault();
        chats.newChat();
        focusComposer();
      } else if (ctrl && key === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (ctrl && e.key === ",") {
        e.preventDefault();
        ui.openSettings();
      } else if (ctrl && e.shiftKey && key === "c") {
        e.preventDefault();
        void chats.copyLastReply();
      } else if (ctrl && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        chats.selectRelative(e.key === "ArrowUp" ? -1 : 1);
      } else if (e.key === "Escape") {
        if (ui.drawerOpen) ui.setDrawerOpen(false);
        else if (chats.activeId && chats.generating[chats.activeId]) chats.stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);
}
