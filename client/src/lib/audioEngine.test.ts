import { describe, it, expect, vi, afterEach } from "vitest";
import { AudioEngine, RemoteAudioManager } from "./audioEngine";

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

describe("RemoteAudioManager volume", () => {
  /** Stubs the browser audio APIs and returns the gain nodes in creation order. */
  function stubPlayback() {
    const gains: { gain: { value: number; setTargetAtTime: ReturnType<typeof vi.fn> } }[] = [];
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        currentTime = 0;
        destination = {};
        createOscillator = () => ({ ...node(), start: vi.fn(), stop: vi.fn() });
        createMediaStreamSource = node;
        createAnalyser = node;
        createGain = () => {
          const gain = { ...node(), gain: { value: 1, setTargetAtTime: vi.fn() } };
          gains.push(gain);
          return gain;
        };
      },
    );
    vi.stubGlobal(
      "Audio",
      class {
        play = () => Promise.resolve();
        pause = vi.fn();
        load = vi.fn();
      },
    );
    return gains;
  }

  const stream = {} as MediaStream;
  const lastGain = (gains: ReturnType<typeof stubPlayback>) => gains[gains.length - 1].gain;

  // Regression: recovery rebuilt the gain at 100% while the slider still showed the old value.
  it("keeps a peer's volume when its audio path is recreated", () => {
    const gains = stubPlayback();
    const manager = new RemoteAudioManager();
    manager.addStream("peer", stream);
    manager.setVolume("peer", 0);
    expect(lastGain(gains).setTargetAtTime).toHaveBeenCalledWith(0, 0, expect.any(Number));

    manager.removeStream("peer");
    manager.addStream("peer", stream);

    expect(lastGain(gains).value).toBe(0);
  });

  it("applies a volume set before the stream arrives", () => {
    const gains = stubPlayback();
    const manager = new RemoteAudioManager();
    manager.setVolume("peer", 0.5);
    manager.addStream("peer", stream);

    expect(lastGain(gains).value).toBe(0.5);
  });

  it("starts other peers at full volume", () => {
    const gains = stubPlayback();
    const manager = new RemoteAudioManager();
    manager.setVolume("peer", 0.5);
    manager.addStream("other", stream);

    expect(lastGain(gains).value).toBe(1);
  });
});
