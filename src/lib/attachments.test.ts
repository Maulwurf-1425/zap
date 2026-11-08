import { describe, expect, it } from "vitest";
import {
  attachmentFromBase64,
  classify,
  composeContent,
  imagesOf,
  parseAttachments,
  serializeAttachments,
  type Attachment,
} from "./attachments";

const text = (name: string, data: string): Attachment => ({
  id: name,
  name,
  kind: "text",
  mime: "text/plain",
  size: data.length,
  data,
});
const image = (name: string): Attachment => ({
  id: name,
  name,
  kind: "image",
  mime: "image/jpeg",
  size: 10,
  data: "data:image/jpeg;base64,QUJD",
});

describe("attachments", () => {
  it("classifies files by type and extension", () => {
    expect(classify({ name: "photo.JPG", type: "" })).toBe("image");
    expect(classify({ name: "x", type: "image/webp" })).toBe("image");
    expect(classify({ name: "main.rs", type: "" })).toBe("text");
    expect(classify({ name: "Dockerfile", type: "" })).toBe("text");
    expect(classify({ name: "readme", type: "text/plain" })).toBe("text");
    expect(classify({ name: "report.docx", type: "application/vnd.openxmlformats" })).toBeNull();
    expect(classify({ name: "tool.exe", type: "application/x-msdownload" })).toBeNull();
  });

  it("inlines text files into the message", () => {
    const out = composeContent("Explain this", [text("app.ts", "const a = 1;\n")], true);
    expect(out).toBe("Explain this\n\n[File: app.ts]\n```ts\nconst a = 1;\n```");
  });

  it("uses a longer fence when the file contains backticks", () => {
    const out = composeContent("", [text("README.md", "```js\nx\n```")], true);
    expect(out.startsWith("[File: README.md]\n````md\n")).toBe(true);
    expect(out.endsWith("\n````")).toBe(true);
  });

  it("sends images separately to vision models, placeholders otherwise", () => {
    const atts = [image("cat.jpg"), text("a.txt", "hi")];
    expect(composeContent("Look", atts, true)).not.toContain("[Image:");
    expect(composeContent("Look", atts, false)).toContain("[Image: cat.jpg]");
    expect(imagesOf(atts)).toEqual(["data:image/jpeg;base64,QUJD"]);
  });

  it("labels mentioned files with their full path", async () => {
    const att = await attachmentFromBase64(
      { name: "notes.txt", path: "C:\\Users\\me\\notes.txt", base64: btoa("hello") },
      false,
    );
    expect(att.path).toBe("C:\\Users\\me\\notes.txt");
    expect(att.data).toBe("hello");
    expect(composeContent("Fix typos", [att], false)).toContain("[File: C:\\Users\\me\\notes.txt]");
  });

  it("serializes and parses safely", () => {
    expect(serializeAttachments([])).toBeNull();
    const atts = [image("x.png")];
    expect(parseAttachments(serializeAttachments(atts))).toEqual(atts);
    expect(parseAttachments("broken")).toEqual([]);
    expect(parseAttachments(null)).toEqual([]);
  });
});
