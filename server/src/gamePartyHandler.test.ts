import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { setupSignaling } from "./signaling.js";
import { setupGameParty } from "./gamePartyHandler.js";
import { setupWatchParty } from "./watchPartyHandler.js";
import { GAME_PARTY_GRACE_MS, MAX_GAME_PARTIES } from "./limits.js";
import { createRoom, getRoom } from "./roomManager.js";
import { GAMES } from "./games.js";
import type { ChatMessage, GameInfo, GamePartyState, WatchPartyState } from "./protocol.js";

const GAME = "ragamuffin";
const VIDEO = "dQw4w9WgXcQ";

let httpServer: HttpServer;
let io: Server;
let url: string;
const clients: ClientSocket[] = [];

beforeAll(async () => {
  httpServer = createServer();
  io = new Server(httpServer, { transports: ["websocket"] });
  setupSignaling(io);
  setupWatchParty(io, { lookupTitle: () => Promise.resolve(null) });
  setupGameParty(io);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await io.close();
});

afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect();
});

type Joined = { socket: ClientSocket; userId: string; gameParties: GamePartyState[]; games: readonly GameInfo[] };

async function join(roomId: string, name: string, clientKey?: string): Promise<Joined> {
  const socket = connect(url, { transports: ["websocket"] });
  clients.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("room-joined", (data: { userId: string; gameParties: GamePartyState[]; games: readonly GameInfo[] }) =>
      resolve({ socket, userId: data.userId, gameParties: data.gameParties, games: data.games }),
    );
    socket.once("error", (e: { message: string }) => reject(new Error(e.message)));
    socket.emit("join-room", { roomId, name, clientKey });
  });
}

const next = <T,>(socket: ClientSocket, event: string) => new Promise<T>((resolve) => socket.once(event, resolve));

/** Resolves with the next list of `event`'s parties matching `test`. */
function listWhere<P>(socket: ClientSocket, event: string, test: (parties: P[]) => boolean): Promise<P[]> {
  return new Promise((resolve) => {
    const handler = (parties: P[]) => {
      if (!test(parties)) return;
      socket.off(event, handler);
      resolve(parties);
    };
    socket.on(event, handler);
  });
}

const partiesWhere = (socket: ClientSocket, test: (parties: GamePartyState[]) => boolean) => listWhere(socket, "game-parties", test);

/** Resolves with party `id` once it matches `test` (null: once it has ended). */
function partyWhere(socket: ClientSocket, id: string, test: (p: GamePartyState | null) => boolean): Promise<GamePartyState | null> {
  return partiesWhere(socket, (parties) => test(parties.find((p) => p.id === id) ?? null)).then(
    (parties) => parties.find((p) => p.id === id) ?? null,
  );
}

const ended = (socket: ClientSocket, id: string) => partyWhere(socket, id, (p) => p === null);

async function start(roomId: string, host: Joined): Promise<GamePartyState> {
  const before = new Set(getRoom(roomId)!.gameParties.keys());
  const parties = partiesWhere(host.socket, (list) => list.some((p) => !before.has(p.id) && p.memberIds.includes(host.userId)));
  host.socket.emit("game-start", { gameId: GAME });
  return (await parties).find((p) => !before.has(p.id))!;
}

async function joinParty(member: Joined, partyId: string): Promise<GamePartyState> {
  const state = partyWhere(member.socket, partyId, (p) => !!p?.memberIds.includes(member.userId));
  member.socket.emit("game-join", { partyId });
  return (await state)!;
}

/** A room with Ana hosting a game party and Ben in the room, not yet in it. */
async function partyRoom() {
  const roomId = createRoom().id;
  const ana = await join(roomId, "Ana");
  const ben = await join(roomId, "Ben");
  const party = await start(roomId, ana);
  return { roomId, ana, ben, party };
}

/** Drops the connection without leaving, as a network blip does. */
function loseConnection(member: Joined): void {
  member.socket.io.engine.close();
}

/** A round trip through `member`'s handlers, which run in order (see watchPartyHandler.test.ts). */
async function roundTrip(member: Joined, observer: Joined): Promise<void> {
  const heard = next(observer.socket, "participant-muted");
  member.socket.emit("mute-toggle", { isMuted: true });
  await heard;
}

