import { describe, expect, it } from "vitest";
import changelog from "../../CHANGELOG.md?raw";
import { notesFor, parseChangelog, parseUpdateBody } from "./changelog";

const SAMPLE = `# Changelog

Intro text.

## 0.4.0 – Big Update

### English

- New thing

### Deutsch

- Neues Ding

## 0.3.9

### English

- Fix only
`;

describe("changelog", () => {
  it("parses versions, names and languages", () => {
    const [big, fix] = parseChangelog(SAMPLE);
    expect(big).toEqual({ version: "0.4.0", name: "Big Update", notes: { en: "- New thing", de: "- Neues Ding" } });
    expect(fix?.name).toBeNull();
    // Missing German falls back to English.
    expect(notesFor(fix!, "de")).toBe("- Fix only");
  });

  it("reads the update body, or keeps plain text", () => {
    const body = SAMPLE.slice(SAMPLE.indexOf("## 0.4.0"), SAMPLE.indexOf("## 0.3.9"));
    expect(parseUpdateBody("0.4.0", body).name).toBe("Big Update");
    expect(parseUpdateBody("1.0.0", "Just text")).toEqual({ version: "1.0.0", name: null, notes: { en: "Just text" } });
  });

  it("has English and German notes for every release in CHANGELOG.md", () => {
    const entries = parseChangelog(changelog);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.notes.en, e.version).toBeTruthy();
      expect(e.notes.de, e.version).toBeTruthy();
    }
  });
});
