// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GamePartyState } from "../types";
import { GamePartyContext } from "../lib/gamePartyContext";
import { WatchPartyContext } from "../lib/watchPartyContext";
import { gameContextValue, makeGameParty } from "../test/gameParty";
import { watchContextValue } from "../test/watchParty";
import GamePartyCreator, { GAME_PARTY_LIMIT_TEXT } from "./GamePartyCreator";

const second = makeGameParty({ id: "g2", memberIds: ["a", "b"] });

function setup({
  parties = [] as GamePartyState[],
  joinedPartyId = null as string | null,
  watchPartyId = null as string | null,
  isOwner = false,
  onSubmit = vi.fn(() => true),
  join = vi.fn((_partyId: string) => true),
} = {}) {
  const onClose = vi.fn();
  const end = vi.fn();
  const prepareStart = vi.fn();
  render(
    <WatchPartyContext value={watchContextValue({ joinedPartyId: watchPartyId })}>
      <GamePartyContext value={gameContextValue({ parties, joinedPartyId, join, end, isOwner, prepareStart })}>
        <GamePartyCreator onSubmit={onSubmit} onClose={onClose} />
      </GamePartyContext>
    </WatchPartyContext>,
  );
  return { onSubmit, onClose, join, end, prepareStart };
}

const startButton = () => screen.getByRole("button", { name: "Start a game party: RagaMuffin" });

afterEach(cleanup);

describe("GamePartyCreator", () => {
  it("lists the games and starts a party for one", () => {
    const { onSubmit, onClose, prepareStart } = setup();
    fireEvent.click(startButton());
    expect(prepareStart).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith("ragamuffin");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays open when the party wasn't started", () => {
    const { onClose } = setup({ onSubmit: vi.fn(() => false) });
    fireEvent.click(startButton());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("lists the room's parties to join, and the one you're in", () => {
    const { join, onClose } = setup({ parties: [makeGameParty(), second], joinedPartyId: "g1" });
    expect(screen.getByText("Game parties in this room (2/2)")).toBeTruthy();
    expect(screen.getByText("You're playing")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Join game party: RagaMuffin" }));
    expect(join).toHaveBeenCalledWith("g2");
    expect(onClose).toHaveBeenCalled();
  });

  it("offers no start at the limit, unless starting would replace your own party", () => {
    setup({ parties: [makeGameParty({ memberIds: ["x"] }), second] });
    expect(screen.getByRole("status").textContent).toContain(GAME_PARTY_LIMIT_TEXT);
    expect(screen.queryByRole("button", { name: /Start a game party/ })).toBeNull();
    cleanup();

    setup({ parties: [makeGameParty({ memberIds: ["me"] }), second], joinedPartyId: "g1" });
    expect(startButton()).toBeTruthy();
  });

  it("lets an owner end a party after confirming", () => {
    const { end } = setup({ parties: [second], isOwner: true });
    fireEvent.click(screen.getByRole("button", { name: "End game party: RagaMuffin" }));
    expect(end).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "End for everyone: RagaMuffin" }));
    expect(end).toHaveBeenCalledWith("g2");
  });

  it("offers no End to anyone else", () => {
    setup({ parties: [second] });
    expect(screen.queryByRole("button", { name: /End game party/ })).toBeNull();
  });

  it("warns that starting leaves the watch party you're in", () => {
    setup({ watchPartyId: "w1" });
    expect(screen.getByText(/leaves the video you're watching/)).toBeTruthy();
  });

  it("stays open with an alert when a join couldn't be sent", () => {
    const { onClose } = setup({ parties: [second], join: vi.fn(() => false) });
    fireEvent.click(screen.getByRole("button", { name: "Join game party: RagaMuffin" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/reconnecting/);
  });
});
