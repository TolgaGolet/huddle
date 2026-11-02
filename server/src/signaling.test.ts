import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { JOIN_DEADLINE_MS, setupSignaling } from "./signaling.js";
import { IP_LIMITS } from "./ipRateLimit.js";
import { JOIN_ERROR } from "./joinErrors.js";
import { MAX_PARTICIPANTS, MAX_ROOM_LIFETIME_MS } from "./limits.js";
import { RATE_LIMITS } from "./rateLimit.js";
import { addParticipant, createRoom, getRoom, socketRoomMap } from "./roomManager.js";

let httpServer: HttpServer;
let io: Server;
let url: string;

beforeAll(async () => {
  httpServer = createServer();
  io = new Server(httpServer, { transports: ["websocket"] });
  setupSignaling(io);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await io.close();
});

function joined<T = unknown>(client: ClientSocket, payload: object): Promise<T> {
  return new Promise((resolve, reject) => {
    client.once("room-joined", resolve);
    client.once("error", (e: { message: string }) => reject(new Error(e.message)));
    client.emit("join-room", payload);
  });
}

describe("password guessing", () => {
  /** Tries one password on a fresh connection, as an attacker dodging per-socket limits would. */
  async function attempt(roomId: string, password: string): Promise<string> {
    const client = connect(url, { transports: ["websocket"] });
    try {
      await joined(client, { roomId, name: "Ana", password });
      return "joined";
    } catch (err) {
      return (err as Error).message;
    } finally {
      client.disconnect();
    }
  }

  it("limits wrong passwords across connections, and then rejects a correct one too", async () => {
    const room = createRoom("secret");
    for (let i = 0; i < IP_LIMITS.passwordGuesses.burst; i++) {
      expect(await attempt(room.id, "wrong")).toBe("Incorrect password");
    }
    expect(await attempt(room.id, "wrong")).toMatch(/too many attempts/i);
    expect(await attempt(room.id, "secret")).toMatch(/too many attempts/i);
  });

  it("counts guesses per room", async () => {
    const guessed = createRoom("secret");
    const other = createRoom("secret");
    for (let i = 0; i < IP_LIMITS.passwordGuesses.burst; i++) await attempt(guessed.id, "wrong");
    expect(await attempt(other.id, "wrong")).toBe("Incorrect password");
  });

  // Regression: anyone could lock members out of a rejoin by guessing wrong.
  it("lets a member rejoin while the password guesses are used up", async () => {
    const room = createRoom("secret");
    const clientKey = "member-key-0123456789";
    const member = connect(url, { transports: ["websocket"] });
    const rejoined = connect(url, { transports: ["websocket"] });
    try {
      await joined(member, { roomId: room.id, name: "Ana", password: "secret", clientKey });
      for (let i = 0; i < IP_LIMITS.passwordGuesses.burst; i++) await attempt(room.id, "wrong");
      expect(await attempt(room.id, "secret")).toMatch(/too many attempts/i);

      await expect(joined(rejoined, { roomId: room.id, name: "Ana", clientKey })).resolves.toBeDefined();
    } finally {
      member.disconnect();
      rejoined.disconnect();
    }
  });

  it("doesn't count correct passwords", async () => {
    const room = createRoom("secret");
    for (let i = 0; i < IP_LIMITS.passwordGuesses.burst + 1; i++) {
      expect(await attempt(room.id, "secret")).toBe("joined");
    }
  });
});

// Regression: many addresses meant unlimited guesses at one room's password.
describe("password guessing from many addresses", () => {
  it("limits a room's wrong passwords across all IPs", async () => {
    const server = createServer();
    const proxied = new Server(server, { transports: ["websocket"] });
    setupSignaling(proxied, 1);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const room = createRoom("long-secret");
    const attempt = async (ip: string, password: string) => {
      const client = connect(`http://localhost:${(server.address() as AddressInfo).port}`, { transports: ["websocket"], extraHeaders: { "x-forwarded-for": ip } });
      try {
        await joined(client, { roomId: room.id, name: "Ana", password });
        return "joined";
      } catch (err) {
        return (err as Error).message;
      } finally {
        client.disconnect();
      }
    };
    try {
      for (let i = 0; i < IP_LIMITS.roomPasswordGuesses.burst; i++) {
        expect(await attempt(`10.0.0.${i}`, "wrong")).toBe("Incorrect password");
      }
      expect(await attempt("10.0.1.1", "long-secret")).toMatch(/too many attempts/i);
    } finally {
      await proxied.close();
    }
  });
});

