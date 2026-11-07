// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { asAppSocket, emitsOf, fakeSocket } from "../test/fakeSocket";
import type { WatchPartyState } from "../types";
import { makeParty } from "../test/watchParty";
import { useWatchParty } from "./useWatchParty";

const party = (memberIds: string[], id = "p1"): WatchPartyState => makeParty({ id, memberIds });

function setup() {
  const socket = fakeSocket();
  const view = renderHook(() => useWatchParty(asAppSocket(socket), "room"));
  const fire = (event: string, data: unknown) => act(() => void socket.fire(event, data));
  const joinRoom = (...watchParties: WatchPartyState[]) => fire("room-joined", { userId: "me", watchParties });
  return { socket, fire, joinRoom, ...view };
}

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

describe("useWatchParty", () => {
  it("is a member of a party it started", () => {
    const { result, joinRoom, fire } = setup();
    joinRoom();
    fire("watch-parties", [party(["me"])]);
    expect(result.current.snapshot).not.toBeNull();
  });

  it("isn't a member of someone else's party until it joins", () => {
    const { result, joinRoom, socket } = setup();
    joinRoom(party(["host"]));
    expect(result.current.snapshot).toBeNull();

    act(() => result.current.join("p1"));

    expect(result.current.snapshot).not.toBeNull();
    expect(emitsOf(socket, "watch-join")).toEqual([["watch-join", { partyId: "p1" }]]);
  });

  it("joins again after a reconnect drops it from the party", () => {
    const { result, joinRoom, socket } = setup();
    joinRoom(party(["host"]));
    act(() => result.current.join("p1"));

    // The server dropped the old socket; the automatic rejoin brings the party back.
    joinRoom(party(["host"]));

    expect(result.current.snapshot).not.toBeNull();
    expect(emitsOf(socket, "watch-join")).toHaveLength(2);
  });

  it("stays out after leaving, even if a broadcast sent earlier still lists it", () => {
    const { result, joinRoom, fire, socket } = setup();
    joinRoom(party(["host", "me"]));
    expect(result.current.snapshot).not.toBeNull();

    act(() => result.current.leave());
    fire("watch-parties", [party(["host", "me"])]);

    expect(result.current.snapshot).toBeNull();
    expect(emitsOf(socket, "watch-leave")).toHaveLength(1);
  });

  it("joins again after a reload of the page", () => {
    const first = setup();
    first.joinRoom(party(["host"]));
    act(() => first.result.current.join("p1"));
    // A reload runs no cleanup, so the first stays mounted.

    const reloaded = setup();
    reloaded.joinRoom(party(["host"]));

    expect(reloaded.result.current.snapshot).not.toBeNull();
    expect(emitsOf(reloaded.socket, "watch-join")).toEqual([["watch-join", { partyId: "p1" }]]);
  });

  it("doesn't join again after leaving the room and coming back", () => {
    const first = setup();
    first.joinRoom(party(["host"]));
    act(() => first.result.current.join("p1"));
    first.unmount();

    const back = setup();
    back.joinRoom(party(["host"]));

    expect(back.result.current.snapshot).toBeNull();
    expect(emitsOf(back.socket, "watch-join")).toEqual([]);
  });

  it("forgets the party when it ends", () => {
    const { result, joinRoom, fire } = setup();
    joinRoom(party(["me"]));
    fire("watch-parties", []);
    expect(result.current.snapshot).toBeNull();
    expect(result.current.snapshot).toBeNull();
  });

  it("moves to another party when joining it, ignoring the old one's stale broadcast", () => {
    const { result, joinRoom, fire, socket } = setup();
    joinRoom(party(["host", "me"]), party(["other"], "p2"));
    expect(result.current.joinedPartyId).toBe("p1");

    act(() => result.current.join("p2"));
    // Sent before the server moved us.
    fire("watch-parties", [party(["host", "me"]), party(["other"], "p2")]);

    expect(result.current.joinedPartyId).toBe("p2");
    expect(result.current.snapshot?.party.id).toBe("p2");
    expect(emitsOf(socket, "watch-join")).toEqual([["watch-join", { partyId: "p2" }]]);
  });

  it("moves into a party it starts while watching another", () => {
    const { result, joinRoom, fire } = setup();
    joinRoom(party(["host", "me"]));
    act(() => result.current.prepareStart());
    fire("watch-parties", [party(["host", "me"])]);
    expect(result.current.joinedPartyId).toBe("p1");

    fire("watch-parties", [party(["host"]), party(["me"], "p2")]);
    expect(result.current.joinedPartyId).toBe("p2");
  });

  it("stays in its party while another one changes", () => {
    const { result, joinRoom, fire } = setup();
    joinRoom(party(["host", "me"]));
    fire("watch-parties", [party(["host", "me"]), party(["other"], "p2")]);
    expect(result.current.joinedPartyId).toBe("p1");
    expect(result.current.parties).toHaveLength(2);
  });

  describe("playbackFeed", () => {
    const paused = { state: "paused" as const, position: 30, rate: 1 };

    // Regression: after a reload the reply to watch-join can arrive before the
    // player mounts, which then started from the old, still-playing snapshot.
    it("keeps the reply to a join for a player that mounts after it", () => {
      const { result, joinRoom, fire } = setup();
      joinRoom(party(["host"]));
      act(() => result.current.join("p1"));
      fire("watch-playback", { ...paused, entryId: "e1" });

      expect(result.current.playbackFeed.latest()).toMatchObject({ entryId: "e1", playback: paused });
    });

    it("passes playback on to subscribers", () => {
      const { result, joinRoom, fire } = setup();
      joinRoom(party(["host", "me"]));
      const listener = vi.fn();
      const unsubscribe = result.current.playbackFeed.subscribe(listener);
      fire("watch-playback", { ...paused, entryId: "e1" });
      unsubscribe();
      fire("watch-playback", { ...paused, entryId: "e1" });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ playback: paused }));
    });

    it("drops playback for another video, or for a party it has left", () => {
      const { result, joinRoom, fire } = setup();
      joinRoom(party(["host", "me"]), makeParty({ id: "p2", entryId: "e2", memberIds: ["other"] }));
      fire("watch-playback", { ...paused, entryId: "old-entry" });
      expect(result.current.playbackFeed.latest()).toBeNull();

      act(() => result.current.join("p2"));
      // Sent by p1 before the server moved us.
      fire("watch-playback", { ...paused, entryId: "e1" });
      expect(result.current.playbackFeed.latest()).toBeNull();
      fire("watch-playback", { ...paused, entryId: "e2" });
      expect(result.current.playbackFeed.latest()?.entryId).toBe("e2");
    });
  });

  it("asks the server to end a party", () => {
    const { result, joinRoom, socket } = setup();
    joinRoom(party(["host"]));
    act(() => result.current.end("p1"));
    expect(emitsOf(socket, "watch-end")).toEqual([["watch-end", { partyId: "p1" }]]);
  });
});
