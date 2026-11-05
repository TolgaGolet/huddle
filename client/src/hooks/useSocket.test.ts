// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { io } from "socket.io-client";
import { claimClientKey } from "../lib/clientKey";
import { keepImageSessionOpen } from "../lib/imageUpload";
import { playDisconnectedSound } from "../lib/notificationSounds";
import { subscribeRoomSounds } from "../lib/roomSounds";
import { emitsOf, fakeSocket, type FakeSocket } from "../test/fakeSocket";
import { JOIN_ERROR } from "../types";
import { clearRoomEntry, roomEntryFor, setRoomEntry } from "../lib/roomEntry";
import { useSocket } from "./useSocket";

vi.mock("socket.io-client", () => ({ io: vi.fn() }));
vi.mock("../lib/clientKey", () => ({ claimClientKey: vi.fn() }));
vi.mock("../lib/imageUpload", () => ({ keepImageSessionOpen: vi.fn() }));
vi.mock("../lib/notificationSounds", () => ({ playDisconnectedSound: vi.fn() }));
vi.mock("../lib/roomSounds", () => ({ subscribeRoomSounds: vi.fn() }));

const ana = { id: "s-ana", userId: "u-ana", name: "Ana", isMuted: false };
const bo = { id: "s-bo", userId: "u-bo", name: "Bo", isMuted: false };
const joined = (overrides = {}) => ({ userId: "u-me", httpToken: "token", participants: [ana], screenSharer: null, closing: null, ...overrides });

let socket: FakeSocket;
let stopSession: ReturnType<typeof vi.fn>;

const props = { roomId: "room", name: "Me", isMuted: false };

/** Mounts the hook and lets the deferred socket creation run. */
async function setup(initial: Parameters<typeof useSocket>[0] = props) {
  const view = renderHook((p: Parameters<typeof useSocket>[0]) => useSocket(p), { initialProps: initial });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return view;
}

