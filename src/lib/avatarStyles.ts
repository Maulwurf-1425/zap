// The DiceBear styles ZAP offers. Heavy (about 1 MB), so it is loaded on
// demand through lib/avatars.ts and never imported directly.
import { createAvatar, type Style } from "@dicebear/core";
import {
  adventurer,
  bigSmile,
  bottts,
  botttsNeutral,
  funEmoji,
  lorelei,
  notionists,
  pixelArt,
  shapes,
  thumbs,
} from "@dicebear/collection";

type AnyStyle = Style<Record<string, unknown>>;

/** Keyed by the id stored with the ZAP (see AVATAR_STYLE_IDS). */
const STYLES: Record<string, AnyStyle> = {
  "bottts-neutral": botttsNeutral,
  bottts,
  "pixel-art": pixelArt,
  "fun-emoji": funEmoji,
  thumbs,
  notionists,
  lorelei,
  adventurer,
  "big-smile": bigSmile,
  shapes,
};

/** Data URI of an avatar; null for an unknown style. */
export function render(styleId: string, seed: string, color: string | null): string | null {
  const style = STYLES[styleId];
  if (!style) return null;
  return createAvatar(style, {
    seed,
    ...(color ? { backgroundColor: [color.replace("#", "")] } : {}),
  }).toDataUri();
}

export interface AvatarCredit {
  title: string;
  creator: string;
  license: string;
}

/** Credits for the offered styles (some licenses ask for attribution). */
export function credits(): AvatarCredit[] {
  return Object.values(STYLES).map(({ meta }) => ({
    title: meta?.title ?? "",
    creator: meta?.creator ?? "",
    license: meta?.license?.name ?? "",
  }));
}