describe("room-joined", () => {
  it("carries the game catalog and the room's game parties", async () => {
    const { roomId, party } = await partyRoom();
    const cara = await join(roomId, "Cara");
    expect(cara.games).toEqual(GAMES);
    expect(cara.gameParties).toEqual([party]);
  });
});

describe("game-start", () => {
  it("starts a party with the starter as host and announces it in the chat", async () => {
    const roomId = createRoom().id;
    const ana = await join(roomId, "Ana");
    const ben = await join(roomId, "Ben");
    const benParties = next<GamePartyState[]>(ben.socket, "game-parties");
    const benInvite = next<ChatMessage>(ben.socket, "chat-message");

    ana.socket.emit("game-start", { gameId: GAME });

    const [party] = await benParties;
    expect(party).toMatchObject({ gameId: GAME, hostId: ana.userId, memberIds: [ana.userId] });
    expect(await benInvite).toMatchObject({ senderId: ana.userId, senderName: "Ana", gameInvite: { partyId: party.id, gameId: GAME } });
    expect(getRoom(roomId)!.chatHistory.some((m) => "gameInvite" in m && m.gameInvite?.partyId === party.id)).toBe(true);
  });

  it("ignores a game that isn't in the catalog", async () => {
    const roomId = createRoom().id;
    const ana = await join(roomId, "Ana");
    const ben = await join(roomId, "Ben");
    ana.socket.emit("game-start", { gameId: "not-a-game" });
    await roundTrip(ana, ben);
    expect(getRoom(roomId)!.gameParties.size).toBe(0);
  });

  it(`allows ${MAX_GAME_PARTIES} parties at once, then refuses with the limit`, async () => {
    const roomId = createRoom().id;
    const members = await Promise.all(["Ana", "Ben", "Cara"].map((name) => join(roomId, name)));
    for (const member of members.slice(0, MAX_GAME_PARTIES)) await start(roomId, member);

    const refused = next(members[MAX_GAME_PARTIES].socket, "game-start-refused");
    members[MAX_GAME_PARTIES].socket.emit("game-start", { gameId: GAME });
    expect(await refused).toEqual({ reason: "limit", max: MAX_GAME_PARTIES });
    expect(getRoom(roomId)!.gameParties.size).toBe(MAX_GAME_PARTIES);
  });

  it("lets someone alone in their party replace it at the limit", async () => {
    const roomId = createRoom().id;
    const ana = await join(roomId, "Ana");
    const ben = await join(roomId, "Ben");
    const first = await start(roomId, ana);
    await start(roomId, ben);
    const replaced = await start(roomId, ana);
    expect(replaced.id).not.toBe(first.id);
    expect([...getRoom(roomId)!.gameParties.keys()]).not.toContain(first.id);
  });

  it("is refused without the message permission", async () => {
    const roomId = createRoom().id;
    const ana = await join(roomId, "Ana");
    getRoom(roomId)!.settings.messagePermission = "owners";
    getRoom(roomId)!.owners.clear();

    const refused = next<{ event: string }>(ana.socket, "not-permitted");
    ana.socket.emit("game-start", { gameId: GAME });
    expect(await refused).toEqual({ event: "game-start" });
    expect(getRoom(roomId)!.gameParties.size).toBe(0);
  });
});

describe("game-join", () => {
  it("adds the member, and leaves their other game party, which ends if they were its last", async () => {
    const { roomId, ana, ben, party } = await partyRoom();
    const own = await start(roomId, ben);
    const gone = ended(ana.socket, own.id);
    expect((await joinParty(ben, party.id)).memberIds).toEqual([ana.userId, ben.userId]);
    expect(await gone).toBeNull();
    expect(getRoom(roomId)!.gameParties.size).toBe(1);
  });

  it("ignores a stale party id", async () => {
    const { roomId, ana, ben } = await partyRoom();
    ben.socket.emit("game-join", { partyId: "old-party" });
    await roundTrip(ben, ana);
    expect([...getRoom(roomId)!.gameParties.values()][0].members.size).toBe(1);
  });
});

