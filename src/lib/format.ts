import { openUrl } from "@tauri-apps/plugin-opener";
import type { Chat } from "./ipc";
import { locale } from "./i18n";

/** Token counts with locale grouping, e.g. 12,345 / 12.345. */
export function formatTokens(n: number): string {
  return new Intl.NumberFormat(locale).format(Math.max(0, Math.round(n)));
}

const de = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${de.format(bytes / 1e9)} GB`;
  if (bytes >= 1e6) return `${de.format(bytes / 1e6)} MB`;
  return `${Math.max(0, Math.round(bytes / 1e3))} KB`;
}

export function formatSpeed(bps: number): string {
  if (bps <= 0) return "";
  return `${de.format(bps / 1e6)} MB/s`;
}

export function percent(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.floor((completed / total) * 100));
}

export function uid(): string {
  return crypto.randomUUID();
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Opens http(s) links in the default browser, never inside the app. */
export async function openExternal(href: string): Promise<boolean> {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    await openUrl(url.toString());
    return true;
  } catch {
    return false;
  }
}

export type DateGroup = "today" | "yesterday" | "week" | "older";

const DAY = 86_400_000;

export function dateGroup(ts: number, now = Date.now()): DateGroup {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  if (ts >= today) return "today";
  if (ts >= today - DAY) return "yesterday";
  if (ts >= today - 7 * DAY) return "week";
  return "older";
}

export interface ChatGroups {
  pinned: Chat[];
  today: Chat[];
  yesterday: Chat[];
  week: Chat[];
  older: Chat[];
}

/** Pinned chats first, the rest bucketed by last activity. */
export function groupChats(chats: Chat[], now = Date.now()): ChatGroups {
  const groups: ChatGroups = { pinned: [], today: [], yesterday: [], week: [], older: [] };
  for (const chat of chats) {
    if (chat.pinned) groups.pinned.push(chat);
    else groups[dateGroup(chat.updated_at, now)].push(chat);
  }
  return groups;
}

/** Shared ordering: pinned first, then most recent. */
export function sortChats(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at);
}
