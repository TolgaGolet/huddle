import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { setupSignaling } from "./signaling.js";
import { JOIN_ERROR } from "./joinErrors.js";
import { MAX_PARTICIPANTS } from "./limits.js";
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

function joined(client: ClientSocket, payload: object): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once("room-joined", () => resolve());
    client.once("error", (e: { message: string }) => reject(new Error(e.message)));
    client.emit("join-room", payload);
  });
}

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

  // Rejoin race: the old socket is gone but its participant entry remains.
  it("evicts a stale participant holding the requested name", async () => {
    const room = createRoom();
    addParticipant(room.id, "gone-socket", "Ana");
    const client = connect(url, { transports: ["websocket"] });
    const peer = connect(url, { transports: ["websocket"] });
    try {
      await joined(peer, { roomId: room.id, name: "Bo" });
      const left = new Promise((resolve) => peer.once("participant-left", resolve));

      await joined(client, { roomId: room.id, name: "ana" });

      await expect(left).resolves.toEqual({ id: "gone-socket" });
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
    for (let i = 0; i < MAX_PARTICIPANTS; i++) addParticipant(full.id, `socket-${i}`, `P${i}`);

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
});
