import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AppSocket } from "../types";
import { resyncCallStateWhenLimited } from "./callStateResync";

function fakeSocket() {
  const listeners = new Set<(data: { event: string }) => void>();
  const emit = vi.fn();
  const socket = {
    connected: true,
    emit,
    on: (_event: string, fn: (data: { event: string }) => void) => listeners.add(fn),
    off: (_event: string, fn: (data: { event: string }) => void) => listeners.delete(fn),
  };
  const limit = (event: string) => listeners.forEach((fn) => fn({ event }));
  return { socket, appSocket: socket as unknown as AppSocket, emit, limit };
}

describe("resyncCallStateWhenLimited", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("re-sends the current state, not the state when the event was dropped", () => {
    const { appSocket, emit, limit } = fakeSocket();
    let isMuted = true;
    resyncCallStateWhenLimited(appSocket, () => ({ isMuted, isScreenSharing: false }));

    limit("mute-toggle");
    isMuted = false;
    vi.advanceTimersByTime(1000);

    expect(emit).toHaveBeenCalledWith("mute-toggle", { isMuted: false });
    expect(emit).toHaveBeenCalledWith("screen-share-stopped");
  });

  it("re-announces an active share", () => {
    const { appSocket, emit, limit } = fakeSocket();
    resyncCallStateWhenLimited(appSocket, () => ({ isMuted: false, isScreenSharing: true }));

    limit("screen-share-started");
    vi.advanceTimersByTime(1000);

    expect(emit).toHaveBeenCalledWith("screen-share-started");
  });

  it("waits for drops to stop, and re-sends once", () => {
    const { appSocket, emit, limit } = fakeSocket();
    resyncCallStateWhenLimited(appSocket, () => ({ isMuted: false, isScreenSharing: false }));

    limit("mute-toggle");
    vi.advanceTimersByTime(900);
    limit("mute-toggle");
    vi.advanceTimersByTime(900);
    expect(emit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("ignores other events, a closed connection and a finished cleanup", () => {
    const { socket, appSocket, emit, limit } = fakeSocket();
    const cleanup = resyncCallStateWhenLimited(appSocket, () => ({ isMuted: false, isScreenSharing: false }));

    limit("chat-reaction");
    vi.advanceTimersByTime(1000);

    socket.connected = false;
    limit("mute-toggle");
    vi.advanceTimersByTime(1000);

    socket.connected = true;
    limit("mute-toggle");
    cleanup();
    vi.advanceTimersByTime(1000);

    expect(emit).not.toHaveBeenCalled();
  });
});
