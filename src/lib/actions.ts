// Small UI actions shared by several components.
import { openExternal } from "./format";
import { t } from "./i18n";
import type { Chat, ProviderKind } from "./ipc";

export function focusComposer(): void {
  window.setTimeout(() => document.getElementById("composer-input")?.focus(), 0);
}

/** Opens the engine's download page in the default browser. */
export function openEngineDownload(kind: ProviderKind): void {
  void openExternal(t.engines.downloadUrl[kind]);
}

/** Untitled chats are stored with an empty title. */
export function chatTitle(chat: Pick<Chat, "title">): string {
  return chat.title.trim() || t.chat.newChat;
}
