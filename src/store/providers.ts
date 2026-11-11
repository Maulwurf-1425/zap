import { create } from "zustand";
import { toast } from "sonner";
import {
  api,
  events,
  PROVIDERS,
  type EngineInstallEvent,
  type InstallPhase,
  type ProviderKind,
  type ProviderStatus,
  type Statuses,
} from "../lib/ipc";
import { engineName, t } from "../lib/i18n";

export interface EngineInstall {
  phase: InstallPhase;
  downloaded: number | null;
  total: number | null;
  /** Smoothed download speed in bytes/s. */
  speed: number | null;
  /** When the install and the current phase began (ms). */
  startedAt: number;
  phaseAt: number;
  /** Last size sample, for the speed. */
  sampleAt: number;
}

const PHASE_ORDER: InstallPhase[] = ["preparing", "downloading", "installing", "starting", "done"];

/** Applies an install event. Phases only move forward (a late download sample
 *  never pulls the UI back), and the speed is smoothed over samples. */
export function nextInstall(
  prev: EngineInstall | undefined,
  e: Pick<EngineInstallEvent, "phase" | "downloaded" | "total">,
  now = Date.now(),
): EngineInstall | undefined {
  const fresh = !prev || prev.phase === "done" || prev.phase === "failed";
  if (fresh) {
    if (e.phase !== "preparing") return prev;
    return {
      phase: "preparing",
      downloaded: null,
      total: null,
      speed: null,
      startedAt: now,
      phaseAt: now,
      sampleAt: now,
    };
  }
  if (e.phase !== "failed" && PHASE_ORDER.indexOf(e.phase) < PHASE_ORDER.indexOf(prev.phase)) return prev;
  const phaseAt = e.phase === prev.phase ? prev.phaseAt : now;
  let speed = prev.speed;
  if (e.phase === "downloading" && e.downloaded !== null && prev.downloaded !== null && now > prev.sampleAt) {
    const current = Math.max(0, ((e.downloaded - prev.downloaded) * 1000) / (now - prev.sampleAt));
    speed = speed === null ? current : speed * 0.7 + current * 0.3;
  }
  return {
    ...prev,
    phase: e.phase,
    phaseAt,
    downloaded: e.downloaded ?? prev.downloaded,
    total: e.total ?? prev.total,
    speed,
    sampleAt: e.downloaded !== null ? now : prev.sampleAt,
  };
}

interface ProvidersState {
  statuses: Statuses;
  /** Whether ZAP can install engines itself (winget); `null` until known. */
  canInstall: boolean | null;
  /** Running or finished installs, per engine. */
  installs: Partial<Record<ProviderKind, EngineInstall>>;
  init: () => Promise<void>;
  start: (kind: ProviderKind) => Promise<void>;
  /** Stops the engine's server and starts it again. */
  restart: (kind: ProviderKind) => Promise<void>;
  install: (kind: ProviderKind) => Promise<void>;
}

export const useProviders = create<ProvidersState>((set, get) => ({
  statuses: { ollama: "starting", lmstudio: "disabled" },
  canInstall: null,
  installs: {},

  init: async () => {
    await Promise.all([
      events.onProviderStatus(({ provider, status }) => set({ statuses: { ...get().statuses, [provider]: status } })),
      events.onEngineInstall((e) =>
        set({ installs: { ...get().installs, [e.provider]: nextInstall(get().installs[e.provider], e) } }),
      ),
    ]);
    try {
      set({ statuses: await api.providerStatus() });
    } catch {
      // Keep defaults; status events follow.
    }
    void api
      .engineInstallSupported()
      .then((canInstall) => set({ canInstall }))
      .catch(() => set({ canInstall: false }));
  },

  start: async (kind) => {
    set({ statuses: { ...get().statuses, [kind]: "starting" } });
    try {
      const status = await api.providerStart(kind);
      set({ statuses: { ...get().statuses, [kind]: status } });
    } catch {
      set({ statuses: { ...get().statuses, [kind]: "stopped" } });
    }
  },

  restart: async (kind) => {
    set({ statuses: { ...get().statuses, [kind]: "starting" } });
    try {
      const status = await api.providerRestart(kind);
      set({ statuses: { ...get().statuses, [kind]: status } });
      toast(status === "running" ? t.engines.restarted(engineName(kind)) : t.engines.restartFailed(engineName(kind)));
    } catch {
      set({ statuses: { ...get().statuses, [kind]: "stopped" } });
      toast(t.engines.restartFailed(engineName(kind)));
    }
  },

  install: async (kind) => {
    const current = get().installs[kind]?.phase;
    if (current && current !== "done" && current !== "failed") return;
    set({
      installs: {
        ...get().installs,
        [kind]: nextInstall(undefined, { phase: "preparing", downloaded: null, total: null }),
      },
    });
    try {
      const status = await api.installEngine(kind);
      set({
        statuses: { ...get().statuses, [kind]: status },
        installs: {
          ...get().installs,
          [kind]: nextInstall(get().installs[kind], { phase: "done", downloaded: null, total: null }),
        },
      });
      toast(t.engines.installed(engineName(kind)));
      if (kind === "lmstudio") toast(t.engines.lmstudioFirstRun, { duration: 10_000 });
    } catch {
      const prev = get().installs[kind];
      if (prev) set({ installs: { ...get().installs, [kind]: { ...prev, phase: "failed" } } });
    }
  },
}));

/** Providers the user turned on. */
export function enabledProviders(statuses: Statuses): ProviderKind[] {
  return PROVIDERS.filter((p) => statuses[p] !== "disabled");
}

export function anyRunning(statuses: Statuses): boolean {
  return PROVIDERS.some((p) => statuses[p] === "running");
}

/** The enabled provider whose (non-running) state the UI should explain:
 *  a starting one first, then the first enabled one. */
export function primaryProvider(statuses: Statuses): { kind: ProviderKind; status: ProviderStatus } | null {
  const enabled = enabledProviders(statuses);
  const starting = enabled.find((p) => statuses[p] === "starting");
  const kind = starting ?? enabled[0];
  return kind ? { kind, status: statuses[kind] } : null;
}
