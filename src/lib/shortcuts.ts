// Keyboard shortcuts the user can change. A combo is stored as text like
// "Ctrl+Shift+C": modifiers in the order Ctrl, Alt, Shift, then one key.
import type { Settings } from "./ipc";

export const SHORTCUT_ACTIONS = [
  "newChat",
  "palette",
  "sidebar",
  "settings",
  "copyLast",
  "prevChat",
  "nextChat",
  "monitor",
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  newChat: "Ctrl+N",
  palette: "Ctrl+K",
  sidebar: "Ctrl+B",
  settings: "Ctrl+,",
  copyLast: "Ctrl+Shift+C",
  prevChat: "Ctrl+Up",
  nextChat: "Ctrl+Down",
  monitor: "F5",
};

/** Text editing keys a shortcut must not take over. */
const RESERVED = new Set(["Ctrl+A", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Y", "Ctrl+Z", "Alt+F4", "Ctrl+Shift+Z"]);

const CODE_KEYS: Record<string, string> = {
  Space: "Space",
  Comma: ",",
  Period: ".",
  Minus: "-",
  Equal: "=",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  Delete: "Delete",
  Backspace: "Backspace",
  Tab: "Tab",
  Enter: "Enter",
  NumpadEnter: "Enter",
};

type KeyEventLike = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

/** The key without modifiers; null for a lone modifier or an unknown key. */
function keyName(e: KeyEventLike): string | null {
  // Letters follow the layout (Z on a German keyboard is Z), the rest the physical key.
  if (/^[a-z]$/i.test(e.key)) return e.key.toUpperCase();
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
  if (digit) return digit[1] ?? null;
  if (/^F([1-9]|1\d|2[0-4])$/.test(e.code)) return e.code;
  if (e.key === "Escape") return "Esc";
  return CODE_KEYS[e.code] ?? null;
}

/** "Ctrl+Shift+C" for a key event; null while only modifiers are held. */
export function comboFromEvent(e: KeyEventLike): string | null {
  const key = keyName(e);
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

export function matches(e: KeyEventLike, combo: string): boolean {
  return comboFromEvent(e) === combo;
}

export function shortcutFor(settings: Pick<Settings, "shortcuts">, action: ShortcutAction): string {
  return settings.shortcuts?.[action] || DEFAULT_SHORTCUTS[action];
}

export type ComboProblem = "needs_modifier" | "reserved";

/** Why a combo can't be a shortcut inside ZAP, or null when it can. */
export function comboProblem(combo: string): ComboProblem | null {
  const parts = combo.split("+");
  const key = parts[parts.length - 1] ?? "";
  const modified = parts.includes("Ctrl") || parts.includes("Alt");
  if (!modified && !/^F\d+$/.test(key)) return "needs_modifier";
  if (RESERVED.has(combo)) return "reserved";
  return null;
}

/** Keys the system-wide quick ask shortcut can use (what Windows accepts). */
export function globalComboProblem(combo: string): ComboProblem | null {
  const parts = combo.split("+");
  const key = parts[parts.length - 1] ?? "";
  if (!parts.includes("Ctrl") && !parts.includes("Alt")) return "needs_modifier";
  if (!/^([A-Z0-9]|Space|F\d+)$/.test(key)) return "needs_modifier";
  if (RESERVED.has(combo)) return "reserved";
  return null;
}

/** The other action already on this combo, if any. */
export function conflictOf(
  settings: Pick<Settings, "shortcuts">,
  action: ShortcutAction,
  combo: string,
): ShortcutAction | null {
  return SHORTCUT_ACTIONS.find((a) => a !== action && shortcutFor(settings, a) === combo) ?? null;
}

/** Display form with localized key names, e.g. "Strg+Leertaste". */
export function formatCombo(combo: string, names: { ctrl: string; space: string; up: string; down: string }): string {
  return combo
    .split("+")
    .map((p) =>
      p === "Ctrl" ? names.ctrl : p === "Space" ? names.space : p === "Up" ? names.up : p === "Down" ? names.down : p,
    )
    .join("+");
}

export type SendKey = "enter" | "shift_enter";

/** Whether this key press sends the message (the other Enter makes a new line). */
export function isSendKey(
  e: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey"> & { isComposing?: boolean },
  mode: SendKey,
): boolean {
  if (e.key !== "Enter" || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return false;
  return mode === "shift_enter" ? e.shiftKey : !e.shiftKey;
}

// While the settings record a new combo, the app's own shortcuts stay quiet.
let recording = false;
export const setRecordingShortcut = (on: boolean) => {
  recording = on;
};
export const isRecordingShortcut = () => recording;
