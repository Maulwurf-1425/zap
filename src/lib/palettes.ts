// Color palettes. Each palette is just an accent and a background tint; the
// full set of surface/text/accent tokens is derived from them for dark and
// light mode. "zap" returns no overrides, so tokens.css (design.md) applies
// unchanged.

export interface PalettePreset {
  id: string;
  accent: string;
  tint: string;
}

export const DEFAULT_PALETTE = "zap";
export const CUSTOM_PALETTE = "custom";

export const PALETTES: PalettePreset[] = [
  { id: "zap", accent: "#fd614b", tint: "#3283be" },
  { id: "midnight", accent: "#a78bfa", tint: "#4f46e5" },
  { id: "forest", accent: "#f5b14c", tint: "#2f855a" },
  { id: "aubergine", accent: "#f472b6", tint: "#7e3a8c" },
  { id: "graphite", accent: "#5aa9e6", tint: "#64748b" },
  { id: "ember", accent: "#ff7a3d", tint: "#8a4b2f" },
  { id: "lagoon", accent: "#2dd4bf", tint: "#0e7490" },
  { id: "rose", accent: "#fb7185", tint: "#a2405a" },
];

const HEX = /^#[0-9a-f]{6}$/i;

export function isHexColor(value: string): boolean {
  return HEX.test(value);
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function hexToHsl(hex: string): Hsl {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: s * 100, l: l * 100 };
}

function hslToRgb({ h, s, l }: Hsl): [number, number, number] {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function hex(c: Hsl): string {
  return `#${hslToRgb(c)
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

function rgba(c: Hsl, alpha: number): string {
  const [r, g, b] = hslToRgb(c);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** WCAG relative luminance (0–1). */
export function luminance(color: string): number {
  const n = parseInt(color.slice(1), 16);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

const clampL = (l: number) => Math.min(96, Math.max(4, l));

function accentTokens(accent: string, ink: string, scheme: "dark" | "light"): Record<string, string> {
  const a = hexToHsl(accent);
  const shade = (dl: number) => hex({ ...a, l: clampL(a.l - dl) });
  return {
    "--coral": accent,
    "--coral-600": shade(5),
    "--coral-700": shade(scheme === "light" ? 18 : 12),
    "--coral-glow": rgba(a, 0.45),
    "--coral-ring": rgba(a, 0.6),
    // Dark text on bright accents, white on deep ones.
    "--on-accent": luminance(accent) > 0.25 ? ink : "#fefdfe",
  };
}

/** CSS custom properties for a palette in the given scheme; empty for the default. */
export function paletteTokens(
  id: string,
  scheme: "dark" | "light",
  custom: { accent: string; tint: string },
): Record<string, string> {
  if (id !== CUSTOM_PALETTE) {
    const preset = PALETTES.find((p) => p.id === id);
    if (!preset || preset.id === DEFAULT_PALETTE) return {};
    return buildTokens(preset.accent, preset.tint, scheme);
  }
  const accent = isHexColor(custom.accent) ? custom.accent : "#fd614b";
  const tint = isHexColor(custom.tint) ? custom.tint : "#3283be";
  return buildTokens(accent, tint, scheme);
}

/** Lightness ladders taken from the ZAP azure ramp (tokens.css). */
export function buildTokens(accent: string, tint: string, scheme: "dark" | "light"): Record<string, string> {
  const t = hexToHsl(tint);
  const h = t.h;
  // Keep greys grey; cap vivid tints at the ZAP saturation.
  const s = Math.min(t.s * 1.2, 70);
  const at = (l: number, sat = s) => ({ h, s: sat, l });
  const ink = hex(at(15, Math.min(s, 71)));

  const ramp = {
    "--azure": hex(at(47, Math.min(s, 58))),
    "--azure-300": hex(at(68, Math.min(s, 59))),
    "--azure-700": hex(at(35, Math.min(s, 65))),
    "--azure-800": hex(at(28)),
    "--azure-900": hex(at(20)),
    "--selection": rgba(at(47, Math.min(s, 58)), scheme === "dark" ? 0.45 : 0.3),
  };

  if (scheme === "dark") {
    const stops = [28, 25, 22, 20, 18, 15, 13];
    const pos = [0, 18, 34, 48, 63, 80, 100];
    return {
      ...ramp,
      "--bg": hex(at(13)),
      "--bg-gradient": `radial-gradient(ellipse 135% 100% at 50% -6%, ${stops
        .map((l, i) => `${hex(at(l))} ${pos[i]}%`)
        .join(", ")})`,
      "--surface-sidebar": rgba(at(20), 0.55),
      "--surface-popover": rgba(at(20), 0.94),
      "--code-bg": rgba(at(20), 0.8),
      "--scrim": rgba(at(14), 0.55),
      "--shadow-card": `0 8px 32px ${rgba(at(14), 0.28)}`,
      "--shadow-pop": `0 16px 48px ${rgba(at(14), 0.4)}`,
      ...accentTokens(accent, ink, scheme),
    };
  }

  const inkHsl = at(15, Math.min(s, 71));
  const ls = Math.min(s, 64);
  return {
    ...ramp,
    "--ink": ink,
    "--bg": hex(at(97, ls)),
    "--bg-gradient": `radial-gradient(ellipse 135% 100% at 50% -6%, ${hex(at(92, ls))} 0%, ${hex(at(95, ls))} 30%, ${hex(
      at(97, ls),
    )} 60%, ${hex(at(98.5, ls / 1.3))} 80%, #fefdfe 100%)`,
    "--surface-sidebar": "rgba(254, 253, 254, 0.7)",
    "--surface-1": rgba(inkHsl, 0.04),
    "--surface-2": rgba(inkHsl, 0.07),
    "--surface-3": rgba(inkHsl, 0.11),
    "--btn-hover": rgba(inkHsl, 0.1),
    "--btn-press": rgba(inkHsl, 0.17),
    "--btn-border-hover": rgba(inkHsl, 0.4),
    "--border": rgba(inkHsl, 0.12),
    "--border-strong": rgba(inkHsl, 0.24),
    "--fg-muted": rgba(inkHsl, 0.72),
    "--fg-subtle": rgba(inkHsl, 0.52),
    "--dot": rgba(inkHsl, 0.1),
    "--glass-border": rgba(inkHsl, 0.12),
    "--scrim": rgba(inkHsl, 0.3),
    "--code-bg": rgba(inkHsl, 0.05),
    "--code-header": rgba(inkHsl, 0.04),
    "--skeleton": rgba(inkHsl, 0.06),
    "--skeleton-shine": rgba(inkHsl, 0.1),
    "--shadow-card": `0 8px 32px ${rgba(inkHsl, 0.1)}`,
    "--shadow-pop": `0 16px 48px ${rgba(inkHsl, 0.18)}`,
    ...accentTokens(accent, ink, scheme),
  };
}
