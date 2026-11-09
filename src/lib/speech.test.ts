import { describe, expect, it } from "vitest";
import { detectLanguage, speakable, splitSentences } from "./speech";

describe("speech", () => {
  it("reads Markdown without code, URLs or symbols", () => {
    const md = [
      "## Ergebnis",
      "Das ist **wichtig** und *schön*. Mehr bei [BBC](https://bbc.com) oder https://example.com.",
      "- erster Punkt",
      "- zweiter Punkt",
      "```js",
      "console.log(1)",
      "```",
      "Nutze `npm test`.",
    ].join("\n");
    const out = speakable(md);
    expect(out).toContain("Ergebnis.");
    expect(out).toContain("Das ist wichtig und schön.");
    expect(out).toContain("Mehr bei BBC oder");
    expect(out).toContain("erster Punkt.");
    expect(out).not.toMatch(/console|https|\*\*|```|#/);
    expect(out).toContain("Nutze npm test.");
  });

  it("drops an unfinished code block while streaming", () => {
    expect(speakable("Hier ist der Code:\n```py\nprint(")).toBe("Hier ist der Code:");
  });

  it("reads tables as rows", () => {
    expect(speakable("| Name | Alter |\n|---|---|\n| Ana | 30 |")).toBe("Name, Alter.\nAna, 30.");
  });

  it("splits sentences but not dates or abbreviations", () => {
    const { sentences, rest } = splitSentences("Am 9. November ist es z. B. kalt. Dr. Who kommt! Und dann", false);
    expect(sentences).toEqual(["Am 9. November ist es z. B. kalt.", "Dr. Who kommt!"]);
    expect(rest).toBe("Und dann");
    expect(splitSentences("Version 3.5", false).sentences).toEqual([]);
    expect(splitSentences("Fertig. Ende", true).sentences).toEqual(["Fertig.", "Ende"]);
  });

  it("guesses the language", () => {
    expect(detectLanguage("Das ist eine gute Frage, und die Antwort ist nicht schwer.")).toBe("de");
    expect(detectLanguage("This is a good question and the answer is not hard.")).toBe("en");
    expect(detectLanguage("OK", "de")).toBe("de");
  });
});
