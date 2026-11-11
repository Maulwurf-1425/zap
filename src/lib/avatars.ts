// ZAP avatars, generated locally with DiceBear (no network: the styles ship
// with the app). A ZAP without avatar shows the ZAP bolt. The styles load on
// first use, so ZAP starts as fast as before.
import { create } from "zustand";
import type { ZapAvatar } from "./ipc";
import type { AvatarCredit } from "./avatarStyles";

type StylesModule = typeof import("./avatarStyles");

/** Offered styles, in picker order (stored with the ZAP). */
export const AVATAR_STYLE_IDS = [
  "bottts-neutral",
  "bottts",
  "pixel-art",
  "fun-emoji",
  "thumbs",
  "notionists",
  "lorelei",
  "adventurer",
  "big-smile",
  "shapes",
];

const useLib = create<{ lib: StylesModule | null }>(() => ({ lib: null }));
let loading: Promise<StylesModule> | null = null;

function loadLib(): Promise<StylesModule> {
  loading ??= import("./avatarStyles").then((lib) => {
    useLib.setState({ lib });
    return lib;
  });
  return loading;
}

export function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** A new robot avatar (used for new ZAPs). */
export function defaultAvatar(): ZapAvatar {
  return { style: "bottts-neutral", seed: randomSeed() };
}

const cache = new Map<string, string | null>();

function uriWith(lib: StylesModule, avatar: ZapAvatar, color: string | null): string | null {
  const key = `${avatar.style}|${avatar.seed}|${color ?? ""}`;
  if (!cache.has(key)) cache.set(key, lib.render(avatar.style, avatar.seed, color));
  return cache.get(key) ?? null;
}

/** Avatar as data URI (`color` becomes its background); null while the
 *  styles load or for an unknown style. */
export function useAvatarUri(avatar: ZapAvatar | null, color: string | null): string | null {
  const lib = useLib((s) => s.lib);
  if (!avatar) return null;
  if (!lib) {
    void loadLib();
    return null;
  }
  return uriWith(lib, avatar, color);
}

/** Avatar as PNG (base64, no prefix) for Windows notifications. */
export async function avatarPng(avatar: ZapAvatar, color: string | null, size = 128): Promise<string | null> {
  const uri = uriWith(await loadLib(), avatar, color);
  if (!uri) return null;
  const img = new Image();
  img.src = uri;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  return canvas.toDataURL("image/png").split(",")[1] ?? null;
}

/** Credits of the offered styles (loads them when needed). */
export function useAvatarCredits(): AvatarCredit[] | null {
  const lib = useLib((s) => s.lib);
  if (!lib) {
    void loadLib();
    return null;
  }
  return lib.credits();
}
