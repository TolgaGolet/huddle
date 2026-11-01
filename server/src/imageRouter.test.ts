import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request, type ClientRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "express";
import { deleteRoomImages, imageRouter, releaseMessageImages, uploadsDir } from "./imageRouter.js";
import { MAX_IMAGE_SIZE, MAX_IMAGES_PER_MESSAGE, MAX_INFLIGHT_UPLOAD_BYTES, MAX_ROOM_IMAGE_BYTES } from "./limits.js";
import { addParticipant, createRoom, emptyReactions, removeParticipant, type ChatMessage, type Room } from "./roomManager.js";

const BOUNDARY = "huddletestboundary";
const SOCKET_ID = "test-socket";

let server: Server;
let port: number;
let room: Room;
const openRequests: ClientRequest[] = [];

beforeAll(async () => {
  const app = express();
  app.use("/api", imageRouter);
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
        headers: { "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`, "X-Socket-Id": socketId, ...headers },
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

    req.destroy();

    await vi.waitFor(() => expect(room.imageBytes).toBe(0));
  });

  it("caps upload bytes held in memory across all rooms", async () => {
    const declared = MAX_IMAGE_SIZE * MAX_IMAGES_PER_MESSAGE;
    const fits = Math.floor(MAX_INFLIGHT_UPLOAD_BYTES / declared);
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

  const get = (filename: string, socketId = SOCKET_ID) =>
    fetch(`http://localhost:${port}/api/rooms/${room.id}/images/${filename}?socketId=${socketId}`);

  async function upload(): Promise<string> {
    const { req, response } = openUpload(SOCKET_ID);
    req.end(multipartBody(IMAGE_BYTES));
    const { urls } = JSON.parse((await response).body) as { urls: string[] };
    return path.basename(urls[0]);
  }

  it("serves an image to a member only", async () => {
    joinRoom();
    const filename = await upload();

    const res = await get(filename);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(image)).toBe(true);

    expect((await get(filename, "not-a-member")).status).toBe(404);
  });

  it("refuses a filename outside the allowlist even if the file exists", async () => {
    joinRoom();
    await mkdir(path.join(uploadsDir, room.id), { recursive: true });
    await writeFile(path.join(uploadsDir, room.id, "aaaaaaaaaa.html"), "<script></script>");

    expect((await get("aaaaaaaaaa.html")).status).toBe(404);
  });

  it("encrypts a password-protected room's image at rest and decrypts it on read", async () => {
    room = createRoom("secret");
    addParticipant(room.id, SOCKET_ID, "Ana");
    const filename = await upload();

    const onDisk = await readFile(path.join(uploadsDir, room.id, filename));
    expect(onDisk.includes(image)).toBe(false);

    const res = await get(filename);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(image)).toBe(true);
  });
});
