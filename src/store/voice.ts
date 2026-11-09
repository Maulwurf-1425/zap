import { create } from "zustand";
import { toast } from "sonner";
import { api, events, toAppError, type VoiceDownloadEvent, type VoiceStatus } from "../lib/ipc";
import { detectLanguage, speakable, splitSentences } from "../lib/speech";
import { formatBytes } from "../lib/format";
import { getLanguage, t } from "../lib/i18n";
import { useChats } from "./chats";
import { useSettings } from "./settings";
import { useUi } from "./ui";

interface VoiceState {
  status: VoiceStatus | null;
  /** Running download, with the item it belongs to. */
  install: VoiceDownloadEvent | null;
  recording: { startedAt: number; level: number } | null;
  transcribing: boolean;
  /** Microphone test in the settings (records without transcribing). */
  testing: boolean;
  /** Loudest level heard during the last test (null before any test). */
  testPeak: number | null;
  testMic: () => Promise<void>;
  /** Message id (or "preview:<voice>") being read aloud. */
  speakingId: string | null;
  init: () => Promise<void>;
  refresh: () => Promise<void>;
  installItem: (item: string) => Promise<boolean>;
  removeItem: (item: string) => Promise<void>;
  /** Starts dictation; offers the download first if Whisper is missing. */
  startRecording: () => Promise<void>;
  /** Stops and returns the transcript ("" if nothing was understood). */
  stopRecording: () => Promise<string>;
  cancelRecording: () => void;
  /** Reads a whole answer; offers the voice download if needed. */
  speak: (id: string, markdown: string) => Promise<void>;
  preview: (voiceId: string) => Promise<void>;
  stopSpeaking: () => void;
}

function voiceErrorText(err: unknown): string {
  const code = toAppError(err).message;
  return t.voice.errors[code] ?? t.errors.generic;
}

/** Install size of an item (only the parts still missing). */
export function installSize(status: VoiceStatus | null, item: string): number {
  if (!status) return 0;
  if (item.startsWith("dictation:")) {
    const m = status.models.find((x) => `dictation:${x.id}` === item);
    return (status.whisper ? 0 : status.whisper_size) + (m && !m.installed ? m.size : 0);
  }
  const v = status.voices.find((x) => `voice:${x.id}` === item);
  return (status.piper ? 0 : status.piper_size) + (v && !v.installed ? v.size : 0);
}

function voiceFor(lang: "de" | "en"): string {
  const s = useSettings.getState().settings;
  return lang === "de" ? s.voice_de : s.voice_en;
}

function isInstalled(status: VoiceStatus | null, voiceId: string): boolean {
  return Boolean(status?.piper && status.voices.find((v) => v.id === voiceId)?.installed);
}

/** Asks before a download; runs the action afterwards if it worked. */
function offerInstall(item: string, title: string, after?: () => void) {
  const { status, installItem } = useVoice.getState();
  useUi.getState().askConfirm({
    title,
    message: t.voice.installBody(formatBytes(installSize(status, item))),
    confirmLabel: t.voice.download,
    // Not awaited: the dialog closes and progress shows inline.
    onConfirm: () => {
      void installItem(item).then((ok) => ok && after?.());
    },
  });
}

// --- Reading aloud while an answer streams ---------------------------------

let auto: { messageId: string; started: boolean; sent: number; cancelled: boolean } | null = null;

function followStreaming() {
  if (!useSettings.getState().settings.auto_read) return;
  const s = useChats.getState();
  // A new reply in the open chat starts a reading session.
  const gen = s.activeId ? s.generating[s.activeId] : undefined;
  if (gen && (!auto || (auto.messageId !== gen.messageId && !auto.started))) {
    auto = { messageId: gen.messageId, started: false, sent: 0, cancelled: false };
  }
  if (!auto || auto.cancelled) return;
  const current = auto;
  // Follow it even if the user switches chats meanwhile.
  const message = Object.values(s.messages)
    .flat()
    .find((m) => m.id === current.messageId);
  if (!message) {
    auto = null;
    return;
  }
  const final = !Object.values(s.generating).some((g) => g.messageId === current.messageId);
  const { sentences, rest } = splitSentences(speakable(message.content), final);
  const ready = final && rest ? [...sentences, rest] : sentences;
  if (!current.started) {
    if (ready.length === 0) return;
    const voiceId = voiceFor(detectLanguage(ready.join(" "), getLanguage()));
    if (!isInstalled(useVoice.getState().status, voiceId)) {
      current.cancelled = true;
      toast(t.voice.autoReadMissing);
      return;
    }
    current.started = true;
    void api.speakStart(current.messageId, voiceId).catch(() => (current.cancelled = true));
  }
  const fresh = ready.slice(current.sent);
  if (fresh.length > 0) {
    current.sent = ready.length;
    void api.speakPush(current.messageId, fresh.join("\n")).catch(() => undefined);
  }
  if (final) {
    void api.speakEnd(current.messageId).catch(() => undefined);
    auto = null;
  }
}