describe("join deadline", () => {
  /** A client's connection, with the deadline callback the server set up for it. */
  async function connectWithDeadline() {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const client = connect(url, { transports: ["websocket"], reconnection: false });
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    await vi.waitFor(() => expect(spy.mock.calls.some(([, ms]) => ms === JOIN_DEADLINE_MS)).toBe(true));
    const expire = spy.mock.calls.find(([, ms]) => ms === JOIN_DEADLINE_MS)![0] as () => void;
    spy.mockRestore();
    return { client, expire };
  }

  // Regression: a socket could stay connected for ever without joining, costing memory.
  it("closes a socket that never joined, so that a real client would reconnect", async () => {
    const { client, expire } = await connectWithDeadline();
    const closed = new Promise<string>((resolve) => client.once("disconnect", resolve));

    expire();

    expect(await closed).toBe("transport close");
  });

  it("leaves a socket alone once it has joined", async () => {
    const { client, expire } = await connectWithDeadline();
    try {
      await joined(client, { roomId: createRoom().id, name: "Ana" });
      expire();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(client.connected).toBe(true);
    } finally {
      client.disconnect();
    }
  });
});

// Regression (F05): a rejoin always created the participant unmuted.
describe("mute state on join", () => {
  it("announces a muted joiner as muted, and lists them as muted for later joiners", async () => {
    const room = createRoom();
    const [ana, bo, cy] = [1, 2, 3].map(() => connect(url, { transports: ["websocket"] }));
    try {
      await joined(ana, { roomId: room.id, name: "Ana" });
      const announced = new Promise<{ isMuted: boolean }>((resolve) => ana.once("participant-joined", resolve));
      await joined(bo, { roomId: room.id, name: "Bo", isMuted: true });
      expect((await announced).isMuted).toBe(true);

      const { participants } = await joined<{ participants: { name: string; isMuted: boolean }[] }>(cy, { roomId: room.id, name: "Cy" });
      expect(participants.find((p) => p.name === "Bo")?.isMuted).toBe(true);
      expect(participants.find((p) => p.name === "Ana")?.isMuted).toBe(false);
    } finally {
      for (const client of [ana, bo, cy]) client.disconnect();
    }
  });
});

// Regression (F02): HTTP routes trusted the socket id, which the room can see.
describe("HTTP token", () => {
  it("goes only to its owner, and never appears in a participant", async () => {
    const room = createRoom();
    const ana = connect(url, { transports: ["websocket"] });
    const bo = connect(url, { transports: ["websocket"] });
    try {
      const anaJoin = await joined<{ httpToken: string }>(ana, { roomId: room.id, name: "Ana" });
      const announced = new Promise<object>((resolve) => ana.once("participant-joined", resolve));
      const boJoin = await joined<{ httpToken: string; participants: object[] }>(bo, { roomId: room.id, name: "Bo" });

      expect(anaJoin.httpToken).toBeTruthy();
      expect(boJoin.httpToken).toBeTruthy();
      expect(boJoin.httpToken).not.toBe(anaJoin.httpToken);
      expect(JSON.stringify(boJoin.participants)).not.toContain(anaJoin.httpToken);
      expect(JSON.stringify(await announced)).not.toContain(boJoin.httpToken);
    } finally {
      ana.disconnect();
      bo.disconnect();
    }
  });
});

describe("screen sharer", () => {
  it("is told to a later joiner, and cleared when the sharer leaves", async () => {
    const room = createRoom();
    const sharer = connect(url, { transports: ["websocket"] });
    const peer = connect(url, { transports: ["websocket"] });
    const late = connect(url, { transports: ["websocket"] });
    const later = connect(url, { transports: ["websocket"] });
    const joinedWith = async (client: ClientSocket, name: string) =>
      (await joined<{ screenSharer: string | null }>(client, { roomId: room.id, name })).screenSharer;
    try {
      await joined(sharer, { roomId: room.id, name: "Ana" });
      await joined(peer, { roomId: room.id, name: "Bo" });
      const started = new Promise((resolve) => peer.once("screen-share-started", resolve));
      sharer.emit("screen-share-started");
      await started;
      const sharerId = sharer.id;

      await expect(joinedWith(late, "Cy")).resolves.toBe(sharerId);
      expect(getRoom(room.id)?.screenSharerId).toBe(sharerId);

      const stopped = new Promise((resolve) => peer.once("screen-share-stopped", resolve));
      sharer.disconnect();
      await expect(stopped).resolves.toEqual({ id: sharerId });

      await expect(joinedWith(later, "Di")).resolves.toBeNull();
    } finally {
      sharer.disconnect();
      peer.disconnect();
      late.disconnect();
      later.disconnect();
    }
  });
});

