import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { setupSignaling } from "./signaling.js";
import { setupChat } from "./chatHandler.js";
import { createRoom, getRoom, type ChatMessage, type Room } from "./roomManager.js";

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

function joined<T = unknown>(socket: ClientSocket, payload: object): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.once("room-joined", resolve);
    socket.once("error", (e: { message: string }) => reject(new Error(e.message)));
    socket.emit("join-room", payload);
  });
}

async function joinNewRoom(): Promise<ClientSocket> {
  const room = createRoom();
  client = connect(url, { transports: ["websocket"] });
  await joined(client, { roomId: room.id, name: "Ana" });
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

describe("chat-pin", () => {
  it("broadcasts only the pinned id, not the chat history", async () => {
    await joinNewRoom();
    const msg = await send<{ id: string }>("chat-message", { text: "hi" }, "chat-message");

    const pinned = await send("chat-pin", { messageId: msg.id }, "chat-pin-update");
    expect(pinned).toEqual({ pinnedMessageId: msg.id });

    const unpinned = await send("chat-pin", { messageId: msg.id }, "chat-pin-update");
    expect(unpinned).toEqual({ pinnedMessageId: null });
  });

  it("sends the current pin to clients joining later", async () => {
    const room = createRoom();
    const join = async (name: string) => {
      const late = connect(url, { transports: ["websocket"] });
      const data = await joined<{ pinnedMessageId: string | null }>(late, { roomId: room.id, name });
      late.disconnect();
      return data.pinnedMessageId;
    };

    client = connect(url, { transports: ["websocket"] });
    await joined(client, { roomId: room.id, name: "Ana" });
    const msg = await send<{ id: string }>("chat-message", { text: "hi" }, "chat-message");
    await send("chat-pin", { messageId: msg.id }, "chat-pin-update");
    expect(await join("Bob")).toBe(msg.id);

    // Deleting the pinned message clears the pin for later joiners too.
    await send("chat-delete", { messageId: msg.id }, "chat-message-delete");
    expect(await join("Cem")).toBeNull();
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

  it("toggles a participant's reaction on and off", async () => {
    await joinNewRoom();
    const msg = await send<{ id: string }>("chat-message", { text: "hi" }, "chat-message");
    const react = () =>
      send<{ reactions: Record<string, string[]> }>("chat-reaction", { messageId: msg.id, emoji: "👍" }, "chat-reaction-update");

    expect((await react()).reactions).toEqual({ "👍": [{ userId: client.id, name: "Ana" }] });
    expect((await react()).reactions).toEqual({});
  });
});

describe("message ownership", () => {
  let other: ClientSocket;
  let room: Room;

  afterEach(() => other?.disconnect());

  async function joinTwo(): Promise<void> {
    room = createRoom();
    client = connect(url, { transports: ["websocket"] });
    other = connect(url, { transports: ["websocket"] });
    await joined(client, { roomId: room.id, name: "Ana" });
    await joined(other, { roomId: room.id, name: "Bob" });
  }

  // Events from one socket are handled in order, so once this reply arrives
  // everything that socket emitted before it has been processed.
  const flush = (socket: ClientSocket, messageId: string) =>
    new Promise((resolve) => {
      socket.once("chat-reaction-update", resolve);
      socket.emit("chat-reaction", { messageId, emoji: "👍" });
    });

  const stored = (id: string) => getRoom(room.id)?.chatHistory.find((m) => m.id === id) as ChatMessage | undefined;

  it("lets the sender edit and delete their message", async () => {
    await joinTwo();
    const msg = await send<{ id: string }>("chat-message", { text: "hi" }, "chat-message");

    const edit = await send("chat-edit", { messageId: msg.id, text: "hello" }, "chat-message-edit");
    expect(edit).toEqual({ messageId: msg.id, text: "hello" });
    expect(stored(msg.id)).toMatchObject({ text: "hello", edited: true });

    await send("chat-delete", { messageId: msg.id }, "chat-message-delete");
    expect(stored(msg.id)).toBeUndefined();
  });

  it("ignores edit and delete from anyone else", async () => {
    await joinTwo();
    const msg = await send<{ id: string }>("chat-message", { text: "hi" }, "chat-message");

    other.emit("chat-edit", { messageId: msg.id, text: "hacked" });
    other.emit("chat-delete", { messageId: msg.id });
    await flush(other, msg.id);

    expect(stored(msg.id)).toMatchObject({ text: "hi" });
    expect(stored(msg.id)?.edited).toBeUndefined();
  });

  it("refuses to edit a GIF message", async () => {
    await joinTwo();
    const msg = await send<{ id: string }>(
      "chat-message",
      { text: "a", gifUrl: "https://media.giphy.com/media/x/giphy.gif" },
      "chat-message",
    );

    client.emit("chat-edit", { messageId: msg.id, text: "b" });
    await flush(client, msg.id);

    expect(stored(msg.id)).toMatchObject({ text: "a" });
  });
});

// Regression (Q-04): ownership was tied to socket.id, so any reconnect lost it.
describe("identity across a reconnect", () => {
  const KEY = "ana-secret-key-0123456789";
  let room: Room;

  type Reactions = { reactions: Record<string, { userId: string; name: string }[]> };

  async function joinWithKey(clientKey: string): Promise<ClientSocket> {
    const socket = connect(url, { transports: ["websocket"] });
    await joined(socket, { roomId: room.id, name: "Ana", clientKey });
    return socket;
  }

  async function dropConnection(): Promise<void> {
    client.disconnect();
    await vi.waitFor(() => expect(getRoom(room.id)?.participants.size).toBe(0));
  }

  const react = (messageId: string) =>
    send<Reactions>("chat-reaction", { messageId, emoji: "👍" }, "chat-reaction-update");
  const stored = (id: string) => getRoom(room.id)?.chatHistory.find((m) => m.id === id) as ChatMessage | undefined;

  it("keeps edit, delete and reactions for the same key", async () => {
    room = createRoom();
    client = await joinWithKey(KEY);
    const msg = await send<{ id: string }>("chat-message", { text: "hi" }, "chat-message");
    await react(msg.id);

    await dropConnection();
    client = await joinWithKey(KEY);

    // Toggles off: a new identity would have added a second reaction instead.
    expect((await react(msg.id)).reactions).toEqual({});
    await send("chat-edit", { messageId: msg.id, text: "hello" }, "chat-message-edit");
    expect(stored(msg.id)).toMatchObject({ text: "hello", edited: true });
    await send("chat-delete", { messageId: msg.id }, "chat-message-delete");
    expect(stored(msg.id)).toBeUndefined();
  });

  it("gives a newcomer with the same name and another key nothing", async () => {
    room = createRoom();
    client = await joinWithKey(KEY);
    const msg = await send<{ id: string }>("chat-message", { text: "hi" }, "chat-message");
    await react(msg.id);

    await dropConnection();
    client = await joinWithKey("someone-else-key-0123456789");

    client.emit("chat-edit", { messageId: msg.id, text: "hacked" });
    client.emit("chat-delete", { messageId: msg.id });
    // Adds a second reaction rather than removing the first person's.
    const { reactions } = await react(msg.id);

    expect(reactions["👍"]).toHaveLength(2);
    expect(stored(msg.id)).toMatchObject({ text: "hi" });
  });

  it("never sends the key to other participants", async () => {
    room = createRoom();
    const watcher = connect(url, { transports: ["websocket"] });
    try {
      await joined(watcher, { roomId: room.id, name: "Bob" });
      const seen: unknown[] = [];
      watcher.onAny((...args) => seen.push(args));

      client = await joinWithKey(KEY);
      const msg = await send<{ id: string }>("chat-message", { text: "hi" }, "chat-message");
      await react(msg.id);
      await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(3));

      expect(JSON.stringify(seen)).not.toContain(KEY);
    } finally {
      watcher.disconnect();
    }
  });
});
