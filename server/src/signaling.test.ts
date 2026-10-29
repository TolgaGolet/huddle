import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { setupSignaling } from "./signaling.js";
import { createRoom, getRoom, socketRoomMap } from "./roomManager.js";

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
});
