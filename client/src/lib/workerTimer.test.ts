import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerInterval } from "./workerTimer";

class FakeWorker {
  static last: FakeWorker;
  onmessage: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor(public url: string) {
    FakeWorker.last = this;
  }
}

beforeEach(() => {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:timer"), revokeObjectURL: vi.fn() }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createWorkerInterval", () => {
  it("starts a worker at the requested interval and calls back on each tick", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const callback = vi.fn();

    createWorkerInterval(callback, 25);
    FakeWorker.last.onmessage!();
    FakeWorker.last.onmessage!();

    expect(FakeWorker.last.url).toBe("blob:timer");
    expect(FakeWorker.last.postMessage).toHaveBeenCalledWith({ action: "start", interval: 25 });
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("stops the worker and frees its URL", () => {
    vi.stubGlobal("Worker", FakeWorker);

    createWorkerInterval(() => {}, 25)();

    expect(FakeWorker.last.postMessage).toHaveBeenLastCalledWith({ action: "stop" });
    expect(FakeWorker.last.terminate).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:timer");
  });

  it("falls back to setInterval where workers are restricted", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("blocked");
        }
      },
    );
    const callback = vi.fn();

    const stop = createWorkerInterval(callback, 25);
    vi.advanceTimersByTime(50);
    expect(callback).toHaveBeenCalledTimes(2);

    stop();
    vi.advanceTimersByTime(50);
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
