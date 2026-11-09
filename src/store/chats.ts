import { create } from "zustand";
import { toast } from "sonner";
import {
  api,
  events,
  toAppError,
  type Chat,
  type ChatGroup,
  type ChatStats,
  type ErrorCode,
  type Message,
  type PayloadMessage,
  type ToolActivity,
} from "../lib/ipc";
import {
  composeContent,
  imagesOf,
  MAX_ATTACHMENTS,
  extractLinks,
  parseAttachments,
  serializeAttachments,
  type Attachment,
} from "../lib/attachments";
import { copyText, hostOf, sortChats, uid } from "../lib/format";
import { t } from "../lib/i18n";
import { useModels } from "./models";
import { useSettings } from "./settings";
import { useUi } from "./ui";

export interface UiMessage extends Message {
  streaming?: boolean;
  /** Between tool steps: the model is working on its next move (no text yet). */
  working?: boolean;
}

export interface ChatError {
  code: ErrorCode;
}

interface Generation {
  messageId: string;
  model: string;
}

/** Key for the draft of a chat that does not exist yet. */
export const NEW_CHAT_DRAFT = "__new__";
const DRAFTS_KEY = "zap.drafts";

interface ChatsState {
  chats: Chat[];
  chatsLoaded: boolean;
  /** Sidebar groups in display order. */
  groups: ChatGroup[];
  activeId: string | null;
  messages: Record<string, UiMessage[]>;
  loadingMessages: Record<string, boolean>;
  generating: Record<string, Generation>;
  errors: Record<string, ChatError>;
  drafts: Record<string, string>;
  /** Attachments waiting to be sent, per draft key (kept in memory only). */
  pendingAttachments: Record<string, Attachment[]>;

  init: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  selectRelative: (delta: 1 | -1) => void;
  newChat: () => void;
  send: (text: string) => Promise<void>;
  stop: (chatId?: string) => void;
  regenerate: (messageId: string) => Promise<void>;
  retry: () => Promise<void>;
  editMessage: (messageId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  pin: (id: string, pinned: boolean) => Promise<void>;
  moveToGroup: (id: string, groupId: string | null) => Promise<void>;
  /** Creates a group at the end; moves `chatId` into it when given. */
  createGroup: (name: string, chatId?: string) => Promise<ChatGroup | null>;
  renameGroup: (id: string, name: string) => Promise<void>;
  setGroupColor: (id: string, color: string | null) => Promise<void>;
  toggleGroup: (id: string) => void;
  moveGroup: (id: string, delta: -1 | 1) => Promise<void>;
  deleteGroup: (id: string, deleteChats: boolean) => Promise<void>;
  exportChat: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  removeAll: () => Promise<void>;
  reload: () => Promise<void>;
  setChatModel: (model: string) => void;
  setDraft: (key: string, text: string) => void;
  addAttachments: (key: string, attachments: Attachment[]) => void;
  removeAttachment: (key: string, id: string) => void;
  copyLastReply: () => Promise<void>;
}

// --- Token batching --------------------------------------------------------
// Tokens arrive far faster than the screen refreshes. Buffer them per chat
// and commit once per animation frame. Only the streaming message object is
// replaced, so memoized older messages never re-render.
const pending = new Map<string, string>();
let frame = 0;

function flushTokens() {
  frame = 0;
  if (pending.size === 0) return;
  const { messages, generating } = useChats.getState();
  const next = { ...messages };
  for (const [chatId, text] of pending) {
    const gen = generating[chatId];
    const list = next[chatId];
    if (!gen || !list) continue;
    const idx = list.findIndex((m) => m.id === gen.messageId);
    const target = list[idx];
    if (!target) continue;
    const copy = list.slice();
    copy[idx] = { ...target, content: target.content + text, working: false };
    next[chatId] = copy;
  }
  pending.clear();
  useChats.setState({ messages: next });
}

function queueToken(chatId: string, content: string) {
  pending.set(chatId, (pending.get(chatId) ?? "") + content);
  if (!frame) frame = requestAnimationFrame(flushTokens);
}

function flushNow() {
  if (frame) cancelAnimationFrame(frame);
  flushTokens();
}

// --- Helpers -----------------------------------------------------------------

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function upsertChat(chats: Chat[], chat: Chat): Chat[] {
  return sortChats([chat, ...chats.filter((c) => c.id !== chat.id)]);
}

function loadDrafts(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

let draftTimer = 0;
function persistDrafts(drafts: Record<string, string>) {
  window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    } catch {
      // Drafts are a convenience; losing them is acceptable.
    }
  }, 300);
}

