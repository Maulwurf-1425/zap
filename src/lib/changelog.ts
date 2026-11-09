// Parses CHANGELOG.md sections ("## 0.3.1 – Name", "### English", "### Deutsch").
// The same format is the release body on GitHub, so update notes from the
// updater and the bundled changelog go through one parser.
import type { Language } from "./i18n";

export interface ReleaseNotes {
  version: string;
  /** Optional update name, e.g. "Fancyness Update". */
  name: string | null;
  /** Markdown per language. */
  notes: Partial<Record<Language, string>>;
}

const LANGUAGE_HEADINGS: Record<string, Language> = { english: "en", deutsch: "de", german: "de" };

export function parseChangelog(markdown: string): ReleaseNotes[] {
  const entries: ReleaseNotes[] = [];
  // Split at level-2 headings; text before the first one is the file intro.
  for (const block of markdown.replace(/\r\n/g, "\n").split(/^## /m).slice(1)) {
    const [heading = "", ...rest] = block.split("\n");
    const match = /^v?(\d+\.\d+\.\d+\S*)\s*(?:[–—-]\s*(.+))?$/.exec(heading.trim());
    if (!match?.[1]) continue;
    const notes: ReleaseNotes["notes"] = {};
    for (const part of rest.join("\n").split(/^### /m).slice(1)) {
      const [title = "", ...body] = part.split("\n");
      const lang = LANGUAGE_HEADINGS[title.trim().toLowerCase()];
      const text = body.join("\n").trim();
      if (lang && text) notes[lang] = text;
    }
    entries.push({ version: match[1], name: match[2]?.trim() || null, notes });
  }
  return entries;
}

/** Notes in the requested language, falling back to English, then any. */
export function notesFor(entry: ReleaseNotes, lang: Language): string {
  return entry.notes[lang] ?? entry.notes.en ?? Object.values(entry.notes)[0] ?? "";
}

/** Release notes from an update body; falls back to the raw text for other formats. */
export function parseUpdateBody(version: string, body: string | undefined): ReleaseNotes {
  const parsed = body ? parseChangelog(body).find((e) => e.version === version) : undefined;
  return parsed ?? { version, name: null, notes: body?.trim() ? { en: body.trim() } : {} };
}
