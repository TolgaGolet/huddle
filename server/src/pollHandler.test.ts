import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { setupSignaling } from "./signaling.js";
import { setupPolls } from "./pollHandler.js";
import { createRoom, getRoom, type PollMessage } from "./roomManager.js";

let httpServer: HttpServer;
let io: Server;
let url: string;
let client: ClientSocket;

beforeAll(async () => {
  httpServer = createServer();
  io = new Server(httpServer, { transports: ["websocket"] });
  setupSignaling(io);
  setupPolls(io);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await io.close();
});

afterEach(() => client?.disconnect());

async function join(roomId: string, clientKey?: string): Promise<void> {
  client = connect(url, { transports: ["websocket"] });
  await new Promise<void>((resolve, reject) => {
    client.once("room-joined", () => resolve());
    client.once("error", (e: { message: string }) => reject(new Error(e.message)));
    client.emit("join-room", { roomId, name: "Ana", clientKey });
  });
}

async function newPoll(allowMultiple: boolean, roomId = createRoom().id, clientKey?: string): Promise<PollMessage> {
  await join(roomId, clientKey);
  return new Promise((resolve) => {
    client.once("poll-create", resolve);
    client.emit("poll-create", { question: "Lunch?", options: ["Soup", "Salad", "Pizza"], allowMultiple });
  });
}

function vote(pollId: string, optionId: string): Promise<PollMessage> {
  return new Promise((resolve) => {
    client.once("poll-update", resolve);
    client.emit("poll-vote", { pollId, optionId });
  });
}

const voteCounts = (poll: PollMessage) => poll.options.map((o) => o.voterIds.length);

describe("poll-vote", () => {
  it("moves a single-select vote to the newly chosen option", async () => {
    const poll = await newPoll(false);
    const [a, b] = poll.options;

    expect(voteCounts(await vote(poll.id, a.id))).toEqual([1, 0, 0]);
    const moved = await vote(poll.id, b.id);
    expect(voteCounts(moved)).toEqual([0, 1, 0]);
    expect(moved.options[1].voterNames).toEqual(["Ana"]);
  });

  it("accumulates multi-select votes", async () => {
    const poll = await newPoll(true);
    const [a, b] = poll.options;

    await vote(poll.id, a.id);
    expect(voteCounts(await vote(poll.id, b.id))).toEqual([1, 1, 0]);
  });

  it("removes the vote when the same option is chosen again", async () => {
    const poll = await newPoll(false);
    const [a] = poll.options;

    await vote(poll.id, a.id);
    const cleared = await vote(poll.id, a.id);
    expect(voteCounts(cleared)).toEqual([0, 0, 0]);
    expect(cleared.options[0].voterNames).toEqual([]);
  });

  it("ignores an unknown poll or option", async () => {
    const poll = await newPoll(false);
    const [a] = poll.options;

    // No update is broadcast for these; the next real vote shows they changed nothing.
    client.emit("poll-vote", { pollId: "missing", optionId: a.id });
    client.emit("poll-vote", { pollId: poll.id, optionId: "missing" });
    expect(voteCounts(await vote(poll.id, a.id))).toEqual([1, 0, 0]);
  });

  // Regression (Q-04): votes were keyed by socket.id, so a reconnect allowed a second vote.
  it("moves a single-select vote after a reconnect instead of counting it twice", async () => {
    const KEY = "ana-secret-key-0123456789";
    const roomId = createRoom().id;
    const poll = await newPoll(false, roomId, KEY);
    const [a, b] = poll.options;
    await vote(poll.id, a.id);

    client.disconnect();
    await vi.waitFor(() => expect(getRoom(roomId)?.participants.size).toBe(0));
    await join(roomId, KEY);

    expect(voteCounts(await vote(poll.id, b.id))).toEqual([0, 1, 0]);
  });
});
