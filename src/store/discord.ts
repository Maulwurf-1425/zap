// Discord Rich Presence: derives "what ZAP is doing" from the app state and
// sends it (debounced) to the backend. Only status and model name, never
// chat titles or content.
import { create } from "zustand";
import { api, events, modelLabel, type DiscordPresence } from "../lib/ipc";
import { t } from "../lib/i18n";
import { parseTools, useChats } from "./chats";
import { useModels } from "./models";
import { useSettings } from "./settings";
import { useVoice } from "./voice";

interface DiscordState {
  /** This build has a Discord application id. */
  available: boolean;
  connected: boolean;
  init: () => Promise<void>;
}

const SESSION_START = Date.now();
const DEBOUNCE_MS = 800;

/** The second line: what ZAP is doing right now. */
export function activityState(): string | null {
  const voice = useVoice.getState();
  if (voice.recording && !voice.testing) return t.discord.listening;
  if (voice.speakingId) return t.discord.reading;
  const chats = useChats.getState();
  for (const [chatId, gen] of Object.entries(chats.generating)) {
    const msg = chats.messages[chatId]?.find((m) => m.id === gen.messageId);
    if (!msg) continue;
    const running = parseTools(msg.tools).find((a) => a.status === "running" || a.status === "pending");
    if (running)
      return running.name === "web_search" || running.name === "fetch_page" ? t.discord.searching : t.discord.files;
    return msg.content.trim() ? t.discord.writing : t.discord.thinking;
  }
  return null;
}

/** The full presence, or null when it should be hidden. */
export function currentPresence(): DiscordPresence | null {
  const settings = useSettings.getState().settings;
  if (!settings.discord_presence) return null;
  const model = useModels.getState().selected;
  return {
    details: settings.discord_show_model && model ? t.discord.chattingWith(modelLabel(model)) : t.discord.chatting,
    state: activityState() ?? t.discord.idle,
    start: SESSION_START,
    image_text: t.discord.imageText,
    button: t.discord.button,
  };
}

let timer = 0;
let lastSent = "";

function schedule() {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    const presence = currentPresence();
    const key = JSON.stringify(presence);
    if (key === lastSent) return;
    lastSent = key;
    void (presence ? api.discordUpdate(presence) : api.discordClear()).catch(() => undefined);
  }, DEBOUNCE_MS);
}

export const useDiscord = create<DiscordState>((set) => ({
  available: false,
  connected: false,

  init: async () => {
    const available = await api.discordAvailable().catch(() => false);
    set({ available });
    if (!available) return;
    await events.onDiscordStatus((connected) => set({ connected }));
    // Re-evaluate whenever something that feeds the status changes.
    useSettings.subscribe(schedule);
    useChats.subscribe(schedule);
    useModels.subscribe(schedule);
    useVoice.subscribe(schedule);
    schedule();
  },
}));
