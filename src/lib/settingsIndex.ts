// Everything the settings search can find: each section and the controls in
// it, with the tab they live on. Labels come from i18n, so the search works
// in both languages and stays in step with what the dialog shows.
import { t } from "./i18n";
import type { SettingsTab } from "../store/ui";

export interface SettingsEntry {
  tab: Exclude<SettingsTab, "search">;
  /** Text shown in the dialog (used to find and highlight it there). */
  label: string;
  /** Section heading the entry sits under; absent for a section itself. */
  section?: string;
  /** Extra words that should find it (synonyms). */
  keywords?: string;
}

type Group = { tab: SettingsEntry["tab"]; section: string; fields?: string[]; keywords?: string };

const groups = (): Group[] => {
  const g = t.settings.general;
  const a = t.settings.appearance;
  const c = t.settings.chat;
  const w = t.settings.webSearch;
  const f = t.settings.files;
  const d = t.settings.data;
  const v = t.voice.settings;
  const z = t.zaps.settings;
  const k = t.knowledge;
  const s = t.shortcuts;
  const kw = t.settings.search.keywords;
  return [
    { tab: "general", section: g.language, keywords: kw.language },
    { tab: "general", section: t.quick.title, fields: [t.quick.enable], keywords: kw.quick },
    { tab: "general", section: t.discord.settings.title, fields: [t.discord.settings.show, t.discord.settings.model] },
    { tab: "general", section: g.onboarding, keywords: kw.onboarding },
    {
      tab: "general",
      section: g.shortcuts,
      fields: [
        g.sendKey,
        s.newChat,
        s.palette,
        s.sidebar,
        s.settings,
        s.copyLast,
        s.prevChat,
        s.nextChat,
        s.monitor,
        s.quickAsk,
      ],
      keywords: kw.shortcuts,
    },
    { tab: "appearance", section: a.theme, keywords: kw.theme },
    { tab: "appearance", section: a.density },
    { tab: "appearance", section: a.colors, fields: [a.accent, a.tint], keywords: kw.colors },
    {
      tab: "appearance",
      section: a.typography,
      fields: [a.font, a.fontSize, a.lineHeight, a.letterSpacing, a.paragraphSpacing],
      keywords: kw.typography,
    },
    { tab: "models", section: t.engines.title, keywords: kw.engines },
    { tab: "models", section: t.cloud.section, keywords: kw.cloud },
    { tab: "models", section: z.memory, fields: [z.idle] },
    { tab: "models", section: t.models.installed },
    { tab: "models", section: t.models.more.replace(" …", ""), fields: [t.models.other], keywords: kw.download },
    {
      tab: "chat",
      section: t.settings.tabs.chat,
      fields: [c.defaultModel, c.temperature, c.contextLength, c.systemPrompt],
    },
    { tab: "chat", section: t.settings.blueprints.title },
    { tab: "voice", section: v.dictation, fields: [v.language, v.microphone], keywords: kw.dictation },
    { tab: "voice", section: v.reading, fields: [v.speed, v.autoRead], keywords: kw.reading },
    { tab: "zaps", section: t.zaps.title, fields: [z.chat] },
    {
      tab: "zaps",
      section: z.background,
      fields: [z.closeToTray, z.autostart, z.notifications],
      keywords: kw.background,
    },
    { tab: "zaps", section: z.permission },
    { tab: "usage", section: t.usage.title, fields: [t.usage.byModel], keywords: kw.usage },
    { tab: "web", section: w.title, fields: [w.enable, w.readLinks] },
    // Provider fields (Brave key, SearXNG address) only show for their provider.
    { tab: "web", section: w.provider },
    { tab: "files", section: f.title, fields: [f.enable] },
    { tab: "files", section: f.permission },
    { tab: "files", section: f.index },
    { tab: "knowledge", section: k.title, keywords: kw.knowledge },
    { tab: "knowledge", section: k.model },
    { tab: "knowledge", section: k.index },
    {
      tab: "data",
      section: t.settings.tabs.data,
      fields: [d.exportTitle, d.importTitle, d.deleteTitle],
      keywords: kw.data,
    },
    { tab: "about", section: t.updates.title, fields: [t.updates.auto], keywords: kw.updates },
    { tab: "about", section: t.settings.about.licenses },
    { tab: "about", section: t.settings.about.avatarCredits },
  ];
};

export function settingsEntries(): SettingsEntry[] {
  return groups().flatMap(({ tab, section, fields = [], keywords }) => [
    { tab, label: section, keywords },
    ...fields.map((label) => ({ tab, label, section, keywords })),
  ]);
}

const normalize = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");

/** Entries matching every word of the query, best first. */
export function searchSettings(query: string, tabLabel: (tab: SettingsEntry["tab"]) => string): SettingsEntry[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const scored: { entry: SettingsEntry; score: number }[] = [];
  for (const entry of settingsEntries()) {
    const label = normalize(entry.label);
    const haystack = normalize([entry.label, entry.section, tabLabel(entry.tab), entry.keywords].join(" "));
    if (!words.every((w) => haystack.includes(w))) continue;
    // Whole query in the name > more of the words in the name > name starts
    // with the first word > found only in section, tab or synonyms.
    const first = words[0] ?? "";
    let score = label.includes(words.join(" ")) ? 0 : 4;
    score += words.filter((w) => !label.includes(w)).length * 2;
    if (label.startsWith(first)) score -= 1;
    scored.push({ entry, score: score + (entry.section ? 0.5 : 0) });
  }
  // Same text twice (e.g. a section named like its tab): keep the first.
  const seen = new Set<string>();
  return scored
    .sort((x, y) => x.score - y.score)
    .map((s) => s.entry)
    .filter((e) => {
      const key = `${e.tab}|${e.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
