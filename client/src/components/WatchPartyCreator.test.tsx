// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WatchPartyState } from "../types";
import { WatchPartyContext } from "../lib/watchPartyContext";
import { makeParty, watchContextValue } from "../test/watchParty";
import WatchPartyCreator, { INVALID_YOUTUBE_LINK, WATCH_PARTY_LIMIT_TEXT } from "./WatchPartyCreator";

const party = makeParty({ title: "First video" });
const second = makeParty({ id: "p2", entryId: "e2", title: "Second video", memberIds: ["a", "b"] });

function setup({
  parties = [] as WatchPartyState[],
  joinedPartyId = null as string | null,
  isOwner = false,
  onSubmit = vi.fn(() => true),
} = {}) {
  const onClose = vi.fn();
  const join = vi.fn(() => true);
  const end = vi.fn();
  const prepareStart = vi.fn();
  render(
    <WatchPartyContext value={watchContextValue({ parties, joinedPartyId, join, end, isOwner, prepareStart })}>
      <WatchPartyCreator onSubmit={onSubmit} onClose={onClose} />
    </WatchPartyContext>,
  );
  return { onSubmit, onClose, join, end, prepareStart };
}

const linkField = () => screen.getByLabelText("YouTube link") as HTMLInputElement;
const startButton = () => screen.getByRole("button", { name: "Start watch party" }) as HTMLButtonElement;

function expectYouTubeLink(link: HTMLElement) {
  expect(link.getAttribute("href")).toBe("https://www.youtube.com/");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
}

afterEach(cleanup);

describe("WatchPartyCreator", () => {
  it("explains what a watch party is", () => {
    setup();
    expect(screen.getByText(/in sync/)).toBeTruthy();
  });

  it("links to YouTube for finding a video", () => {
    setup();
    expectYouTubeLink(screen.getByRole("link", { name: /Open YouTube/ }));
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
    fireEvent.click(screen.getByRole("switch", { name: /Others can control the video/ }));
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

  it("lists the running parties and joins one on click, still offering to start another", () => {
    const { join, onClose } = setup({ parties: [party] });
    expect(screen.getByText("Watch parties in this room (1/2)")).toBeTruthy();
    expect(screen.getByLabelText("YouTube link")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Join watch party: First video" }));
    expect(join).toHaveBeenCalledWith("p1");
    expect(onClose).toHaveBeenCalled();
  });

  it("explains the limit and offers no form once it's reached", () => {
    setup({ parties: [party, second] });
    expect(screen.queryByLabelText("YouTube link")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(WATCH_PARTY_LIMIT_TEXT);
    // Both can still be joined.
    expect(screen.getByRole("button", { name: "Join watch party: First video" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Join watch party: Second video" })).toBeTruthy();
  });

  it("says which one they're watching, with no join button for it", () => {
    setup({ parties: [party, second], joinedPartyId: "p1" });
    expect(screen.queryByRole("button", { name: "Join watch party: First video" })).toBeNull();
    expect(screen.getByText(/You're watching/)).toBeTruthy();
  });

  it("lets an owner end a party after confirming", () => {
    const { end } = setup({ parties: [party], isOwner: true });
    fireEvent.click(screen.getByRole("button", { name: "End watch party: First video" }));
    expect(end).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "End for everyone: First video" }));
    expect(end).toHaveBeenCalledWith("p1");
  });

  it("offers no End button to others", () => {
    setup({ parties: [party] });
    expect(screen.queryByRole("button", { name: /^End/ })).toBeNull();
  });

  it("tells the hook a start is coming, so the old party's broadcasts don't pull it back", () => {
    const { prepareStart, onSubmit } = setup({ parties: [party], joinedPartyId: "p1" });
    fireEvent.change(linkField(), { target: { value: "youtu.be/9bZkp7q19f0" } });
    fireEvent.click(startButton());
    expect(prepareStart).toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith("9bZkp7q19f0", true);
  });
});
