import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { setupSignaling } from "./signaling.js";
import { setupWatchParty } from "./watchPartyHandler.js";
import { MAX_WATCH_PARTIES, MAX_WATCH_QUEUE, WATCH_PARTY_GRACE_MS } from "./limits.js";
import { createRoom, getRoom } from "./roomManager.js";
import type { ChatMessage, WatchPartyState, WatchPlayback } from "./protocol.js";

const VIDEO = "dQw4w9WgXcQ";
const OTHER_VIDEO = "9bZkp7q19f0";
const THIRD_VIDEO = "kJQP7kiw5Fk";

let httpServer: HttpServer;
let io: Server;
let url: string;
const clients: ClientSocket[] = [];
/** Titles the fake lookup knows; anything else resolves to null. */
const titles = new Map<string, string>([[VIDEO, "Never Gonna Give You Up"]]);

beforeAll(async () => {
  httpServer = createServer();
  io = new Server(httpServer, { transports: ["websocket"] });
  setupSignaling(io);
  setupWatchParty(io, { lookupTitle: (videoId) => Promise.resolve(titles.get(videoId) ?? null) });
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

type Joined = { socket: ClientSocket; userId: string; watchParties: WatchPartyState[] };

async function join(roomId: string, name: string, clientKey?: string): Promise<Joined> {
  const socket = connect(url, { transports: ["websocket"] });
  clients.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("room-joined", (data: { userId: string; watchParties: WatchPartyState[] }) =>
      resolve({ socket, userId: data.userId, watchParties: data.watchParties }),
    );
    socket.once("error", (e: { message: string }) => reject(new Error(e.message)));
    socket.emit("join-room", { roomId, name, clientKey });
  });
}

const next = <T,>(socket: ClientSocket, event: string) => new Promise<T>((resolve) => socket.once(event, resolve));

/** Resolves with the next list of parties matching `test`. */
function partiesWhere(socket: ClientSocket, test: (parties: WatchPartyState[]) => boolean): Promise<WatchPartyState[]> {
  return new Promise((resolve) => {
    const handler = (parties: WatchPartyState[]) => {
      if (!test(parties)) return;
      socket.off("watch-parties", handler);
      resolve(parties);
    };
    socket.on("watch-parties", handler);
  });
}

/** Resolves with party `id` once it matches `test` (null: once it has ended). */
function partyWhere(socket: ClientSocket, id: string, test: (p: WatchPartyState | null) => boolean): Promise<WatchPartyState | null> {
  return partiesWhere(socket, (parties) => test(parties.find((p) => p.id === id) ?? null)).then(
    (parties) => parties.find((p) => p.id === id) ?? null,
  );
}

const ended = (socket: ClientSocket, id: string) => partyWhere(socket, id, (p) => p === null);

