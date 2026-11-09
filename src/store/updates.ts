import { create } from "zustand";
import { toast } from "sonner";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import changelog from "../../CHANGELOG.md?raw";
import { parseChangelog, parseUpdateBody, type ReleaseNotes } from "../lib/changelog";
import { api } from "../lib/ipc";
import { t } from "../lib/i18n";
import { useSettings } from "./settings";

export type UpdateStatus = "idle" | "checking" | "none" | "available" | "downloading" | "error";

/** What the "What's new" dialog shows: an available update or the running version. */
export interface WhatsNew {
  notes: ReleaseNotes;
  pending: boolean;
}

interface UpdatesState {
  status: UpdateStatus;
  /** Notes of the available update (version, optional name, text). */
  available: ReleaseNotes | null;
  /** Download progress 0–1, `null` while the size is unknown. */
  progress: number | null;
  whatsNew: WhatsNew | null;
  /** Looks for a new release; `silent` skips the "up to date" / error feedback. */
  check: (silent?: boolean) => Promise<void>;
  /** Downloads, installs and restarts ZAP. */
  install: () => Promise<void>;
  /** Opens notes for the available update, or for the running version. */
  showWhatsNew: (pending: boolean) => Promise<void>;
  closeWhatsNew: () => void;
  /** After an update: shows the new version's notes once. */
  greetNewVersion: () => Promise<void>;
}

let pending: Update | null = null;

/** "0.3.1" or "0.3.1 „Fancyness Update"" for messages. */
export function releaseLabel(notes: ReleaseNotes): string {
  return notes.name ? t.updates.named(notes.version, notes.name) : notes.version;
}

async function currentNotes(): Promise<ReleaseNotes | null> {
  const { version } = await api.appInfo();
  return parseChangelog(changelog).find((e) => e.version === version) ?? null;
}

export const useUpdates = create<UpdatesState>((set, get) => ({
  status: "idle",
  available: null,
  progress: null,
  whatsNew: null,

  check: async (silent = false) => {
    if (get().status === "checking" || get().status === "downloading") return;
    set({ status: "checking" });
    try {
      pending = await check();
      if (!pending) {
        set({ status: "none", available: null });
        return;
      }
      const notes = parseUpdateBody(pending.version, pending.body);
      set({ status: "available", available: notes });
      if (silent) {
        toast(t.updates.available(releaseLabel(notes)), {
          duration: Infinity,
          action: { label: t.updates.install, onClick: () => void get().install() },
          cancel: { label: t.updates.whatsNew, onClick: () => void get().showWhatsNew(true) },
        });
      }
    } catch {
      set({ status: silent ? "idle" : "error" });
    }
  },

  install: async () => {
    if (!pending || get().status === "downloading") return;
    let total = 0;
    let done = 0;
    set({ status: "downloading", progress: null, whatsNew: null });
    try {
      await pending.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") {
          done += event.data.chunkLength;
          if (total > 0) set({ progress: Math.min(done / total, 1) });
        }
      });
      await relaunch();
    } catch {
      set({ status: "available", progress: null });
      toast(t.updates.failed);
    }
  },

  showWhatsNew: async (pendingUpdate) => {
    const available = get().available;
    if (pendingUpdate && available) {
      set({ whatsNew: { notes: available, pending: true } });
      return;
    }
    const notes = await currentNotes().catch(() => null);
    if (notes) set({ whatsNew: { notes, pending: false } });
  },

  closeWhatsNew: () => set({ whatsNew: null }),

  greetNewVersion: async () => {
    const { settings, update } = useSettings.getState();
    const { version } = await api.appInfo();
    if (settings.last_seen_version === version) return;
    // Fresh installs skip the greeting (onboarding explains ZAP instead).
    if (settings.onboarding_done) {
      const notes = parseChangelog(changelog).find((e) => e.version === version);
      if (notes) set({ whatsNew: { notes, pending: false } });
    }
    await update({ last_seen_version: version });
  },
}));
