import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request, type ClientRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "express";
import { httpErrorHandler } from "./httpErrors.js";
import { deleteRoomImages, IMAGE_READ_TIMEOUT_MS, imageRouter, releaseMessageImages, uploadsDir } from "./imageRouter.js";
import { MAX_IMAGE_SIZE, MAX_IMAGES_PER_MESSAGE, MAX_INFLIGHT_IMAGE_BYTES, MAX_ROOM_IMAGE_BYTES, MAX_ROOM_INFLIGHT_READ_BYTES } from "./limits.js";
import { addParticipant, createRoom, emptyReactions, httpTokenFor, removeParticipant, type ChatMessage, type Room } from "./roomManager.js";

// Lets a test hold a route at one of its file operations.
const fsHooks = vi.hoisted(() => ({
  stat: null as Promise<unknown> | null,
  statSize: null as number | null,
  readFile: null as Promise<unknown> | null,
  writeFile: null as Promise<unknown> | null,
  writeReached: () => {},
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      await fsHooks.stat;
      const stats = await actual.stat(...args);
      return fsHooks.statSize === null ? stats : { ...stats, size: fsHooks.statSize };
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      await fsHooks.readFile;
      return actual.readFile(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      fsHooks.writeReached();
      await fsHooks.writeFile;
      return actual.writeFile(...args);
    },
  };
});

const BOUNDARY = "huddletestboundary";
const SOCKET_ID = "test-socket";

let server: Server;
let port: number;
let room: Room;
const openRequests: ClientRequest[] = [];