async function start(host: Joined, allowOthersToChange = false, videoId = VIDEO): Promise<WatchPartyState> {
  const parties = partiesWhere(host.socket, (list) => list.some((p) => p.memberIds.includes(host.userId) && p.videoId === videoId));
  host.socket.emit("watch-start", { videoId, allowOthersToChange });
  return (await parties).find((p) => p.memberIds.includes(host.userId))!;
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
  const state = partyWhere(member.socket, partyId, (p) => !!p?.memberIds.includes(member.userId));
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

const stored = (roomId: string, partyId: string) => getRoom(roomId)!.watchParties.get(partyId)!;

/**
 * A round trip through `member`'s handlers, which run in order, so whatever it
 * sent before has been handled. Through mute, which anyone may send, since a
 * dropped event has no reply to wait for.
 */
async function roundTrip(member: Joined, observer: Joined): Promise<void> {
  const heard = next(observer.socket, "participant-muted");
  member.socket.emit("mute-toggle", { isMuted: true });
  await heard;
}

describe("watch-start", () => {
  it("starts a playing party with the starter as host and announces it in the chat", async () => {
    const roomId = createRoom().id;
    const ana = await join(roomId, "Ana");
    const ben = await join(roomId, "Ben");
    const benParties = next<WatchPartyState[]>(ben.socket, "watch-parties");
    const benInvite = next<ChatMessage>(ben.socket, "chat-message");

    ana.socket.emit("watch-start", { videoId: VIDEO, allowOthersToChange: true });

    const [party] = await benParties;
    expect(party).toMatchObject({ hostId: ana.userId, videoId: VIDEO, allowOthersToChange: true, memberIds: [ana.userId], queue: [] });
    expect(party.playback.state).toBe("playing");
    const invite = await benInvite;
    expect(invite).toMatchObject({ senderId: ana.userId, senderName: "Ana", watchInvite: { partyId: party.id, videoId: VIDEO } });
    expect(getRoom(roomId)!.chatHistory.at(-1)?.id).toBe(invite.id);
  });

  it("looks up the video's title", async () => {
    const { ben, party } = await partyRoom();
    const titled = party.title ? party : await partyWhere(ben.socket, party.id, (p) => !!p?.title);
    expect(titled?.title).toBe("Never Gonna Give You Up");
  });

  it(`allows ${MAX_WATCH_PARTIES} parties at once, then refuses with the limit`, async () => {
    const { roomId, ben, party } = await partyRoom();
    const second = await start(ben, false, OTHER_VIDEO);
    expect(second.id).not.toBe(party.id);
    expect(getRoom(roomId)!.watchParties.size).toBe(2);

    const cara = await join(roomId, "Cara");
    const refused = next<{ reason: string; max: number }>(cara.socket, "watch-start-refused");
    cara.socket.emit("watch-start", { videoId: THIRD_VIDEO, allowOthersToChange: false });
    expect(await refused).toEqual({ reason: "limit", max: MAX_WATCH_PARTIES });
    expect(getRoom(roomId)!.watchParties.size).toBe(2);
  });

  // Regression: the limit was checked before the starter left their party.
  it("lets someone alone in their party replace it at the limit", async () => {
    const { roomId, ana, ben, party } = await partyRoom();
    await start(ben, false, OTHER_VIDEO);
    const replaced = await start(ana, false, THIRD_VIDEO);
    expect(replaced.id).not.toBe(party.id);
    expect([...getRoom(roomId)!.watchParties.keys()]).not.toContain(party.id);
    expect(getRoom(roomId)!.watchParties.size).toBe(2);
  });

  it("leaves the starter's previous party", async () => {
    const { roomId, ana, ben, party } = await partyRoom();
    await joinParty(ben, party.id);
    const benLeft = partyWhere(ana.socket, party.id, (p) => p?.memberIds.length === 1);
    const second = await start(ben, false, OTHER_VIDEO);
    expect((await benLeft)?.memberIds).toEqual([ana.userId]);
    expect(stored(roomId, second.id).members.size).toBe(1);
  });

  it("is refused without the message permission", async () => {
    const roomId = createRoom().id;
    const ana = await join(roomId, "Ana");
    getRoom(roomId)!.settings.messagePermission = "owners";
    getRoom(roomId)!.owners.clear();

    const refused = next<{ event: string }>(ana.socket, "not-permitted");
    ana.socket.emit("watch-start", { videoId: VIDEO, allowOthersToChange: false });

    expect(await refused).toEqual({ event: "watch-start" });
    expect(getRoom(roomId)!.watchParties.size).toBe(0);
  });
});

describe("watch-join", () => {
  it("adds the member and gives late joiners the projected position", async () => {
    const { roomId, ben, party } = await partyRoom();
    const s = stored(roomId, party.id);
    s.playback = { state: "playing", position: 10, rate: 2 };
    s.updatedAt = Date.now() - 5_000;

    const joined = await joinParty(ben, party.id);

    expect(joined.memberIds).toHaveLength(2);
    // 10 s plus 5 s at double speed.
    expect(joined.playback.position).toBeGreaterThanOrEqual(20);
    expect(joined.playback.position).toBeLessThan(21);
  });

  it("sends the joiner the current playback, which members' party states can't carry", async () => {
    const { roomId, ben, party } = await partyRoom();
    stored(roomId, party.id).playback = { state: "paused", position: 30, rate: 1 };
    const playback = next<WatchPlayback>(ben.socket, "watch-playback");
    ben.socket.emit("watch-join", { partyId: party.id });
    expect(await playback).toEqual({ state: "paused", position: 30, rate: 1, entryId: party.entryId });
  });

  it("leaves the member's other party, which ends if they were its last", async () => {
    const { roomId, ana, ben, party } = await partyRoom();
    const second = await start(ben, false, OTHER_VIDEO);
    const secondEnded = ended(ana.socket, second.id);
    const joined = await joinParty(ben, party.id);
    await secondEnded;
    expect(joined.memberIds).toEqual([ana.userId, ben.userId]);
    expect([...getRoom(roomId)!.watchParties.keys()]).toEqual([party.id]);
  });

  it("ignores a stale party id", async () => {
    const { roomId, ben } = await partyRoom();
    ben.socket.emit("watch-join", { partyId: "old-party" });
    // A round trip through the same handler order shows it changed nothing.
    ben.socket.emit("watch-leave");
    await vi.waitFor(() => expect([...getRoom(roomId)!.watchParties.values()][0].members.size).toBe(1));
  });

  it("is in room-joined for someone arriving later", async () => {
    const { roomId, party } = await partyRoom();
    const cara = await join(roomId, "Cara");
    expect(cara.watchParties.map((p) => p.id)).toEqual([party.id]);
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
    ana.socket.emit("watch-playback", { entryId: party.entryId, state: "paused", position: 42, rate: 1 });

    expect(await relayed).toEqual({ state: "paused", position: 42, rate: 1, entryId: party.entryId });
    expect(stored(roomId, party.id).playback).toEqual({ state: "paused", position: 42, rate: 1 });
    expect(caraHeard).not.toHaveBeenCalled();
    expect(anaHeard).not.toHaveBeenCalled();
  });

  it("ignores someone who isn't in the party", async () => {
    const { roomId, ana, ben, party } = await partyRoom();
    ben.socket.emit("watch-playback", { entryId: party.entryId, state: "paused", position: 99, rate: 1 });
    // Ana's own update, sent after, is handled after Ben's.
    ana.socket.emit("watch-playback", { entryId: party.entryId, state: "playing", position: 5, rate: 1 });
    await vi.waitFor(() => expect(stored(roomId, party.id).playback.position).toBe(5));
  });

  it("ignores a member who may not control the party", async () => {
    const { roomId, ana, ben, party } = await partyRoom(false);
    await joinParty(ben, party.id);
    const anaHeard = vi.fn();
    ana.socket.on("watch-playback", anaHeard);
    ben.socket.emit("watch-playback", { entryId: party.entryId, state: "paused", position: 99, rate: 1 });
    await roundTrip(ben, ana);
    expect(stored(roomId, party.id).playback.state).toBe("playing");
    expect(anaHeard).not.toHaveBeenCalled();
  });

  // Regression: reports were matched by video, so one about the last play
  // moved the next play of the same video (a repeat, or queued twice).
  it("ignores a report about the previous play, even of the same video", async () => {
    const { roomId, ana, ben, party } = await partyRoom(true);
    await joinParty(ben, party.id);
    const replayed = partyWhere(ben.socket, party.id, (p) => !!p && p.entryId !== party.entryId);
    ana.socket.emit("watch-change-video", { videoId: VIDEO });
    const replay = (await replayed)!;

    const anaHeard = next<WatchPlayback>(ana.socket, "watch-playback");
    ben.socket.emit("watch-playback", { entryId: party.entryId, state: "paused", position: 600, rate: 1 });
    ben.socket.emit("watch-playback", { entryId: replay.entryId, state: "playing", position: 2, rate: 1 });
    // The stale report, sent first, was neither relayed nor stored.
    expect(await anaHeard).toMatchObject({ state: "playing", position: 2, rate: 1 });
    expect(stored(roomId, party.id).playback).toEqual({ state: "playing", position: 2, rate: 1 });
  });

  // Regression guard: io.to([]) sends to every socket on the server.
  it("sends nothing when the sender is the only member", async () => {
    const { ana, ben, party } = await partyRoom();
    const benHeard = vi.fn();
    ben.socket.on("watch-playback", benHeard);
    ana.socket.emit("watch-playback", { entryId: party.entryId, state: "paused", position: 3, rate: 1 });
    const echo = partyWhere(ana.socket, party.id, () => true);
    ana.socket.emit("watch-change-video", { videoId: OTHER_VIDEO });
    await echo;
    expect(benHeard).not.toHaveBeenCalled();
  });

  it("goes only to the sender's own party", async () => {
    const { roomId, ana, ben, party } = await partyRoom();
    await start(ben, false, OTHER_VIDEO);
    const benHeard = vi.fn();
    ben.socket.on("watch-playback", benHeard);
    ana.socket.emit("watch-playback", { entryId: party.entryId, state: "paused", position: 7, rate: 1 });
    await vi.waitFor(() => expect(stored(roomId, party.id).playback.position).toBe(7));
    expect(benHeard).not.toHaveBeenCalled();
  });
});

describe("watch-change-video", () => {
  it("lets only the host change the video unless others may", async () => {
    const { roomId, ana, ben, party } = await partyRoom(false);
    await joinParty(ben, party.id);

    ben.socket.emit("watch-change-video", { videoId: OTHER_VIDEO });
    const changed = partyWhere(ben.socket, party.id, (p) => p?.videoId === OTHER_VIDEO);
    ana.socket.emit("watch-change-video", { videoId: OTHER_VIDEO });
    const state = await changed;

    expect(state?.playback).toMatchObject({ state: "playing", rate: 1 });
    expect(state!.playback.position).toBeLessThan(1);
    expect(state!.entryId).not.toBe(party.entryId);
    expect(stored(roomId, party.id).videoId).toBe(OTHER_VIDEO);
  });

  it("lets any member change it when allowed", async () => {
    const { ana, ben, party } = await partyRoom(true);
    await joinParty(ben, party.id);
    const changed = partyWhere(ana.socket, party.id, (p) => p?.videoId === OTHER_VIDEO);
    ben.socket.emit("watch-change-video", { videoId: OTHER_VIDEO });
    expect((await changed)?.videoId).toBe(OTHER_VIDEO);
  });

  it("refuses a guest when not allowed", async () => {
    const { roomId, ana, ben, party } = await partyRoom(false);
    await joinParty(ben, party.id);
    ben.socket.emit("watch-change-video", { videoId: OTHER_VIDEO });
    await roundTrip(ben, ana);
    expect(stored(roomId, party.id).videoId).toBe(VIDEO);
  });
});

describe("queue", () => {
  async function queueOf(member: Joined, partyId: string, videoIds: string[]): Promise<WatchPartyState> {
    const done = partyWhere(member.socket, partyId, (p) => p?.queue.length === videoIds.length);
    for (const videoId of videoIds) member.socket.emit("watch-queue-add", { videoId });
    return (await done)!;
  }

  it("adds, removes and reorders, and is refused to a guest who may not control it", async () => {
    const { roomId, ana, ben, party } = await partyRoom(false);
    await joinParty(ben, party.id);

    ben.socket.emit("watch-queue-add", { videoId: OTHER_VIDEO });
    const added = await queueOf(ana, party.id, [OTHER_VIDEO, THIRD_VIDEO]);
    expect(added.queue.map((e) => e.videoId)).toEqual([OTHER_VIDEO, THIRD_VIDEO]);
    expect(added.queue[0].addedBy).toBe(ana.userId);

    const [first, second] = added.queue;
    const moved = partyWhere(ana.socket, party.id, (p) => p?.queue[0]?.id === second.id);
    ben.socket.emit("watch-queue-remove", { entryId: first.id });
    ana.socket.emit("watch-queue-move", { entryId: second.id, toIndex: 0 });
    expect((await moved)?.queue.map((e) => e.id)).toEqual([second.id, first.id]);

    const removed = partyWhere(ana.socket, party.id, (p) => p?.queue.length === 1);
    ana.socket.emit("watch-queue-remove", { entryId: second.id });
    expect((await removed)?.queue.map((e) => e.id)).toEqual([first.id]);
    expect(stored(roomId, party.id).queue).toHaveLength(1);
  });

  it(`holds at most ${MAX_WATCH_QUEUE} videos`, async () => {
    const { roomId, ana, party } = await partyRoom();
    stored(roomId, party.id).queue = Array.from({ length: MAX_WATCH_QUEUE }, (_, i) => ({
      id: `e${i}`,
      videoId: VIDEO,
      title: null,
      addedBy: ana.userId,
    }));
    ana.socket.emit("watch-queue-add", { videoId: OTHER_VIDEO });
    ana.socket.emit("watch-change-video", { videoId: OTHER_VIDEO });
    await vi.waitFor(() => expect(stored(roomId, party.id).videoId).toBe(OTHER_VIDEO));
    expect(stored(roomId, party.id).queue).toHaveLength(MAX_WATCH_QUEUE);
  });

  it("fills in a queued video's title", async () => {
    const { ana, party } = await partyRoom();
    titles.set(OTHER_VIDEO, "Gangnam Style");
    const titled = partyWhere(ana.socket, party.id, (p) => p?.queue[0]?.title === "Gangnam Style");
    ana.socket.emit("watch-queue-add", { videoId: OTHER_VIDEO });
    expect((await titled)?.queue[0].videoId).toBe(OTHER_VIDEO);
  });

  // Regression: every title re-sent all parties to the room on its own.
  it("announces the titles of a burst of queued videos together", async () => {
    const { ana, party } = await partyRoom();
    titles.set(OTHER_VIDEO, "Gangnam Style");
    titles.set(THIRD_VIDEO, "Despacito");
    const broadcasts = vi.fn();
    ana.socket.on("watch-parties", broadcasts);
    const titled = partyWhere(ana.socket, party.id, (p) => p?.queue.length === 2 && p.queue.every((e) => e.title));
    ana.socket.emit("watch-queue-add", { videoId: OTHER_VIDEO });
    ana.socket.emit("watch-queue-add", { videoId: THIRD_VIDEO });
    await titled;
    // One per add, and one for both titles.
    expect(broadcasts).toHaveBeenCalledTimes(3);
  });

  it("plays the next video when the current one ends, once however many members report it", async () => {
    const { roomId, ana, ben, party } = await partyRoom(true);
    await joinParty(ben, party.id);
    const queued = await queueOf(ana, party.id, [OTHER_VIDEO, THIRD_VIDEO]);

    const advanced = partyWhere(ben.socket, party.id, (p) => p?.videoId === OTHER_VIDEO);
    ana.socket.emit("watch-ended", { entryId: party.entryId });
    ben.socket.emit("watch-ended", { entryId: party.entryId });
    const state = (await advanced)!;
    expect(state.entryId).not.toBe(party.entryId);
    expect(state.queue.map((e) => e.id)).toEqual([queued.queue[1].id]);
    expect(state.playback).toMatchObject({ state: "playing", rate: 1 });

    await roundTrip(ben, ana);
    expect(stored(roomId, party.id).videoId).toBe(OTHER_VIDEO);
  });

  it("plays a queued video at once when one with control picks it, and not for a guest", async () => {
    const { roomId, ana, ben, party } = await partyRoom(false);
    await joinParty(ben, party.id);
    const queued = await queueOf(ana, party.id, [OTHER_VIDEO, THIRD_VIDEO]);
    const [first, second] = queued.queue;

    ben.socket.emit("watch-queue-play", { entryId: second.id });
    await roundTrip(ben, ana);
    expect(stored(roomId, party.id).videoId).toBe(VIDEO);

    const playing = partyWhere(ben.socket, party.id, (p) => p?.videoId === THIRD_VIDEO);
    ana.socket.emit("watch-queue-play", { entryId: second.id });
    const state = (await playing)!;
    expect(state.entryId).not.toBe(party.entryId);
    expect(state.playback).toMatchObject({ state: "playing", rate: 1 });
    expect(state.queue.map((e) => e.id)).toEqual([first.id]);
  });

  it("pauses the party at the end when the queue is empty, telling its members", async () => {
    const { roomId, ana, ben, party } = await partyRoom();
    await joinParty(ben, party.id);
    const told = next<WatchPlayback & { entryId: string }>(ben.socket, "watch-playback");
    ana.socket.emit("watch-ended", { entryId: party.entryId });
    expect(await told).toMatchObject({ state: "paused", entryId: party.entryId });
    expect(stored(roomId, party.id)).toMatchObject({ videoId: VIDEO, entryId: party.entryId, playback: { state: "paused" } });
  });

  // Regression: only a controller's report counted, so a host whose player
  // never ended (blocked autoplay, an error) held the party on a finished video.
  it("moves on once every member without control has ended, but not for one of them alone", async () => {
    const { roomId, ana, ben, party } = await partyRoom(false);
    const cara = await join(roomId, "Cara");
    await joinParty(ben, party.id);
    await joinParty(cara, party.id);
    await queueOf(ana, party.id, [OTHER_VIDEO]);

    ben.socket.emit("watch-ended", { entryId: party.entryId });
    await roundTrip(ben, ana);
    expect(stored(roomId, party.id).videoId).toBe(VIDEO);

    const advanced = partyWhere(ana.socket, party.id, (p) => p?.videoId === OTHER_VIDEO);
    cara.socket.emit("watch-ended", { entryId: party.entryId });
    expect((await advanced)?.queue).toEqual([]);
  });
});

describe("watch-end", () => {
  it("lets an owner end any party, and nobody else", async () => {
    const { roomId, ana, ben, party } = await partyRoom();
    const room = getRoom(roomId)!;
    room.owners.clear();
    room.owners.add(ben.userId);

    ana.socket.emit("watch-end", { partyId: party.id });
    await roundTrip(ana, ben);
    expect(room.watchParties.has(party.id)).toBe(true);

    const gone = ended(ana.socket, party.id);
    ben.socket.emit("watch-end", { partyId: party.id });
    expect(await gone).toBeNull();
    expect(room.watchParties.size).toBe(0);
  });
});

describe("leaving", () => {
  it("hands the host role on when the host leaves", async () => {
    const { ana, ben, party } = await partyRoom();
    await joinParty(ben, party.id);
    const handedOn = partyWhere(ben.socket, party.id, (p) => p?.hostId === ben.userId);
    ana.socket.emit("watch-leave");
    expect((await handedOn)?.memberIds).toEqual([ben.userId]);
  });

  it("ends the party at once when the last member leaves it", async () => {
    const { roomId, ana, ben, party } = await partyRoom();
    const gone = ended(ben.socket, party.id);
    ana.socket.emit("watch-leave");
    expect(await gone).toBeNull();
    expect(getRoom(roomId)!.watchParties.size).toBe(0);
  });

  it("waits for a member who lost their connection, then ends", async () => {
    const roomId = createRoom().id;
    const ben = await join(roomId, "Ben");
    const ana = await join(roomId, "Ana");
    const party = await start(ana);
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const memberGone = partyWhere(ben.socket, party.id, (p) => p?.memberIds.length === 0);
      loseConnection(ana);
      await memberGone;
      expect(getRoom(roomId)!.watchParties.has(party.id)).toBe(true);

      const call = setSpy.mock.calls.find(([, ms]) => ms === WATCH_PARTY_GRACE_MS);
      expect(call).toBeDefined();
      const gone = ended(ben.socket, party.id);
      (call![0] as () => void)();
      expect(await gone).toBeNull();
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
    const memberGone = partyWhere(ben.socket, party.id, (p) => p?.memberIds.length === 0);
    loseConnection(ana);
    await memberGone;

    const back = await join(roomId, "Ana", KEY);
    expect(back.watchParties.map((p) => p.id)).toEqual([party.id]);
    const rejoined = await joinParty(back, party.id);
    expect(rejoined.memberIds).toEqual([back.userId]);
    expect(rejoined.hostId).toBe(back.userId);
  });

  it("ends the party at once when its last member leaves the room", async () => {
    const { roomId, ana, ben, party } = await partyRoom();
    const gone = ended(ben.socket, party.id);
    ana.socket.disconnect();
    expect(await gone).toBeNull();
    expect(getRoom(roomId)!.watchParties.size).toBe(0);
  });

  it("gives a host who lost their connection the role back when they return", async () => {
    const KEY = "ana-secret-key-0123456789";
    const roomId = createRoom().id;
    const ben = await join(roomId, "Ben");
    const ana = await join(roomId, "Ana", KEY);
    const party = await start(ana);
    await joinParty(ben, party.id);

    const covering = partyWhere(ben.socket, party.id, (p) => p?.hostId === ben.userId);
    loseConnection(ana);
    await covering;

    const back = await join(roomId, "Ana", KEY);
    const rejoined = await joinParty(back, party.id);
    expect(rejoined.hostId).toBe(back.userId);
    expect(rejoined.memberIds).toEqual([ben.userId, back.userId]);
  });
});