describe("join-room", () => {
  it("leaves the previous room instead of leaving a ghost participant there", async () => {
    const a = createRoom();
    const b = createRoom();
    const client = connect(url, { transports: ["websocket"] });
    try {
      await joined(client, { roomId: a.id, name: "Ana" });
      await joined(client, { roomId: b.id, name: "Ana" });

      expect(getRoom(a.id)?.participants.size).toBe(0);
      expect(getRoom(b.id)?.participants.has(client.id!)).toBe(true);
      expect(socketRoomMap.get(client.id!)).toBe(b.id);
    } finally {
      client.disconnect();
    }
  });

  it("stays in the current room when a join into another room fails", async () => {
    const a = createRoom();
    const locked = createRoom("secret");
    const client = connect(url, { transports: ["websocket"] });
    try {
      await joined(client, { roomId: a.id, name: "Ana" });
      await expect(joined(client, { roomId: locked.id, name: "Ana", password: "wrong" })).rejects.toThrow(
        "Incorrect password",
      );

      expect(getRoom(a.id)?.participants.has(client.id!)).toBe(true);
      expect(socketRoomMap.get(client.id!)).toBe(a.id);
    } finally {
      client.disconnect();
    }
  });

  it("ignores a repeated join for the room the socket is already in", async () => {
    const a = createRoom();
    const client = connect(url, { transports: ["websocket"] });
    const peer = connect(url, { transports: ["websocket"] });
    try {
      await joined(client, { roomId: a.id, name: "Ana" });
      await joined(peer, { roomId: a.id, name: "Bo" });
      const left = vi.fn();
      peer.on("participant-left", left);

      client.emit("join-room", { roomId: a.id, name: "Ana" });
      // Give the server time to process (and ignore) the repeated join.
      await new Promise((r) => setTimeout(r, 50));

      expect(left).not.toHaveBeenCalled();
      expect(getRoom(a.id)?.participants.has(client.id!)).toBe(true);
    } finally {
      client.disconnect();
      peer.disconnect();
    }
  });

  it("leaves your old session alone when a join under your key is refused", async () => {
    const room = createRoom();
    const clientKey = "k".repeat(32);
    const old = connect(url, { transports: ["websocket"] });
    const peer = connect(url, { transports: ["websocket"] });
    const retry = connect(url, { transports: ["websocket"] });
    try {
      await joined(old, { roomId: room.id, name: "Ana", clientKey });
      await joined(peer, { roomId: room.id, name: "Bo" });

      await expect(joined(retry, { roomId: room.id, name: "Bo", clientKey })).rejects.toThrow(/name already taken/i);

      expect(getRoom(room.id)?.participants.has(old.id!)).toBe(true);
      expect(old.connected).toBe(true);
    } finally {
      for (const client of [old, peer, retry]) client.disconnect();
    }
  });

  it("lets you rejoin a full room, since your old session's place is freed", async () => {
    const room = createRoom();
    const clientKey = "k".repeat(32);
    const old = connect(url, { transports: ["websocket"] });
    const again = connect(url, { transports: ["websocket"] });
    try {
      await joined(old, { roomId: room.id, name: "Ana", clientKey });
      for (let i = 1; i < MAX_PARTICIPANTS; i++) addParticipant(room, `socket-${i}`, `P${i}`);

      await joined(again, { roomId: room.id, name: "Ana", clientKey });

      expect(getRoom(room.id)?.participants.has(again.id!)).toBe(true);
      expect(getRoom(room.id)?.participants.size).toBe(MAX_PARTICIPANTS);
    } finally {
      old.disconnect();
      again.disconnect();
    }
  });

  // Rejoin race: the old socket is gone but its participant entry remains.
  it("evicts a stale participant holding the requested name", async () => {
    const room = createRoom();
    addParticipant(room, "gone-socket", "Ana");
    const client = connect(url, { transports: ["websocket"] });
    const peer = connect(url, { transports: ["websocket"] });
    try {
      await joined(peer, { roomId: room.id, name: "Bo" });
      const left = new Promise((resolve) => peer.once("participant-left", resolve));

      await joined(client, { roomId: room.id, name: "ana" });

      await expect(left).resolves.toEqual({ id: "gone-socket", userId: "gone-socket" });
      expect(getRoom(room.id)?.participants.has("gone-socket")).toBe(false);
      expect(getRoom(room.id)?.participants.has(client.id!)).toBe(true);
    } finally {
      client.disconnect();
      peer.disconnect();
    }
  });

  // Half-open drop: the old socket still looks live until the ping timeout.
  it("evicts a live entry with the same key and ends its screen share", async () => {
    const clientKey = "same-key-0123456789";
    const room = createRoom();
    const old = connect(url, { transports: ["websocket"] });
    const rejoin = connect(url, { transports: ["websocket"] });
    const peer = connect(url, { transports: ["websocket"] });
    try {
      await joined(old, { roomId: room.id, name: "Ana", clientKey });
      await joined(peer, { roomId: room.id, name: "Bo" });
      const oldId = old.id!;
      const stopped = new Promise((resolve) => peer.once("screen-share-stopped", resolve));
      const dropped = new Promise((resolve) => old.once("disconnect", resolve));
      old.emit("screen-share-started");
      await new Promise((resolve) => peer.once("screen-share-started", resolve));

      await joined(rejoin, { roomId: room.id, name: "Ana", clientKey });

      await expect(stopped).resolves.toEqual({ id: oldId });
      await expect(dropped).resolves.toBe("io server disconnect");
      expect(getRoom(room.id)?.participants.has(oldId)).toBe(false);
      expect(getRoom(room.id)?.participants.has(rejoin.id!)).toBe(true);
    } finally {
      old.disconnect();
      rejoin.disconnect();
      peer.disconnect();
    }
  });

  it("doesn't evict a live participant with the same name and another key", async () => {
    const room = createRoom();
    const first = connect(url, { transports: ["websocket"] });
    const second = connect(url, { transports: ["websocket"] });
    try {
      await joined(first, { roomId: room.id, name: "Ana", clientKey: "first-key-0123456789" });

      await expect(joined(second, { roomId: room.id, name: "Ana", clientKey: "other-key-0123456789" })).rejects.toThrow(
        "Name already taken",
      );
      expect(getRoom(room.id)?.participants.has(first.id!)).toBe(true);
    } finally {
      first.disconnect();
      second.disconnect();
    }
  });
});

