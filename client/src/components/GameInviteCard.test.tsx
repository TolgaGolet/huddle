// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GamePartyState } from "../types";
import { GamePartyContext } from "../lib/gamePartyContext";
import { gameContextValue, makeGameParty } from "../test/gameParty";
import GameInviteCard from "./GameInviteCard";

const party = makeGameParty({ memberIds: ["u1", "u2"] });

function setup(active: GamePartyState | null, isMember = false) {
  const join = vi.fn(() => true);
  render(
    <GamePartyContext value={gameContextValue({ parties: active ? [active] : [], joinedPartyId: isMember && active ? active.id : null, join })}>
      <GameInviteCard partyId="g1" gameId="ragamuffin" senderName="Ana" />
    </GamePartyContext>,
  );
  return { join };
}

afterEach(cleanup);

describe("GameInviteCard", () => {
  it("names the game and joins a running party", () => {
    const { join } = setup(party);
    expect(screen.getByText("RagaMuffin")).toBeTruthy();
    expect(screen.getByText("2 playing")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Join game" }));
    expect(join).toHaveBeenCalledWith("g1");
  });

  it("shows a member they're playing, with no join button", () => {
    setup(party, true);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("You're playing")).toBeTruthy();
  });

  it("says when the party has ended", () => {
    setup(null);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("This game party has ended.")).toBeTruthy();
  });
});
