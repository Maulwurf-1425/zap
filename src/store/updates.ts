import { create } from "zustand";
import { toast } from "sonner";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { t } from "../lib/i18n";

export type UpdateStatus = "idle" | "checking" | "none" | "available" | "downloading" | "error";

interface UpdatesState {
  status: UpdateStatus;
  /** Version of the available update. */
  version: string | null;
  /** Download progress 0–1, `null` while the size is unknown. */
  progress: number | null;
  /** Looks for a new release; `silent` skips the "up to date" / error feedback. */
  check: (silent?: boolean) => Promise<void>;
  /** Downloads, installs and restarts ZAP. */
  install: () => Promise<void>;
}

let pending: Update | null = null;

export const useUpdates = create<UpdatesState>((set, get) => ({
  status: "idle",
  version: null,
  progress: null,

  check: async (silent = false) => {
    if (get().status === "checking" || get().status === "downloading") return;
    set({ status: "checking" });
    try {
      pending = await check();
      if (!pending) {
        set({ status: "none", version: null });
        return;
      }
      set({ status: "available", version: pending.version });
      if (silent) {
        toast(t.updates.available(pending.version), {
          duration: Infinity,
          action: { label: t.updates.install, onClick: () => void get().install() },
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
    set({ status: "downloading", progress: null });
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
}));
