import { EventEmitter } from "node:events";
import type { Response } from "express";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request, type ClientRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "express";
import { httpErrorHandler } from "./httpErrors.js";
import { createImageRouter, deleteRoomImages, IMAGE_READ_TIMEOUT_MS, releaseMessageImages, uploadsDir } from "./imageRouter.js";
import { holdImageMemory } from "./imageQuota.js";
import { MAX_IMAGE_SIZE, MAX_IMAGES_PER_MESSAGE, MAX_CLIENT_INFLIGHT_IMAGE_BYTES, MAX_INFLIGHT_IMAGE_BYTES, MAX_ROOM_IMAGE_BYTES, MAX_ROOM_INFLIGHT_READ_BYTES, MAX_TOTAL_IMAGE_BYTES } from "./limits.js";
import { addParticipant, createRoom, emptyReactions, httpTokenFor, removeParticipant, type ChatMessage, type Room } from "./roomManager.js";

// Before imageRouter loads, so its files go to a temp directory, not the real uploads.
await vi.hoisted(async () => {
  const [{ mkdtempSync }, { tmpdir }, { join }] = await Promise.all([import("node:fs"), import("node:os"), import("node:path")]);
  process.env.HUDDLE_UPLOADS_DIR = mkdtempSync(join(tmpdir(), "huddle-uploads-"));
});

afterAll(() => rm(uploadsDir, { recursive: true, force: true }));

