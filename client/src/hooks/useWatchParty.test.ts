// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { asAppSocket, emitsOf, fakeSocket } from "../test/fakeSocket";
import type { WatchPartyState } from "../types";
import { useWatchParty } from "./useWatchParty";

const party = (memberIds: string[], id = "p1"): WatchPartyState => ({
  id,
  hostId: "host",
  allowOthersToChange: false,
  videoId: "dQw4w9WgXcQ",
  memberIds,
  playback: { state: "playing", position: 0, rate: 1 },
});

function setup() {
  const socket = fakeSocket();
  const view = renderHook(() => useWatchParty(asAppSocket(socket), "room"));
  const fire = (event: string, data: unknown) => act(() => void socket.fire(event, data));
  const joinRoom = (watchParty: WatchPartyState | null) => fire("room-joined", { userId: "me", watchParty });
  return { socket, fire, joinRoom, ...view };
}

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

describe("useWatchParty", () => {
  it("is a member of a party it started", () => {
    const { result, joinRoom, fire } = setup();
    joinRoom(null);
    fire("watch-party", party(["me"]));
    expect(result.current.isMember).toBe(true);
  });

  it("isn't a member of someone else's party until it joins", () => {
    const { result, joinRoom, socket } = setup();
    joinRoom(party(["host"]));
    expect(result.current.isMember).toBe(false);

    act(() => result.current.join());

    expect(result.current.isMember).toBe(true);
    expect(emitsOf(socket, "watch-join")).toEqual([["watch-join", { partyId: "p1" }]]);
  });

  it("joins again after a reconnect drops it from the party", () => {
    const { result, joinRoom, socket } = setup();
    joinRoom(party(["host"]));
    act(() => result.current.join());

    // The server dropped the old socket; the automatic rejoin brings the party back.
    joinRoom(party(["host"]));

    expect(result.current.isMember).toBe(true);
    expect(emitsOf(socket, "watch-join")).toHaveLength(2);
  });

  it("stays out after leaving, even if a broadcast sent earlier still lists it", () => {
    const { result, joinRoom, fire, socket } = setup();
    joinRoom(party(["host", "me"]));
    expect(result.current.isMember).toBe(true);

    act(() => result.current.leave());
    fire("watch-party", party(["host", "me"]));

    expect(result.current.isMember).toBe(false);
    expect(emitsOf(socket, "watch-leave")).toHaveLength(1);
  });

  it("joins again after a reload of the page", () => {
    const first = setup();
    first.joinRoom(party(["host"]));
    act(() => first.result.current.join());
    // A reload runs no cleanup, so the first stays mounted.

    const reloaded = setup();
    reloaded.joinRoom(party(["host"]));

    expect(reloaded.result.current.isMember).toBe(true);
    expect(emitsOf(reloaded.socket, "watch-join")).toEqual([["watch-join", { partyId: "p1" }]]);
  });

  it("doesn't join again after leaving the room and coming back", () => {
    const first = setup();
    first.joinRoom(party(["host"]));
    act(() => first.result.current.join());
    first.unmount();

    const back = setup();
    back.joinRoom(party(["host"]));

    expect(back.result.current.isMember).toBe(false);
    expect(emitsOf(back.socket, "watch-join")).toEqual([]);
  });

  it("forgets the party when it ends", () => {
    const { result, joinRoom, fire } = setup();
    joinRoom(party(["me"]));
    fire("watch-party", null);
    expect(result.current.party).toBeNull();
    expect(result.current.isMember).toBe(false);
  });
});