async function fire(event: string, data?: unknown) {
  await act(async () => {
    socket.fire(event, data);
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Connects and completes a first join, as a call does. */
async function setupJoined() {
  const view = await setup();
  await fire("connect");
  act(() => view.result.current.joinRoom());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await fire("room-joined", joined());
  socket.emit.mockClear();
  return view;
}

const notFound = { code: JOIN_ERROR.ROOM_NOT_FOUND, message: "Room not found" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  socket = fakeSocket();
  stopSession = vi.fn();
  vi.mocked(io).mockReset().mockImplementation(() => socket as never);
  vi.mocked(claimClientKey).mockReset().mockResolvedValue("client-key");
  vi.mocked(keepImageSessionOpen).mockReset().mockReturnValue(stopSession as () => void);
  vi.mocked(playDisconnectedSound).mockReset();
  vi.mocked(subscribeRoomSounds).mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("connection", () => {
  it("opens a websocket-only connection", async () => {
    const { result } = await setup();

    expect(io).toHaveBeenCalledWith({ transports: ["websocket"] });
    expect(result.current.socket).not.toBeNull();
  });

  // StrictMode's mount/unmount/mount must not open a WebSocket for the first mount.
  it("opens nothing if unmounted before the deferred creation runs", () => {
    const { unmount } = renderHook(() => useSocket(props));

    unmount();
    vi.advanceTimersByTime(10);

    expect(io).not.toHaveBeenCalled();
  });

  it.each([
    ["a room", { ...props, roomId: "" }],
    ["a name", { ...props, name: "" }],
  ])("opens nothing without %s", async (_label, incomplete) => {
    await setup(incomplete);

    expect(io).not.toHaveBeenCalled();
  });

  it("reports the connected state", async () => {
    const { result } = await setup();
    expect(result.current.connected).toBe(false);

    await fire("connect");
    expect(result.current.connected).toBe(true);

    await fire("disconnect", "transport close");
    expect(result.current.connected).toBe(false);
  });

  it("releases everything on unmount", async () => {
    const { unmount } = await setupJoined();

    unmount();

    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.listening("connect")).toBe(0);
    expect(stopSession).toHaveBeenCalled();
  });
});

describe("joining", () => {
  it("doesn't join until the caller says signaling is ready", async () => {
    await setup();

    await fire("connect");

    expect(emitsOf(socket, "join-room")).toEqual([]);
  });

  it("sends the current details and the claimed key", async () => {
    setRoomEntry({ roomId: "room", password: "pw", ownerToken: "owner-token" });
    const { result } = await setup({ ...props, isMuted: true });
    await fire("connect");

    act(() => result.current.joinRoom());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(emitsOf(socket, "join-room")).toEqual([
      ["join-room", { roomId: "room", name: "Me", password: "pw", ownerToken: "owner-token", isMuted: true, clientKey: "client-key" }],
    ]);
    clearRoomEntry();
  });

  // Regression: the password stayed available to every later rejoin.
  it("forgets the password once it has joined", async () => {
    setRoomEntry({ roomId: "room", password: "pw" });
    await setupJoined();

    expect(roomEntryFor("room")).toEqual({});
  });

  it("forgets the password when a join fails", async () => {
    setRoomEntry({ roomId: "room", password: "pw" });
    await setup();

    await fire("error", { code: JOIN_ERROR.INCORRECT_PASSWORD, message: "Incorrect password" });

    expect(roomEntryFor("room")).toEqual({});
  });

  it("tracks settings from joining and from later changes", async () => {
    const { result } = await setupJoined();
    const settings = { pinPermission: "owners", screenSharePermission: "everyone", messagePermission: "everyone", waitingRoom: true, hasPassword: false, ownerIds: ["u-me"] };

    await fire("room-settings", settings);

    expect(result.current.settings).toEqual(settings);
  });

  // Regression: someone who lost their mic while waiting was announced as unmuted.
  it("sends a mute change made while waiting once admitted, and not otherwise", async () => {
    const { rerender } = await setup();
    await fire("join-waiting");
    rerender({ ...props, isMuted: true });

    await fire("room-joined", joined());
    expect(emitsOf(socket, "mute-toggle")).toEqual([["mute-toggle", { isMuted: true }]]);

    await fire("room-joined", joined());
    expect(emitsOf(socket, "mute-toggle")).toHaveLength(1);
  });

  it("shows the waiting room until joined", async () => {
    const { result } = await setup();

    await fire("join-waiting");
    expect(result.current.isWaiting).toBe(true);

    await fire("room-joined", joined());
    expect(result.current.isWaiting).toBe(false);
  });

  it("tracks who is waiting and who couldn't be accepted", async () => {
    const { result } = await setupJoined();
    const person = { id: "s1", name: "Bo", wasRemoved: true };

    await fire("waiting-list", [person]);
    await fire("admit-refused", { id: "s1" });

    expect(result.current.waitingList).toEqual([person]);
    expect(result.current.admitRefusedId).toBe("s1");
  });

  it("reports being kicked and doesn't try to rejoin", async () => {
    const { result } = await setupJoined();

    await fire("kicked");

    expect(result.current.exit).toEqual({ notice: expect.stringMatching(/removed you/) });
  });

  it("joins on connect when the caller was ready first", async () => {
    const { result } = await setup();
    socket.connected = false;
    act(() => result.current.joinRoom());
    expect(claimClientKey).not.toHaveBeenCalled();

    socket.connected = true;
    await fire("connect");

    expect(emitsOf(socket, "join-room")).toHaveLength(1);
  });

  it("doesn't join twice for repeated calls", async () => {
    const { result } = await setup();
    await fire("connect");

    act(() => {
      result.current.joinRoom();
      result.current.joinRoom();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(emitsOf(socket, "join-room")).toHaveLength(1);
  });

  it("drops the join if the socket went down during the key claim", async () => {
    let finishClaim!: (key: string) => void;
    vi.mocked(claimClientKey).mockReturnValue(new Promise((resolve) => (finishClaim = resolve)));
    const { result } = await setup();
    await fire("connect");
    act(() => result.current.joinRoom());

    socket.connected = false;
    await fire("disconnect", "transport close");
    await act(async () => {
      finishClaim("client-key");
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(emitsOf(socket, "join-room")).toEqual([]);
  });

  it("exposes identity, token and roster once joined", async () => {
    const { result } = await setupJoined();

    expect(result.current.userId).toBe("u-me");
    expect(result.current.httpToken).toBe("token");
    expect(result.current.participants).toEqual([ana]);
  });

  it("tracks a closing warning, and drops it when cancelled", async () => {
    const { result } = await setupJoined();
    expect(result.current.closing).toBeNull();

    await fire("room-closing", { reason: "inactive", remainingMs: 60_000 });
    expect(result.current.closing?.reason).toBe("inactive");
    expect(result.current.closing!.closesAt).toBeGreaterThan(Date.now());

    await fire("room-closing", null);
    expect(result.current.closing).toBeNull();
  });

  it("picks up a warning already running when it joins", async () => {
    const { result } = await setupJoined();

    await fire("room-joined", joined({ closing: { reason: "lifetime", remainingMs: 1000 } }));

    expect(result.current.closing?.reason).toBe("lifetime");
  });

  it("reports the room closing and stops trying to rejoin", async () => {
    const { result } = await setupJoined();

    await fire("room-closed", { reason: "inactive" });

    expect(result.current.exit).toEqual({ notice: expect.stringMatching(/31 minutes/) });
  });

  it("opens the image session and bumps its counter each time it settles", async () => {
    const { result } = await setupJoined();
    expect(keepImageSessionOpen).toHaveBeenCalledWith("room", "token", expect.any(Function));
    expect(result.current.imageSession).toBe(0);

    const settled = vi.mocked(keepImageSessionOpen).mock.calls[0][2];
    act(() => settled());
    act(() => settled());

    expect(result.current.imageSession).toBe(2);
  });

  it("replaces the image session on every join", async () => {
    await setupJoined();

    await fire("room-joined", joined({ httpToken: "token-2" }));

    expect(stopSession).toHaveBeenCalledOnce();
    expect(vi.mocked(keepImageSessionOpen).mock.calls[1][1]).toBe("token-2");
  });

  it("lets room sounds read the identity that's current when they play", async () => {
    await setupJoined();

    const getUserId = vi.mocked(subscribeRoomSounds).mock.calls[0][1];

    expect(getUserId()).toBe("u-me");
  });
});

describe("roster", () => {
  it("adds someone joining, replacing a stale entry with the same id", async () => {
    const { result } = await setupJoined();

    await fire("participant-joined", bo);
    await fire("participant-joined", { ...bo, name: "Bo2" });

    expect(result.current.participants.map((p) => p.name)).toEqual(["Ana", "Bo2"]);
  });

  it("removes someone leaving", async () => {
    const { result } = await setupJoined();

    await fire("participant-left", { id: ana.id, userId: ana.userId });

    expect(result.current.participants).toEqual([]);
  });

  it("updates only the participant whose mute changed", async () => {
    const { result } = await setupJoined();
    await fire("participant-joined", bo);

    await fire("participant-muted", { id: bo.id, isMuted: true });

    expect(result.current.participants.map((p) => p.isMuted)).toEqual([false, true]);
  });
});

describe("screen sharer", () => {
  it("comes from the join and later events", async () => {
    const { result } = await setupJoined();
    await fire("room-joined", joined({ screenSharer: ana.id }));
    expect(result.current.currentScreenSharer).toBe(ana.id);

    await fire("screen-share-stopped", { id: ana.id });
    expect(result.current.currentScreenSharer).toBeNull();

    await fire("screen-share-started", { id: bo.id });
    expect(result.current.currentScreenSharer).toBe(bo.id);
  });

  it("ignores a stop from someone who isn't sharing", async () => {
    const { result } = await setupJoined();
    await fire("screen-share-started", { id: ana.id });

    await fire("screen-share-stopped", { id: bo.id });

    expect(result.current.currentScreenSharer).toBe(ana.id);
  });

  it("clears when the sharer leaves, but not for anyone else", async () => {
    const { result } = await setupJoined();
    await fire("screen-share-started", { id: ana.id });

    await fire("participant-left", { id: bo.id, userId: bo.userId });
    expect(result.current.currentScreenSharer).toBe(ana.id);

    await fire("participant-left", { id: ana.id, userId: ana.userId });
    expect(result.current.currentScreenSharer).toBeNull();
  });
});

describe("disconnects", () => {
  it("warns of an unexpected drop and ends the HTTP token and image session", async () => {
    const { result } = await setupJoined();

    await fire("disconnect", "transport close");

    expect(playDisconnectedSound).toHaveBeenCalledOnce();
    expect(result.current.httpToken).toBeNull();
    expect(stopSession).toHaveBeenCalled();
  });

  it("stays quiet when the client disconnected itself", async () => {
    await setupJoined();

    await fire("disconnect", "io client disconnect");

    expect(playDisconnectedSound).not.toHaveBeenCalled();
  });

  it("stays quiet before the caller has asked to join", async () => {
    await setup();

    await fire("disconnect", "transport close");

    expect(playDisconnectedSound).not.toHaveBeenCalled();
  });

  it("rejoins on reconnect with the state at that moment", async () => {
    const { rerender } = await setupJoined();
    await fire("disconnect", "transport close");
    rerender({ ...props, isMuted: true });

    await fire("connect");

    expect(emitsOf(socket, "join-room")).toEqual([["join-room", expect.objectContaining({ isMuted: true })]]);
  });
});

describe("join errors", () => {
  it("reports a dead link at once on a first join", async () => {
    const { result } = await setup();
    await fire("connect");
    act(() => result.current.joinRoom());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await fire("error", notFound);

    expect(result.current.exit).toEqual({ error: "Room not found" });
    expect(socket.disconnect).toHaveBeenCalled();
  });

  it("retries a rejoin while the room is missing, without kicking the user", async () => {
    const { result } = await setupJoined();
    await fire("disconnect", "transport close");
    await fire("connect");
    socket.emit.mockClear();

    await fire("error", notFound);
    expect(result.current.exit).toBeNull();
    expect(socket.disconnect).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(emitsOf(socket, "join-room")).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(emitsOf(socket, "join-room")).toHaveLength(1);
  });

  it("gives up once the retries run out", async () => {
    const { result } = await setupJoined();

    for (const delay of [1000, 2000, 4000, 8000, 15000]) {
      await fire("error", notFound);
      expect(result.current.exit).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay);
      });
    }
    await fire("error", notFound);

    expect(result.current.exit).toEqual({ error: "Room not found" });
    expect(socket.disconnect).toHaveBeenCalled();
  });

  it("starts the backoff over after a successful rejoin", async () => {
    await setupJoined();
    await fire("error", notFound);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await fire("room-joined", joined());
    socket.emit.mockClear();

    await fire("error", notFound);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(emitsOf(socket, "join-room")).toHaveLength(1);
  });

  it.each([JOIN_ERROR.INCORRECT_PASSWORD, JOIN_ERROR.NAME_TAKEN, JOIN_ERROR.ROOM_FULL])("doesn't retry a rejoin that failed with %s", async (code) => {
    const { result } = await setupJoined();

    await fire("error", { code, message: "No" });

    expect(result.current.exit).toEqual({ error: "No" });
  });

  it("cancels a pending retry on unmount", async () => {
    const { unmount } = await setupJoined();
    await fire("error", notFound);

    unmount();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(emitsOf(socket, "join-room")).toEqual([]);
  });

  // Suspected bug: hasJoinedRef is never reset, and RoomCall has no `key` on the room id.
  // Going straight from one room to another (history go(-2), which keeps RoomPage mounted)
  // treats the first join of the new room as a rejoin: a dead link retries for 30s
  // instead of reporting at once.
  it.skip("reports a dead link at once after moving to a different room", async () => {
    const { result, rerender } = await setupJoined();
    const next = fakeSocket();
    vi.mocked(io).mockImplementation(() => next as never);
    socket = next;
    rerender({ ...props, roomId: "other" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await fire("connect");
    act(() => result.current.joinRoom());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await fire("error", notFound);

    expect(result.current.exit).toEqual({ error: "Room not found" });
  });
});
