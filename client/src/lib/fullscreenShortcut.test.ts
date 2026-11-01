import { describe, it, expect } from "vitest";
import { isFullscreenShortcut } from "./fullscreenShortcut";

const press = (key: string, modifiers: Partial<KeyboardEvent> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, ...modifiers });

describe("isFullscreenShortcut", () => {
  it("accepts F with or without Shift", () => {
    expect(isFullscreenShortcut(press("f"))).toBe(true);
    expect(isFullscreenShortcut(press("F"))).toBe(true);
  });

  // Regression: Ctrl+F opened the find bar and also toggled fullscreen.
  it("leaves browser shortcuts alone", () => {
    expect(isFullscreenShortcut(press("f", { ctrlKey: true }))).toBe(false);
    expect(isFullscreenShortcut(press("f", { metaKey: true }))).toBe(false);
    expect(isFullscreenShortcut(press("f", { altKey: true }))).toBe(false);
  });

  it("ignores other keys", () => {
    expect(isFullscreenShortcut(press("g"))).toBe(false);
  });
});
