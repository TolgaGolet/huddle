// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import RoomHeader from "./RoomHeader";

let writeText: ReturnType<typeof vi.fn>;

function setup(connected = true) {
  const onOpenSettings = vi.fn();
  const onLeave = vi.fn();
  render(<RoomHeader roomId="abc123" connected={connected} onOpenSettings={onOpenSettings} onLeave={onLeave} />);
  return { onOpenSettings, onLeave };
}

async function click(name: string) {
  await act(async () => void fireEvent.click(screen.getByRole("button", { name })));
}

beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RoomHeader", () => {
  it("copies the room id", async () => {
    setup();

    await click("abc123");

    expect(writeText).toHaveBeenCalledWith("abc123");
  });

  it("copies the current page's link", async () => {
    setup();

    await click("Copy room link");

    expect(writeText).toHaveBeenCalledWith(window.location.href);
  });

  it("says when copying the link failed", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    setup();

    await click("Copy room link");

    expect(screen.getByRole("button", { name: "Couldn't copy room link" })).toBeTruthy();
  });

  it("says when copying the id failed", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    setup();

    await click("abc123");

    expect(screen.getByTitle("Couldn't copy room ID")).toBeTruthy();
  });

  it("tracks the two copy buttons separately", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    setup();

    await click("abc123");

    expect(screen.getByRole("button", { name: "Copy room link" })).toBeTruthy();
  });

  it("shows when the connection is down", () => {
    setup(false);

    expect(screen.getByText("Connecting...")).toBeTruthy();
  });

  it("hides that once connected", () => {
    setup(true);

    expect(screen.queryByText("Connecting...")).toBeNull();
  });

  it("opens settings and asks to leave", async () => {
    const { onOpenSettings, onLeave } = setup();

    await click("Settings");
    await click("Leave room");

    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onLeave).toHaveBeenCalledOnce();
  });
});
