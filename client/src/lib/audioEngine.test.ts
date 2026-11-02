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

describe("AudioEngine input", () => {
  function stubCapture(state = "running", resume: () => Promise<void> = () => Promise.resolve()) {
    const sources: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
    const contexts: { close: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal(
      "AudioContext",
      class {
        state = state;
        close = vi.fn();
        resume = resume;
        constructor() {
          contexts.push(this);
        }
        createAnalyser = () => ({ fftSize: 0, disconnect: vi.fn() });
        createMediaStreamSource = () => {
          const source = { connect: vi.fn(), disconnect: vi.fn() };
          sources.push(source);
          return source;
        };
      },
    );
    return { sources, contexts };
  }
  const stream = {} as MediaStream;

  it("has no analyser until a stream is attached", async () => {
    stubCapture();
    const engine = new AudioEngine();
    expect(engine.getAnalyser()).toBeNull();

    await engine.setInputStream(stream);

    expect(engine.getAnalyser()?.fftSize).toBe(512);
  });

  it("disconnects the previous source when the input changes", async () => {
    const { sources, contexts } = stubCapture();
    const engine = new AudioEngine();

    await engine.setInputStream(stream);
    await engine.setInputStream(stream);

    expect(contexts).toHaveLength(1);
    expect(sources[0].disconnect).toHaveBeenCalled();
    expect(sources[1].connect).toHaveBeenCalledWith(engine.getAnalyser());
  });

  it("asks for a gesture but still attaches when the context can't resume", async () => {
    const { sources } = stubCapture("suspended", () => Promise.reject(new Error("blocked")));
    const engine = new AudioEngine();
    const onHealth = vi.fn();
    engine.onHealth(onHealth);

    await engine.setInputStream(stream);

    expect(onHealth).toHaveBeenCalledWith(true);
    expect(sources).toHaveLength(1);
  });

  it("releases everything on destroy and stops reporting health", async () => {
    const { contexts } = stubCapture();
    const engine = new AudioEngine();
    const onHealth = vi.fn();
    engine.onHealth(onHealth);
    await engine.setInputStream(stream);

    engine.destroy();

    expect(contexts[0].close).toHaveBeenCalled();
    expect(engine.getAnalyser()).toBeNull();
    await engine.resume();
    expect(onHealth).not.toHaveBeenCalled();
  });

  it("survives a health listener that throws", async () => {
    stubCapture();
    const engine = new AudioEngine();
    const after = vi.fn();
    engine.onHealth(() => {
      throw new Error("listener");
    });
    engine.onHealth(after);

    await engine.resume();

    expect(after).toHaveBeenCalledWith(false);
  });

  it("stops notifying a listener that unsubscribed", async () => {
    stubCapture();
    const engine = new AudioEngine();
    const onHealth = vi.fn();
    engine.onHealth(onHealth)();

    await engine.resume();

    expect(onHealth).not.toHaveBeenCalled();
  });
});

describe("RemoteAudioManager playback", () => {
  interface FakeAudio {
    paused: boolean;
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
    srcObject: unknown;
    volume: number;
    onpause: (() => void) | null;
  }

  function stubPlayback({ state = "running", play = () => Promise.resolve() as Promise<void> } = {}) {
    const audios: FakeAudio[] = [];
    const contexts: { state: string; resume: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
    const oscillators: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
    const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    vi.stubGlobal(
      "AudioContext",
      class {
        state = state;
        currentTime = 0;
        destination = {};
        resume = vi.fn(async () => {});
        close = vi.fn();
        constructor() {
          contexts.push(this);
        }
        createOscillator = () => {
          const osc = { ...node(), start: vi.fn(), stop: vi.fn() };
          oscillators.push(osc);
          return osc;
        };
        createMediaStreamSource = node;
        createAnalyser = node;
        createGain = () => ({ ...node(), gain: { value: 1, setTargetAtTime: vi.fn() } });
      },
    );
    vi.stubGlobal(
      "Audio",
      class implements FakeAudio {
        paused = false;
        play = vi.fn(play);
        pause = vi.fn();
        load = vi.fn();
        srcObject: unknown = null;
        volume = 1;
        onpause: (() => void) | null = null;
        constructor() {
          audios.push(this);
        }
      },
    );
    return { audios, contexts, oscillators };
  }

  const stream = {} as MediaStream;

  it("activates the stream through a silent element rather than a muted one", () => {
    const { audios } = stubPlayback();
    new RemoteAudioManager().addStream("peer", stream);

    expect(audios[0].srcObject).toBe(stream);
    expect(audios[0].volume).toBe(0);
    expect(audios[0].play).toHaveBeenCalled();
  });

  it("exposes one analyser per peer", () => {
    stubPlayback();
    const manager = new RemoteAudioManager();

    manager.addStream("a", stream);
    manager.addStream("b", stream);
    manager.addStream("a", stream);

    expect([...manager.getAnalysers().keys()]).toEqual(["b", "a"]);
  });

  it("tears down the old element when a peer's stream is replaced, without flagging a block", () => {
    const { audios } = stubPlayback();
    const manager = new RemoteAudioManager();
    const onHealth = vi.fn();
    manager.onHealth(onHealth);
    manager.addStream("peer", stream);

    manager.addStream("peer", stream);

    expect(audios[0].pause).toHaveBeenCalled();
    expect(audios[0].srcObject).toBeNull();
    expect(audios[0].onpause).toBeNull();
    expect(onHealth).not.toHaveBeenCalled();
  });

  it("flags a block when autoplay refuses the element", async () => {
    stubPlayback({ play: () => Promise.reject(new Error("autoplay")) });
    const manager = new RemoteAudioManager();
    const onHealth = vi.fn();
    manager.onHealth(onHealth);

    manager.addStream("peer", stream);
    await Promise.resolve();
    await Promise.resolve();

    expect(onHealth).toHaveBeenCalledWith(true);
  });

  it("flags a block when the element pauses later", () => {
    const { audios } = stubPlayback();
    const manager = new RemoteAudioManager();
    const onHealth = vi.fn();
    manager.onHealth(onHealth);
    manager.addStream("peer", stream);

    audios[0].onpause!();

    expect(onHealth).toHaveBeenCalledWith(true);
  });

  it("has nothing to resume before any stream", async () => {
    stubPlayback();

    expect(await new RemoteAudioManager().resumePlayback()).toBe(false);
  });

  it("reports healthy only when the context runs and every element plays", async () => {
    stubPlayback();
    const manager = new RemoteAudioManager();
    const onHealth = vi.fn();
    manager.onHealth(onHealth);
    manager.addStream("peer", stream);

    expect(await manager.resumePlayback()).toBe(true);
    expect(onHealth).toHaveBeenLastCalledWith(false);
  });

  // Regression: resuming used to report success while the context was still suspended.
  it("stays blocked while the context is suspended, even if the elements play", async () => {
    const { contexts } = stubPlayback({ state: "suspended" });
    const manager = new RemoteAudioManager();
    const onHealth = vi.fn();
    manager.onHealth(onHealth);
    manager.addStream("peer", stream);

    expect(await manager.resumePlayback()).toBe(false);
    expect(contexts[0].resume).toHaveBeenCalled();
    expect(onHealth).toHaveBeenLastCalledWith(true);
  });

  it("stays blocked while any element is still paused", async () => {
    const { audios } = stubPlayback();
    const manager = new RemoteAudioManager();
    manager.addStream("a", stream);
    manager.addStream("b", stream);
    audios[1].paused = true;

    expect(await manager.resumePlayback()).toBe(false);
  });

  it("keeps trying the other elements when one refuses to play", async () => {
    const { audios } = stubPlayback();
    const manager = new RemoteAudioManager();
    manager.addStream("a", stream);
    manager.addStream("b", stream);
    audios[0].play.mockRejectedValueOnce(new Error("blocked"));

    await manager.resumePlayback();

    expect(audios[1].play).toHaveBeenCalledTimes(2);
  });

  it("starts one keep-alive oscillator, however many peers join", () => {
    const { oscillators } = stubPlayback();
    const manager = new RemoteAudioManager();

    manager.addStream("a", stream);
    manager.addStream("b", stream);

    expect(oscillators).toHaveLength(1);
    expect(oscillators[0].start).toHaveBeenCalledOnce();
  });

  it("releases every peer and the context on destroy", () => {
    const { audios, contexts, oscillators } = stubPlayback();
    const manager = new RemoteAudioManager();
    manager.addStream("a", stream);
    manager.addStream("b", stream);

    manager.destroy();

    expect(manager.getAnalysers().size).toBe(0);
    expect(audios.every((a) => a.srcObject === null)).toBe(true);
    expect(oscillators[0].stop).toHaveBeenCalled();
    expect(contexts[0].close).toHaveBeenCalled();
  });
});
