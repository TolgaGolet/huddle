// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WatchQueueEntry } from "../types";
import WatchQueue from "./WatchQueue";

const queue: WatchQueueEntry[] = [
  { id: "a", videoId: "dQw4w9WgXcQ", title: "First", addedBy: "u1" },
  { id: "b", videoId: "9bZkp7q19f0", title: null, addedBy: "u2" },
];

function setup(canEdit: boolean, entries = queue) {
  const onRemove = vi.fn();
  const onMove = vi.fn();
  const onPlay = vi.fn();
  render(
    <WatchQueue queue={entries} canEdit={canEdit} nameOf={(id) => (id === "u1" ? "Ana" : "Ben")} onRemove={onRemove} onPlay={onPlay} onMove={onMove} />,
  );
  return { onRemove, onMove, onPlay };
}

afterEach(cleanup);

describe("WatchQueue", () => {
  it("shows nothing when empty", () => {
    const { container } = render(<WatchQueue queue={[]} canEdit nameOf={() => ""} onRemove={() => {}} onPlay={() => {}} onMove={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("lists the videos in order, with who added them and a stand-in for unknown titles", () => {
    setup(false);
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([expect.stringContaining("First"), expect.stringContaining("YouTube video")]);
    expect(screen.getByText("Added by Ben")).toBeTruthy();
  });

  it("gives a viewer no controls and nothing to drag", () => {
    setup(false);
    expect(screen.queryByRole("button", { name: /Remove|Move/ })).toBeNull();
    expect(screen.getAllByRole("listitem")[0].getAttribute("draggable")).toBe("false");
  });

  it("plays an item at once when one with control clicks it", () => {
    const { onPlay } = setup(true);
    fireEvent.click(screen.getByRole("button", { name: "Play now: YouTube video" }));
    expect(onPlay).toHaveBeenCalledWith("b");
  });

  it("lets a viewer click nothing in it", () => {
    setup(false);
    expect(screen.queryByRole("button", { name: /Play now/ })).toBeNull();
  });

  it("removes and reorders with buttons", () => {
    const { onRemove, onMove } = setup(true);
    expect((screen.getByRole("button", { name: "Move up: First" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Move down: First" }));
    expect(onMove).toHaveBeenCalledWith("a", 1);
    fireEvent.click(screen.getByRole("button", { name: "Move up: YouTube video" }));
    expect(onMove).toHaveBeenCalledWith("b", 0);
    fireEvent.click(screen.getByRole("button", { name: "Remove from queue: First" }));
    expect(onRemove).toHaveBeenCalledWith("a");
  });

  it("moves a dragged video to where it's dropped", () => {
    const { onMove } = setup(true);
    const [first, second] = screen.getAllByRole("listitem");
    const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(second, { dataTransfer });
    fireEvent.dragOver(first, { dataTransfer });
    fireEvent.drop(first, { dataTransfer });
    expect(onMove).toHaveBeenCalledWith("b", 0);
  });

  // Regression: dropping downwards landed one slot below the indicator, as the
  // server takes the dragged item out before inserting it.
  it("puts a video dragged down just before the item it's dropped on", () => {
    const entries: WatchQueueEntry[] = ["a", "b", "c", "d"].map((id) => ({ id, videoId: "dQw4w9WgXcQ", title: id, addedBy: "u1" }));
    const { onMove } = setup(true, entries);
    const items = screen.getAllByRole("listitem");
    const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(items[0], { dataTransfer });
    fireEvent.dragOver(items[2], { dataTransfer });
    fireEvent.drop(items[2], { dataTransfer });
    // [b, c, d] with "a" at 1: [b, a, c, d], before "c" as shown.
    expect(onMove).toHaveBeenCalledWith("a", 1);

    // Onto the very next item: before it is where it already is.
    onMove.mockClear();
    fireEvent.dragStart(items[0], { dataTransfer });
    fireEvent.drop(items[1], { dataTransfer });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("collapses to the next video's title", () => {
    setup(false);
    const toggle = screen.getByRole("button", { name: /Up next \(2\)/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("First");
  });
});
