// Applies appearance settings to <html> and mirrors them to localStorage so
// public/theme-init.js can restore them before the first paint.
import type { Density, FontFamily, ThemeMode } from "./ipc";
import { paletteTokens } from "./palettes";

export const FONT_MIN = 12;
export const FONT_MAX = 24;
export const LINE_HEIGHT_MIN = 1.2;
export const LINE_HEIGHT_MAX = 2.2;
export const LETTER_SPACING_MIN = -0.03;
export const LETTER_SPACING_MAX = 0.12;
export const PARAGRAPH_MIN = 0.25;
export const PARAGRAPH_MAX = 2;
const STORAGE_KEY = "zap.appearance";

const FONT_STACKS: Record<FontFamily, string> = {
  inter: "var(--font-sans)",
  system: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  serif: 'Georgia, Cambria, "Times New Roman", serif',
  mono: "var(--font-mono)",
};

export interface Appearance {
  theme: ThemeMode;
  fontSize: number;
  density: Density;
  /** Mirrored so the first render (and <html lang>) uses the right language. */
  language: "en" | "de";
  palette: string;
  customAccent: string;
  customTint: string;
  fontFamily: FontFamily;
  lineHeight: number;
  letterSpacing: number;
  paragraphSpacing: number;
}

const systemQuery = () => window.matchMedia("(prefers-color-scheme: light)");

export function resolveTheme(mode: ThemeMode): "dark" | "light" {
  if (mode === "system") return systemQuery().matches ? "light" : "dark";
  return mode;
}

const clamp = (v: number, min: number, max: number, fallback: number) =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** Every inline custom property for the given appearance (colors + chat typography). */
export function appearanceVars(a: Appearance, scheme: "dark" | "light"): Record<string, string> {
  const size = Math.round(clamp(a.fontSize, FONT_MIN, FONT_MAX, 16));
  const lineHeight = clamp(a.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, 1.625);
  return {
    ...paletteTokens(a.palette, scheme, { accent: a.customAccent, tint: a.customTint }),
    "--chat-font": FONT_STACKS[a.fontFamily] ?? FONT_STACKS.inter,
    "--chat-font-size": `${size}px`,
    "--chat-line-height": `${Math.round(size * lineHeight)}px`,
    "--chat-letter-spacing": `${clamp(a.letterSpacing, LETTER_SPACING_MIN, LETTER_SPACING_MAX, 0)}em`,
    "--chat-paragraph-gap": `${clamp(a.paragraphSpacing, PARAGRAPH_MIN, PARAGRAPH_MAX, 0.875)}em`,
  };
}

/** Names set by the last call, so switching palettes removes stale overrides. */
let applied: string[] = [];

export function applyAppearance(a: Appearance): void {
  const root = document.documentElement;
  const scheme = resolveTheme(a.theme);
  root.setAttribute("data-theme", scheme);
  root.setAttribute("data-density", a.density);
  root.lang = a.language;
  const vars = appearanceVars(a, scheme);
  for (const name of applied) if (!(name in vars)) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  applied = Object.keys(vars);
  try {
    // Both schemes are stored so theme-init.js can follow Windows in System mode.
    const stored = { dark: appearanceVars(a, "dark"), light: appearanceVars(a, "light") };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...a, vars: stored }));
  } catch {
    // Storage may be unavailable; the settings table stays the source of truth.
  }
}

/** Re-applies the theme when Windows switches light/dark (System mode). */
export function watchSystemTheme(getMode: () => ThemeMode, onChange: () => void): () => void {
  const mq = systemQuery();
  const handler = () => {
    if (getMode() === "system") onChange();
  };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
