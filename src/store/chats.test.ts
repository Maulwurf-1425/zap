import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, DoneEvent, ErrorEvent, NewMessage, TokenEvent, ToolEvent } from "../lib/ipc";

// --- Mocks -------------------------------------------------------------------

const handlers: {
  token?: (e: TokenEvent) => void;
  done?: (e: DoneEvent) => void;
  error?: (e: ErrorEvent) => void;
  tool?: (e: ToolEvent) => void;
} = {};

let chatSeq = 0;
const makeChat = (id: string, extra: Partial<Chat> = {}): Chat => ({
  id,
  title: "",
  model: "m",
  created_at: 1,
  updated_at: 1,
  pinned: false,
  system_prompt: null,
  group_id: null,
  ...extra,
});

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    api: {
      createChat: vi.fn(() => Promise.resolve(makeChat(`c${++chatSeq}`))),
      saveMessage: vi.fn((m: NewMessage) => Promise.resolve({ message: m, chat: null })),
      chatStream: vi.fn(() => Promise.resolve()),
      stopGeneration: vi.fn(() => Promise.resolve()),
      generateTitle: vi.fn(() => Promise.resolve(null)),
      updateMessage: vi.fn(() => Promise.resolve()),
      deleteMessage: vi.fn(() => Promise.resolve()),
      deleteMessagesAfter: vi.fn(() => Promise.resolve(0)),
      pinChat: vi.fn(() => Promise.resolve()),
      listChats: vi.fn(() => Promise.resolve([])),
      listGroups: vi.fn(() => Promise.resolve([])),
      createGroup: vi.fn((name: string) =>
        Promise.resolve({ id: "g1", name, position: 0, collapsed: false, color: null }),
      ),
      setChatGroup: vi.fn(() => Promise.resolve()),
      setGroupCollapsed: vi.fn(() => Promise.resolve()),
      deleteGroup: vi.fn(() => Promise.resolve()),
      modelCapabilities: vi.fn((model: string) =>
        Promise.resolve({ vision: model.includes("vision"), tools: model.includes("tools") }),
      ),
    },
    events: {
      onToken: vi.fn((cb: (e: TokenEvent) => void) => ((handlers.token = cb), Promise.resolve(() => {}))),
      onDone: vi.fn((cb: (e: DoneEvent) => void) => ((handlers.done = cb), Promise.resolve(() => {}))),
      onTool: vi.fn((cb: (e: ToolEvent) => void) => ((handlers.tool = cb), Promise.resolve(() => {}))),
      onError: vi.fn((cb: (e: ErrorEvent) => void) => ((handlers.error = cb), Promise.resolve(() => {}))),
    },
  };
});
vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

// Run rAF callbacks on the next macrotask so batching is observable.
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));

const { api } = await import("../lib/ipc");
const { useChats } = await import("./chats");
const { useModels } = await import("./models");
const { useSettings, DEFAULT_SETTINGS } = await import("./settings");

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  vi.clearAllMocks();
  chatSeq = 0;
  useChats.setState({
    chats: [],
    groups: [],
    activeId: null,
    messages: {},
    generating: {},
    errors: {},
    drafts: {},
    pendingAttachments: {},
  });
  useModels.setState({ selected: "llama3.2:3b", installed: [], caps: {} });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, system_prompt: "Sei kurz.", context_length: 4096 } });
  await useChats.getState().init();
});

// --- Tests -------------------------------------------------------------------

