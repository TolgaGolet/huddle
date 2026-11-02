// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useCopyFeedback } from "./useCopyFeedback";

function stubClipboard(clipboard: unknown) {
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useCopyFeedback", () => {
  it("copies and reports success for two seconds", async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard({ writeText });
    const { result } = renderHook(() => useCopyFeedback());
    expect(result.current.status).toBe("idle");

    await act(() => result.current.copy("room-id"));
    expect(writeText).toHaveBeenCalledWith("room-id");
    expect(result.current.status).toBe("copied");

    act(() => vi.advanceTimersByTime(1999));
    expect(result.current.status).toBe("copied");

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.status).toBe("idle");
  });

  it("reports a denied write", async () => {
    stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    const { result } = renderHook(() => useCopyFeedback());

    await act(() => result.current.copy("x"));

    expect(result.current.status).toBe("failed");
  });

  // navigator.clipboard is undefined on insecure origins.
  it("reports failure instead of throwing when there is no clipboard", async () => {
    stubClipboard(undefined);
    const { result } = renderHook(() => useCopyFeedback());

    await act(() => result.current.copy("x"));

    expect(result.current.status).toBe("failed");
  });

  it("restarts the two seconds on a second copy", async () => {
    stubClipboard({ writeText: vi.fn(async () => {}) });
    const { result } = renderHook(() => useCopyFeedback());
    await act(() => result.current.copy("a"));
    act(() => vi.advanceTimersByTime(1500));

    await act(() => result.current.copy("b"));
    act(() => vi.advanceTimersByTime(1500));

    expect(result.current.status).toBe("copied");
  });

  it("leaves no timer behind on unmount", async () => {
    stubClipboard({ writeText: vi.fn(async () => {}) });
    const { result, unmount } = renderHook(() => useCopyFeedback());
    await act(() => result.current.copy("a"));

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
