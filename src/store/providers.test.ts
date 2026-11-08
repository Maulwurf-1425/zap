import { describe, expect, it } from "vitest";
import { anyRunning, enabledProviders, primaryProvider } from "./providers";
import { modelLabel, modelProvider } from "../lib/ipc";

describe("engines", () => {
  it("lists enabled engines and finds a running one", () => {
    const s = { ollama: "stopped", lmstudio: "running" } as const;
    expect(enabledProviders(s)).toEqual(["ollama", "lmstudio"]);
    expect(anyRunning(s)).toBe(true);
    expect(anyRunning({ ollama: "disabled", lmstudio: "not_found" })).toBe(false);
  });

  it("explains a starting engine first, then the first enabled one", () => {
    expect(primaryProvider({ ollama: "stopped", lmstudio: "starting" })).toEqual({
      kind: "lmstudio",
      status: "starting",
    });
    expect(primaryProvider({ ollama: "disabled", lmstudio: "not_found" })).toEqual({
      kind: "lmstudio",
      status: "not_found",
    });
    expect(primaryProvider({ ollama: "disabled", lmstudio: "disabled" })).toBeNull();
  });

  it("parses model keys like the backend", () => {
    expect(modelProvider("llama3.2:3b")).toBe("ollama");
    expect(modelProvider("lmstudio::qwen/qwen2.5-7b")).toBe("lmstudio");
    expect(modelLabel("lmstudio::qwen/qwen2.5-7b")).toBe("qwen/qwen2.5-7b");
    expect(modelLabel("mistral:7b")).toBe("mistral:7b");
  });
});
