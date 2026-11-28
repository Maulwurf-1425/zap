import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "./i18n";
import { searchSettings, settingsEntries } from "./settingsIndex";

const tabLabel = (tab: string) => tab;

describe("settings search", () => {
  afterEach(() => setLanguage("en"));

  it("finds settings by name, best match first", () => {
    const hits = searchSettings("font size", tabLabel);
    expect(hits[0]?.label).toBe("Chat font size");
    expect(hits[0]?.tab).toBe("appearance");
    expect(searchSettings("", tabLabel)).toEqual([]);
    expect(searchSettings("zzzz", tabLabel)).toEqual([]);
  });

  it("finds settings by synonyms and section", () => {
    expect(searchSettings("dark", tabLabel)[0]?.tab).toBe("appearance");
    expect(searchSettings("api key", tabLabel).some((e) => e.tab === "models")).toBe(true);
  });

  it("follows the language and ignores accents", () => {
    setLanguage("de");
    const hits = searchSettings("tastenkurzel", tabLabel);
    expect(hits[0]?.label).toBe("Tastenkürzel");
    expect(searchSettings("dunkel", tabLabel)[0]?.tab).toBe("appearance");
  });

  it("has no empty labels", () => {
    expect(settingsEntries().every((e) => e.label.trim().length > 0)).toBe(true);
  });
});
