// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { asAppSocket, emitsOf, fakeSocket } from "../test/fakeSocket";
import type { GamePartyState } from "../types";
import { makeGameParty, RAGAMUFFIN } from "../test/gameParty";
import { useGameParty } from "./useGameParty";

const party = (memberIds: string[], id = "g1"): GamePartyState => makeGameParty({ id, memberIds });

function setup() {
  const socket = fakeSocket();
  const view = renderHook(() => useGameParty(asAppSocket(socket), "room"));
  const fire = (event: string, data: unknown) => act(() => void socket.fire(event, data));
  const joinRoom = (...gameParties: GamePartyState[]) => fire("room-joined", { userId: "me", gameParties, games: [RAGAMUFFIN] });
  return { socket, fire, joinRoom, ...view };
}

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

describe("useGameParty", () => {
  it("keeps the catalog and is a member of a party it started, with its game", () => {
    const { result, joinRoom, fire } = setup();
    joinRoom();
    expect(result.current.games).toEqual([RAGAMUFFIN]);
    fire("game-parties", [party(["me"])]);
    expect(result.current.party?.id).toBe("g1");
    expect(result.current.game).toEqual(RAGAMUFFIN);
  });

  it("isn't a member of someone else's party until it joins", () => {
    const { result, joinRoom, socket } = setup();
    joinRoom(party(["host"]));
    expect(result.current.party).toBeNull();

    act(() => result.current.join("g1"));

    expect(result.current.party).not.toBeNull();
    expect(emitsOf(socket, "game-join")).toEqual([["game-join", { partyId: "g1" }]]);
  });

  it("joins again after a reconnect drops it from the party", () => {
    const { result, joinRoom, socket } = setup();
    joinRoom(party(["host"]));
    act(() => result.current.join("g1"));

    joinRoom(party(["host"]));

    expect(result.current.party).not.toBeNull();
    expect(emitsOf(socket, "game-join")).toHaveLength(2);
  });

  it("stays out after leaving, even if a broadcast sent earlier still lists it", () => {
    const { result, joinRoom, fire, socket } = setup();
    joinRoom(party(["host", "me"]));
    expect(result.current.party).not.toBeNull();

    act(() => result.current.leave());
    fire("game-parties", [party(["host", "me"])]);

    expect(result.current.party).toBeNull();
    expect(emitsOf(socket, "game-leave")).toHaveLength(1);
  });

  it("joins again after a reload, but not after leaving the room", () => {
    const first = setup();
    first.joinRoom(party(["host"]));
    act(() => first.result.current.join("g1"));
    // A reload runs no cleanup, so the first stays mounted.
    const reloaded = setup();
    reloaded.joinRoom(party(["host"]));
    expect(emitsOf(reloaded.socket, "game-join")).toEqual([["game-join", { partyId: "g1" }]]);

    first.unmount();
    reloaded.unmount();
    const later = setup();
    later.joinRoom(party(["host"]));
    expect(emitsOf(later.socket, "game-join")).toEqual([]);
  });

  it("forgets a party that ended", () => {
    const { result, joinRoom, fire } = setup();
    joinRoom(party(["host", "me"]));
    fire("game-parties", []);
    expect(result.current.joinedPartyId).toBeNull();
  });

  it("asks the server to end a party", () => {
    const { result, joinRoom, socket } = setup();
    joinRoom(party(["host"]));
    act(() => result.current.end("g1"));
    expect(emitsOf(socket, "game-end")).toEqual([["game-end", { partyId: "g1" }]]);
  });

  // Regression: moving into a watch party used to need a cross-hook effect that
  // sent game-leave, which also fired for a watch join the server ignored.
  it("lets go of a party once the server, having listed it there, stops listing it", () => {
    const { result, joinRoom, fire, socket } = setup();
    joinRoom(party(["host"]));
    act(() => result.current.join("g1"));
    fire("game-parties", [party(["host", "me"])]);

    fire("game-parties", [party(["host"])]);

    expect(result.current.party).toBeNull();
    expect(emitsOf(socket, "game-leave")).toEqual([]);
  });

  it("keeps a just-joined party while broadcasts sent before the join still leave it out", () => {
    const { result, joinRoom, fire } = setup();
    joinRoom(party(["host"]));
    act(() => result.current.join("g1"));

    fire("game-parties", [party(["host"])]);

    expect(result.current.party?.id).toBe("g1");
  });

  it("reports a join it couldn't send while disconnected", () => {
    const { result, joinRoom, socket } = setup();
    joinRoom(party(["host"]));
    socket.connected = false;

    let sent = true;
    act(() => void (sent = result.current.join("g1")));

    expect(sent).toBe(false);
    expect(result.current.party).toBeNull();
  });
});
