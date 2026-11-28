import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Toaster } from "sonner";
import { listen } from "@tauri-apps/api/event";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { focusComposer } from "./lib/actions";
import { ChatView, type ChatViewHandle } from "./components/ChatView";
import { SettingsDialog } from "./components/SettingsDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { WhatsNewDialog } from "./components/WhatsNewDialog";
import { Onboarding } from "./components/Onboarding";
import { CommandPalette } from "./components/CommandPalette";
import { ZapEditor, ZapView } from "./components/ZapView";
import { ResourceMonitor } from "./components/ResourceMonitor";
import { CompareView } from "./components/CompareView";
import { useCompare } from "./store/compare";
import { useChats } from "./store/chats";
import { sameModel, useModels } from "./store/models";
import { useProviders } from "./store/providers";
import { applySettingsAppearance, useSettings } from "./store/settings";
import { isOverlayOpen, useUi } from "./store/ui";
import { useUpdates } from "./store/updates";
import { useVoice } from "./store/voice";
import { useDiscord } from "./store/discord";
import { useZaps } from "./store/zaps";
import { watchSystemTheme } from "./lib/theme";
import { isRecordingShortcut, matches, shortcutFor, type ShortcutAction } from "./lib/shortcuts";

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
  const zapOpen = useZaps((s) => s.openId !== null);
  const compareOpen = useUi((s) => s.compareOpen);

  // Boot once (guarded so StrictMode can't register listeners twice).
  useEffect(() => {
    if (booted) return;
    booted = true;
    void (async () => {
      await useSettings.getState().load();
      await Promise.all([
        useProviders.getState().init(),
        useModels.getState().init(),
        useChats.getState().init(),
        useZaps.getState().init(),
        useCompare.getState().init(),
      ]);
      void useDiscord
        .getState()
        .init()
        .catch(() => undefined);
      void useVoice
        .getState()
        .init()
        .catch(() => undefined);
      void listen<{ chat_id: string }>("quick://open-chat", (e) => {
        void useChats
          .getState()
          .reload()
          .then(() => useChats.getState().select(e.payload.chat_id));
      });
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

              {compareOpen ? <CompareView /> : zapOpen ? <ZapView /> : <ChatView ref={chatView} />}
            </div>
          </div>
        </div>

        <SettingsDialog />
        <ZapEditor />
        <ConfirmDialog />
        <WhatsNewDialog />
        <Onboarding />
        <CommandPalette onToggleSidebar={toggleSidebar} />
        <ResourceMonitor />
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

/** Global keyboard shortcuts (changeable in Settings → General, see lib/shortcuts). */
function useShortcuts(toggleSidebar: () => void) {
  // The resource monitor works anywhere (even in dialogs), and F5 never
  // reloads the window.
  useEffect(() => {
    const onMonitor = (e: KeyboardEvent) => {
      if (isRecordingShortcut()) return;
      const hit = matches(e, shortcutFor(useSettings.getState().settings, "monitor"));
      if (!hit && e.key !== "F5") return;
      e.preventDefault();
      e.stopPropagation();
      if (hit && !e.repeat) useUi.getState().toggleMonitor();
    };
    window.addEventListener("keydown", onMonitor, true);
    return () => window.removeEventListener("keydown", onMonitor, true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isRecordingShortcut()) return;
      const ui = useUi.getState();
      const chats = useChats.getState();
      const settings = useSettings.getState().settings;
      const is = (action: ShortcutAction) => matches(e, shortcutFor(settings, action));

      if (is("palette")) {
        e.preventDefault();
        ui.setPaletteOpen(!ui.paletteOpen);
        return;
      }
      // Everything else backs off while a dialog owns the keyboard.
      if (isOverlayOpen()) return;

      if (is("newChat")) {
        e.preventDefault();
        chats.newChat();
        focusComposer();
      } else if (is("sidebar")) {
        e.preventDefault();
        toggleSidebar();
      } else if (is("settings")) {
        e.preventDefault();
        ui.openSettings();
      } else if (is("copyLast")) {
        e.preventDefault();
        void chats.copyLastReply();
      } else if (is("prevChat") || is("nextChat")) {
        e.preventDefault();
        chats.selectRelative(is("prevChat") ? -1 : 1);
      } else if (e.key === "Escape") {
        if (ui.drawerOpen) ui.setDrawerOpen(false);
        else if (chats.activeId && chats.generating[chats.activeId]) chats.stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);
}
