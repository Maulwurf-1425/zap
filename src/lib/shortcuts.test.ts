import { describe, expect, it } from "vitest";
import {
  comboFromEvent,
  comboProblem,
  conflictOf,
  formatCombo,
  globalComboProblem,
  isSendKey,
  shortcutFor,
} from "./shortcuts";

const ev = (key: string, code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) => ({
  key,
  code,
  ctrlKey: !!mods.ctrl,
  metaKey: false,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
});

describe("shortcuts", () => {
  it("builds combos from key events", () => {
    expect(comboFromEvent(ev("C", "KeyC", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+C");
    expect(comboFromEvent(ev(",", "Comma", { ctrl: true }))).toBe("Ctrl+,");
    // Shift changes the character but not the physical key.
    expect(comboFromEvent(ev(";", "Comma", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+,");
    expect(comboFromEvent(ev("!", "Digit1", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+1");
    expect(comboFromEvent(ev("ArrowUp", "ArrowUp", { ctrl: true }))).toBe("Ctrl+Up");
    expect(comboFromEvent(ev("F5", "F5"))).toBe("F5");
    expect(comboFromEvent(ev(" ", "Space", { alt: true }))).toBe("Alt+Space");
    // German layout: the key labelled Z sits where US has Y.
    expect(comboFromEvent(ev("z", "KeyY", { ctrl: true }))).toBe("Ctrl+Z");
    expect(comboFromEvent(ev("Control", "ControlLeft", { ctrl: true }))).toBeNull();
  });

  it("checks combos", () => {
    expect(comboProblem("K")).toBe("needs_modifier");
    expect(comboProblem("Shift+K")).toBe("needs_modifier");
    expect(comboProblem("F6")).toBeNull();
    expect(comboProblem("Ctrl+V")).toBe("reserved");
    expect(comboProblem("Ctrl+Alt+K")).toBeNull();
    expect(globalComboProblem("Ctrl+,")).toBe("needs_modifier");
    expect(globalComboProblem("F5")).toBe("needs_modifier");
    expect(globalComboProblem("Ctrl+Shift+Space")).toBeNull();
  });

  it("uses overrides and finds conflicts", () => {
    const settings = { shortcuts: { newChat: "Ctrl+Alt+N" } };
    expect(shortcutFor(settings, "newChat")).toBe("Ctrl+Alt+N");
    expect(shortcutFor(settings, "palette")).toBe("Ctrl+K");
    expect(conflictOf(settings, "sidebar", "Ctrl+K")).toBe("palette");
    expect(conflictOf(settings, "sidebar", "Ctrl+N")).toBeNull();
    expect(formatCombo("Ctrl+Space", { ctrl: "Strg", space: "Leertaste", up: "↑", down: "↓" })).toBe("Strg+Leertaste");
  });

  it("decides which Enter sends", () => {
    const enter = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };
    const shiftEnter = { ...enter, shiftKey: true };
    expect(isSendKey(enter, "enter")).toBe(true);
    expect(isSendKey(shiftEnter, "enter")).toBe(false);
    expect(isSendKey(enter, "shift_enter")).toBe(false);
    expect(isSendKey(shiftEnter, "shift_enter")).toBe(true);
    expect(isSendKey({ ...enter, isComposing: true }, "enter")).toBe(false);
    expect(isSendKey({ ...enter, ctrlKey: true }, "enter")).toBe(false);
  });
});
