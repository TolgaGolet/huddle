import { describe, it, expect, vi, afterEach } from "vitest";
import { AudioEngine } from "./audioEngine";

afterEach(() => vi.unstubAllGlobals());

function stubAudioContext(resume: (ctx: { state: string }) => Promise<void>) {
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "suspended";
      createAnalyser = () => ({});
      resume = () => resume(this);
    },
  );
}

describe("AudioEngine.resume", () => {
  it("keeps asking for a gesture when resuming fails", async () => {
    stubAudioContext(() => Promise.reject(new Error("blocked")));
    const engine = new AudioEngine();
    const onHealth = vi.fn();
    engine.onHealth(onHealth);

    await engine.resume();
    expect(onHealth).toHaveBeenLastCalledWith(true);
  });

  it("keeps asking when resuming settles but the context stays suspended", async () => {
    stubAudioContext(() => Promise.resolve());
    const engine = new AudioEngine();
    const onHealth = vi.fn();
    engine.onHealth(onHealth);

    await engine.resume();
    expect(onHealth).toHaveBeenLastCalledWith(true);
  });

  it("clears the request once the context is running", async () => {
    stubAudioContext(async (ctx) => {
      ctx.state = "running";
    });
    const engine = new AudioEngine();
    const onHealth = vi.fn();
    engine.onHealth(onHealth);

    await engine.resume();
    expect(onHealth).toHaveBeenLastCalledWith(false);
  });
});
