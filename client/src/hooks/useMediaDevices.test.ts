import { describe, it, expect, vi, afterEach } from "vitest";
import { watchDeviceChanges } from "./useMediaDevices";

afterEach(() => vi.unstubAllGlobals());

describe("watchDeviceChanges", () => {
  // Regression: this threw on plain HTTP, leaving a blank page.
  it("does nothing on an insecure origin, where mediaDevices is undefined", () => {
    vi.stubGlobal("navigator", {});

    expect(() => watchDeviceChanges(() => {})()).not.toThrow();
  });

  it("subscribes and unsubscribes the handler", () => {
    const mediaDevices = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("navigator", { mediaDevices });
    const onChange = () => {};

    const stop = watchDeviceChanges(onChange);
    expect(mediaDevices.addEventListener).toHaveBeenCalledWith("devicechange", onChange);

    stop();
    expect(mediaDevices.removeEventListener).toHaveBeenCalledWith("devicechange", onChange);
  });
});
