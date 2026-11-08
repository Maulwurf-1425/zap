// UI language. `t` is an ES live binding: modules that import it always see
// the current language. The app remounts its tree on change (see App.tsx), so
// every component re-renders with the new strings.
import type { ErrorCode, ProviderKind } from "../ipc";
import { de } from "./de";
import { en, type Strings } from "./en";

export type Language = "en" | "de";
export type { Strings };

const STRINGS: Record<Language, Strings> = { en, de };
const LOCALES: Record<Language, string> = { en: "en-US", de: "de-DE" };

export function normalizeLanguage(value: unknown): Language {
  return value === "de" ? "de" : "en";
}

/** Language mirrored by lib/theme.ts, so the first render is already right. */
function initialLanguage(): Language {
  try {
    const prefs = JSON.parse(localStorage.getItem("zap.appearance") ?? "{}") as { language?: unknown };
    return normalizeLanguage(prefs.language);
  } catch {
    return "en";
  }
}

let current: Language = initialLanguage();
export let t: Strings = STRINGS[current];
export let locale: string = LOCALES[current];

export function getLanguage(): Language {
  return current;
}

export function setLanguage(lang: Language): void {
  current = lang;
  t = STRINGS[lang];
  locale = LOCALES[lang];
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}

export function engineName(kind: ProviderKind): string {
  return t.engines.names[kind];
}

export function errorMessage(code: ErrorCode): string {
  const e = t.errors;
  switch (code) {
    case "provider_unreachable":
      return e.providerUnreachable;
    case "model_not_found":
      return e.modelNotFound;
    case "disk_full":
      return e.diskFull;
    case "cancelled":
      return e.cancelled;
    case "invalid_file":
      return e.invalidFile;
    case "unsupported":
      return e.unsupported;
    case "tool_format":
      return e.toolFormat;
    default:
      return e.generic;
  }
}

/** Download errors fall back to the connection hint instead of the generic copy. */
export function downloadErrorMessage(code: ErrorCode): string {
  if (code === "disk_full" || code === "provider_unreachable") return errorMessage(code);
  if (code === "model_not_found") return t.errors.modelNameUnknown;
  return t.errors.downloadFailed;
}

export function pullStatusLabel(status: string): string {
  const s = t.models.status;
  if (status.startsWith("pulling manifest")) return s.preparing;
  if (status.startsWith("pulling") || status.startsWith("downloading")) return s.downloading;
  if (status.startsWith("verifying")) return s.verifying;
  if (status.startsWith("writing") || status.startsWith("removing")) return s.finishing;
  if (status === "success") return s.done;
  return s.downloading;
}
