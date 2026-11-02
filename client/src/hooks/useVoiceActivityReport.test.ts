// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { AppSocket } from "../types";
import { VOICE_REPORT_INTERVAL_MS } from "../lib/voiceActivityReport";
import { useVoiceActivityReport } from "./useVoiceActivityReport";

const fakeSocket = (connected = true) => ({ connected, emit: vi.fn() }) as unknown as AppSocket & { emit: ReturnType<typeof vi.fn> };

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useVoiceActivityReport", () => {
  it("says nothing while silent", () => {
    const socket = fakeSocket();
    renderHook(() => useVoiceActivityReport(socket, false));

    vi.advanceTimersByTime(VOICE_REPORT_INTERVAL_MS * 2);

    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("reports at once, and again while speech continues", () => {
    const socket = fakeSocket();
    renderHook(() => useVoiceActivityReport(socket, true));
    expect(socket.emit).toHaveBeenCalledExactlyOnceWith("voice-activity");

    vi.advanceTimersByTime(VOICE_REPORT_INTERVAL_MS);

    expect(socket.emit).toHaveBeenCalledTimes(2);
  });

  it("doesn't repeat for short bursts of speech within the interval", () => {
    const socket = fakeSocket();
    const { rerender } = renderHook(({ speaking }) => useVoiceActivityReport(socket, speaking), { initialProps: { speaking: true } });

    rerender({ speaking: false });
    rerender({ speaking: true });

    expect(socket.emit).toHaveBeenCalledOnce();
  });

  it("stops when speech stops, and skips a disconnected socket", () => {
    const socket = fakeSocket();
    const { rerender } = renderHook(({ speaking }) => useVoiceActivityReport(socket, speaking), { initialProps: { speaking: true } });
    rerender({ speaking: false });
    vi.advanceTimersByTime(VOICE_REPORT_INTERVAL_MS * 2);
    expect(socket.emit).toHaveBeenCalledOnce();

    const offline = fakeSocket(false);
    renderHook(() => useVoiceActivityReport(offline, true));
    expect(offline.emit).not.toHaveBeenCalled();
  });
});
