// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import MessageContextMenu from "./MessageContextMenu";

function setup(overrides: Partial<React.ComponentProps<typeof MessageContextMenu>> = {}) {
  const handlers = { onEdit: vi.fn(), onDelete: vi.fn(), onTogglePin: vi.fn(), onClose: vi.fn(), onDismiss: vi.fn() };
  render(<MessageContextMenu messageId="m1" x={10} y={20} isOwn canEdit isPinned={false} {...handlers} {...overrides} />);
  return handlers;
}

const item = (name: string) => screen.getByRole("menuitem", { name });
const items = () => screen.queryAllByRole("menuitem").map((el) => el.textContent?.trim());
const menu = () => screen.getByRole("menu");

afterEach(cleanup);

describe("MessageContextMenu", () => {
  it("offers edit, delete and pin on an editable message of your own", () => {
    setup();

    expect(items()).toEqual(["Edit message", "Delete message", "Pin message"]);
  });

  it("doesn't offer edit on your own GIF or image", () => {
    setup({ canEdit: false });

    expect(items()).toEqual(["Delete message", "Pin message"]);
  });

  it("offers only pinning on someone else's message", () => {
    setup({ isOwn: false, canEdit: false });

    expect(items()).toEqual(["Pin message"]);
  });

  it("offers unpin on a pinned message", () => {
    setup({ isPinned: true });

    expect(items()).toContain("Unpin message");
  });

  it("runs the chosen action", () => {
    const { onEdit, onDelete, onTogglePin } = setup();

    fireEvent.click(item("Edit message"));
    fireEvent.click(item("Delete message"));
    fireEvent.click(item("Pin message"));

    expect(onEdit).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onTogglePin).toHaveBeenCalledOnce();
  });

  it("opens at the given position, with focus on the first item", () => {
    setup();

    expect(menu().style.left).toBe("10px");
    expect(menu().style.top).toBe("20px");
    expect(document.activeElement).toBe(item("Edit message"));
  });

  it("moves through the items with the arrow keys, wrapping around", () => {
    setup();

    fireEvent.keyDown(menu(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(item("Delete message"));

    fireEvent.keyDown(menu(), { key: "ArrowUp" });
    fireEvent.keyDown(menu(), { key: "ArrowUp" });
    expect(document.activeElement).toBe(item("Pin message"));
  });

  it.each(["Escape", "Tab"])("closes on %s, returning focus through onClose", (key) => {
    const { onClose, onDismiss } = setup();

    fireEvent.keyDown(menu(), { key });

    expect(onClose).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("dismisses on a press outside, leaving focus where the press put it", () => {
    const { onClose, onDismiss } = setup();

    fireEvent.mouseDown(document.body);

    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stays open on a press inside", () => {
    const { onDismiss } = setup();

    fireEvent.mouseDown(item("Pin message"));

    expect(onDismiss).not.toHaveBeenCalled();
  });
});