beforeAll(async () => {
  const app = express();
  app.use("/api", imageRouter);
  app.use(httpErrorHandler);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

afterEach(async () => {
  for (const req of openRequests.splice(0)) req.destroy();
  removeParticipant(room.id, SOCKET_ID);
  await deleteRoomImages(room.id);
});

function multipartBody(size: number): Buffer {
  return Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="images"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
    Buffer.alloc(size, 1),
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

/** Opens an upload whose body the caller writes, and may leave unfinished. */
function openUpload(socketId: string, headers: Record<string, string | number> = {}) {
  let req!: ClientRequest;
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req = request(
      {
        port,
        method: "POST",
        path: `/api/rooms/${room.id}/images`,
        headers: { "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`, "X-Participant-Token": httpTokenFor(socketId) ?? socketId, ...headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
  });
  openRequests.push(req);
  return { req, response };
}

function joinRoom(extraBytes = 0): void {
  room = createRoom();
  room.imageBytes = extraBytes;
  addParticipant(room.id, SOCKET_ID, "Ana");
}

describe("POST /rooms/:id/images", () => {
  it("rejects a non-member without waiting for the request body", async () => {
    joinRoom();
    const { req, response } = openUpload("not-a-member");
    req.write(multipartBody(16).subarray(0, 20));

    expect((await response).status).toBe(403);
  });

  it("rejects an upload whose Content-Length exceeds the quota without waiting for the body", async () => {
    joinRoom(MAX_ROOM_IMAGE_BYTES - 10);
    const { req, response } = openUpload(SOCKET_ID, { "Content-Length": 1000 });
    req.write(multipartBody(16).subarray(0, 20));

    const { status, body } = await response;
    expect(status).toBe(413);
    expect(JSON.parse(body).error).toMatch(/storage limit/);
  });

  it("requires a Content-Length, since a chunked body can't be reserved", async () => {
    joinRoom();
    const { req, response } = openUpload(SOCKET_ID);
    req.write(multipartBody(16).subarray(0, 20));

    expect((await response).status).toBe(411);
    expect(room.imageBytes).toBe(0);
  });

  it("rejects a body larger than any allowed upload without waiting for it", async () => {
    joinRoom();
    const { req, response } = openUpload(SOCKET_ID, { "Content-Length": MAX_IMAGE_SIZE * MAX_IMAGES_PER_MESSAGE + 1024 * 1024 });
    req.write(multipartBody(16).subarray(0, 20));

    expect((await response).status).toBe(413);
  });

  it("reserves an upload's size so concurrent ones can't exceed the quota", async () => {
    joinRoom(MAX_ROOM_IMAGE_BYTES - 1000);
    const first = openUpload(SOCKET_ID, { "Content-Length": 900 });
    first.response.catch(() => {});
    first.req.write(multipartBody(16).subarray(0, 20));
    await vi.waitFor(() => expect(room.imageBytes).toBe(MAX_ROOM_IMAGE_BYTES - 100));

    const second = openUpload(SOCKET_ID, { "Content-Length": 900 });
    second.req.write(multipartBody(16).subarray(0, 20));

    expect((await second.response).status).toBe(413);
  });

  it("releases the reservation when the client abandons the upload", async () => {
    joinRoom();
    const { req, response } = openUpload(SOCKET_ID, { "Content-Length": 900 });
    response.catch(() => {});
    req.write(multipartBody(16).subarray(0, 20));
    await vi.waitFor(() => expect(room.imageBytes).toBe(900));

    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    req.destroy();

    await vi.waitFor(() => expect(room.imageBytes).toBe(0));
    // Leaving mid-upload is normal, not a server error.
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("caps upload bytes held in memory across all rooms", async () => {
    const declared = MAX_IMAGE_SIZE * MAX_IMAGES_PER_MESSAGE;
    const fits = Math.floor(MAX_INFLIGHT_IMAGE_BYTES / declared);
    for (let i = 0; i < fits; i++) {
      joinRoom();
      const { req, response } = openUpload(SOCKET_ID, { "Content-Length": declared });
      response.catch(() => {});
      req.write(multipartBody(16).subarray(0, 20));
      await vi.waitFor(() => expect(room.imageBytes).toBe(declared));
    }

    joinRoom();
    const { req, response } = openUpload(SOCKET_ID, { "Content-Length": declared });
    req.write(multipartBody(16).subarray(0, 20));

    expect((await response).status).toBe(503);
  });

  it("stores a member's image and counts it towards the quota", async () => {
    joinRoom();
    const { req, response } = openUpload(SOCKET_ID);
    req.end(multipartBody(100));

    const { status, body } = await response;
    expect(status).toBe(200);
    const { urls } = JSON.parse(body) as { urls: string[] };
    expect(urls).toHaveLength(1);
    expect(existsSync(path.join(uploadsDir, room.id, path.basename(urls[0])))).toBe(true);
    await vi.waitFor(() => expect(room.imageBytes).toBe(100));
  });

  // Regression (F08): this was a 500 with an HTML body, so the user saw a generic failure.
  it("answers an image over the size limit with a message the client can show", async () => {
    joinRoom();
    const { req, response } = openUpload(SOCKET_ID);
    req.end(multipartBody(MAX_IMAGE_SIZE + 1));

    const { status, body } = await response;
    expect(status).toBe(413);
    expect(JSON.parse(body)).toEqual({ error: "Image is too large" });
    await vi.waitFor(() => expect(room.imageBytes).toBe(0));
  });

  it("releases the reservation when storing fails", async () => {
    joinRoom();
    // A plain file at the room's folder path makes creating the folder fail.
    await mkdir(uploadsDir, { recursive: true });
    await writeFile(path.join(uploadsDir, room.id), "");
    const { req, response } = openUpload(SOCKET_ID);
    req.end(multipartBody(100));

    expect((await response).status).toBe(500);
    await vi.waitFor(() => expect(room.imageBytes).toBe(0));
  });

  // Regression: the close refunded bytes the store was still about to count, so
  // disconnecting right after sending bypassed the quota.
  it("still counts an image whose client disconnects while it is being stored", async () => {
    joinRoom();
    let releaseWrite!: () => void;
    fsHooks.writeFile = new Promise<void>((resolve) => (releaseWrite = resolve));
    const writing = new Promise<void>((resolve) => (fsHooks.writeReached = resolve));
    try {
      const { req, response } = openUpload(SOCKET_ID);
      response.catch(() => {});
      req.end(multipartBody(100));
      await writing;

      req.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseWrite();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(room.imageBytes).toBe(100);
      expect(room.imageSizes.size).toBe(1);
    } finally {
      fsHooks.writeFile = null;
      fsHooks.writeReached = () => {};
    }
  });

  it("stores nothing if the sender leaves the room during the upload", async () => {
    joinRoom();
    const body = multipartBody(100);
    const { req, response } = openUpload(SOCKET_ID, { "Content-Length": body.length });
    req.write(body.subarray(0, 20));
    await new Promise((resolve) => setTimeout(resolve, 50));
    removeParticipant(room.id, SOCKET_ID);
    req.end(body.subarray(20));

    expect((await response).status).toBe(403);
    await vi.waitFor(() => expect(room.imageBytes).toBe(0));
    expect(existsSync(path.join(uploadsDir, room.id))).toBe(false);
  });
});

describe("releaseMessageImages", () => {
  const message = (id: string, imageUrls: string[]): ChatMessage => ({
    id,
    senderId: "u",
    senderName: "Ana",
    text: "",
    timestamp: 0,
    reactions: emptyReactions(),
    imageUrls,
  });

  async function uploadUrl(): Promise<string> {
    const { req, response } = openUpload(SOCKET_ID);
    req.end(multipartBody(100));
    const { urls } = JSON.parse((await response).body) as { urls: string[] };
    await vi.waitFor(() => expect(room.imageBytes).toBeLessThan(1000));
    return urls[0];
  }

  const fileOf = (url: string) => path.join(uploadsDir, room.id, path.basename(url));

  it("deletes the file and frees its quota", async () => {
    joinRoom();
    const url = await uploadUrl();

    releaseMessageImages(room, message("a", [url]));

    expect(room.imageBytes).toBe(0);
    await vi.waitFor(() => expect(existsSync(fileOf(url))).toBe(false));
  });

  it("keeps an image another message still uses, and releases it only once", async () => {
    joinRoom();
    const url = await uploadUrl();
    room.chatHistory.push(message("other", [url]));

    releaseMessageImages(room, message("a", [url]));
    expect(room.imageBytes).toBe(100);
    expect(existsSync(fileOf(url))).toBe(true);

    room.chatHistory = [];
    releaseMessageImages(room, message("other", [url]));
    releaseMessageImages(room, message("again", [url]));
    expect(room.imageBytes).toBe(0);
  });
});

describe("GET /rooms/:id/images/:filename", () => {
  const IMAGE_BYTES = 100;
  const image = Buffer.alloc(IMAGE_BYTES, 1);

  const openSession = (roomId = room.id, socketId = SOCKET_ID) =>
    fetch(`http://localhost:${port}/api/rooms/${roomId}/image-session`, {
      method: "POST",
      headers: { "X-Participant-Token": httpTokenFor(socketId) ?? socketId },
    });

  /** The session cookie as a browser would send it back. */
  async function sessionCookie(roomId = room.id, socketId = SOCKET_ID): Promise<string> {
    const res = await openSession(roomId, socketId);
    expect(res.status).toBe(204);
    return res.headers.getSetCookie()[0].split(";")[0];
  }

  const get = (filename: string, cookie?: string, query = "") =>
    fetch(`http://localhost:${port}/api/rooms/${room.id}/images/${filename}${query}`, {
      headers: cookie ? { Cookie: cookie } : {},
    });

  async function upload(): Promise<string> {
    const { req, response } = openUpload(SOCKET_ID);
    req.end(multipartBody(IMAGE_BYTES));
    const { urls } = JSON.parse((await response).body) as { urls: string[] };
    return path.basename(urls[0]);
  }

  it("serves an image to a member's session, cacheably in an open room", async () => {
    joinRoom();
    const filename = await upload();

    const res = await get(filename, await sessionCookie());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(Buffer.from(await res.arrayBuffer()).equals(image)).toBe(true);
  });

  it("scopes the session cookie to the room's images and hides it from scripts", async () => {
    joinRoom();
    const header = (await openSession()).headers.getSetCookie()[0];
    expect(header).toContain(`Path=/api/rooms/${room.id}/images`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
  });

  it("opens a session for a member only", async () => {
    joinRoom();
    expect((await openSession(room.id, "not-a-member")).status).toBe(403);
    expect((await openSession(createRoom().id)).status).toBe(403);
  });

  // Regression: the socket id in the URL ended up in proxy and access logs.
  it("no longer accepts the socket id in place of a session", async () => {
    joinRoom();
    const filename = await upload();

    expect((await get(filename)).status).toBe(404);
    expect((await get(filename, undefined, `?socketId=${SOCKET_ID}`)).status).toBe(404);
  });

  // Regression (F02): a former member reused another member's broadcast socket
  // id to open a session, read images and upload.
  it("refuses another member's socket id on every route that needs a token", async () => {
    joinRoom();
    const asSocketId = { "X-Socket-Id": SOCKET_ID, "X-Participant-Token": SOCKET_ID };

    const session = await fetch(`http://localhost:${port}/api/rooms/${room.id}/image-session`, { method: "POST", headers: asSocketId });
    expect(session.status).toBe(403);

    const { req, response } = openUpload(SOCKET_ID, asSocketId);
    req.end(multipartBody(100));
    expect((await response).status).toBe(403);
  });

  it("stops accepting the token once its owner leaves", async () => {
    joinRoom();
    const token = httpTokenFor(SOCKET_ID)!;
    removeParticipant(room.id, SOCKET_ID);

    const session = await fetch(`http://localhost:${port}/api/rooms/${room.id}/image-session`, {
      method: "POST",
      headers: { "X-Participant-Token": token },
    });
    expect(session.status).toBe(403);
  });

  it("revalidates an open room's image from its metadata, for members only", async () => {
    joinRoom();
    const filename = await upload();
    const cookie = await sessionCookie();
    const etag = (await get(filename, cookie)).headers.get("etag");
    expect(etag).toBeTruthy();

    // Not fetch: with If-None-Match it adds Cache-Control: no-cache, which forces a 200.
    const revalidate = () =>
      new Promise<IncomingMessage>((resolve, reject) => {
        request(
          { port, path: `/api/rooms/${room.id}/images/${filename}`, headers: { Cookie: cookie, "If-None-Match": etag! } },
          (res) => {
            res.resume();
            resolve(res);
          },
        ).on("error", reject).end();
      });
    const fresh = await revalidate();
    expect(fresh.statusCode).toBe(304);
    expect(fresh.headers["cache-control"]).toBe("private, no-cache");

    removeParticipant(room.id, SOCKET_ID);
    expect((await revalidate()).statusCode).toBe(404);
  });

  it("refuses a decrypting read while image memory is full, then serves it", async () => {
    room = createRoom("secret");
    addParticipant(room.id, SOCKET_ID, "Ana");
    const filename = await upload();
    const cookie = await sessionCookie();
    const imageRoom = room;

    // Two unfinished uploads, from other rooms, reserve the whole budget.
    const declared = MAX_IMAGE_SIZE * MAX_IMAGES_PER_MESSAGE;
    const holds = [];
    for (const size of [declared, MAX_INFLIGHT_IMAGE_BYTES - declared]) {
      joinRoom();
      const hold = openUpload(SOCKET_ID, { "Content-Length": size });
      hold.response.catch(() => {});
      hold.req.write(multipartBody(16).subarray(0, 20));
      await vi.waitFor(() => expect(room.imageBytes).toBe(size));
      holds.push(hold);
    }
    room = imageRoom;
    addParticipant(room.id, SOCKET_ID, "Ana");

    const busy = await get(filename, cookie);
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("1");

    for (const hold of holds) hold.req.destroy();
    await vi.waitFor(async () => expect((await get(filename, cookie)).status).toBe(200));
  });

  /** Holds the whole image budget with unfinished uploads from other rooms. */
  async function holdWholeBudget() {
    const imageRoom = room;
    const declared = MAX_IMAGE_SIZE * MAX_IMAGES_PER_MESSAGE;
    const holds = [];
    for (const size of [declared, MAX_INFLIGHT_IMAGE_BYTES - declared]) {
      joinRoom();
      const hold = openUpload(SOCKET_ID, { "Content-Length": size });
      hold.response.catch(() => {});
      hold.req.write(multipartBody(16).subarray(0, 20));
      await vi.waitFor(() => expect(room.imageBytes).toBe(size));
      holds.push(hold);
    }
    room = imageRoom;
    addParticipant(room.id, SOCKET_ID, "Ana");
    return holds;
  }

  /** A read that may never be answered, for the caller to abandon. */
  function openRead(filename: string, cookie: string, onClose?: () => void): ClientRequest {
    const req = request({ port, path: `/api/rooms/${room.id}/images/${filename}`, headers: { Cookie: cookie } }, (res) => res.resume());
    req.on("error", () => {});
    if (onClose) req.on("close", onClose);
    req.end();
    openRequests.push(req);
    return req;
  }

  // Regression: the release was registered after `close` had already fired, so
  // about eight abandoned reads took every upload and decrypting read down for good.
  it("doesn't reserve image memory for a read abandoned before the reservation", async () => {
    room = createRoom("secret");
    addParticipant(room.id, SOCKET_ID, "Ana");
    const filename = await upload();
    const cookie = await sessionCookie();
    let releaseStat!: () => void;
    fsHooks.stat = new Promise<void>((resolve) => (releaseStat = resolve));
    try {
      const read = openRead(filename, cookie);
      await new Promise((resolve) => setTimeout(resolve, 50));
      read.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseStat();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      fsHooks.stat = null;
    }

    // Exactly the whole budget still fits, so not one byte was left reserved.
    const holds = await holdWholeBudget();
    for (const hold of holds) hold.req.destroy();
  });

  describe("while a decrypting read is held", () => {
    let releaseRead: () => void;

    const passwordRoomFile = async () => {
      room = createRoom("secret");
      addParticipant(room.id, SOCKET_ID, "Ana");
      const filename = await upload();
      return { filename, cookie: await sessionCookie() };
    };

    const holdReads = () => {
      fsHooks.statSize = MAX_ROOM_INFLIGHT_READ_BYTES / 2;
      fsHooks.readFile = new Promise<void>((resolve) => (releaseRead = resolve));
    };

    afterEach(() => {
      releaseRead?.();
      fsHooks.readFile = null;
      fsHooks.statSize = null;
    });

    // Regression: one member not reading their responses starved every other room.
    it("caps one room's reads, leaving budget for other rooms", async () => {
      const other = await passwordRoomFile();
      const otherRoom = room;
      const { filename, cookie } = await passwordRoomFile();
      holdReads();

      openRead(filename, cookie);
      await vi.waitFor(() => expect(room.inFlightReadBytes).toBe(MAX_ROOM_INFLIGHT_READ_BYTES));

      expect((await get(filename, cookie)).status).toBe(503);

      const imageRoom = room;
      room = otherRoom;
      openRead(other.filename, other.cookie);
      await vi.waitFor(() => expect(otherRoom.inFlightReadBytes).toBe(MAX_ROOM_INFLIGHT_READ_BYTES));
      removeParticipant(otherRoom.id, SOCKET_ID);
      room = imageRoom;
    });

    it("ends a read that outlasts its deadline, releasing its reservation", async () => {
      const { filename, cookie } = await passwordRoomFile();
      holdReads();
      const timers = vi.spyOn(globalThis, "setTimeout");

      const closed = new Promise<void>((resolve) => openRead(filename, cookie, resolve));
      await vi.waitFor(() => expect(room.inFlightReadBytes).toBe(MAX_ROOM_INFLIGHT_READ_BYTES));
      const deadline = timers.mock.calls.find(([, ms]) => ms === IMAGE_READ_TIMEOUT_MS);
      timers.mockRestore();
      expect(deadline).toBeDefined();

      (deadline![0] as () => void)();

      await closed;
      await vi.waitFor(() => expect(room.inFlightReadBytes).toBe(0));
    });
  });

  it("refuses a tampered cookie", async () => {
    joinRoom();
    const filename = await upload();
    const cookie = await sessionCookie();
    // Not the last character: its low bits are ignored when decoding base64url,
    // so changing it may not change the signature.
    const at = cookie.length - 10;
    const flipped = `${cookie.slice(0, at)}${cookie[at] === "A" ? "B" : "A"}${cookie.slice(at + 1)}`;

    expect((await get(filename, flipped)).status).toBe(404);
  });

  it("refuses another room's cookie", async () => {
    joinRoom();
    const filename = await upload();
    const imageRoom = room;
    joinRoom();
    const otherCookie = await sessionCookie();
    removeParticipant(room.id, SOCKET_ID);
    room = imageRoom;
    addParticipant(room.id, SOCKET_ID, "Ana");

    expect((await get(filename, otherCookie)).status).toBe(404);
  });

  it("refuses an expired cookie", async () => {
    joinRoom();
    const filename = await upload();
    const cookie = await sessionCookie();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 13 * 60 * 60 * 1000);
    try {
      expect((await get(filename, cookie)).status).toBe(404);
    } finally {
      clock.mockRestore();
    }
  });

  it("ends access when the user leaves the room", async () => {
    joinRoom();
    const filename = await upload();
    const cookie = await sessionCookie();
    removeParticipant(room.id, SOCKET_ID);

    expect((await get(filename, cookie)).status).toBe(404);
  });

  it("refuses a filename outside the allowlist even if the file exists", async () => {
    joinRoom();
    await mkdir(path.join(uploadsDir, room.id), { recursive: true });
    await writeFile(path.join(uploadsDir, room.id, "aaaaaaaaaa.html"), "<script></script>");

    expect((await get("aaaaaaaaaa.html", await sessionCookie())).status).toBe(404);
  });

  it("encrypts a password-protected room's image at rest and decrypts it on read", async () => {
    room = createRoom("secret");
    addParticipant(room.id, SOCKET_ID, "Ana");
    const filename = await upload();

    const onDisk = await readFile(path.join(uploadsDir, room.id, filename));
    expect(onDisk.includes(image)).toBe(false);

    const res = await get(filename, await sessionCookie());
    expect(res.status).toBe(200);
    // Decrypted images must stay out of the browser's disk cache.
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await res.arrayBuffer()).equals(image)).toBe(true);
  });
});
