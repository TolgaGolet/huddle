import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { setupChat } from "./chatHandler.js";
import { JOIN_ERROR } from "./joinErrors.js";
import { MAX_WAITING_PER_ROOM } from "./limits.js";
import type { RoomSettings, WaitingPerson } from "./protocol.js";
import { sweepRoomLifetimes } from "./roomLifetime.js";
import { addChatMessage, createRoom, emptyReactions, type Room } from "./roomManager.js";
import { OWNER_GRACE_MS, setupModeration } from "./roomModeration.js";
import { JOIN_DEADLINE_MS, setupSignaling } from "./signaling.js";
import type { AppServer } from "./socketRoute.js";

let httpServer: HttpServer;
let io: Server;
let url: string;
const clients: ClientSocket[] = [];

beforeAll(async () => {
  httpServer = createServer();
  io = new Server(httpServer, { transports: ["websocket"] });
  setupSignaling(io);
  setupModeration(io);
  setupChat(io);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await io.close();
});

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
});

function client(): ClientSocket {
  const socket = connect(url, { transports: ["websocket"], reconnection: false });
  clients.push(socket);
  return socket;
}

let nextKey = 1;
const newKey = () => `key-for-this-test-${nextKey++}`;

interface Joined {
  userId: string;
  settings: RoomSettings;
}

/** Whichever answer a join gets: in the room, in the waiting room, or an error. */
function attemptJoin(socket: ClientSocket, payload: object): Promise<{ joined?: Joined; waiting?: true; code?: string }> {
  return new Promise((resolve) => {
    socket.once("room-joined", (joined: Joined) => resolve({ joined }));
    socket.once("join-waiting", () => resolve({ waiting: true }));
    socket.once("error", ({ code }: { code: string }) => resolve({ code }));
    socket.emit("join-room", payload);
  });
}

async function join(room: Room, name: string, extra: object = {}) {
  const socket = client();
  const clientKey = newKey();
  const { joined, code, waiting } = await attemptJoin(socket, { roomId: room.id, name, clientKey, ...extra });
  if (!joined) throw new Error(`Expected to join, got ${code ?? (waiting ? "waiting" : "nothing")}`);
  return { socket, clientKey, userId: joined.userId, settings: joined.settings };
}

/** A room with its creator in it as owner. */
async function ownedRoom(permissions: Parameters<typeof createRoom>[2] = {}, password?: string) {
  const room = createRoom(password, null, permissions);
  const owner = await join(room, "Owner", { ownerToken: room.ownerToken, password });
  return { room, owner };
}

/** Something a non-owner sent has been processed, once a later reply from the same socket arrives. */
function settled(socket: ClientSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.once("rate-limited", () => resolve());
    socket.once("error", () => resolve());
    socket.emit("join-room", { roomId: "no-such-room", name: "x" });
  });
}

const once = <T>(socket: ClientSocket, event: string) => new Promise<T>((resolve) => socket.once(event, resolve));

describe("creator", () => {
  it("becomes owner through the token, which works once", async () => {
    const { room, owner } = await ownedRoom();
    expect(room.owners.has(owner.userId)).toBe(true);
    expect(room.ownerToken).toBeNull();

    const other = await join(room, "Bo", { ownerToken: "guessed" });
    expect(room.owners.has(other.userId)).toBe(false);
  });

  it("never exposes the token or password in settings", async () => {
    const room = createRoom("long-secret");
    const token = room.ownerToken!;
    const { settings } = await join(room, "Owner", { ownerToken: token, password: "long-secret" });

    expect(settings.hasPassword).toBe(true);
    expect(JSON.stringify(settings)).not.toContain(token);
    expect(JSON.stringify(settings)).not.toContain("long-secret");
  });
});