// Lets a test hold a route at one of its file operations.
const fsHooks = vi.hoisted(() => ({
  stat: null as Promise<unknown> | null,
  statSize: null as number | null,
  readFile: null as Promise<unknown> | null,
  writeFile: null as Promise<unknown> | null,
  writeReached: () => {},
  /** What the mocked encoder returns, when not simply its input. */
  encoded: null as Buffer | null,
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
  app.use("/api", createImageRouter(1));
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
  addParticipant(room, SOCKET_ID, "Ana");
}

// Router tests upload filler bytes; imageProcessing.test.ts covers the real thing.
vi.mock("./imageProcessing.js", async (original) => ({
  ...(await original<typeof import("./imageProcessing.js")>()),
  processImage: (input: Buffer) => Promise.resolve(fsHooks.encoded ?? input),
}));

let nextClient = 1;
/** Headers making a request count as a new client, each with its own in-flight share. */
const newClient = () => ({ "X-Forwarded-For": `10.1.0.${nextClient++}` });

/** A response object that holds image memory until told it closed. */
function fakeResponse() {
  return Object.assign(new EventEmitter(), { closed: false }) as unknown as Response;
}

/** Takes the whole shared image budget, leaving nothing for a request under test. */
function fillImageMemory() {
  const res = fakeResponse();
  expect(holdImageMemory(res).take(MAX_INFLIGHT_IMAGE_BYTES)).toBe(true);
  return { release: () => void res.emit("close") };
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

  it("answers 503 without reserving when all rooms together hold the server-wide limit", async () => {
    const other = createRoom();
    other.imageBytes = MAX_TOTAL_IMAGE_BYTES;
    joinRoom();
    try {
      const { req, response } = openUpload(SOCKET_ID, { "Content-Length": 1000 });
      req.write(multipartBody(16).subarray(0, 20));

      const { status, body } = await response;
      expect(status).toBe(503);
      expect(JSON.parse(body).error).toMatch(/busy/);
      expect(room.imageBytes).toBe(0);
    } finally {
      other.imageBytes = 0;
    }
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
    const hold = fillImageMemory();
    joinRoom();
    const { req, response } = openUpload(SOCKET_ID, { "Content-Length": MAX_IMAGE_SIZE, ...newClient() });
    req.write(multipartBody(16).subarray(0, 20));

    expect((await response).status).toBe(503);
    hold.release();
  });

  // Regression: declared bytes were reserved up front, so stalled requests blocked every room.
  it("holds no shared memory for a declared size that hasn't arrived", async () => {
    joinRoom();
    const stalled = openUpload(SOCKET_ID, { "Content-Length": MAX_IMAGE_SIZE, ...newClient() });
    stalled.response.catch(() => {});
    stalled.req.write(multipartBody(16).subarray(0, 20));
    await vi.waitFor(() => expect(room.imageBytes).toBe(MAX_IMAGE_SIZE));

    const fake = fakeResponse();
    expect(holdImageMemory(fake).take(MAX_INFLIGHT_IMAGE_BYTES - 1024)).toBe(true);
    fake.emit("close");
    stalled.req.destroy();
  });

  it("caps what one client can have in flight", async () => {
    const declared = MAX_IMAGE_SIZE * MAX_IMAGES_PER_MESSAGE;
    const client = newClient();
    joinRoom();
    const first = openUpload(SOCKET_ID, { "Content-Length": declared, ...client });
    first.response.catch(() => {});
    first.req.write(multipartBody(16).subarray(0, 20));
    await vi.waitFor(() => expect(room.imageBytes).toBe(declared));

    joinRoom();
    const second = openUpload(SOCKET_ID, { "Content-Length": MAX_CLIENT_INFLIGHT_IMAGE_BYTES - declared + 1, ...client });
    second.req.write(multipartBody(16).subarray(0, 20));

    expect((await second.response).status).toBe(503);
    first.req.destroy();
  });

  it("refuses an upload whose bytes no longer fit once they arrive", async () => {
    joinRoom();
    const { req, response } = openUpload(SOCKET_ID, { "Content-Length": 4096, ...newClient() });
    req.flushHeaders();
    await vi.waitFor(() => expect(room.imageBytes).toBe(4096));
    const hold = fillImageMemory();

    req.write(Buffer.alloc(1024));

    expect((await response).status).toBe(503);
    hold.release();
  });

  it("drops an upload that stops sending, and gives back what it reserved", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    joinRoom();
    const { req, response } = openUpload(SOCKET_ID, { "Content-Length": 4096, ...newClient() });
    response.catch(() => {});
    req.on("error", () => {});
    req.flushHeaders();
    await vi.waitFor(() => expect(room.imageBytes).toBe(4096));
    const stall = timers.mock.calls.find(([, ms]) => ms === 15_000)![0] as () => void;
    timers.mockRestore();

    stall();

    await vi.waitFor(() => expect(room.imageBytes).toBe(0));
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

  const roomFiles = () => readdir(path.join(uploadsDir, room.id)).catch(() => []);

  // Regression: the close refunded bytes the store was still about to count, so
  // disconnecting right after sending bypassed the quota.
  it("keeps counting an image until a client that disconnected during its store is cleaned up", async () => {
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
      expect(room.imageBytes).toBeGreaterThanOrEqual(100);
      releaseWrite();

      // Nobody got the URL, so nothing could ever reference or free the file.
      await vi.waitFor(() => expect(room.imageBytes).toBe(0));
      expect(room.imageSizes.size).toBe(0);
      expect(await roomFiles()).toEqual([]);
    } finally {
      fsHooks.writeFile = null;
      fsHooks.writeReached = () => {};
    }
  });

  // Regression: images already written stayed on disk and counted, with no URL for them.
  it("stores nothing if a later image in the batch can't be written", async () => {
    joinRoom();
    const part = (name: string) => `--${BOUNDARY}\r\nContent-Disposition: form-data; name="images"; filename="${name}"\r\nContent-Type: image/png\r\n\r\nimage-bytes\r\n`;
    let writes = 0;
    fsHooks.writeReached = () => {
      if (++writes === 2) fsHooks.writeFile = Promise.reject(new Error("disk full"));
    };
    try {
      const { req, response } = openUpload(SOCKET_ID);
      req.end(`${part("a.png")}${part("b.png")}--${BOUNDARY}--\r\n`);

      expect((await response).status).toBe(500);
      await vi.waitFor(() => expect(room.imageBytes).toBe(0));
      expect(room.imageSizes.size).toBe(0);
      expect(await roomFiles()).toEqual([]);
    } finally {
      fsHooks.writeFile = null;
      fsHooks.writeReached = () => {};
    }
  });

  describe("when encoding makes an image larger than its upload", () => {
    const body = multipartBody(100);
    const upload = () => {
      const { req, response } = openUpload(SOCKET_ID, newClient());
      req.end(body);
      return response;
    };
    afterEach(() => {
      fsHooks.encoded = null;
    });

    it("counts the size actually stored", async () => {
      joinRoom();
      fsHooks.encoded = Buffer.alloc(body.length + 500, 1);

      expect((await upload()).status).toBe(200);
      await vi.waitFor(() => expect(room.imageBytes).toBe(fsHooks.encoded!.length));
    });

    // Regression: only the upload's size was checked, so the quota could be passed.
    it("refuses what no longer fits the room's quota, storing nothing", async () => {
      const others = MAX_ROOM_IMAGE_BYTES - body.length - 10;
      joinRoom(others);
      fsHooks.encoded = Buffer.alloc(body.length + 11, 1);

      expect((await upload()).status).toBe(413);
      await vi.waitFor(() => expect(room.imageBytes).toBe(others));
      expect(await roomFiles()).toEqual([]);
    });

    // Regression: encoded images were held in memory that no budget counted.
    it("refuses what no longer fits the memory budget, storing nothing", async () => {
      joinRoom();
      const res = fakeResponse();
      expect(holdImageMemory(res).take(MAX_INFLIGHT_IMAGE_BYTES - body.length - 10)).toBe(true);
      fsHooks.encoded = Buffer.alloc(body.length + 1024, 1);
      try {
        expect((await upload()).status).toBe(503);
        await vi.waitFor(() => expect(room.imageBytes).toBe(0));
        expect(await roomFiles()).toEqual([]);
      } finally {
        res.emit("close");
      }
    });
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
    expect(res.headers.get("content-type")).toBe("image/webp");
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

  // Regression: a corrupted file answered 404 and logged nothing, like a missing one.
  it("answers 500 and logs without the message when a stored file can't be decrypted", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    room = createRoom("secret");
    addParticipant(room, SOCKET_ID, "Ana");
    const filename = await upload();
    const filePath = path.join(uploadsDir, room.id, filename);
    const stored = await readFile(filePath);
    stored[stored.length - 1] ^= 1; // fails the GCM authentication check
    await writeFile(filePath, stored);

    expect((await get(filename, await sessionCookie())).status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith("[images] read failed", { name: "Error", frames: expect.any(String) });
    errorSpy.mockRestore();
  });

  it("still answers 404 without logging when a stored file is gone", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    room = createRoom("secret");
    addParticipant(room, SOCKET_ID, "Ana");
    const filename = await upload();
    await rm(path.join(uploadsDir, room.id, filename));

    expect((await get(filename, await sessionCookie())).status).toBe(404);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("refuses a decrypting read while image memory is full, then serves it", async () => {
    room = createRoom("secret");
    addParticipant(room, SOCKET_ID, "Ana");
    const filename = await upload();
    const cookie = await sessionCookie();
    const imageRoom = room;

    // Other requests hold the whole budget.
    const hold = fillImageMemory();
    room = imageRoom;

    const busy = await get(filename, cookie);
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("1");

    hold.release();
    await vi.waitFor(async () => expect((await get(filename, cookie)).status).toBe(200));
  });

  /** Holds the whole image budget, as other requests would. */
  async function holdWholeBudget() {
    const hold = fillImageMemory();
    return [{ req: { destroy: hold.release } }];
  }

  /** A read that may never be answered, for the caller to abandon. */
  function openRead(filename: string, cookie: string, onClose?: () => void): ClientRequest {
    const req = request({ port, path: `/api/rooms/${room.id}/images/${filename}`, headers: { Cookie: cookie, ...newClient() } }, (res) => res.resume());
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
    addParticipant(room, SOCKET_ID, "Ana");
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
      addParticipant(room, SOCKET_ID, "Ana");
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
    addParticipant(room, SOCKET_ID, "Ana");

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
    addParticipant(room, SOCKET_ID, "Ana");
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
