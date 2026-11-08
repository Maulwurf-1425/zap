import { create } from "zustand";
import { api, events, PROVIDERS, type ProviderKind, type ProviderStatus, type Statuses } from "../lib/ipc";

interface ProvidersState {
  statuses: Statuses;
  init: () => Promise<void>;
  start: (kind: ProviderKind) => Promise<void>;
}

export const useProviders = create<ProvidersState>((set, get) => ({
  statuses: { ollama: "starting", lmstudio: "disabled" },

  init: async () => {
    await events.onProviderStatus(({ provider, status }) =>
      set({ statuses: { ...get().statuses, [provider]: status } }),
    );
    try {
      set({ statuses: await api.providerStatus() });
    } catch {
      // Keep defaults; status events follow.
    }
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
