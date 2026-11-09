import { describe, expect, it } from "vitest";
import { buildTokens, hexToHsl, isHexColor, luminance, paletteTokens, PALETTES } from "./palettes";

const HEX = /^#[0-9a-f]{6}$/;

describe("palettes", () => {
  it("leaves the default ZAP palette to tokens.css", () => {
    expect(paletteTokens("zap", "dark", { accent: "#000000", tint: "#000000" })).toEqual({});
    expect(paletteTokens("unknown", "light", { accent: "#000000", tint: "#000000" })).toEqual({});
  });

  it("builds every preset in both schemes", () => {
    for (const p of PALETTES.filter((p) => p.id !== "zap")) {
      for (const scheme of ["dark", "light"] as const) {
        const tokens = paletteTokens(p.id, scheme, { accent: "", tint: "" });
        expect(tokens["--coral"]).toBe(p.accent);
        expect(tokens["--bg"]).toMatch(HEX);
        expect(tokens["--bg-gradient"]).toContain("radial-gradient");
      }
    }
  });

  it("keeps dark backgrounds dark and light backgrounds light", () => {
    const tint = "#2f855a";
    expect(luminance(buildTokens("#f5b14c", tint, "dark")["--bg"] ?? "")).toBeLessThan(0.05);
    expect(luminance(buildTokens("#f5b14c", tint, "light")["--bg"] ?? "")).toBeGreaterThan(0.85);
  });

  it("puts readable text on the accent", () => {
    expect(buildTokens("#fde047", "#3283be", "dark")["--on-accent"]).not.toBe("#fefdfe");
    expect(buildTokens("#1e3a8a", "#3283be", "dark")["--on-accent"]).toBe("#fefdfe");
  });

  it("falls back to ZAP colors for invalid custom input", () => {
    const tokens = paletteTokens("custom", "dark", { accent: "red", tint: "#12" });
    expect(tokens["--coral"]).toBe("#fd614b");
  });

  it("parses colors", () => {
    expect(isHexColor("#A1b2C3")).toBe(true);
    expect(isHexColor("A1b2C3")).toBe(false);
    const { h, s, l } = hexToHsl("#ff0000");
    expect([Math.round(h), Math.round(s), Math.round(l)]).toEqual([0, 100, 50]);
  });
});
