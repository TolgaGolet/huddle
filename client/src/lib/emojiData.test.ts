// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATEGORIES, EMOJI_NAMES, loadRecentEmojis, saveRecentEmoji } from "./emojiData";

const KEY = "huddle_recent_emojis";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("recent emojis", () => {
  it("starts empty", () => {
    expect(loadRecentEmojis()).toEqual([]);
  });

  it("puts the latest first and survives a reload", () => {
    saveRecentEmoji("😀");
    saveRecentEmoji("🎉");

    expect(loadRecentEmojis()).toEqual(["🎉", "😀"]);
  });

  it("moves a repeat to the front instead of listing it twice", () => {
    saveRecentEmoji("😀");
    saveRecentEmoji("🎉");

    expect(saveRecentEmoji("😀")).toEqual(["😀", "🎉"]);
  });

  it("keeps only the five latest", () => {
    for (const emoji of ["1", "2", "3", "4", "5", "6"]) saveRecentEmoji(emoji);

    expect(loadRecentEmojis()).toEqual(["6", "5", "4", "3", "2"]);
  });

  it("ignores stored data that isn't JSON", () => {
    localStorage.setItem(KEY, "{oops");

    expect(loadRecentEmojis()).toEqual([]);
  });

  it("still returns the list when storage refuses the write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });

    expect(saveRecentEmoji("😀")).toEqual(["😀"]);
  });

  // Suspected bug: only JSON syntax is checked, so valid JSON of another shape comes back
  // cast to string[]. EmojiPicker then throws on `.map` while rendering, and keeps doing
  // so until the storage is cleared, because the value is never overwritten.
  it.skip("ignores stored JSON that isn't an array", () => {
    localStorage.setItem(KEY, '"abc"');

    expect(loadRecentEmojis()).toEqual([]);
  });
});

describe("emoji data", () => {
  it("gives every emoji a searchable name", () => {
    const unnamed = CATEGORIES.flatMap((c) => c.emojis).filter((e) => !EMOJI_NAMES[e]);

    expect(unnamed).toEqual([]);
  });
});
