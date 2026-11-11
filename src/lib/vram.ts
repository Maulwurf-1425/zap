// "Does this model fit into the free video memory?" A model that doesn't fit
// runs partly on the CPU and gets much slower.
import { useEffect, useState } from "react";
import { api, type ModelInfo } from "./ipc";

/** Room for the context cache and buffers on top of the model file. */
const OVERHEAD_BYTES = 0.6e9;
const OVERHEAD_FACTOR = 1.1;

export interface VramInfo {
  /** Dedicated video memory of the GPU. */
  total: number;
  /** In use right now (all programs). */
  used: number;
  /** Model keys the engines hold in memory (they need no extra room). */
  loaded: Set<string>;
}

/** Estimated video memory a model needs, from its file size. */
export function vramNeeded(model: ModelInfo): number {
  return model.size_bytes * OVERHEAD_FACTOR + OVERHEAD_BYTES;
}

/** `{ needed, free }` when the model likely won't fit; null when it fits or
 *  can't be judged (unknown size or GPU). */
export function vramShortfall(model: ModelInfo, info: VramInfo | null): { needed: number; free: number } | null {
  if (!info || model.size_bytes <= 0 || info.loaded.has(model.id)) return null;
  const free = Math.max(0, info.total - info.used);
  const needed = vramNeeded(model);
  return needed > free ? { needed, free } : null;
}

/** GPU memory and loaded models, fetched while `enabled`. */
export function useVramInfo(enabled = true): VramInfo | null {
  const [info, setInfo] = useState<VramInfo | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void Promise.all([api.gpuMemory(), api.loadedModels().catch(() => [])])
      .then(([gpu, loaded]) => {
        if (!alive) return;
        setInfo(
          gpu.total && gpu.used !== null
            ? { total: gpu.total, used: gpu.used, loaded: new Set(loaded.map((m) => m.id)) }
            : null,
        );
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled]);
  return info;
}
