import { create } from "zustand";
import { useUpdates } from "./updates";

export type SettingsTab =
  "general" | "appearance" | "models" | "chat" | "voice" | "usage" | "web" | "files" | "data" | "about";

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
}

interface UiState {
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  paletteOpen: boolean;
  onboardingOpen: boolean;
  confirm: ConfirmRequest | null;
  /** Overlay drawer state on narrow windows. */
  drawerOpen: boolean;
  /** Screen-reader announcement for the streaming live region. */
  announcement: string;

  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setSettingsTab: (tab: SettingsTab) => void;
  setPaletteOpen: (open: boolean) => void;
  setOnboardingOpen: (open: boolean) => void;
  askConfirm: (req: ConfirmRequest) => void;
  closeConfirm: () => void;
  setDrawerOpen: (open: boolean) => void;
  announce: (text: string) => void;
}

export const useUi = create<UiState>((set) => ({
  settingsOpen: false,
  settingsTab: "general",
  paletteOpen: false,
  onboardingOpen: false,
  confirm: null,
  drawerOpen: false,
  announcement: "",

  openSettings: (tab) => set((s) => ({ settingsOpen: true, settingsTab: tab ?? s.settingsTab, paletteOpen: false })),
  closeSettings: () => set({ settingsOpen: false }),
  setSettingsTab: (settingsTab) => set({ settingsTab }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setOnboardingOpen: (onboardingOpen) => set({ onboardingOpen }),
  askConfirm: (confirm) => set({ confirm }),
  closeConfirm: () => set({ confirm: null }),
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  // Clear first so repeating the same text is announced again.
  announce: (text) => {
    set({ announcement: "" });
    requestAnimationFrame(() => set({ announcement: text }));
  },
}));

/** True while any dialog owns the keyboard (global shortcuts back off). */
export function isOverlayOpen(): boolean {
  const s = useUi.getState();
  return (
    s.settingsOpen || s.paletteOpen || s.onboardingOpen || s.confirm !== null || useUpdates.getState().whatsNew !== null
  );
}
