import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { setupSignaling } from "./signaling.js";
import { setupWatchParty } from "./watchPartyHandler.js";
import { WATCH_PARTY_GRACE_MS } from "./limits.js";
import { createRoom, getRoom } from "./roomManager.js";
import type { ChatMessage, WatchPartyState, WatchPlayback } from "./protocol.js";

const VIDEO = "dQw4w9WgXcQ";
const OTHER_VIDEO = "9bZkp7q19f0";

let httpServer: HttpServer;
let io: Server;
let url: string;
const clients: ClientSocket[] = [];

beforeAll(async () => {
  httpServer = createServer();
  io = new Server(httpServer, { transports: ["websocket"] });
  setupSignaling(io);
  setupWatchParty(io);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await io.close();
});

afterEach(() => {
  vi.useRealTimers();
  for (const c of clients.splice(0)) c.disconnect();
});

type Joined = { socket: ClientSocket; userId: string; watchParty: WatchPartyState | null };

async function join(roomId: string, name: string, clientKey?: string): Promise<Joined> {
  const socket = connect(url, { transports: ["websocket"] });
  clients.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("room-joined", (data: { userId: string; watchParty: WatchPartyState | null }) =>
      resolve({ socket, userId: data.userId, watchParty: data.watchParty }),
    );
    socket.once("error", (e: { message: string }) => reject(new Error(e.message)));
    socket.emit("join-room", { roomId, name, clientKey });
  });
}

const next = <T,>(socket: ClientSocket, event: string) => new Promise<T>((resolve) => socket.once(event, resolve));

/** Resolves with the next party state matching `test`. */
function partyWhere(socket: ClientSocket, test: (p: WatchPartyState | null) => boolean): Promise<WatchPartyState | null> {
  return new Promise((resolve) => {
    const handler = (p: WatchPartyState | null) => {
      if (!test(p)) return;
      socket.off("watch-party", handler);
      resolve(p);
    };
    socket.on("watch-party", handler);
  });
}

async function start(host: Joined, allowOthersToChange = false): Promise<WatchPartyState> {
  const party = next<WatchPartyState>(host.socket, "watch-party");
  host.socket.emit("watch-start", { videoId: VIDEO, allowOthersToChange });
  return party;
}

/** A room with Ana hosting a party and Ben in the room, not yet in it. */
async function partyRoom(allowOthersToChange = false) {
  const roomId = createRoom().id;
  const ana = await join(roomId, "Ana");
  const ben = await join(roomId, "Ben");
  const party = await start(ana, allowOthersToChange);
  return { roomId, ana, ben, party };
}

/** Joins and waits for both the party state and the playback a joiner is sent. */
async function joinParty(member: Joined, partyId: string): Promise<WatchPartyState> {
  const state = partyWhere(member.socket, (p) => !!p?.memberIds.includes(member.userId));
  const playback = next<WatchPlayback>(member.socket, "watch-playback");
  member.socket.emit("watch-join", { partyId });
  const joined = (await state)!;
  await playback;
  return joined;
}

/** Drops the connection without leaving, as a network blip does. */
function loseConnection(member: Joined): void {
  member.socket.io.engine.close();
}

describe("watch-start", () => {
  it("starts a playing party with the starter as host and announces it in the chat", async () => {
    const roomId = createRoom().id;
    const ana = await join(roomId, "Ana");
    const ben = await join(roomId, "Ben");
    const benParty = next<WatchPartyState>(ben.socket, "watch-party");
    const benInvite = next<ChatMessage>(ben.socket, "chat-message");

    ana.socket.emit("watch-start", { videoId: VIDEO, allowOthersToChange: true });

    const party = await benParty;
    expect(party).toMatchObject({ hostId: ana.userId, videoId: VIDEO, allowOthersToChange: true, memberIds: [ana.userId] });
    expect(party.playback.state).toBe("playing");
    const invite = await benInvite;
    expect(invite).toMatchObject({ senderId: ana.userId, senderName: "Ana", watchInvite: { partyId: party.id, videoId: VIDEO } });
    expect(getRoom(roomId)!.chatHistory.at(-1)?.id).toBe(invite.id);
  });

  it("refuses a second party while one is running", async () => {
    const { roomId, ben, party } = await partyRoom();
    const refused = next<{ reason: string }>(ben.socket, "watch-start-refused");

    ben.socket.emit("watch-start", { videoId: OTHER_VIDEO, allowOthersToChange: false });

    expect(await refused).toEqual({ reason: "active" });
    expect(getRoom(roomId)!.watchParty?.id).toBe(party.id);
  });

  it("is refused without the message permission", async () => {
    const roomId = createRoom().id;
    const ana = await join(roomId, "Ana");
    getRoom(roomId)!.settings.messagePermission = "owners";

    const refused = next<{ event: string }>(ana.socket, "not-permitted");
    ana.socket.emit("watch-start", { videoId: VIDEO, allowOthersToChange: false });

    expect(await refused).toEqual({ event: "watch-start" });
    expect(getRoom(roomId)!.watchParty).toBeNull();
  });
});