function toNew(m: UiMessage, stats?: ChatStats | null) {
  return {
    id: m.id,
    chat_id: m.chat_id,
    role: m.role,
    content: m.content,
    created_at: m.created_at,
    model: m.model,
    stats: stats ?? null,
    attachments: m.attachments,
    tools: m.tools,
  };
}

/** A stored message as the model sees it (text files inlined, images for vision models). */
function toPayload(m: UiMessage, vision: boolean): PayloadMessage {
  const attachments = parseAttachments(m.attachments);
  if (attachments.length === 0) return { role: m.role, content: m.content };
  const images = vision ? imagesOf(attachments) : [];
  return {
    role: m.role,
    content: composeContent(m.content, attachments, vision),
    ...(images.length > 0 ? { images } : {}),
  };
}

/** "Current date and time: Monday, 9 November 2026, 12:45 (user's local time, UTC+01:00)." */
export function dateContext(now = new Date()): string {
  const when = now.toLocaleString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const mm = String(Math.abs(offset) % 60).padStart(2, "0");
  return `Current date and time: ${when.replace(" at ", ", ")} (the user's local time, UTC${sign}${hh}:${mm}).`;
}

/** Tool activity of a reply (stored as JSON). */
export function parseTools(raw: string | null | undefined): ToolActivity[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ToolActivity[]) : [];
  } catch {
    return [];
  }
}