// Regression (Q-23): the client's rejoin retry depends on these codes, not on
// the display text beside them.
describe("join-room error codes", () => {
  function joinError(client: ClientSocket, payload: object): Promise<{ code: string; message: string }> {
    return new Promise((resolve) => {
      client.once("error", resolve);
      client.emit("join-room", payload);
    });
  }

  it("identifies each failure with a stable code", async () => {
    const open = createRoom();
    const locked = createRoom("secret");
    const full = createRoom();
    for (let i = 0; i < MAX_PARTICIPANTS; i++) addParticipant(full, `socket-${i}`, `P${i}`);

    const client = connect(url, { transports: ["websocket"] });
    const peer = connect(url, { transports: ["websocket"] });
    try {
      await joined(peer, { roomId: open.id, name: "Ana" });

      const codeFor = async (payload: object) => (await joinError(client, payload)).code;
      expect(await codeFor({ roomId: "missing", name: "Bo" })).toBe(JOIN_ERROR.ROOM_NOT_FOUND);
      expect(await codeFor({ roomId: locked.id, name: "Bo", password: "wrong" })).toBe(JOIN_ERROR.INCORRECT_PASSWORD);
      expect(await codeFor({ roomId: open.id, name: "ANA" })).toBe(JOIN_ERROR.NAME_TAKEN);
      expect(await codeFor({ roomId: full.id, name: "Bo" })).toBe(JOIN_ERROR.ROOM_FULL);
      expect(await codeFor({ roomId: open.id })).toBe(JOIN_ERROR.INVALID_JOIN);
    } finally {
      client.disconnect();
      peer.disconnect();
    }
  });

  it("answers a flood of joins with RATE_LIMITED, which also stops password guessing", async () => {
    const locked = createRoom("secret");
    const client = connect(url, { transports: ["websocket"] });
    const codes: string[] = [];
    client.on("error", (e: { code: string }) => codes.push(e.code));
    try {
      const attempts = RATE_LIMITS.join.burst + 5;
      for (let i = 0; i < attempts; i++) client.emit("join-room", { roomId: locked.id, name: "Bo", password: `guess${i}` });
      await vi.waitFor(() => expect(codes).toHaveLength(attempts));

      expect(codes.filter((c) => c === JOIN_ERROR.INCORRECT_PASSWORD)).toHaveLength(RATE_LIMITS.join.burst);
      expect(codes.filter((c) => c === JOIN_ERROR.RATE_LIMITED)).toHaveLength(5);
    } finally {
      client.disconnect();
    }
  });
});

describe("room activity and closing", () => {
  it("counts speech reported by a client", async () => {
    const room = createRoom();
    const client = connect(url, { transports: ["websocket"] });
    try {
      await joined(client, { roomId: room.id, name: "Ana" });
      room.lastActivityAt = 0;

      client.emit("voice-activity");

      await vi.waitFor(() => expect(room.lastActivityAt).toBeGreaterThan(0));
    } finally {
      client.disconnect();
    }
  });

  it("tells someone joining during a closing warning", async () => {
    const room = createRoom();
    room.createdAt = Date.now() - MAX_ROOM_LIFETIME_MS + 60_000;
    const client = connect(url, { transports: ["websocket"] });
    try {
      const { closing } = await joined<{ closing: { reason: string; remainingMs: number } }>(client, { roomId: room.id, name: "Ana" });

      expect(closing.reason).toBe("lifetime");
      expect(closing.remainingMs).toBeLessThanOrEqual(60_000);
    } finally {
      client.disconnect();
    }
  });
});