export const useVoice = create<VoiceState>((set, get) => ({
  status: null,
  install: null,
  recording: null,
  transcribing: false,
  testing: false,
  testPeak: null,
  speakingId: null,

  init: async () => {
    await Promise.all([
      events.onVoiceDownload((e) => set({ install: e })),
      events.onVoiceLevel((level) => {
        const r = get().recording;
        if (!r) return;
        set({ recording: { ...r, level } });
        if (get().testing) set({ testPeak: Math.max(get().testPeak ?? 0, level) });
      }),
      events.onSpeaking(({ id, active, error }) => {
        if (active) set({ speakingId: id });
        else if (get().speakingId === id) set({ speakingId: null });
        if (error) toast(t.voice.errors[error] ?? t.errors.generic);
      }),
    ]);
    useChats.subscribe(followStreaming);
    await get().refresh();
  },

  refresh: async () => {
    try {
      set({ status: await api.voiceStatus() });
    } catch {
      // Keep the last status.
    }
  },

  installItem: async (item) => {
    set({ install: { item, part: "", downloaded: 0, total: 0 } });
    try {
      await api.voiceInstall(item);
      toast(t.voice.installed);
      return true;
    } catch (err) {
      toast(voiceErrorText(err));
      return false;
    } finally {
      set({ install: null });
      await get().refresh();
    }
  },

  removeItem: async (item) => {
    await api.voiceRemove(item).catch(() => toast(t.errors.generic));
    await get().refresh();
  },

  startRecording: async () => {
    if (get().recording || get().transcribing) return;
    const { status } = get();
    const model = useSettings.getState().settings.voice_model;
    const ready = status?.whisper && status.models.find((m) => m.id === model)?.installed;
    if (!ready) {
      offerInstall(`dictation:${model}`, t.voice.setupDictation);
      return;
    }
    get().stopSpeaking();
    try {
      await api.recordStart();
      set({ recording: { startedAt: Date.now(), level: 0 } });
    } catch (err) {
      toast(voiceErrorText(err));
    }
  },

  stopRecording: async () => {
    if (!get().recording) return "";
    set({ recording: null, transcribing: true });
    try {
      const text = await api.recordStop();
      if (!text) toast(t.voice.nothingHeard);
      return text;
    } catch (err) {
      toast(voiceErrorText(err));
      return "";
    } finally {
      set({ transcribing: false });
    }
  },

  testMic: async () => {
    if (get().recording || get().transcribing) return;
    try {
      await api.recordStart();
    } catch (err) {
      toast(voiceErrorText(err));
      return;
    }
    set({ recording: { startedAt: Date.now(), level: 0 }, testing: true, testPeak: 0 });
    await new Promise((r) => window.setTimeout(r, 5000));
    set({ recording: null, testing: false });
    await api.recordCancel().catch(() => undefined);
  },

  cancelRecording: () => {
    if (!get().recording) return;
    set({ recording: null });
    void api.recordCancel().catch(() => undefined);
  },

  speak: async (id, markdown) => {
    if (get().speakingId === id) {
      get().stopSpeaking();
      return;
    }
    const text = speakable(markdown);
    if (!text) return;
    const voiceId = voiceFor(detectLanguage(text, getLanguage()));
    if (!isInstalled(get().status, voiceId)) {
      const name = get().status?.voices.find((v) => v.id === voiceId)?.name ?? voiceId;
      offerInstall(`voice:${voiceId}`, t.voice.setupVoice(name), () => void get().speak(id, markdown));
      return;
    }
    if (auto) auto.cancelled = true;
    try {
      await api.speakStart(id, voiceId);
      set({ speakingId: id });
      await api.speakPush(id, splitSentences(text, true).sentences.join("\n"));
      await api.speakEnd(id);
    } catch (err) {
      set({ speakingId: null });
      toast(voiceErrorText(err));
    }
  },

  preview: async (voiceId) => {
    const id = `preview:${voiceId}`;
    if (get().speakingId === id) {
      get().stopSpeaking();
      return;
    }
    const v = get().status?.voices.find((x) => x.id === voiceId);
    if (!v) return;
    if (!isInstalled(get().status, voiceId)) {
      offerInstall(`voice:${voiceId}`, t.voice.setupVoice(v.name), () => void get().preview(voiceId));
      return;
    }
    try {
      await api.speakStart(id, voiceId);
      set({ speakingId: id });
      await api.speakPush(id, (v.lang === "de" ? t.voice.sampleDe : t.voice.sampleEn)(v.name));
      await api.speakEnd(id);
    } catch (err) {
      set({ speakingId: null });
      toast(voiceErrorText(err));
    }
  },

  stopSpeaking: () => {
    if (auto) auto.cancelled = true;
    set({ speakingId: null });
    void api.speakStop().catch(() => undefined);
  },
}));