describe("non-owners", () => {
  it("can't do anything owners can", async () => {
    const { room, owner } = await ownedRoom({ waitingRoom: true });
    room.settings.waitingRoom = false;
    const bo = await join(room, "Bo");
    const cy = await join(room, "Cy");
    room.waiting.set("someone", { id: "someone", name: "W", userId: "w", wasRemoved: false, admit: vi.fn(() => true) });

    bo.socket.emit("set-owner", { userId: cy.userId, isOwner: true });
    bo.socket.emit("set-owner", { userId: owner.userId, isOwner: false });
    bo.socket.emit("kick-participant", { userId: cy.userId });
    bo.socket.emit("update-room-settings", { pinPermission: "owners", screenSharePermission: "owners", waitingRoom: true });
    bo.socket.emit("change-room-password", { password: "long-secret" });
    bo.socket.emit("admit-waiting", { id: "someone" });
    await settled(bo.socket);

    expect([...room.owners]).toEqual([owner.userId]);
    expect(room.blockedUsers.size).toBe(0);
    expect(cy.socket.connected).toBe(true);
    expect(room.settings).toEqual({ pinPermission: "everyone", screenSharePermission: "everyone", waitingRoom: false });
    expect(room.password).toBeNull();
    expect(room.waiting.get("someone")!.admit).not.toHaveBeenCalled();
    room.waiting.clear();
  });
});

describe("owners", () => {
  it("can make several owners and remove others, but not themselves", async () => {
    const { room, owner } = await ownedRoom();
    const bo = await join(room, "Bo");

    const announced = once<RoomSettings>(bo.socket, "room-settings");
    owner.socket.emit("set-owner", { userId: bo.userId, isOwner: true });
    expect((await announced).ownerIds).toEqual(expect.arrayContaining([owner.userId, bo.userId]));

    bo.socket.emit("set-owner", { userId: bo.userId, isOwner: false });
    await settled(bo.socket);
    expect(room.owners.has(bo.userId)).toBe(true);

    bo.socket.emit("set-owner", { userId: owner.userId, isOwner: false });
    await vi.waitFor(() => expect(room.owners.has(owner.userId)).toBe(false));
  });

  it("change settings for everyone, and a share they no longer allow stops", async () => {
    const { room, owner } = await ownedRoom();
    const bo = await join(room, "Bo");
    bo.socket.emit("screen-share-started");
    await vi.waitFor(() => expect(room.screenSharerId).toBe(bo.socket.id));

    const stopped = once<{ id: string }>(bo.socket, "screen-share-stopped");
    const updated = once<RoomSettings>(bo.socket, "room-settings");
    owner.socket.emit("update-room-settings", { screenSharePermission: "owners" });

    expect((await updated).screenSharePermission).toBe("owners");
    expect((await stopped).id).toBe(bo.socket.id);
    expect(room.screenSharerId).toBeNull();
  });

  it("refuses unknown setting values", async () => {
    const { room, owner } = await ownedRoom();
    owner.socket.emit("update-room-settings", { pinPermission: "nobody" });
    await settled(owner.socket);
    expect(room.settings.pinPermission).toBe("everyone");
  });
});

describe("permissions", () => {
  it("defaults to everyone being able to pin and share", async () => {
    const { room } = await ownedRoom();
    const bo = await join(room, "Bo");
    expect(bo.settings.pinPermission).toBe("everyone");
    expect(bo.settings.screenSharePermission).toBe("everyone");
    expect(bo.settings.waitingRoom).toBe(false);
  });

  it("stops non-owners pinning and sharing when set to owners, not owners themselves", async () => {
    const { room, owner } = await ownedRoom({ pinPermission: "owners", screenSharePermission: "owners" });
    const bo = await join(room, "Bo");
    addChatMessage(room, { id: "m1", senderId: "x", senderName: "X", text: "hi", timestamp: 1, reactions: emptyReactions() });

    bo.socket.emit("chat-pin", { messageId: "m1" });
    bo.socket.emit("screen-share-started");
    await settled(bo.socket);
    expect(room.pinnedMessageId).toBeNull();
    expect(room.screenSharerId).toBeNull();

    owner.socket.emit("chat-pin", { messageId: "m1" });
    owner.socket.emit("screen-share-started");
    await vi.waitFor(() => expect(room.pinnedMessageId).toBe("m1"));
    await vi.waitFor(() => expect(room.screenSharerId).toBe(owner.socket.id));
  });
});

