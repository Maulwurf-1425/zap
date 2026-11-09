import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
const { dateGroup, groupChats, formatBytes, percent } = await import("./format");

const NOW = new Date(2026, 10, 8, 15, 0).getTime();
const at = (daysAgo: number, hour = 12) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

describe("date grouping", () => {
  it("buckets by calendar day", () => {
    expect(dateGroup(at(0, 0), NOW)).toBe("today");
    expect(dateGroup(at(1, 23), NOW)).toBe("yesterday");
    expect(dateGroup(at(6), NOW)).toBe("week");
    expect(dateGroup(at(30), NOW)).toBe("older");
  });

  it("puts pinned chats in their own group", () => {
    const chat = (id: string, updated_at: number, pinned = false) => ({
      id,
      title: id,
      model: null,
      created_at: 0,
      updated_at,
      pinned,
      system_prompt: null,
      group_id: null,
    });
    const groups = groupChats([chat("a", at(0)), chat("b", at(30), true), chat("c", at(1))], NOW);
    expect(groups.pinned.map((c) => c.id)).toEqual(["b"]);
    expect(groups.today.map((c) => c.id)).toEqual(["a"]);
    expect(groups.yesterday.map((c) => c.id)).toEqual(["c"]);
  });
});

describe("formatting", () => {
  it("formats sizes in German", () => {
    expect(formatBytes(2.0e9)).toBe("2,0 GB");
    expect(formatBytes(512e6)).toBe("512,0 MB");
  });
  it("clamps percentages", () => {
    expect(percent(5, 0)).toBe(0);
    expect(percent(150, 100)).toBe(100);
  });
});
