import { describe, expect, it } from "vitest";
import { anyRunning, enabledProviders, modelReady, nextInstall, primaryProvider } from "./providers";
import { cloudConnectionOf, modelLabel, modelProvider, type InstallPhase } from "../lib/ipc";

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

  it("tracks install progress forward only, with a smoothed speed", () => {
    const ev = (phase: InstallPhase, downloaded: number | null = null, total: number | null = null) => ({
      phase,
      downloaded,
      total,
    });
    let s = nextInstall(undefined, ev("preparing"), 0);
    s = nextInstall(s, ev("downloading", 0, 1000), 1000);
    s = nextInstall(s, ev("downloading", 500, null), 2000);
    expect(s).toMatchObject({ phase: "downloading", downloaded: 500, total: 1000, speed: 500, phaseAt: 1000 });

    s = nextInstall(s, ev("installing"), 3000);
    // A late download sample doesn't pull the phase back.
    s = nextInstall(s, ev("downloading", 900, 1000), 3100);
    expect(s?.phase).toBe("installing");
    expect(nextInstall(s, ev("failed"), 4000)?.phase).toBe("failed");

    // A finished install ignores stray events until a new one starts.
    const done = nextInstall(s, ev("done"), 5000);
    expect(nextInstall(done, ev("downloading", 1, 2), 6000)).toBe(done);
    expect(nextInstall(done, ev("preparing"), 7000)?.startedAt).toBe(7000);
  });

  it("parses model keys like the backend", () => {
    expect(modelProvider("llama3.2:3b")).toBe("ollama");
    expect(modelProvider("lmstudio::qwen/qwen2.5-7b")).toBe("lmstudio");
    expect(modelLabel("lmstudio::qwen/qwen2.5-7b")).toBe("qwen/qwen2.5-7b");
    expect(modelLabel("mistral:7b")).toBe("mistral:7b");
  });

  it("treats cloud models as always ready", () => {
    const key = "cloud::c1::meta-llama/llama-3.3-70b";
    expect(modelProvider(key)).toBe("cloud");
    expect(modelLabel(key)).toBe("meta-llama/llama-3.3-70b");
    expect(cloudConnectionOf(key)).toBe("c1");
    expect(cloudConnectionOf("mistral:7b")).toBeNull();
    const down = { ollama: "stopped", lmstudio: "disabled" } as const;
    expect(modelReady(down, key)).toBe(true);
    expect(modelReady(down, "mistral:7b")).toBe(false);
    expect(modelReady({ ollama: "running", lmstudio: "disabled" }, "mistral:7b")).toBe(true);
  });
});