describe("kicking", () => {
  it("removes someone, who waits for an owner's acceptance if they return", async () => {
    const { room, owner } = await ownedRoom();
    const bo = await join(room, "Bo");

    const kicked = once<void>(bo.socket, "kicked");
    const left = once<{ userId: string }>(owner.socket, "participant-left");
    owner.socket.emit("kick-participant", { userId: bo.userId });
    await kicked;
    expect((await left).userId).toBe(bo.userId);

    const list = once<WaitingPerson[]>(owner.socket, "waiting-list");
    const back = client();
    const attempt = await attemptJoin(back, { roomId: room.id, name: "Bo", clientKey: bo.clientKey });
    expect(attempt.waiting).toBe(true);
    expect(room.participants.size).toBe(1);
    const [person] = await list;
    expect(person).toMatchObject({ name: "Bo", wasRemoved: true });

    const admitted = once<Joined>(back, "room-joined");
    owner.socket.emit("admit-waiting", { id: person.id });
    expect((await admitted).userId).toBe(bo.userId);
    expect(room.waiting.size).toBe(0);
    expect(room.blockedUsers.size).toBe(0);
    expect(room.blockedIps.size).toBe(0);
  });

  it("sends a newcomer on the same network to the waiting room too", async () => {
    const { room, owner } = await ownedRoom();
    const bo = await join(room, "Bo");
    owner.socket.emit("kick-participant", { userId: bo.userId });
    await vi.waitFor(() => expect(room.blockedIps.size).toBe(1));

    expect((await attemptJoin(client(), { roomId: room.id, name: "Neighbour", clientKey: newKey() })).waiting).toBe(true);
  });

  it("doesn't affect a member on that network who reconnects", async () => {
    const { room, owner } = await ownedRoom();
    const bo = await join(room, "Bo");
    const cy = await join(room, "Cy");
    owner.socket.emit("kick-participant", { userId: bo.userId });
    await vi.waitFor(() => expect(room.blockedIps.size).toBe(1));

    cy.socket.io.engine.close(); // A lost connection, unlike leaving on purpose.
    await vi.waitFor(() => expect(room.participants.size).toBe(1));

    expect((await attemptJoin(client(), { roomId: room.id, name: "Cy", clientKey: cy.clientKey })).joined).toBeTruthy();
  });

  it("can't be used on yourself", async () => {
    const { room, owner } = await ownedRoom();
    owner.socket.emit("kick-participant", { userId: owner.userId });
    await settled(owner.socket);
    expect(owner.socket.connected).toBe(true);
    expect(room.blockedUsers.size).toBe(0);
  });
});