describe("watch-join", () => {
  it("adds the member and gives late joiners the projected position", async () => {
    const { roomId, ben, party } = await partyRoom();
    const stored = getRoom(roomId)!.watchParty!;
    stored.playback = { state: "playing", position: 10, rate: 2 };
    stored.updatedAt = Date.now() - 5_000;

    const joined = await joinParty(ben, party.id);

    expect(joined.memberIds).toHaveLength(2);
    // 10 s plus 5 s at double speed.
    expect(joined.playback.position).toBeGreaterThanOrEqual(20);
    expect(joined.playback.position).toBeLessThan(21);
  });

  it("sends the joiner the current playback, which members' party states can't carry", async () => {
    const { roomId, ben, party } = await partyRoom();
    const stored = getRoom(roomId)!.watchParty!;
    stored.playback = { state: "paused", position: 30, rate: 1 };
    const playback = next<WatchPlayback>(ben.socket, "watch-playback");
    ben.socket.emit("watch-join", { partyId: party.id });
    expect(await playback).toEqual({ state: "paused", position: 30, rate: 1 });
  });

  it("ignores a stale party id", async () => {
    const { roomId, ben } = await partyRoom();
    ben.socket.emit("watch-join", { partyId: "old-party" });
    // A round trip through the same handler order shows it changed nothing.
    ben.socket.emit("watch-leave");
    await vi.waitFor(() => expect(getRoom(roomId)!.watchParty!.members.size).toBe(1));
  });

  it("is in room-joined for someone arriving later", async () => {
    const { roomId, party } = await partyRoom();
    const cara = await join(roomId, "Cara");
    expect(cara.watchParty?.id).toBe(party.id);
  });
});

describe("watch-playback", () => {
  it("relays to the other members only and stores the state", async () => {
    const { roomId, ana, ben, party } = await partyRoom();
    const cara = await join(roomId, "Cara");
    await joinParty(ben, party.id);
    const caraHeard = vi.fn();
    cara.socket.on("watch-playback", caraHeard);
    const anaHeard = vi.fn();
    ana.socket.on("watch-playback", anaHeard);

    const relayed = next<WatchPlayback>(ben.socket, "watch-playback");
    ana.socket.emit("watch-playback", { videoId: VIDEO, state: "paused", position: 42, rate: 1 });

    expect(await relayed).toEqual({ state: "paused", position: 42, rate: 1 });
    expect(getRoom(roomId)!.watchParty!.playback).toEqual({ state: "paused", position: 42, rate: 1 });
    expect(caraHeard).not.toHaveBeenCalled();
    expect(anaHeard).not.toHaveBeenCalled();
  });

  it("ignores someone who isn't in the party", async () => {
    const { roomId, ana, ben } = await partyRoom();
    ben.socket.emit("watch-playback", { videoId: VIDEO, state: "paused", position: 99, rate: 1 });
    // Ana's own update, sent after, is handled after Ben's.
    ana.socket.emit("watch-playback", { videoId: VIDEO, state: "playing", position: 5, rate: 1 });
    await vi.waitFor(() => expect(getRoom(roomId)!.watchParty!.playback.position).toBe(5));
  });

  it("ignores a report about the previous video", async () => {
    const { roomId, ana, ben, party } = await partyRoom(true);
    await joinParty(ben, party.id);
    const changed = partyWhere(ben.socket, (p) => p?.videoId === OTHER_VIDEO);
    ana.socket.emit("watch-change-video", { videoId: OTHER_VIDEO });
    await changed;

    const anaHeard = next<WatchPlayback>(ana.socket, "watch-playback");
    ben.socket.emit("watch-playback", { videoId: VIDEO, state: "paused", position: 600, rate: 1 });
    ben.socket.emit("watch-playback", { videoId: OTHER_VIDEO, state: "playing", position: 2, rate: 1 });
    // The stale report, sent first, was neither relayed nor stored.
    expect(await anaHeard).toEqual({ state: "playing", position: 2, rate: 1 });
    expect(getRoom(roomId)!.watchParty!.playback).toEqual({ state: "playing", position: 2, rate: 1 });
  });

  // Regression guard: io.to([]) sends to every socket on the server.
  it("sends nothing when the sender is the only member", async () => {
    const { ana, ben } = await partyRoom();
    const benHeard = vi.fn();
    ben.socket.on("watch-playback", benHeard);
    ana.socket.emit("watch-playback", { videoId: VIDEO, state: "paused", position: 3, rate: 1 });
    const echo = partyWhere(ana.socket, () => true);
    ana.socket.emit("watch-change-video", { videoId: OTHER_VIDEO });
    await echo;
    expect(benHeard).not.toHaveBeenCalled();
  });
});

