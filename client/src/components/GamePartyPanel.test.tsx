// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Participant } from "../types";
import { makeGameParty, RAGAMUFFIN } from "../test/gameParty";
import GamePartyPanel from "./GamePartyPanel";

const participants: Participant[] = [
  { id: "s1", userId: "host", name: "Ana", isMuted: false },
  { id: "s2", userId: "me", name: "Ben", isMuted: false },
];

function setup(isOwner = false, game = RAGAMUFFIN) {
  const onLeave = vi.fn();
  const onEnd = vi.fn();
  render(
    <GamePartyPanel
      party={makeGameParty({ memberIds: ["host", "me"] })}
      game={game}
      localUserId="me"
      isOwner={isOwner}
      participants={participants}
      onLeave={onLeave}
      onEnd={onEnd}
    />,
  );
  return { onLeave, onEnd };
}

afterEach(cleanup);

describe("GamePartyPanel", () => {
  it("embeds the game, without letting it navigate the call away", () => {
    setup();
    const frame = screen.getByTitle("RagaMuffin") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(RAGAMUFFIN.url);
    expect(frame.getAttribute("sandbox")).toContain("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(screen.getByText(`Loading ${RAGAMUFFIN.name}…`)).toBeTruthy();
    fireEvent.load(frame);
    expect(screen.queryByText(`Loading ${RAGAMUFFIN.name}…`)).toBeNull();
  });

  it("offers a game its host won't let be framed in a tab of its own, with no frame", () => {
    setup(false, { ...RAGAMUFFIN, embed: false });
    expect(screen.queryByTitle("RagaMuffin")).toBeNull();
    const link = screen.getByRole("link", { name: "Open RagaMuffin" });
    expect(link.getAttribute("href")).toBe(RAGAMUFFIN.url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.queryByRole("button", { name: "Fullscreen" })).toBeNull();
    // Still a party: members and leaving work the same.
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Leave party" })).toBeTruthy();
  });

  it("lists the members, marking the host and you", () => {
    setup();
    const members = within(screen.getByRole("list", { name: "Playing" })).getAllByRole("listitem");
    expect(members.map((m) => m.textContent)).toEqual(["Ana", "Ben(you)"]);
    expect(within(members[0]).getByLabelText("Host")).toBeTruthy();
  });

  it("links the game for a new tab", () => {
    setup();
    const link = screen.getByRole("link", { name: "Open the game in a new tab" });
    expect(link.getAttribute("href")).toBe(RAGAMUFFIN.url);
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("leaves the party", () => {
    const { onLeave } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Leave party" }));
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it("lets only an owner end it, after confirming", () => {
    setup();
    expect(screen.queryByRole("button", { name: "End party" })).toBeNull();
    cleanup();

    const { onEnd } = setup(true);
    fireEvent.click(screen.getByRole("button", { name: "End party" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "End party" }));
    expect(onEnd).toHaveBeenCalledWith("g1");
  });
});
