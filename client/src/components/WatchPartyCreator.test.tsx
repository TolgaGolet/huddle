// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WatchPartyState } from "../types";
import { WatchPartyContext } from "../lib/watchPartyContext";
import WatchPartyCreator, { INVALID_YOUTUBE_LINK } from "./WatchPartyCreator";

const party: WatchPartyState = {
  id: "p1",
  hostId: "u1",
  allowOthersToChange: false,
  videoId: "dQw4w9WgXcQ",
  memberIds: ["u1"],
  playback: { state: "playing", position: 0, rate: 1 },
};

function setup({ active = null as WatchPartyState | null, isMember = false, onSubmit = vi.fn(() => true) } = {}) {
  const onClose = vi.fn();
  const join = vi.fn();
  render(
    <WatchPartyContext value={{ party: active, isMember, join }}>
      <WatchPartyCreator onSubmit={onSubmit} onClose={onClose} />
    </WatchPartyContext>,
  );
  return { onSubmit, onClose, join };
}

const linkField = () => screen.getByLabelText("YouTube link") as HTMLInputElement;
const startButton = () => screen.getByRole("button", { name: "Start watch party" }) as HTMLButtonElement;

afterEach(cleanup);

describe("WatchPartyCreator", () => {
  it("explains what a watch party is", () => {
    setup();
    expect(screen.getByText(/in sync/)).toBeTruthy();
  });

  it("can't be submitted empty", () => {
    const { onSubmit } = setup();
    expect(startButton().disabled).toBe(true);
    fireEvent.click(startButton());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("refuses a link that isn't a YouTube video", () => {
    const { onSubmit } = setup();
    fireEvent.change(linkField(), { target: { value: "https://vimeo.com/123" } });
    fireEvent.click(startButton());

    expect(screen.getByRole("alert").textContent).toBe(INVALID_YOUTUBE_LINK);
    expect(linkField().getAttribute("aria-invalid")).toBe("true");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the video id with the toggle, on by default, then closes", () => {
    const { onSubmit, onClose } = setup();
    fireEvent.change(linkField(), { target: { value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5" } });
    fireEvent.click(screen.getByRole("switch", { name: "Other users can change the video" }));
    fireEvent.click(startButton());

    expect(onSubmit).toHaveBeenCalledWith("dQw4w9WgXcQ", false);
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the form when the party wasn't started", () => {
    const { onClose } = setup({ onSubmit: vi.fn(() => false) });
    fireEvent.change(linkField(), { target: { value: "youtu.be/dQw4w9WgXcQ" } });
    fireEvent.click(startButton());
    expect(onClose).not.toHaveBeenCalled();
    expect(linkField().value).toBe("youtu.be/dQw4w9WgXcQ");
  });

  it("offers to join the running party instead of starting another", () => {
    const { join, onClose } = setup({ active: party });
    expect(screen.queryByLabelText("YouTube link")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Join Watch Together" }));
    expect(join).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("says so when already watching", () => {
    setup({ active: party, isMember: true });
    expect(screen.queryByRole("button", { name: "Join Watch Together" })).toBeNull();
    expect(screen.getByText(/You're watching/)).toBeTruthy();
  });
});