describe("watch-change-video", () => {
  it("lets only the host change the video unless others may", async () => {
    const { roomId, ana, ben, party } = await partyRoom(false);
    await joinParty(ben, party.id);

    ben.socket.emit("watch-change-video", { videoId: OTHER_VIDEO });
    const changed = partyWhere(ben.socket, (p) => p?.videoId === OTHER_VIDEO);
    ana.socket.emit("watch-change-video", { videoId: OTHER_VIDEO });
    const state = await changed;

    expect(state?.playback).toMatchObject({ state: "playing", rate: 1 });
    expect(state!.playback.position).toBeLessThan(1);
    expect(getRoom(roomId)!.watchParty!.videoId).toBe(OTHER_VIDEO);
  });

  it("lets any member change it when allowed", async () => {
    const { ana, ben, party } = await partyRoom(true);
    await joinParty(ben, party.id);
    const changed = partyWhere(ana.socket, (p) => p?.videoId === OTHER_VIDEO);
    ben.socket.emit("watch-change-video", { videoId: OTHER_VIDEO });
    expect((await changed)?.videoId).toBe(OTHER_VIDEO);
  });

  it("refuses a guest when not allowed", async () => {
    const { roomId, ben, party } = await partyRoom(false);
    await joinParty(ben, party.id);
    ben.socket.emit("watch-change-video", { videoId: OTHER_VIDEO });
    ben.socket.emit("watch-playback", { videoId: VIDEO, state: "paused", position: 1, rate: 1 });
    await vi.waitFor(() => expect(getRoom(roomId)!.watchParty!.playback.state).toBe("paused"));
    expect(getRoom(roomId)!.watchParty!.videoId).toBe(VIDEO);
  });
});

describe("leaving", () => {
  it("hands the host role on when the host leaves", async () => {
    const { ana, ben, party } = await partyRoom();
    await joinParty(ben, party.id);
    const handedOn = partyWhere(ben.socket, (p) => p?.hostId === ben.userId);
    ana.socket.emit("watch-leave");
    expect((await handedOn)?.memberIds).toEqual([ben.userId]);
  });

  it("ends the party at once when the last member leaves it", async () => {
    const { roomId, ana, ben } = await partyRoom();
    const ended = partyWhere(ben.socket, (p) => p === null);
    ana.socket.emit("watch-leave");
    expect(await ended).toBeNull();
    expect(getRoom(roomId)!.watchParty).toBeNull();
  });

  it("waits for a member who lost their connection, then ends", async () => {
    const roomId = createRoom().id;
    const ben = await join(roomId, "Ben");
    const ana = await join(roomId, "Ana");
    await start(ana);
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const memberGone = partyWhere(ben.socket, (p) => p?.memberIds.length === 0);
      loseConnection(ana);
      await memberGone;
      expect(getRoom(roomId)!.watchParty).not.toBeNull();

      const call = setSpy.mock.calls.find(([, ms]) => ms === WATCH_PARTY_GRACE_MS);
      expect(call).toBeDefined();
      const ended = partyWhere(ben.socket, (p) => p === null);
      (call![0] as () => void)();
      expect(await ended).toBeNull();
    } finally {
      setSpy.mockRestore();
    }
  });

  it("keeps the party for a member who comes back in time", async () => {
    const KEY = "ana-secret-key-0123456789";
    const roomId = createRoom().id;
    const ben = await join(roomId, "Ben");
    const ana = await join(roomId, "Ana", KEY);
    const party = await start(ana);
    const memberGone = partyWhere(ben.socket, (p) => p?.memberIds.length === 0);
    loseConnection(ana);
    await memberGone;

    const back = await join(roomId, "Ana", KEY);
    expect(back.watchParty?.id).toBe(party.id);
    const rejoined = await joinParty(back, party.id);
    expect(rejoined.memberIds).toEqual([back.userId]);
    expect(rejoined.hostId).toBe(back.userId);
  });

  it("ends the party at once when its last member leaves the room", async () => {
    const { roomId, ana, ben } = await partyRoom();
    const ended = partyWhere(ben.socket, (p) => p === null);
    ana.socket.disconnect();
    expect(await ended).toBeNull();
    expect(getRoom(roomId)!.watchParty).toBeNull();
  });

  it("gives a host who lost their connection the role back when they return", async () => {
    const KEY = "ana-secret-key-0123456789";
    const roomId = createRoom().id;
    const ben = await join(roomId, "Ben");
    const ana = await join(roomId, "Ana", KEY);
    const party = await start(ana);
    await joinParty(ben, party.id);

    const covering = partyWhere(ben.socket, (p) => p?.hostId === ben.userId);
    loseConnection(ana);
    await covering;

    const back = await join(roomId, "Ana", KEY);
    const rejoined = await joinParty(back, party.id);
    expect(rejoined.hostId).toBe(back.userId);
    expect(rejoined.memberIds).toEqual([ben.userId, back.userId]);
  });
});