describe("waiting room setting", () => {
  it("holds newcomers until accepted, while the creator goes straight in", async () => {
    const { room, owner } = await ownedRoom({ waitingRoom: true });

    const list = once<WaitingPerson[]>(owner.socket, "waiting-list");
    const bo = client();
    expect((await attemptJoin(bo, { roomId: room.id, name: "Bo", clientKey: newKey() })).waiting).toBe(true);
    const [person] = await list;
    expect(person).toMatchObject({ name: "Bo", wasRemoved: false });

    const admitted = once<Joined>(bo, "room-joined");
    owner.socket.emit("admit-waiting", { id: person.id });
    await admitted;
    expect(room.participants.size).toBe(2);
  });

  it("doesn't hold an admitted member who lost their connection, but does one who left", async () => {
    const { room, owner } = await ownedRoom();
    const bo = await join(room, "Bo");
    const cy = await join(room, "Cy");
    owner.socket.emit("update-room-settings", { waitingRoom: true });
    await vi.waitFor(() => expect(room.settings.waitingRoom).toBe(true));

    bo.socket.io.engine.close();
    await vi.waitFor(() => expect(room.participants.size).toBe(2));
    expect((await attemptJoin(client(), { roomId: room.id, name: "Bo", clientKey: bo.clientKey })).joined).toBeTruthy();

    cy.socket.disconnect();
    await vi.waitFor(() => expect(room.memberIds.has(cy.userId)).toBe(false));
    expect((await attemptJoin(client(), { roomId: room.id, name: "Cy", clientKey: cy.clientKey })).waiting).toBe(true);
  });

  it("when turned off, admits everyone waiting except people removed earlier", async () => {
    const { room, owner } = await ownedRoom({ waitingRoom: true });
    const removedAdmit = vi.fn(() => true);
    room.waiting.set("removed", { id: "removed", name: "R", userId: "r", wasRemoved: true, admit: removedAdmit });
    const bo = client();
    await attemptJoin(bo, { roomId: room.id, name: "Bo", clientKey: newKey() });

    const admitted = once<Joined>(bo, "room-joined");
    owner.socket.emit("update-room-settings", { waitingRoom: false });
    await admitted;

    expect(removedAdmit).not.toHaveBeenCalled();
    room.waiting.clear();
  });

  it("is capped", async () => {
    const { room } = await ownedRoom({ waitingRoom: true });
    for (let i = 0; i < MAX_WAITING_PER_ROOM; i++) {
      expect((await attemptJoin(client(), { roomId: room.id, name: `W${i}`, clientKey: newKey() })).waiting).toBe(true);
    }
    expect((await attemptJoin(client(), { roomId: room.id, name: "Late", clientKey: newKey() })).code).toBe(JOIN_ERROR.WAITING_ROOM_FULL);
  });

  it("lets the same person retry without taking a second place", async () => {
    const { room } = await ownedRoom({ waitingRoom: true });
    const clientKey = newKey();
    await attemptJoin(client(), { roomId: room.id, name: "Bo", clientKey });
    await attemptJoin(client(), { roomId: room.id, name: "Bo", clientKey });
    await vi.waitFor(() => expect(room.waiting.size).toBe(1));
  });

  it("keeps someone waiting past the join deadline", async () => {
    const { room } = await ownedRoom({ waitingRoom: true });
    const timers = vi.spyOn(globalThis, "setTimeout");
    const bo = client();
    await once(bo, "connect");
    await vi.waitFor(() => expect(timers.mock.calls.some(([, ms]) => ms === JOIN_DEADLINE_MS)).toBe(true));
    const expire = timers.mock.calls.find(([, ms]) => ms === JOIN_DEADLINE_MS)![0] as () => void;
    timers.mockRestore();
    await attemptJoin(bo, { roomId: room.id, name: "Bo", clientKey: newKey() });

    expire();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bo.connected).toBe(true);
  });

  it("removes someone who gives up, and tells owners", async () => {
    const { room, owner } = await ownedRoom({ waitingRoom: true });
    const bo = client();
    await attemptJoin(bo, { roomId: room.id, name: "Bo", clientKey: newKey() });
    await once(owner.socket, "waiting-list");

    const list = once<WaitingPerson[]>(owner.socket, "waiting-list");
    bo.disconnect();

    expect(await list).toEqual([]);
    expect(room.waiting.size).toBe(0);
  });

  it("tells people waiting when the room ends with nobody left", async () => {
    const { room, owner } = await ownedRoom({ waitingRoom: true });
    const bo = client();
    await attemptJoin(bo, { roomId: room.id, name: "Bo", clientKey: newKey() });
    owner.socket.disconnect();
    await vi.waitFor(() => expect(room.participants.size).toBe(0));

    const closed = once<{ reason: string }>(bo, "room-closed");
    sweepRoomLifetimes(io as unknown as AppServer, room.emptySince! + 60_001);

    expect((await closed).reason).toBe("empty");
  });
});

