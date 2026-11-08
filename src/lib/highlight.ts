// Lazy, fine-grained shiki setup. The JS regex engine avoids WASM, and the
// css-variables theme pulls every color from tokens.css.
import type { HighlighterCore, LanguageRegistration } from "shiki/core";

type LangLoader = () => Promise<{ default: LanguageRegistration[] }>;

const loaders: Record<string, LangLoader> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  java: () => import("@shikijs/langs/java"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  bash: () => import("@shikijs/langs/bash"),
  powershell: () => import("@shikijs/langs/powershell"),
  json: () => import("@shikijs/langs/json"),
  yaml: () => import("@shikijs/langs/yaml"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  sql: () => import("@shikijs/langs/sql"),
  markdown: () => import("@shikijs/langs/markdown"),
};

const aliases: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  zsh: "bash",
  ps: "powershell",
  ps1: "powershell",
  pwsh: "powershell",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  cs: "csharp",
  "c#": "csharp",
  golang: "go",
  xml: "html",
};

export function resolveLang(lang: string): string | null {
  const key = lang.toLowerCase();
  const resolved = aliases[key] ?? key;
  return resolved in loaders ? resolved : null;
}

let highlighterPromise: Promise<HighlighterCore> | null = null;
let readyHighlighter: HighlighterCore | null = null;
const loadedLangs = new Set<string>();
const pendingLangs = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore, createCssVariablesTheme }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    const theme = createCssVariablesTheme({ name: "zap", variablePrefix: "--shiki-" });
    readyHighlighter = await createHighlighterCore({
      themes: [theme],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
    return readyHighlighter;
  })();
  return highlighterPromise;
}

async function ensureLang(lang: string): Promise<HighlighterCore> {
  const hl = await getHighlighter();
  if (!loadedLangs.has(lang)) {
    let pending = pendingLangs.get(lang);
    if (!pending) {
      const loader = loaders[lang];
      pending = loader
        ? loader().then(async (mod) => {
            await hl.loadLanguage(mod.default);
            loadedLangs.add(lang);
          })
        : Promise.resolve();
      pendingLangs.set(lang, pending);
    }
    await pending;
  }
  return hl;
}

/** Returns highlighted HTML, or null when the language is unsupported. */
export async function highlight(code: string, lang: string): Promise<string | null> {
  const resolved = resolveLang(lang);
  if (!resolved) return null;
  const hl = await ensureLang(resolved);
  return hl.codeToHtml(code, { lang: resolved, theme: "zap" });
}

/** Synchronous variant, so streaming updates don't flash unhighlighted text
 *  once the language has been loaded. */
export function highlightSync(code: string, lang: string): string | null {
  const resolved = resolveLang(lang);
  if (!resolved || !readyHighlighter || !loadedLangs.has(resolved)) return null;
  return readyHighlighter.codeToHtml(code, { lang: resolved, theme: "zap" });
}
