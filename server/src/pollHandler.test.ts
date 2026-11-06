import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { setupSignaling } from "./signaling.js";
import { setupPolls } from "./pollHandler.js";
import { createRoom, getRoom, removeMessage, type PollMessage } from "./roomManager.js";

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

type PollExtra = { lockVotes?: boolean; durationMs?: number };

/** Creates a poll from the already joined client. */
function createPoll(allowMultiple: boolean, extra: PollExtra = {}): Promise<PollMessage> {
  return new Promise((resolve) => {
    client.once("poll-create", resolve);
    client.emit("poll-create", { question: "Lunch?", options: ["Soup", "Salad", "Pizza"], allowMultiple, lockVotes: false, ...extra });
  });
}

/** Joins a room (a new one by default), then creates a poll there. */
async function newPoll(
  allowMultiple: boolean,
  { roomId = createRoom().id, clientKey, ...extra }: PollExtra & { roomId?: string; clientKey?: string } = {},
): Promise<PollMessage> {
  await join(roomId, clientKey);
  return createPoll(allowMultiple, extra);
}

function submit(pollId: string, optionIds: string[]): Promise<PollMessage> {
  return new Promise((resolve) => {
    client.once("poll-update", resolve);
    client.emit("poll-submit", { pollId, optionIds });
  });
}

function vote(pollId: string, optionId: string): Promise<PollMessage> {
  return new Promise((resolve) => {
    client.once("poll-update", resolve);
    client.emit("poll-vote", { pollId, optionId });
  });
}

const voteCounts = (poll: PollMessage) => poll.options.map((o) => o.voters.length);

describe("poll-vote", () => {
  it("moves a single-select vote to the newly chosen option", async () => {
    const poll = await newPoll(false);
    const [a, b] = poll.options;

    expect(voteCounts(await vote(poll.id, a.id))).toEqual([1, 0, 0]);
    const moved = await vote(poll.id, b.id);
    expect(voteCounts(moved)).toEqual([0, 1, 0]);
    expect(moved.options[1].voters.map((v) => v.name)).toEqual(["Ana"]);
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
    expect(cleared.options[0].voters).toEqual([]);
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
    const poll = await newPoll(false, { roomId, clientKey: KEY });
    const [a, b] = poll.options;
    await vote(poll.id, a.id);

    client.disconnect();
    await vi.waitFor(() => expect(getRoom(roomId)?.participants.size).toBe(0));
    await join(roomId, KEY);

    expect(voteCounts(await vote(poll.id, b.id))).toEqual([0, 1, 0]);
  });
});

/** Resolves once the server has handled everything this client sent before it. */
const barrier = () => createPoll(false);

const stored = (roomId: string, pollId: string) => getRoom(roomId)!.chatHistory.find((e) => e.id === pollId) as PollMessage;

describe("poll end time", () => {
  it("sets endsAt from the chosen duration", async () => {
    const poll = await newPoll(false, { durationMs: 5 * 60_000 });
    expect(poll.endsAt).toBe(poll.timestamp + 5 * 60_000);
  });

  it("refuses votes once the poll has ended", async () => {
    const roomId = createRoom().id;
    const poll = await newPoll(false, { roomId, durationMs: 60_000 });
    // Move the end into the past without waiting for the timer.
    stored(roomId, poll.id).endsAt = Date.now() - 1;

    client.emit("poll-vote", { pollId: poll.id, optionId: poll.options[0].id });
    await barrier();
    expect(voteCounts(stored(roomId, poll.id))).toEqual([0, 0, 0]);
  });

  it("broadcasts the poll as closed when its time is up", async () => {
    await join(createRoom().id);
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      const poll = await createPoll(false, { durationMs: 60_000 });
      const call = spy.mock.calls.find(([, ms]) => ms === 60_000);
      expect(call).toBeDefined();
      const closed = new Promise<PollMessage>((resolve) => client.once("poll-update", resolve));
      (call![0] as () => void)();
      const update = await closed;
      expect(update.id).toBe(poll.id);
      expect(update.closed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  // Regression: a deleted poll kept its close timer for up to its full duration.
  it("cancels the close timer when the poll is removed", async () => {
    const roomId = createRoom().id;
    await join(roomId);
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const poll = await createPoll(false, { durationMs: 60_000 });
      const index = setSpy.mock.calls.findIndex(([, ms]) => ms === 60_000);
      const timer = setSpy.mock.results[index].value;

      removeMessage(getRoom(roomId)!, poll.id);

      expect(clearSpy).toHaveBeenCalledWith(timer);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});

describe("locked polls", () => {
  it("ignores poll-vote and keeps the first poll-submit", async () => {
    const roomId = createRoom().id;
    const poll = await newPoll(false, { roomId, lockVotes: true });
    const [a, b] = poll.options;

    client.emit("poll-vote", { pollId: poll.id, optionId: b.id });
    expect(voteCounts(await submit(poll.id, [a.id]))).toEqual([1, 0, 0]);

    client.emit("poll-submit", { pollId: poll.id, optionIds: [b.id] });
    client.emit("poll-vote", { pollId: poll.id, optionId: a.id });
    await barrier();
    expect(voteCounts(stored(roomId, poll.id))).toEqual([1, 0, 0]);
  });

  it("takes several options at once only when multiple selections are allowed", async () => {
    const roomId = createRoom().id;
    const single = await newPoll(false, { roomId, lockVotes: true });
    client.emit("poll-submit", { pollId: single.id, optionIds: [single.options[0].id, single.options[1].id] });
    await barrier();
    expect(voteCounts(stored(roomId, single.id))).toEqual([0, 0, 0]);

    const multi = await createPoll(true, { lockVotes: true });
    const [a, , c] = multi.options;
    expect(voteCounts(await submit(multi.id, [a.id, c.id]))).toEqual([1, 0, 1]);
  });

  it("refuses a submit naming an unknown option", async () => {
    const roomId = createRoom().id;
    const poll = await newPoll(true, { roomId, lockVotes: true });
    client.emit("poll-submit", { pollId: poll.id, optionIds: [poll.options[0].id, "missing"] });
    await barrier();
    expect(voteCounts(stored(roomId, poll.id))).toEqual([0, 0, 0]);
  });
});
