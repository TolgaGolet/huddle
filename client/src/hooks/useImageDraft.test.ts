// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { MAX_IMAGE_SIZE, MAX_IMAGES_PER_MESSAGE } from "../types";
import { useImageDraft } from "./useImageDraft";

const image = (name = "a.png") => new File(["x"], name, { type: "image/png" });

function oversized() {
  const file = image("big.png");
  Object.defineProperty(file, "size", { value: MAX_IMAGE_SIZE + 1 });
  return file;
}

function addAll(result: { current: ReturnType<typeof useImageDraft> }, files: File[]) {
  let problem: string | null = null;
  act(() => {
    problem = result.current.add(files);
  });
  return problem;
}

beforeEach(() => {
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:${++n}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(cleanup);

describe("useImageDraft", () => {
  it("accepts images and makes a preview for each", () => {
    const { result } = renderHook(() => useImageDraft());

    expect(addAll(result, [image("a.png"), image("b.png")])).toBeNull();

    expect(result.current.images.map((i) => i.file.name)).toEqual(["a.png", "b.png"]);
    expect(result.current.images.map((i) => i.previewUrl)).toEqual(["blob:1", "blob:2"]);
  });

  it("gives the same file added twice distinct ids", () => {
    const { result } = renderHook(() => useImageDraft());
    const file = image();

    addAll(result, [file, file]);

    expect(new Set(result.current.images.map((i) => i.id)).size).toBe(2);
  });

  it("skips a non-image but keeps the good ones", () => {
    const { result } = renderHook(() => useImageDraft());
    const text = new File(["x"], "notes.txt", { type: "text/plain" });

    const problem = addAll(result, [image("a.png"), text, image("b.png")]);

    expect(problem).toContain("notes.txt");
    expect(result.current.images.map((i) => i.file.name)).toEqual(["a.png", "b.png"]);
  });

  it("skips an image over the size limit, without making a preview", () => {
    const { result } = renderHook(() => useImageDraft());

    const problem = addAll(result, [oversized()]);

    expect(problem).toContain("big.png");
    expect(result.current.images).toEqual([]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("allows an image exactly at the size limit", () => {
    const { result } = renderHook(() => useImageDraft());
    const file = image();
    Object.defineProperty(file, "size", { value: MAX_IMAGE_SIZE });

    expect(addAll(result, [file])).toBeNull();
  });

  it("stops at the per-message limit, counting what's already there", () => {
    const { result } = renderHook(() => useImageDraft());
    addAll(result, Array.from({ length: MAX_IMAGES_PER_MESSAGE - 1 }, () => image()));

    const problem = addAll(result, [image(), image()]);

    expect(problem).toContain(String(MAX_IMAGES_PER_MESSAGE));
    expect(result.current.images).toHaveLength(MAX_IMAGES_PER_MESSAGE);
  });

  it("reports the first problem when there are several", () => {
    const { result } = renderHook(() => useImageDraft());

    const problem = addAll(result, [new File(["x"], "first.txt", { type: "text/plain" }), oversized()]);

    expect(problem).toContain("first.txt");
  });

  it("frees the preview of a removed image only", () => {
    const { result } = renderHook(() => useImageDraft());
    addAll(result, [image("a.png"), image("b.png")]);
    const [first] = result.current.images;

    act(() => result.current.remove(first.id));

    expect(result.current.images.map((i) => i.file.name)).toEqual(["b.png"]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first.previewUrl);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:2");
  });

  it("ignores removing an unknown id", () => {
    const { result } = renderHook(() => useImageDraft());
    addAll(result, [image()]);

    act(() => result.current.remove("nope"));

    expect(result.current.images).toHaveLength(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("frees every preview on clear", () => {
    const { result } = renderHook(() => useImageDraft());
    addAll(result, [image(), image()]);

    act(() => result.current.clear());

    expect(result.current.images).toEqual([]);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("frees an unsent draft's previews on unmount", () => {
    const { result, unmount } = renderHook(() => useImageDraft());
    addAll(result, [image(), image()]);

    unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});