export const useChats = create<ChatsState>((set, get) => {
  const setMessages = (chatId: string, list: UiMessage[]) => set({ messages: { ...get().messages, [chatId]: list } });

  /** Adds or updates one tool activity on the reply being generated. */
  function applyToolActivity(chatId: string, activity: ToolActivity) {
    const gen = get().generating[chatId];
    const list = get().messages[chatId];
    if (!gen || !list) return;
    setMessages(
      chatId,
      list.map((m) => {
        if (m.id !== gen.messageId) return m;
        const current = parseTools(m.tools);
        const idx = current.findIndex((a) => a.id === activity.id);
        const next = idx >= 0 ? current.map((a, i) => (i === idx ? activity : a)) : [...current, activity];
        // A finished step means the model is busy with the next one.
        const working = activity.status !== "pending" && activity.status !== "running";
        return { ...m, tools: JSON.stringify(next), working };
      }),
    );
  }

  /** Ends a generation: persists what was streamed, or drops an empty reply. */
  async function finish(chatId: string, error: ErrorCode | null, stats: ChatStats | null, stopped: boolean) {
    flushNow();
    const gen = get().generating[chatId];
    if (!gen) return;
    const list = get().messages[chatId] ?? [];
    const msg = list.find((m) => m.id === gen.messageId);
    set({
      generating: without(get().generating, chatId),
      errors: error ? { ...get().errors, [chatId]: { code: error } } : get().errors,
    });

    if (!msg || msg.content.trim() === "") {
      setMessages(
        chatId,
        list.filter((m) => m.id !== gen.messageId),
      );
      if (!error) useUi.getState().announce(t.chat.stopped);
      return;
    }

    const statsText = stats ? JSON.stringify(stats) : null;
    setMessages(
      chatId,
      list.map((m) => (m.id === gen.messageId ? { ...m, streaming: false, stats: statsText } : m)),
    );
    useUi.getState().announce(stopped ? t.chat.stopped : t.chat.replyDone);

    try {
      const { chat } = await api.saveMessage(toNew(msg, stats));
      if (chat) set({ chats: upsertChat(get().chats, chat) });
    } catch (err) {
      toast(toAppError(err).code === "disk_full" ? t.errors.diskFull : t.errors.generic);
    }

    // First reply of a chat: let the model title it (fallback is server-side).
    const firstReply = list.filter((m) => m.role === "assistant").length === 1;
    if (firstReply && !error && !stopped) {
      void api
        .generateTitle(chatId, gen.model)
        .then((chat) => chat && set({ chats: upsertChat(get().chats, chat) }))
        .catch(() => undefined);
    }
  }

  /** Starts streaming an assistant reply for the chat's current history. */
  /** Chats whose reply is still waiting for linked pages (stop ends it locally). */
  const readingLinks = new Set<string>();

  /** Reads web pages linked in the last user message (once) and stores their
   *  text as attachments, so every model gets the content. Shows a card per
   *  link on the reply being generated. */
  async function readLinks(chatId: string) {
    if (!useSettings.getState().settings.read_links) return;
    const user = [...(get().messages[chatId] ?? [])].reverse().find((m) => m.role === "user");
    if (!user) return;
    const inText = extractLinks(user.content);
    const stored = parseAttachments(user.attachments);
    // Pages whose link was edited out of the message are dropped.
    const existing = stored.filter((a) => !a.url || inText.includes(a.url));
    const known = new Set(existing.map((a) => a.url));
    const links = inText.filter((url) => !known.has(url));
    if (links.length === 0) {
      if (existing.length !== stored.length) await saveAttachments(chatId, user, existing);
      return;
    }

    const pages = await Promise.all(
      links.map(async (url): Promise<Attachment | null> => {
        const activity: ToolActivity = { id: uid(), name: "fetch_page", input: url, status: "running", sources: [] };
        applyToolActivity(chatId, activity);
        try {
          const { page, error } = await api.readLink(url);
          if (page) {
            const title = page.title || hostOf(page.url);
            applyToolActivity(chatId, { ...activity, status: "done", sources: [{ title, url: page.url }] });
            return {
              id: uid(),
              name: title,
              kind: "text",
              mime: "text/html",
              size: page.text.length,
              data: page.text,
              url,
            };
          }
          applyToolActivity(chatId, { ...activity, status: "error", error: error ?? "fetch_failed" });
        } catch {
          applyToolActivity(chatId, { ...activity, status: "error", error: "fetch_failed" });
        }
        return null;
      }),
    );
    const read = pages.filter((p): p is Attachment => p !== null);
    if (read.length > 0 || existing.length !== stored.length)
      await saveAttachments(chatId, user, [...existing, ...read]);
  }

  async function saveAttachments(chatId: string, message: UiMessage, attachments: Attachment[]) {
    const updated = { ...message, attachments: serializeAttachments(attachments) };
    setMessages(
      chatId,
      (get().messages[chatId] ?? []).map((m) => (m.id === message.id ? updated : m)),
    );
    await api.saveMessage(toNew(updated)).catch(() => undefined);
  }

  async function generate(chatId: string, model: string) {
    // Images only go to vision models; others get a text placeholder.
    const { vision, tools } = await useModels.getState().ensureCaps(model);

    const assistant: UiMessage = {
      id: uid(),
      chat_id: chatId,
      role: "assistant",
      content: "",
      created_at: Date.now(),
      model,
      stats: null,
      attachments: null,
      tools: null,
      streaming: true,
    };
    set({
      messages: { ...get().messages, [chatId]: [...(get().messages[chatId] ?? []), assistant] },
      generating: { ...get().generating, [chatId]: { messageId: assistant.id, model } },
      errors: without(get().errors, chatId),
    });
    useUi.getState().announce(t.chat.replyStarted);

    readingLinks.add(chatId);
    await readLinks(chatId);
    readingLinks.delete(chatId);
    // Stopped or deleted while the links were read.
    if (get().generating[chatId]?.messageId !== assistant.id) return;

    const history = (get().messages[chatId] ?? []).filter(
      (m) => m.id !== assistant.id && (m.content.trim() !== "" || m.attachments),
    );
    const { system_prompt, temperature, context_length } = useSettings.getState().settings;
    const chat = get().chats.find((c) => c.id === chatId);
    const system = (chat?.system_prompt ?? system_prompt).trim();
    const payload = [
      // Models don't know the date; "today" or "tomorrow" need it.
      { role: "system" as const, content: dateContext() },
      ...(system ? [{ role: "system" as const, content: system }] : []),
      ...history.map((m) => toPayload(m, vision)),
    ];

    try {
      // Web tools only for models that can call tools.
      const { web_search_enabled, file_tools_enabled } = useSettings.getState().settings;
      const web = web_search_enabled && tools;
      const files = file_tools_enabled && tools;
      await api.chatStream(chatId, model, payload, { temperature, num_ctx: context_length, web, files });
    } catch (err) {
      await finish(chatId, toAppError(err).code, null, false);
    }
  }

  function currentModel(): string | null {
    return useModels.getState().selected;
  }

  /** Removes `fromIdx` and everything after it, locally and in the DB. */
  async function truncateFrom(chatId: string, fromIdx: number) {
    const list = get().messages[chatId] ?? [];
    const keep = list.slice(0, fromIdx);
    setMessages(chatId, keep);
    const anchor = keep.at(-1);
    if (anchor) {
      await api.deleteMessagesAfter(chatId, anchor.id).catch(() => undefined);
    } else {
      await Promise.all(list.map((m) => api.deleteMessage(m.id).catch(() => undefined)));
    }
    return keep;
  }

  return {
    chats: [],
    chatsLoaded: false,
    groups: [],
    activeId: null,
    messages: {},
    loadingMessages: {},
    generating: {},
    errors: {},
    drafts: loadDrafts(),
    pendingAttachments: {},

    init: async () => {
      await Promise.all([
        events.onToken(({ chat_id, content }) => queueToken(chat_id, content)),
        events.onDone(({ chat_id, stats, stopped }) => void finish(chat_id, null, stats, stopped)),
        events.onTool(({ chat_id, activity }) => applyToolActivity(chat_id, activity)),
        events.onError(({ chat_id, error }) => void finish(chat_id, error.code, null, false)),
      ]);
      await get().reload();
    },

    reload: async () => {
      try {
        const [chats, groups] = await Promise.all([api.listChats(), api.listGroups()]);
        set({ chats: sortChats(chats), groups, chatsLoaded: true });
      } catch {
        set({ chatsLoaded: true });
        toast(t.errors.generic);
      }
    },

    select: async (id) => {
      set({ activeId: id });
      if (!id) return;
      const chat = get().chats.find((c) => c.id === id);
      const models = useModels.getState();
      if (chat?.model && models.installed.some((m) => m.name === chat.model)) {
        models.select(chat.model);
      }
      if (get().messages[id] || get().generating[id]) return;
      set({ loadingMessages: { ...get().loadingMessages, [id]: true } });
      try {
        const msgs = await api.getMessages(id);
        set({ messages: { ...get().messages, [id]: msgs } });
      } catch {
        toast(t.errors.generic);
      } finally {
        set({ loadingMessages: without(get().loadingMessages, id) });
      }
    },

    selectRelative: (delta) => {
      const { chats, activeId } = get();
      if (chats.length === 0) return;
      const idx = activeId ? chats.findIndex((c) => c.id === activeId) : -1;
      const nextIdx = idx < 0 ? (delta > 0 ? 0 : chats.length - 1) : idx + delta;
      const next = chats[Math.max(0, Math.min(chats.length - 1, nextIdx))];
      if (next && next.id !== activeId) void get().select(next.id);
    },

    newChat: () => {
      // Created lazily on the first message, so empty chats never pile up.
      set({ activeId: null });
    },

    send: async (raw) => {
      const text = raw.trim();
      const model = currentModel();
      const pendingKey = get().activeId ?? NEW_CHAT_DRAFT;
      const attachments = get().pendingAttachments[pendingKey] ?? [];
      if (!text && attachments.length === 0) return;
      if (!model) {
        toast(t.models.noModel);
        return;
      }

      let chatId = get().activeId;
      if (chatId && get().generating[chatId]) return;
      const draftKey = chatId ?? NEW_CHAT_DRAFT;
      if (!chatId) {
        try {
          const chat = await api.createChat(model);
          chatId = chat.id;
          set({
            chats: upsertChat(get().chats, chat),
            activeId: chat.id,
            messages: { ...get().messages, [chat.id]: [] },
          });
        } catch {
          toast(t.errors.generic);
          return;
        }
      }
      get().setDraft(draftKey, "");
      set({ pendingAttachments: without(get().pendingAttachments, draftKey) });

      const user: UiMessage = {
        id: uid(),
        chat_id: chatId,
        role: "user",
        content: text,
        created_at: Date.now(),
        model: null,
        stats: null,
        attachments: serializeAttachments(attachments),
        tools: null,
      };
      setMessages(chatId, [...(get().messages[chatId] ?? []), user]);
      try {
        const { chat } = await api.saveMessage(toNew(user));
        if (chat) set({ chats: upsertChat(get().chats, chat) });
      } catch {
        toast(t.errors.generic);
      }
      await generate(chatId, model);
    },

    stop: (chatId) => {
      const id = chatId ?? get().activeId;
      if (!id || !get().generating[id]) return;
      // Still reading links: nothing runs in the backend yet, end it here.
      if (readingLinks.delete(id)) void finish(id, null, null, true);
      else void api.stopGeneration(id);
    },

    regenerate: async (messageId) => {
      const chatId = get().activeId;
      const model = currentModel();
      if (!chatId || !model || get().generating[chatId]) return;
      const list = get().messages[chatId] ?? [];
      const idx = list.findIndex((m) => m.id === messageId);
      if (idx < 0 || list[idx]?.role !== "assistant") return;
      const keep = await truncateFrom(chatId, idx);
      if (keep.at(-1)?.role === "user") await generate(chatId, model);
    },

    retry: async () => {
      const chatId = get().activeId;
      if (!chatId) return;
      set({ errors: without(get().errors, chatId) });
      const last = (get().messages[chatId] ?? []).at(-1);
      if (last?.role === "assistant") {
        await get().regenerate(last.id);
      } else if (last?.role === "user") {
        const model = currentModel();
        if (model) await generate(chatId, model);
      }
    },

    editMessage: async (messageId, raw) => {
      const content = raw.trim();
      const chatId = get().activeId;
      const model = currentModel();
      if (!chatId || !content || !model || get().generating[chatId]) return;
      const list = get().messages[chatId] ?? [];
      const idx = list.findIndex((m) => m.id === messageId);
      const target = list[idx];
      if (!target || target.role !== "user") return;

      setMessages(chatId, [...list.slice(0, idx), { ...target, content }]);
      try {
        await api.updateMessage(messageId, content);
        await api.deleteMessagesAfter(chatId, messageId);
      } catch {
        toast(t.errors.generic);
      }
      await generate(chatId, model);
    },

    deleteMessage: async (messageId) => {
      const chatId = get().activeId;
      if (!chatId) return;
      setMessages(
        chatId,
        (get().messages[chatId] ?? []).filter((m) => m.id !== messageId),
      );
      try {
        await api.deleteMessage(messageId);
      } catch {
        toast(t.errors.generic);
      }
    },

    rename: async (id, title) => {
      // Empty means untitled; the UI shows "New chat" in the active language.
      const clean = title.trim();
      set({ chats: get().chats.map((c) => (c.id === id ? { ...c, title: clean } : c)) });
      await api.renameChat(id, clean).catch(() => toast(t.errors.generic));
    },

    pin: async (id, pinned) => {
      set({ chats: sortChats(get().chats.map((c) => (c.id === id ? { ...c, pinned } : c))) });
      await api.pinChat(id, pinned).catch(() => toast(t.errors.generic));
    },

    moveToGroup: async (id, groupId) => {
      set({ chats: get().chats.map((c) => (c.id === id ? { ...c, group_id: groupId } : c)) });
      // Moving into a collapsed group opens it, so the chat doesn't vanish.
      if (groupId) {
        const group = get().groups.find((g) => g.id === groupId);
        if (group?.collapsed) get().toggleGroup(groupId);
      }
      await api.setChatGroup(id, groupId).catch(() => toast(t.errors.generic));
    },

    createGroup: async (name, chatId) => {
      const clean = name.trim();
      if (!clean) return null;
      try {
        const group = await api.createGroup(clean);
        set({ groups: [...get().groups, group] });
        if (chatId) await get().moveToGroup(chatId, group.id);
        return group;
      } catch {
        toast(t.errors.generic);
        return null;
      }
    },

    renameGroup: async (id, name) => {
      const clean = name.trim();
      if (!clean) return;
      set({ groups: get().groups.map((g) => (g.id === id ? { ...g, name: clean } : g)) });
      await api.renameGroup(id, clean).catch(() => toast(t.errors.generic));
    },

    setGroupColor: async (id, color) => {
      set({ groups: get().groups.map((g) => (g.id === id ? { ...g, color } : g)) });
      await api.setGroupColor(id, color).catch(() => toast(t.errors.generic));
    },

    toggleGroup: (id) => {
      const group = get().groups.find((g) => g.id === id);
      if (!group) return;
      const collapsed = !group.collapsed;
      set({ groups: get().groups.map((g) => (g.id === id ? { ...g, collapsed } : g)) });
      void api.setGroupCollapsed(id, collapsed).catch(() => undefined);
    },

    moveGroup: async (id, delta) => {
      const groups = [...get().groups];
      const from = groups.findIndex((g) => g.id === id);
      const to = from + delta;
      const item = groups[from];
      if (!item || to < 0 || to >= groups.length) return;
      groups.splice(from, 1);
      groups.splice(to, 0, item);
      set({ groups: groups.map((g, i) => ({ ...g, position: i })) });
      await api.reorderGroups(groups.map((g) => g.id)).catch(() => toast(t.errors.generic));
    },

    deleteGroup: async (id, deleteChats) => {
      try {
        await api.deleteGroup(id, deleteChats);
      } catch {
        toast(t.errors.generic);
        return;
      }
      const inGroup = new Set(
        get()
          .chats.filter((c) => c.group_id === id)
          .map((c) => c.id),
      );
      const drop = <T>(record: Record<string, T>) =>
        Object.fromEntries(Object.entries(record).filter(([k]) => !inGroup.has(k)));
      if (deleteChats) {
        set({
          chats: get().chats.filter((c) => !inGroup.has(c.id)),
          messages: drop(get().messages),
          generating: drop(get().generating),
          errors: drop(get().errors),
          activeId: inGroup.has(get().activeId ?? "") ? null : get().activeId,
        });
        for (const chatId of inGroup) get().setDraft(chatId, "");
      } else {
        set({ chats: get().chats.map((c) => (inGroup.has(c.id) ? { ...c, group_id: null } : c)) });
      }
      set({ groups: get().groups.filter((g) => g.id !== id) });
    },

    exportChat: async (id) => {
      try {
        if (await api.exportChat(id)) toast(t.sidebar.exported);
      } catch (err) {
        toast(toAppError(err).code === "disk_full" ? t.errors.diskFull : t.errors.generic);
      }
    },

    remove: async (id) => {
      try {
        await api.deleteChat(id);
      } catch {
        toast(t.errors.generic);
        return;
      }
      set({
        chats: get().chats.filter((c) => c.id !== id),
        messages: without(get().messages, id),
        generating: without(get().generating, id),
        errors: without(get().errors, id),
        activeId: get().activeId === id ? null : get().activeId,
      });
      get().setDraft(id, "");
    },

    removeAll: async () => {
      try {
        await api.deleteAllChats();
      } catch {
        toast(t.errors.generic);
        return;
      }
      set({ chats: [], messages: {}, generating: {}, errors: {}, activeId: null, drafts: {}, pendingAttachments: {} });
      persistDrafts({});
      toast(t.settings.data.deletedAll);
    },

    setChatModel: (model) => {
      useModels.getState().select(model);
      const id = get().activeId;
      if (!id) return;
      set({ chats: get().chats.map((c) => (c.id === id ? { ...c, model } : c)) });
      void api.setChatModel(id, model).catch(() => undefined);
    },

    setDraft: (key, text) => {
      const drafts = text ? { ...get().drafts, [key]: text } : without(get().drafts, key);
      set({ drafts });
      persistDrafts(drafts);
    },

    addAttachments: (key, attachments) => {
      const current = get().pendingAttachments[key] ?? [];
      const room = MAX_ATTACHMENTS - current.length;
      if (attachments.length > room) toast(t.attach.tooMany(MAX_ATTACHMENTS));
      if (room <= 0) return;
      set({ pendingAttachments: { ...get().pendingAttachments, [key]: [...current, ...attachments.slice(0, room)] } });
    },

    removeAttachment: (key, id) => {
      const next = (get().pendingAttachments[key] ?? []).filter((a) => a.id !== id);
      set({
        pendingAttachments:
          next.length > 0 ? { ...get().pendingAttachments, [key]: next } : without(get().pendingAttachments, key),
      });
    },

    copyLastReply: async () => {
      const id = get().activeId;
      const last = id
        ? [...(get().messages[id] ?? [])].reverse().find((m) => m.role === "assistant" && !m.streaming)
        : undefined;
      if (!last) {
        toast(t.toast.nothingToCopy);
        return;
      }
      toast((await copyText(last.content)) ? t.toast.copied : t.errors.generic);
    },
  };
});
