// Turning Markdown answers into text a voice can read: no code, no URLs, no
// formatting symbols, split into sentences (also while the answer streams).

/** Words before a period that don't end a sentence. */
// prettier-ignore
const ABBREVIATIONS = new Set([
  "z", "b", "bzw", "ca", "dr", "mr", "mrs", "ms", "nr", "usw", "vs", "etc", "e.g", "i.e", "u.a", "inkl", "evtl", "ggf", "st", "jh",
]);

/** Plain, speakable text from Markdown. Unclosed code blocks (while
 *  streaming) are dropped up to the end. */
export function speakable(markdown: string): string {
  let text = markdown.replace(/\r\n/g, "\n");
  // Code blocks (closed, then a trailing open one).
  text = text.replace(/```[\s\S]*?```/g, "\n");
  text = text.replace(/```[\s\S]*$/, "");
  // Tables: drop separator rows, read cells with pauses.
  text = text.replace(/^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$/gm, "");
  text = text.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row: string) =>
    row
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean)
      .join(", ")
      .concat("."),
  );
  // Images and links keep their text; bare URLs are not read.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/https?:\/\/\S+/g, "");
  text = text.replace(/<[^>]+>/g, "");
  // Inline code, emphasis, headings, quotes, list markers.
  text = text.replace(/`([^`]*)`/g, "$1");
  text = text.replace(/(\*\*|__)(.+?)\1/g, "$2");
  text = text.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, "$1$2");
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s*>\s?/gm, "");
  text = text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "");
  text = text.replace(/^\s*(?:-{3,}|\*{3,})\s*$/gm, "");
  // A line without final punctuation (heading, list item) still ends a sentence.
  text = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/[.!?…:;]$/.test(l) ? l : `${l}.`))
    .join("\n");
  return text.replace(/[ \t]+/g, " ").trim();
}

/** Splits into sentences. Unless `final`, the last unfinished piece is
 *  returned as `rest` (it may still grow). */
export function splitSentences(text: string, final: boolean): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") {
      push(text.slice(start, i));
      start = i + 1;
      continue;
    }
    if (c !== "." && c !== "!" && c !== "?" && c !== "…") continue;
    const next = text[i + 1];
    if (next === undefined) break; // could still be "3.5" or "..."
    if (next !== " ") continue;
    if (c === "." && !endsSentence(text.slice(start, i))) continue;
    push(text.slice(start, i + 1));
    start = i + 2;
  }
  const tail = text.slice(start).trim();
  if (final) {
    push(tail);
    return { sentences, rest: "" };
  }
  return { sentences, rest: tail };

  function push(s: string) {
    const t = s.trim();
    if (t && /[\p{L}\p{N}]/u.test(t)) sentences.push(t);
  }
}

function endsSentence(before: string): boolean {
  const word = before.split(/\s+/).pop() ?? "";
  if (/^\d+$/.test(word)) return false; // "9. November", "1. Platz"
  if (word.length === 1) return false; // initials, "z. B."
  return !ABBREVIATIONS.has(word.toLowerCase());
}

/** Live microphone level 0–1 from a peak sample, scaled so normal speech
 *  fills most of a meter. */
export function micLevel(peak: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, peak)) * 1.6);
}

/** Loudest sample at which a recording counts as speech (matches the backend). */
export const SPEECH_PEAK = 0.015;

const DE_HINTS = /\b(der|die|das|und|ist|nicht|ich|du|ein|eine|mit|für|auf|dass|sich|auch|wie|wird|sind)\b|[äöüß]/gi;
const EN_HINTS = /\b(the|and|is|are|you|of|to|it|that|with|for|this|be|was|have|not|can)\b/gi;

/** "de" or "en", guessed from common words; `fallback` when unclear. */
export function detectLanguage(text: string, fallback: "de" | "en" = "en"): "de" | "en" {
  const sample = text.slice(0, 600);
  const de = sample.match(DE_HINTS)?.length ?? 0;
  const en = sample.match(EN_HINTS)?.length ?? 0;
  if (de === en) return fallback;
  return de > en ? "de" : "en";
}
