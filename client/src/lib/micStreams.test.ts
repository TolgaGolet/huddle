import { describe, it, expect, vi } from "vitest";
import { applyNoiseSuppression, stopStreams } from "./micStreams";

const fakeTrack = () => ({ stop: vi.fn() }) as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
const fakeStream = (...tracks: MediaStreamTrack[]) => ({ getTracks: () => tracks }) as unknown as MediaStream;

// Regression (Q-02): leaving the room stopped only the raw capture, so the
// independent outbound clone kept the microphone open.
describe("stopStreams", () => {
  it("stops both the raw track and its outbound clone", () => {
    const raw = fakeTrack();
    const clone = fakeTrack();
    stopStreams(fakeStream(raw), fakeStream(clone));
    expect(raw.stop).toHaveBeenCalledTimes(1);
    expect(clone.stop).toHaveBeenCalledTimes(1);
  });

  it("ignores missing streams", () => {
    const t = fakeTrack();
    expect(() => stopStreams(null, undefined, fakeStream(t))).not.toThrow();
    expect(t.stop).toHaveBeenCalledTimes(1);
  });

  it("stops a track shared by two streams only once", () => {
    const t = fakeTrack();
    const s = fakeStream(t);
    stopStreams(s, s);
    expect(t.stop).toHaveBeenCalledTimes(1);
  });
});

// Regression (F07): only the raw track was changed, not the clone peers receive.
describe("applyNoiseSuppression", () => {
  /** A track whose setting follows the constraint unless `reported` overrides it. */
  const constrainable = (reported?: { noiseSuppression?: boolean }) => {
    let applied: boolean | undefined;
    const applyConstraints = vi.fn(async (c: MediaTrackConstraints) => {
      applied = c.noiseSuppression as boolean;
    });
    return {
      applyConstraints,
      getSettings: () => reported ?? { noiseSuppression: applied },
    } as unknown as MediaStreamTrack & { applyConstraints: typeof applyConstraints };
  };

  it("applies to every track and resolves true when all took effect", async () => {
    const raw = constrainable();
    const clone = constrainable();
    await expect(applyNoiseSuppression([raw, clone], false)).resolves.toBe(true);
    expect(raw.applyConstraints).toHaveBeenCalledWith({ noiseSuppression: false });
    expect(clone.applyConstraints).toHaveBeenCalledWith({ noiseSuppression: false });
  });

  it("resolves false when a browser accepts the call but keeps the old setting", async () => {
    const stuck = constrainable({ noiseSuppression: true });
    await expect(applyNoiseSuppression([constrainable(), stuck], false)).resolves.toBe(false);
  });

  it("trusts a browser that doesn't report the setting", async () => {
    await expect(applyNoiseSuppression([constrainable({})], false)).resolves.toBe(true);
  });

  it("resolves false with no tracks, or a track that can't take constraints", async () => {
    await expect(applyNoiseSuppression([], true)).resolves.toBe(false);
    await expect(applyNoiseSuppression([{} as MediaStreamTrack], true)).resolves.toBe(false);
  });

  it("rejects when the browser refuses the constraint", async () => {
    const refusing = constrainable();
    refusing.applyConstraints.mockRejectedValue(new Error("OverconstrainedError"));
    await expect(applyNoiseSuppression([refusing], true)).rejects.toThrow();
  });
});
