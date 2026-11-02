// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useImageDraft } from "./useImageDraft";

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe("useImageDraft", () => {
  it("explains that HEIC isn't supported, and still takes the other files", () => {
    const { result } = renderHook(() => useImageDraft());
    let problem: string | null = null;

    act(() => {
      problem = result.current.add([new File(["x"], "photo.HEIC"), new File(["x"], "ok.png", { type: "image/png" })]);
    });

    expect(problem).toBe("HEIC photos aren't supported. Please convert to JPEG first.");
    expect(result.current.images.map((image) => image.file.name)).toEqual(["ok.png"]);
  });
});
