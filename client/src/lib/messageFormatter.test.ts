import { describe, it, expect } from "vitest";
import { detectEmojiOnly, tokenize } from "./messageFormatter";

describe("tokenize", () => {
  it("reads ** as bold rather than two italics", () => {
    expect(tokenize("**a** *b*")).toEqual([
      { type: "bold", content: "a" },
      { type: "text", content: " " },
      { type: "italic", content: "b" },
    ]);
  });

  it("recognises code and strikethrough", () => {
    expect(tokenize("`x` ~~y~~")).toEqual([
      { type: "code", content: "x" },
      { type: "text", content: " " },
      { type: "strike", content: "y" },
    ]);
  });

  it("ends a URL before a closing bracket or whitespace", () => {
    expect(tokenize("(see https://a.example/x?y=1) now")).toEqual([
      { type: "text", content: "(see " },
      { type: "url", content: "https://a.example/x?y=1" },
      { type: "text", content: ") now" },
    ]);
  });

  it("only links http and https", () => {
    expect(tokenize("javascript:alert(1)")).toEqual([{ type: "text", content: "javascript:alert(1)" }]);
  });

  it("leaves unmatched markers as plain text", () => {
    expect(tokenize("**a")).toEqual([{ type: "text", content: "**a" }]);
  });

  it("returns no tokens for empty text", () => {
    expect(tokenize("")).toEqual([]);
  });
});

describe("detectEmojiOnly", () => {
  it("accepts up to two emoji", () => {
    expect(detectEmojiOnly("😂")).toBe(true);
    expect(detectEmojiOnly(" 🍕🍕 ")).toBe(true);
  });

  it("counts a ZWJ sequence as one emoji", () => {
    expect(detectEmojiOnly("🐻‍❄️🐻‍❄️")).toBe(true);
  });

  it("rejects three emoji, mixed text and blank input", () => {
    expect(detectEmojiOnly("😂😂😂")).toBe(false);
    expect(detectEmojiOnly("hi 😂")).toBe(false);
    expect(detectEmojiOnly("   ")).toBe(false);
  });
});
