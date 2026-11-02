// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import FormattingToolbar, { formatForShortcut } from "./FormattingToolbar";

function setup(text: string, start: number, end = start) {
  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  textarea.value = text;
  textarea.setSelectionRange(start, end);
  const setText = vi.fn((value: string) => {
    textarea.value = value;
  });
  render(<FormattingToolbar textareaRef={{ current: textarea }} text={text} setText={setText} />);
  return { textarea, setText };
}

const press = (label: string) => fireEvent.click(screen.getByRole("button", { name: label }));
const shortcut = (init: Partial<React.KeyboardEvent>) => formatForShortcut(init as React.KeyboardEvent)?.label ?? null;

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("toolbar", () => {
  it.each([
    ["Bold", "say **hi** now"],
    ["Italic", "say *hi* now"],
    ["Strikethrough", "say ~~hi~~ now"],
    ["Code", "say `hi` now"],
  ])("wraps the selection with %s", (label, expected) => {
    const { setText } = setup("say hi now", 4, 6);

    press(label);

    expect(setText).toHaveBeenCalledWith(expected);
  });

  it("keeps the selection on the words, not the markers", () => {
    const { textarea } = setup("say hi now", 4, 6);

    press("Bold");

    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([6, 8]);
    expect(document.activeElement).toBe(textarea);
  });

  it("puts the caret between empty markers with no selection", () => {
    const { textarea, setText } = setup("ab", 1);

    press("Bold");

    expect(setText).toHaveBeenCalledWith("a****b");
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([3, 3]);
  });

  it("works on an empty draft", () => {
    const { setText } = setup("", 0);

    press("Code");

    expect(setText).toHaveBeenCalledWith("``");
  });

  it("does nothing before the textarea exists", () => {
    const setText = vi.fn();
    render(<FormattingToolbar textareaRef={{ current: null }} text="x" setText={setText} />);

    press("Bold");

    expect(setText).not.toHaveBeenCalled();
  });
});

describe("formatForShortcut", () => {
  it.each([
    [{ ctrlKey: true, key: "b" }, "Bold"],
    [{ metaKey: true, key: "b" }, "Bold"],
    [{ ctrlKey: true, key: "i" }, "Italic"],
    [{ ctrlKey: true, key: "e" }, "Code"],
    [{ ctrlKey: true, shiftKey: true, key: "X" }, "Strikethrough"],
  ])("maps %j to %s", (init, label) => {
    expect(shortcut(init)).toBe(label);
  });

  it.each([
    [{ key: "b" }],
    [{ shiftKey: true, key: "X" }],
    [{ ctrlKey: true, key: "x" }], // plain Ctrl+X must stay cut
    [{ ctrlKey: true, key: "X" }],
    [{ ctrlKey: true, key: "a" }],
  ])("ignores %j", (init) => {
    expect(shortcut(init)).toBeNull();
  });
});
