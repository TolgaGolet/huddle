// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CATEGORIES, EMOJI_NAMES } from "../lib/emojiData";
import EmojiPicker from "./EmojiPicker";

function setup() {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(<EmojiPicker onSelect={onSelect} onClose={onClose} />);
  return { onSelect, onClose };
}

const search = (value: string) => fireEvent.change(screen.getByLabelText("Search emojis"), { target: { value } });

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("EmojiPicker", () => {
  it("opens on the first category, with no recents section on a first visit", () => {
    setup();

    expect(screen.getByRole("button", { name: CATEGORIES[0].emojis[0] })).toBeTruthy();
    expect(screen.queryByText("Recent")).toBeNull();
  });

  it("switches categories", () => {
    setup();
    const other = CATEGORIES[1];

    fireEvent.click(screen.getByRole("button", { name: other.name }));

    expect(screen.getByRole("button", { name: other.emojis[0] })).toBeTruthy();
  });

  it("selects, remembers and closes", () => {
    const { onSelect, onClose } = setup();
    const emoji = CATEGORIES[0].emojis[0];

    fireEvent.click(screen.getByRole("button", { name: emoji }));

    expect(onSelect).toHaveBeenCalledWith(emoji);
    expect(onClose).toHaveBeenCalledOnce();
    expect(JSON.parse(localStorage.getItem("huddle_recent_emojis")!)).toEqual([emoji]);
  });

  it("offers recents on the next open", () => {
    localStorage.setItem("huddle_recent_emojis", JSON.stringify(["🎉"]));

    setup();

    expect(screen.getByText("Recent")).toBeTruthy();
  });

  it("searches across categories by name, ignoring case", () => {
    setup();
    const lastCategory = CATEGORIES[CATEGORIES.length - 1].emojis[0];
    const name = EMOJI_NAMES[lastCategory].split(" ")[0];

    search(`  ${name.toUpperCase()}  `);

    expect(screen.getByRole("button", { name: lastCategory })).toBeTruthy();
    expect(screen.getByText(/results?$/)).toBeTruthy();
  });

  it("hides the tabs and recents while searching", () => {
    localStorage.setItem("huddle_recent_emojis", JSON.stringify(["🎉"]));
    setup();

    search("smile");

    expect(screen.queryByText("Recent")).toBeNull();
    expect(screen.queryByRole("button", { name: CATEGORIES[0].name })).toBeNull();
  });

  it("shows the empty state for no match", () => {
    setup();

    search("zzzzzz-no-such-emoji");

    expect(screen.getByText("No emojis found")).toBeTruthy();
    expect(screen.getByText("0 results")).toBeTruthy();
  });

  it("shows the hovered emoji's name, and the category otherwise", () => {
    setup();
    const emoji = CATEGORIES[0].emojis[0];
    const button = screen.getByRole("button", { name: emoji });

    fireEvent.mouseEnter(button);
    expect(screen.getByText(EMOJI_NAMES[emoji].split(" ")[0])).toBeTruthy();

    fireEvent.mouseLeave(button);
    expect(screen.getByText(CATEGORIES[0].name)).toBeTruthy();
  });

  it("closes on a press outside but not inside", () => {
    const { onClose } = setup();

    fireEvent.mouseDown(screen.getByLabelText("Search emojis"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stops listening once closed", () => {
    const remove = vi.spyOn(document, "removeEventListener");
    render(<EmojiPicker onSelect={() => {}} onClose={() => {}} />);

    cleanup();

    expect(remove).toHaveBeenCalledWith("mousedown", expect.any(Function));
    remove.mockRestore();
  });
});
