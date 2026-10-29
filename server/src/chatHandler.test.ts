import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { setupSignaling } from "./signaling.js";
import { setupChat } from "./chatHandler.js";
import { createRoom } from "./roomManager.js";

let httpServer: HttpServer;
let io: Server;
let url: string;
let client: ClientSocket;

beforeAll(async () => {
  httpServer = createServer();
  io = new Server(httpServer, { transports: ["websocket"] });
  setupSignaling(io);
  setupChat(io);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await io.close();
});

afterEach(() => client?.disconnect());

async function joinNewRoom(): Promise<ClientSocket> {
  const room = createRoom();
  client = connect(url, { transports: ["websocket"] });
  await new Promise<void>((resolve, reject) => {
    client.once("room-joined", () => resolve());
    client.once("error", (e: { message: string }) => reject(new Error(e.message)));
    client.emit("join-room", { roomId: room.id, name: "Ana" });
  });
  return client;
}

function send<T>(event: string, payload: object, reply: string): Promise<T> {
  return new Promise((resolve) => {
    client.once(reply, resolve);
    client.emit(event, payload);
  });
}

describe("chat-message gifUrl", () => {
  it("keeps Giphy CDN URLs and drops look-alike hosts", async () => {
    await joinNewRoom();
    const ok = await send<{ gifUrl?: string }>(
      "chat-message",
      { text: "a", gifUrl: "https://media2.giphy.com/media/x/giphy.gif" },
      "chat-message",
    );
    expect(ok.gifUrl).toBe("https://media2.giphy.com/media/x/giphy.gif");

    for (const gifUrl of ["https://media.attacker.example/t.gif", "https://mediaevil.com/x", "http://media.giphy.com/x"]) {
      const msg = await send<{ gifUrl?: string }>("chat-message", { text: "b", gifUrl }, "chat-message");
      expect(msg.gifUrl).toBeUndefined();
    }
  });
});

describe("chat-reaction", () => {
  it("caps the number of distinct reaction keys per message", async () => {
    await joinNewRoom();
    const msg = await send<{ id: string }>("chat-message", { text: "hi" }, "chat-message");

    const react = (emoji: string) =>
      send<{ reactions: Record<string, string[]> }>("chat-reaction", { messageId: msg.id, emoji }, "chat-reaction-update");
    for (let i = 0; i < 20; i++) await react(`e${i}`);

    // Over the cap: no update is broadcast. Toggling an existing key still
    // works, and its update shows the over-cap key was never added.
    client.emit("chat-reaction", { messageId: msg.id, emoji: "e20" });
    const { reactions } = await react("e0");
    expect(reactions).not.toHaveProperty("e20");
    expect(Object.keys(reactions)).toHaveLength(19);
  });
});