describe("one party at a time, of either kind", () => {
  it("leaves the member's watch party when they start or join a game party", async () => {
    const roomId = createRoom().id;
    const ana = await join(roomId, "Ana");
    const ben = await join(roomId, "Ben");
    const watchStarted = listWhere<WatchPartyState>(ben.socket, "watch-parties", (list) => list.length === 1);
    ana.socket.emit("watch-start", { videoId: VIDEO, allowOthersToChange: false });
    const [watch] = await watchStarted;

    // Ana was alone in it, so leaving it for a game ends it.
    const watchEnded = listWhere<WatchPartyState>(ben.socket, "watch-parties", (list) => list.length === 0);
    const game = await start(roomId, ana);
    await watchEnded;
    expect(getRoom(roomId)!.watchParties.has(watch.id)).toBe(false);
    expect(game.memberIds).toEqual([ana.userId]);
  });

  it("leaves the member's game party when they start or join a watch party", async () => {
    const { roomId, ana, ben, party } = await partyRoom();
    await joinParty(ben, party.id);

    const benLeft = partyWhere(ana.socket, party.id, (p) => p?.memberIds.length === 1);
    ben.socket.emit("watch-start", { videoId: VIDEO, allowOthersToChange: false });
    expect((await benLeft)?.memberIds).toEqual([ana.userId]);

    const gone = ended(ben.socket, party.id);
    const watch = [...getRoom(roomId)!.watchParties.values()][0];
    ana.socket.emit("watch-join", { partyId: watch.id });
    expect(await gone).toBeNull();
  });
});

describe("game-end", () => {
  it("lets an owner end any party, and nobody else", async () => {
    const { roomId, ana, ben, party } = await partyRoom();
    const room = getRoom(roomId)!;
    room.owners.clear();
    room.owners.add(ben.userId);

    ana.socket.emit("game-end", { partyId: party.id });
    await roundTrip(ana, ben);
    expect(room.gameParties.has(party.id)).toBe(true);

    const gone = ended(ana.socket, party.id);
    ben.socket.emit("game-end", { partyId: party.id });
    expect(await gone).toBeNull();
    expect(room.gameParties.size).toBe(0);
  });
});

describe("leaving", () => {
  it("hands the host role on when the host leaves", async () => {
    const { ana, ben, party } = await partyRoom();
    await joinParty(ben, party.id);
    const handedOn = partyWhere(ben.socket, party.id, (p) => p?.hostId === ben.userId);
    ana.socket.emit("game-leave");
    expect((await handedOn)?.memberIds).toEqual([ben.userId]);
  });

  it("ends the party at once when the last member leaves it or the room", async () => {
    const { roomId, ana, ben, party } = await partyRoom();
    const gone = ended(ben.socket, party.id);
    ana.socket.emit("game-leave");
    expect(await gone).toBeNull();

    const again = await start(roomId, ben);
    const goneAgain = ended(ana.socket, again.id);
    ben.socket.disconnect();
    expect(await goneAgain).toBeNull();
    expect(getRoom(roomId)!.gameParties.size).toBe(0);
  });

  it("waits for a member who lost their connection, then ends", async () => {
    const roomId = createRoom().id;
    const ben = await join(roomId, "Ben");
    const ana = await join(roomId, "Ana");
    const party = await start(roomId, ana);
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const memberGone = partyWhere(ben.socket, party.id, (p) => p?.memberIds.length === 0);
      loseConnection(ana);
      await memberGone;
      expect(getRoom(roomId)!.gameParties.has(party.id)).toBe(true);

      const call = setSpy.mock.calls.find(([, ms]) => ms === GAME_PARTY_GRACE_MS);
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
    const party = await start(roomId, ana);
    const memberGone = partyWhere(ben.socket, party.id, (p) => p?.memberIds.length === 0);
    loseConnection(ana);
    await memberGone;

    const back = await join(roomId, "Ana", KEY);
    expect(back.gameParties.map((p) => p.id)).toEqual([party.id]);
    const rejoined = await joinParty(back, party.id);
    expect(rejoined).toMatchObject({ hostId: back.userId, memberIds: [back.userId] });
  });
});
