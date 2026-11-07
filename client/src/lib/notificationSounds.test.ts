import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeContext {
  static created: FakeContext[] = [];
  state = "running";
  currentTime = 0;
  destination = {};
  resume = vi.fn();
  oscillators: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; frequency: { setValueAtTime: ReturnType<typeof vi.fn> } }[] = [];
  constructor() {
    FakeContext.created.push(this);
  }
  peakGains: number[] = [];
  createGain = () => ({
    connect: vi.fn(),
    gain: {
      setValueAtTime: vi.fn((value: number) => this.peakGains.push(value)),
      exponentialRampToValueAtTime: vi.fn(),
    },
  });
  createOscillator = () => {
    const osc = { type: "", connect: vi.fn(), start: vi.fn(), stop: vi.fn(), frequency: { setValueAtTime: vi.fn() } };
    this.oscillators.push(osc);
    return osc;
  };
}

// The context is a module-level singleton, so each test imports a fresh copy.
const load = () => import("./notificationSounds");

beforeEach(() => {
  vi.resetModules();
  FakeContext.created = [];
  vi.stubGlobal("AudioContext", FakeContext);
});

afterEach(() => vi.unstubAllGlobals());

describe("notification sounds", () => {
  it("shares one AudioContext between sounds", async () => {
    const { playJoinSound, playLeaveSound } = await load();

    playJoinSound();
    playLeaveSound();

    expect(FakeContext.created).toHaveLength(1);
  });

  it("creates a new context once the old one has closed", async () => {
    const { playJoinSound } = await load();
    playJoinSound();
    FakeContext.created[0].state = "closed";

    playJoinSound();

    expect(FakeContext.created).toHaveLength(2);
  });

  it("resumes a suspended context", async () => {
    const { playJoinSound } = await load();
    playJoinSound();
    FakeContext.created[0].state = "suspended";

    playJoinSound();

    expect(FakeContext.created[0].resume).toHaveBeenCalledOnce();
  });

  it("plays the disconnect cue as three consecutive notes, unlike the two-note leave", async () => {
    const { playDisconnectedSound, playLeaveSound } = await load();

    playLeaveSound();
    const leaveNotes = FakeContext.created[0].oscillators.length;
    playDisconnectedSound();
    const notes = FakeContext.created[0].oscillators.slice(leaveNotes);

    expect(leaveNotes).toBe(2);
    expect(notes).toHaveLength(3);
    expect(notes[0].stop.mock.calls[0][0]).toBeCloseTo(notes[1].start.mock.calls[0][0]);
    expect(notes[1].stop.mock.calls[0][0]).toBeCloseTo(notes[2].start.mock.calls[0][0]);
  });

  it("plays every cue loud enough to hear over a call, without letting two overlapping cues clip", async () => {
    const sounds = await load();
    const cues = [
      sounds.playJoinSound,
      sounds.playLeaveSound,
      sounds.playDisconnectedSound,
      sounds.playMuteSound,
      sounds.playUnmuteSound,
      sounds.playMessageSound,
    ];

    cues.forEach((play) => play());

    const peaks = FakeContext.created[0].peakGains;
    expect(peaks).toHaveLength(cues.length);
    for (const peak of peaks) {
      expect(peak).toBeGreaterThanOrEqual(0.2);
      expect(peak * 2).toBeLessThan(1);
    }
  });

  it("makes mute and unmute distinguishable by pitch direction", async () => {
    const { playMuteSound, playUnmuteSound } = await load();
    const pitches = (from: number) =>
      FakeContext.created[0].oscillators.slice(from).map((o) => o.frequency.setValueAtTime.mock.calls[0][0] as number);

    playMuteSound();
    playUnmuteSound();

    const [muteStart, muteEnd] = pitches(0);
    const [unmuteStart, unmuteEnd] = pitches(2);
    expect(muteEnd).toBeLessThan(muteStart);
    expect(unmuteEnd).toBeGreaterThan(unmuteStart);
  });
});