describe("the last owner going", () => {
  it("promotes the longest-present participant at once when they leave on purpose", async () => {
    const { room, owner } = await ownedRoom();
    const bo = await join(room, "Bo");
    const cy = await join(room, "Cy");

    const announced = once<RoomSettings>(cy.socket, "room-settings");
    owner.socket.disconnect();

    expect((await announced).ownerIds).toEqual([bo.userId]);
  });

  it("gives someone who lost their connection time to return", async () => {
    const { room, owner } = await ownedRoom();
    const bo = await join(room, "Bo");
    owner.socket.io.engine.close();
    await vi.waitFor(() => expect(room.participants.size).toBe(1));
    const now = Date.now();

    sweepRoomLifetimes(io as unknown as AppServer, now);
    sweepRoomLifetimes(io as unknown as AppServer, now + OWNER_GRACE_MS - 1);
    expect(room.owners.has(bo.userId)).toBe(false);

    sweepRoomLifetimes(io as unknown as AppServer, now + OWNER_GRACE_MS);
    expect(room.owners.has(bo.userId)).toBe(true);
  });

  it("keeps ownership for someone returning after a lost connection", async () => {
    const { room, owner } = await ownedRoom();
    owner.socket.io.engine.close();
    await vi.waitFor(() => expect(room.participants.size).toBe(0));

    await attemptJoin(client(), { roomId: room.id, name: "Owner", clientKey: owner.clientKey });

    expect(room.owners.has(owner.userId)).toBe(true);
  });
});

// Regression: a reload needed the password, so browsers kept it in history.
describe("passwords and returning members", () => {
  it("lets a member back in without the password until they leave on purpose", async () => {
    const room = createRoom("long-secret");
    const bo = await join(room, "Bo", { password: "long-secret" });
    bo.socket.io.engine.close();
    await vi.waitFor(() => expect(room.participants.size).toBe(0));

    const back = client();
    expect((await attemptJoin(back, { roomId: room.id, name: "Bo", clientKey: bo.clientKey })).joined).toBeTruthy();

    back.disconnect();
    await vi.waitFor(() => expect(room.memberIds.has(bo.userId)).toBe(false));
    expect((await attemptJoin(client(), { roomId: room.id, name: "Bo", clientKey: bo.clientKey })).code).toBe(JOIN_ERROR.PASSWORD_REQUIRED);
  });

  it("asks a stranger for the password without spending a guess", async () => {
    const room = createRoom("long-secret");
    for (let i = 0; i < 20; i++) {
      expect((await attemptJoin(client(), { roomId: room.id, name: "Bo", clientKey: newKey() })).code).toBe(JOIN_ERROR.PASSWORD_REQUIRED);
    }
    expect((await attemptJoin(client(), { roomId: room.id, name: "Bo", clientKey: newKey(), password: "long-secret" })).joined).toBeTruthy();
  });

  it("changes the password: those present stay, others need the new one", async () => {
    const { room, owner } = await ownedRoom({}, "long-secret");
    const bo = await join(room, "Bo", { password: "long-secret" });
    const cy = await join(room, "Cy", { password: "long-secret" });
    cy.socket.io.engine.close();
    await vi.waitFor(() => expect(room.participants.size).toBe(2));

    const result = once<{ ok: boolean }>(owner.socket, "room-password-result");
    owner.socket.emit("change-room-password", { password: "brand-new-secret" });
    expect((await result).ok).toBe(true);

    expect(bo.socket.connected).toBe(true);
    expect((await attemptJoin(client(), { roomId: room.id, name: "Cy", clientKey: cy.clientKey, password: "long-secret" })).code).toBe(JOIN_ERROR.INCORRECT_PASSWORD);
    expect((await attemptJoin(client(), { roomId: room.id, name: "Cy", clientKey: cy.clientKey, password: "brand-new-secret" })).joined).toBeTruthy();
  });

  it("refuses a new password under the minimum, and can remove it", async () => {
    const { room, owner } = await ownedRoom({}, "long-secret");

    owner.socket.emit("change-room-password", { password: "short" });
    await settled(owner.socket);
    expect(room.password).toBe("long-secret");

    const result = once<{ ok: boolean }>(owner.socket, "room-password-result");
    const announced = once<RoomSettings>(owner.socket, "room-settings");
    owner.socket.emit("change-room-password", { password: "" });
    await result;
    expect((await announced).hasPassword).toBe(false);
    expect(room.password).toBeNull();
  });
});
