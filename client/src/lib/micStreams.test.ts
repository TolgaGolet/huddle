import { describe, it, expect, vi } from "vitest";
import { stopStreams } from "./micStreams";

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