describe("chat store", () => {
  it("sends, streams batched tokens and persists the reply", async () => {
    await useChats.getState().send("  Hallo  ");
    const chatId = useChats.getState().activeId!;
    expect(chatId).toBe("c1");

    // System prompt + user message, temperature and context length.
    expect(api.chatStream).toHaveBeenCalledWith(
      "c1",
      "llama3.2:3b",
      [
        { role: "system", content: "Sei kurz." },
        { role: "user", content: "Hallo" },
      ],
      { temperature: 0.7, num_ctx: 4096, web: false, files: false },
    );
    expect(useChats.getState().generating[chatId]).toBeDefined();

    handlers.token!({ chat_id: chatId, content: "Hi" });
    handlers.token!({ chat_id: chatId, content: " du" });
    // Batched: nothing rendered before the frame.
    expect(useChats.getState().messages[chatId]!.at(-1)!.content).toBe("");
    await tick();
    expect(useChats.getState().messages[chatId]!.at(-1)!.content).toBe("Hi du");

    const stats = { eval_count: 10, eval_duration_ns: 1e9, total_duration_ns: 2e9, tokens_per_sec: 10 };
    handlers.done!({ chat_id: chatId, stats, stopped: false });
    await tick();

    const state = useChats.getState();
    expect(state.generating[chatId]).toBeUndefined();
    const reply = state.messages[chatId]!.at(-1)!;
    expect(reply.streaming).toBe(false);
    expect(JSON.parse(reply.stats!)).toEqual(stats);
    expect(api.saveMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ role: "assistant", content: "Hi du", model: "llama3.2:3b", stats }),
    );
    expect(api.generateTitle).toHaveBeenCalledWith(chatId, "llama3.2:3b");
  });

  it("keeps concurrent streams of different chats apart", async () => {
    await useChats.getState().send("A?");
    useChats.setState({ activeId: null });
    await useChats.getState().send("B?");

    handlers.token!({ chat_id: "c1", content: "a1" });
    handlers.token!({ chat_id: "c2", content: "b1" });
    handlers.token!({ chat_id: "c1", content: "a2" });
    await tick();

    const { messages, generating } = useChats.getState();
    expect(messages.c1!.at(-1)!.content).toBe("a1a2");
    expect(messages.c2!.at(-1)!.content).toBe("b1");
    expect(Object.keys(generating).sort()).toEqual(["c1", "c2"]);

    handlers.done!({ chat_id: "c2", stats: null, stopped: false });
    await tick();
    expect(useChats.getState().generating.c1).toBeDefined();
    expect(useChats.getState().generating.c2).toBeUndefined();
  });

  it("keeps partial output on error and drops empty replies", async () => {
    await useChats.getState().send("Frage");
    handlers.token!({ chat_id: "c1", content: "Teil" });
    handlers.error!({ chat_id: "c1", error: { code: "provider_unreachable", message: "" } });
    await tick();
    let s = useChats.getState();
    expect(s.errors.c1).toEqual({ code: "provider_unreachable" });
    expect(s.messages.c1!.at(-1)!.content).toBe("Teil");

    // Retry regenerates: the partial reply is removed and a new one starts.
    await s.retry();
    s = useChats.getState();
    expect(api.deleteMessagesAfter).toHaveBeenCalled();
    expect(s.messages.c1!.at(-1)!.content).toBe("");
    handlers.done!({ chat_id: "c1", stats: null, stopped: true });
    await tick();
    expect(useChats.getState().messages.c1!.map((m) => m.role)).toEqual(["user"]);
  });

  it("edits a user message, discards later ones and regenerates", async () => {
    await useChats.getState().send("Eins");
    handlers.token!({ chat_id: "c1", content: "Antwort" });
    handlers.done!({ chat_id: "c1", stats: null, stopped: false });
    await tick();
    const userId = useChats.getState().messages.c1![0]!.id;

    await useChats.getState().editMessage(userId, "Zwei");
    expect(api.updateMessage).toHaveBeenCalledWith(userId, "Zwei");
    expect(api.deleteMessagesAfter).toHaveBeenCalledWith("c1", userId);
    const list = useChats.getState().messages.c1!;
    expect(list.map((m) => [m.role, m.content])).toEqual([
      ["user", "Zwei"],
      ["assistant", ""],
    ]);
    expect(useChats.getState().generating.c1).toBeDefined();
  });

  it("sorts pinned chats first", async () => {
    useChats.setState({
      chats: [makeChat("new", { updated_at: 5 }), makeChat("old", { updated_at: 1 })],
    });
    await useChats.getState().pin("old", true);
    expect(useChats.getState().chats.map((c) => c.id)).toEqual(["old", "new"]);
    expect(api.pinChat).toHaveBeenCalledWith("old", true);
  });

  it("groups chats and ungroups or deletes them with the group", async () => {
    useChats.setState({ chats: [makeChat("a"), makeChat("b")], activeId: "b" });
    const group = await useChats.getState().createGroup("  Work ", "a");
    expect(group?.name).toBe("Work");
    expect(api.setChatGroup).toHaveBeenCalledWith("a", "g1");
    expect(useChats.getState().chats.find((c) => c.id === "a")?.group_id).toBe("g1");

    // Moving into a collapsed group expands it.
    useChats.getState().toggleGroup("g1");
    expect(useChats.getState().groups[0]?.collapsed).toBe(true);
    await useChats.getState().moveToGroup("b", "g1");
    expect(useChats.getState().groups[0]?.collapsed).toBe(false);

    await useChats.getState().deleteGroup("g1", true);
    expect(api.deleteGroup).toHaveBeenCalledWith("g1", true);
    expect(useChats.getState().chats).toEqual([]);
    expect(useChats.getState().activeId).toBeNull();
    expect(useChats.getState().groups).toEqual([]);
  });

  it("stores drafts per chat and clears them on send", async () => {
    const { setDraft } = useChats.getState();
    setDraft("__new__", "Entwurf");
    setDraft("x", "anderer");
    expect(useChats.getState().drafts).toEqual({ __new__: "Entwurf", x: "anderer" });
    await useChats.getState().send("Entwurf");
    expect(useChats.getState().drafts).toEqual({ x: "anderer" });
  });

  it("sends attachments: text inlined for all, images only to vision models", async () => {
    const img = {
      id: "i1",
      name: "cat.jpg",
      kind: "image" as const,
      mime: "image/jpeg",
      size: 3,
      data: "data:image/jpeg;base64,QUJD",
    };
    const doc = { id: "d1", name: "notes.txt", kind: "text" as const, mime: "text/plain", size: 2, data: "hi" };

    useModels.setState({ selected: "llava-vision" });
    useChats.getState().addAttachments("__new__", [img, doc]);
    await useChats.getState().send("What is this?");

    const [, , payload] = vi.mocked(api.chatStream).mock.calls[0]!;
    const user = payload.at(-1)!;
    expect(user.images).toEqual([img.data]);
    expect(user.content).toContain("[File: notes.txt]");
    expect(user.content).not.toContain("[Image:");
    expect(useChats.getState().pendingAttachments).toEqual({});
    const saved = vi.mocked(api.saveMessage).mock.calls[0]![0];
    expect(JSON.parse(saved.attachments!)).toHaveLength(2);

    // Same history with a text-only model: image becomes a placeholder.
    handlers.done!({ chat_id: "c1", stats: null, stopped: false });
    await tick();
    useModels.setState({ selected: "llama3.2:3b" });
    await useChats.getState().send("And now?");
    const [, , payload2] = vi.mocked(api.chatStream).mock.calls[1]!;
    const firstUser = payload2.find((m) => m.role === "user")!;
    expect(firstUser.images).toBeUndefined();
    expect(firstUser.content).toContain("[Image: cat.jpg]");
  });

  it("sends a message with only attachments", async () => {
    const doc = { id: "d1", name: "a.md", kind: "text" as const, mime: "text/markdown", size: 1, data: "# A" };
    useChats.getState().addAttachments("__new__", [doc]);
    await useChats.getState().send("   ");
    expect(api.chatStream).toHaveBeenCalledTimes(1);
  });

  it("offers web tools only when enabled and the model can call tools", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, web_search_enabled: true } });
    await useChats.getState().send("No tools model");
    expect(vi.mocked(api.chatStream).mock.calls[0]![3]).toMatchObject({ web: false });

    handlers.done!({ chat_id: "c1", stats: null, stopped: false });
    await tick();
    useModels.setState({ selected: "qwen-tools" });
    await useChats.getState().send("Search please");
    expect(vi.mocked(api.chatStream).mock.calls[1]![3]).toMatchObject({ web: true });
  });

  it("attaches tool activity to the reply and saves it", async () => {
    useModels.setState({ selected: "qwen-tools" });
    await useChats.getState().send("What's new?");
    const running = { id: "c1", name: "web_search", input: "news", status: "running" as const, sources: [] };
    handlers.tool!({ chat_id: "c1", activity: running });
    handlers.tool!({
      chat_id: "c1",
      activity: { ...running, status: "done", sources: [{ title: "A", url: "https://a.example" }] },
    });
    handlers.token!({ chat_id: "c1", content: "Here you go." });
    await tick();
    const reply = useChats.getState().messages.c1!.at(-1)!;
    const tools = JSON.parse(reply.tools!) as { status: string }[];
    expect(tools).toHaveLength(1);
    expect(tools[0]!.status).toBe("done");

    handlers.done!({ chat_id: "c1", stats: null, stopped: false });
    await tick();
    expect(api.saveMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ role: "assistant", tools: reply.tools }),
    );
  });

  it("offers file tools only when enabled and the model can call tools", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, file_tools_enabled: true } });
    useModels.setState({ selected: "qwen-tools" });
    await useChats.getState().send("Find my notes");
    expect(vi.mocked(api.chatStream).mock.calls[0]![3]).toMatchObject({ files: true, web: false });
  });

  it("marks the reply as working between tool steps", async () => {
    useModels.setState({ selected: "qwen-tools" });
    await useChats.getState().send("Make a folder");
    const step = { id: "a1", name: "create_folder", input: "C:\\x", status: "pending" as const, sources: [] };
    handlers.tool!({ chat_id: "c1", activity: step });
    expect(useChats.getState().messages.c1!.at(-1)!.working).toBe(false);
    handlers.tool!({ chat_id: "c1", activity: { ...step, status: "done" } });
    expect(useChats.getState().messages.c1!.at(-1)!.working).toBe(true);
    handlers.token!({ chat_id: "c1", content: "Done." });
    await tick();
    expect(useChats.getState().messages.c1!.at(-1)!.working).toBe(false);
  });

  it("refuses to send without a model", async () => {
    useModels.setState({ selected: null });
    await useChats.getState().send("Hallo");
    expect(api.createChat).not.toHaveBeenCalled();
  });
});
