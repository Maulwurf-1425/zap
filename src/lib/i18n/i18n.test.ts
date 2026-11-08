import { afterEach, describe, expect, it } from "vitest";
import { en } from "./en";
import { de } from "./de";
import { errorMessage, getLanguage, normalizeLanguage, setLanguage, t } from "./index";
import * as i18n from "./index";

/** Flattens a strings object into "path → type" pairs (functions: arity). */
function shape(value: unknown, path = ""): Record<string, string> {
  if (typeof value === "function") return { [path]: `fn/${value.length}` };
  if (Array.isArray(value)) {
    return value.reduce<Record<string, string>>((acc, item, i) => ({ ...acc, ...shape(item, `${path}[${i}]`) }), {});
  }
  if (value && typeof value === "object") {
    return Object.entries(value).reduce<Record<string, string>>(
      (acc, [k, v]) => ({ ...acc, ...shape(v, path ? `${path}.${k}` : k) }),
      {},
    );
  }
  return { [path]: typeof value };
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

afterEach(() => setLanguage("en"));

describe("i18n", () => {
  it("English and German have the same keys", () => {
    expect(shape(de)).toEqual(shape(en));
  });

  it("has no empty strings", () => {
    expect(strings(en).filter((s) => s.trim() === "")).toEqual([]);
    expect(strings(de).filter((s) => s.trim() === "")).toEqual([]);
  });

  it("keeps the design.md §9 copy in German", () => {
    expect(de.composer.placeholder).toBe("Schreib etwas …");
    expect(de.chat.generating).toBe("ZAP denkt nach …");
    expect(de.engines.missing("Ollama")).toBe(
      "Ollama wurde nicht gefunden. Installiere es, damit ZAP lokal antworten kann.",
    );
    expect(de.models.noModel).toBe("Noch kein Modell geladen. Wähle eins, um loszulegen.");
    expect(de.errors.generic).toBe("Das hat nicht geklappt. Versuch's nochmal.");
  });

  it("defaults to English and switches live", () => {
    expect(normalizeLanguage(undefined)).toBe("en");
    expect(normalizeLanguage("fr")).toBe("en");
    expect(getLanguage()).toBe("en");
    expect(t.chat.newChat).toBe("New chat");

    setLanguage("de");
    // `t` is a live binding: the namespace sees the new value.
    expect(i18n.t.chat.newChat).toBe("Neuer Chat");
    expect(i18n.locale).toBe("de-DE");
    expect(document.documentElement.lang).toBe("de");
    expect(errorMessage("disk_full")).toBe(de.errors.diskFull);
  });

  it("maps every error code to copy", () => {
    expect(errorMessage("provider_unreachable")).toBe(en.errors.providerUnreachable);
    expect(errorMessage("provider_error")).toBe(en.errors.generic);
    expect(errorMessage("unsupported")).toBe(en.errors.unsupported);
  });
});
