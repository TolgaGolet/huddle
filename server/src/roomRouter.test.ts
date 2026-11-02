import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { MAX_PARTICIPANTS, MAX_PASSWORD_LENGTH } from "./limits.js";
import { addParticipant, createRoom, getRoom, removeParticipant, ROOM_GRACE_MS } from "./roomManager.js";
import { createRoomRouter } from "./roomRouter.js";

let server: Server;
let baseUrl: string;

async function listen(proxyHops = 0) {
  const app = express();
  app.use(express.json());
  app.use("/api", createRoomRouter(proxyHops));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}/api/rooms`;
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(baseUrl, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

beforeEach(() => listen());

afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe("POST /rooms", () => {
  it("creates an open room when no password is given", async () => {
    const res = await post({});

    expect(res.status).toBe(200);
    const { roomId } = await res.json();
    expect(getRoom(roomId)?.password).toBeNull();
    expect(getRoom(roomId)?.encryptionSalt).toBeNull();
  });

  it("accepts a request with no body at all", async () => {
    const res = await fetch(baseUrl, { method: "POST" });

    expect(res.status).toBe(200);
  });

  it("trims the password, the same as a join does", async () => {
    const { roomId } = await (await post({ password: "  secret  " })).json();

    expect(getRoom(roomId)?.password).toBe("secret");
    expect(getRoom(roomId)?.encryptionSalt).toBeTruthy();
  });

  it("treats a blank password as an open room", async () => {
    const { roomId } = await (await post({ password: "   " })).json();

    expect(getRoom(roomId)?.password).toBeNull();
  });

  it("allows a password at the length limit", async () => {
    expect((await post({ password: "x".repeat(MAX_PASSWORD_LENGTH) })).status).toBe(200);
  });

  it("explains a password over the length limit", async () => {
    const res = await post({ password: "x".repeat(MAX_PASSWORD_LENGTH + 1) });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(String(MAX_PASSWORD_LENGTH));
  });

  it.each([[{ password: 123 }], [{ password: null }], [["array"]]])("rejects the malformed body %j", async (body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request" });
  });

  it("charges the room to the client behind a trusted proxy, not the proxy", async () => {
    await new Promise((resolve) => server.close(resolve));
    await listen(1);

    const { roomId } = await (await post({}, { "X-Forwarded-For": "203.0.113.9" })).json();

    expect(getRoom(roomId)?.creatorIp).toBe("203.0.113.9");
  });
});

describe("GET /rooms/:id", () => {
  const get = async (id: string) => (await fetch(`${baseUrl}/${id}`)).json();

  it("reports a missing room as a normal answer", async () => {
    expect(await get("nope")).toEqual({ exists: false, hasPassword: false, participantCount: 0, maxParticipants: MAX_PARTICIPANTS });
  });

  it("reports an open room and who is in it", async () => {
    const room = createRoom();
    addParticipant(room, "s1", "Ana");

    expect(await get(room.id)).toEqual({ exists: true, hasPassword: false, participantCount: 1, maxParticipants: MAX_PARTICIPANTS });
  });

  it("says a password is needed without revealing it or the secrets beside it", async () => {
    const room = createRoom("secret", "203.0.113.9");

    const info = await get(room.id);

    expect(info.hasPassword).toBe(true);
    expect(JSON.stringify(info)).not.toContain("secret");
    expect(JSON.stringify(info)).not.toContain("203.0.113.9");
    expect(JSON.stringify(info)).not.toContain(room.encryptionSalt);
  });

  it("reports a room as gone once its grace period has passed", async () => {
    const room = createRoom();
    addParticipant(room, "s2", "Ana");
    removeParticipant(room.id, "s2");
    expect((await get(room.id)).exists).toBe(true);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + ROOM_GRACE_MS + 1);

    expect((await get(room.id)).exists).toBe(false);
  });
});
