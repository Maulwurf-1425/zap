// Applies appearance settings to <html> and mirrors them to localStorage so
// public/theme-init.js can restore them before the first paint.
import type { Density, ThemeMode } from "./ipc";

export const FONT_MIN = 14;
export const FONT_MAX = 18;
const STORAGE_KEY = "zap.appearance";

export interface Appearance {
  theme: ThemeMode;
  fontSize: number;
  density: Density;
  /** Mirrored so the first render (and <html lang>) uses the right language. */
  language: "en" | "de";
}

const systemQuery = () => window.matchMedia("(prefers-color-scheme: light)");

export function resolveTheme(mode: ThemeMode): "dark" | "light" {
  if (mode === "system") return systemQuery().matches ? "light" : "dark";
  return mode;
}

export function applyAppearance(a: Appearance): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", resolveTheme(a.theme));
  root.setAttribute("data-density", a.density);
  root.lang = a.language;
  const size = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(a.fontSize)));
  root.style.setProperty("--chat-font-size", `${size}px`);
  root.style.setProperty("--chat-line-height", `${Math.round(size * 1.625)}px`);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
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
