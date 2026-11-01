import { Router, type Request, type RequestHandler, type Response } from "express";
import multer from "multer";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { resolveParticipant, type ChatEntry, type Room } from "./roomManager.js";
import { decryptFile, encryptFile, roomImageKey } from "./imageCrypto.js";
import { IMAGE_EXTENSIONS, isAllowedImage, MAX_IMAGE_SIZE, MAX_IMAGES_PER_MESSAGE, MAX_INFLIGHT_UPLOAD_BYTES, MAX_ROOM_IMAGE_BYTES } from "./limits.js";
import { errorSummary } from "./errorLog.js";

export const uploadsDir = path.resolve(process.cwd(), "uploads");
// nanoid filenames may contain letters, digits, `_`, and `-`. Keep the
// complete filename constrained to this allowlist so path traversal remains
// impossible while every generated filename can be served.
const filenamePattern = /^[a-z0-9_-]{10}\.(jpg|jpeg|png|gif|webp|bmp|avif|heic|heif)$/;

/** True if `url` is the served path of an image uploaded to this room. */
export function isRoomImageUrl(roomId: string, url: string): boolean {
  const prefix = `/api/rooms/${roomId}/images/`;
  return url.startsWith(prefix) && filenamePattern.test(url.slice(prefix.length));
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_SIZE, files: MAX_IMAGES_PER_MESSAGE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(1).toLowerCase();
    cb(null, isAllowedImage(ext, file.mimetype));
  },
});

/** The requester's room, if their socket is a participant of `roomId`. */
function authorizedRoom(roomId: string, socketId: string | undefined) {
  const ctx = socketId ? resolveParticipant(socketId) : null;
  return ctx?.roomId === roomId ? ctx.room : undefined;
}

function socketId(req: { headers: Record<string, string | string[] | undefined>; query: Record<string, unknown> }): string | undefined {
  const header = req.headers["x-socket-id"];
  return (Array.isArray(header) ? header[0] : header) || (typeof req.query.socketId === "string" ? req.query.socketId : undefined);
}

function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

/** The requester's room, or undefined after sending the 403. */
function requireRoom(req: Request, res: Response) {
  const room = authorizedRoom(param(req.params.id), socketId(req));
  if (!room) res.status(403).json({ error: "Not authorized for this room" });
  return room;
}

const QUOTA_ERROR = "This room has reached its image storage limit";
/** Room for the multipart boundaries and part headers around the files. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_UPLOAD_BYTES = MAX_IMAGE_SIZE * MAX_IMAGES_PER_MESSAGE + MULTIPART_OVERHEAD_BYTES;

let inFlightUploadBytes = 0;

/**
 * Rejects before multer reads the body, so a request that will be refused never
 * gets buffered. Node stops reading at Content-Length, so reserving it bounds
 * what concurrent uploads can buffer and exceeds what they can store. When the
 * response closes, however it ended, only the bytes actually stored stay counted.
 */
const rejectEarly: RequestHandler = (req, res, next) => {
  const room = requireRoom(req, res);
  if (!room) return;
  const declaredBytes = Number(req.headers["content-length"]);
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0) {
    res.status(411).json({ error: "Content-Length is required" });
    return;
  }
  if (declaredBytes > MAX_UPLOAD_BYTES) {
    res.status(413).json({ error: "Upload is too large" });
    return;
  }
  if (room.imageBytes + declaredBytes > MAX_ROOM_IMAGE_BYTES) {
    res.status(413).json({ error: QUOTA_ERROR });
    return;
  }
  if (inFlightUploadBytes + declaredBytes > MAX_INFLIGHT_UPLOAD_BYTES) {
    res.status(503).json({ error: "The server is busy, please try again" });
    return;
  }
  room.imageBytes += declaredBytes;
  inFlightUploadBytes += declaredBytes;
  res.locals.storedBytes = 0;
  res.once("close", () => {
    room.imageBytes -= declaredBytes - (res.locals.storedBytes as number);
    inFlightUploadBytes -= declaredBytes;
  });
  next();
};

export const imageRouter = Router();

imageRouter.post("/rooms/:id/images", rejectEarly, upload.array("images", MAX_IMAGES_PER_MESSAGE), async (req, res) => {
  // Checked again: a slow upload can outlast the sender's membership or the
  // room itself, and writing then would leave files no cleanup will remove.
  const room = requireRoom(req, res);
  if (!room) return;
  const roomId = param(req.params.id);
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) {
    res.status(400).json({ error: "No valid image files supplied" });
    return;
  }
  try {
    const roomDir = path.join(uploadsDir, roomId);
    await mkdir(roomDir, { recursive: true });
    const key = await roomImageKey(room);
    const urls: string[] = [];
    for (const file of files) {
      const ext = path.extname(file.originalname).slice(1).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;
      const filename = `${nanoid(10).toLowerCase()}.${ext}`;
      const body = key ? encryptFile(file.buffer, key) : file.buffer;
      await writeFile(path.join(roomDir, filename), body, { flag: "wx" });
      room.imageSizes.set(filename, file.size);
      res.locals.storedBytes += file.size;
      urls.push(`/api/rooms/${roomId}/images/${filename}`);
    }
    res.json({ urls });
  } catch {
    res.status(500).json({ error: "Failed to store images" });
  }
});

imageRouter.get("/rooms/:id/images/:filename", async (req, res) => {
  const roomId = param(req.params.id);
  const filename = param(req.params.filename);
  const room = authorizedRoom(roomId, socketId(req));
  if (!room || !filenamePattern.test(filename)) {
    res.status(404).end();
    return;
  }
  const filePath = path.join(uploadsDir, roomId, filename);
  if (path.dirname(filePath) !== path.join(uploadsDir, roomId)) {
    res.status(404).end();
    return;
  }
  try {
    let body = await readFile(filePath);
    const key = await roomImageKey(room);
    if (key) body = decryptFile(body, key);
    const ext = path.extname(filename).slice(1);
    const contentType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "heic" || ext === "heif" ? "image/heic" : `image/${ext}`;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(body);
  } catch {
    res.status(404).end();
  }
});

/**
 * Deletes a removed message's images and frees their quota. Any member can post
 * an existing room image URL, so one still used by another message stays.
 */
export function releaseMessageImages(room: Room, entry: ChatEntry): void {
  if ("type" in entry || !entry.imageUrls) return;
  const stillUsed = new Set(room.chatHistory.flatMap((m) => ("type" in m ? [] : m.imageUrls ?? [])));
  for (const url of entry.imageUrls) {
    if (stillUsed.has(url)) continue;
    const filename = path.basename(url);
    const size = room.imageSizes.get(filename);
    if (size === undefined) continue;
    room.imageSizes.delete(filename);
    room.imageBytes -= size;
    rm(path.join(uploadsDir, room.id, filename), { force: true }).catch((err) => {
      console.error("[images] delete failed", errorSummary(err));
    });
  }
}

/** Best-effort cleanup: never rejects (callers fire and forget it). */
export async function deleteRoomImages(roomId: string): Promise<void> {
  try {
    await rm(path.join(uploadsDir, roomId), { recursive: true, force: true });
  } catch (err) {
    console.error("[images] cleanup failed", errorSummary(err));
  }
}

export async function clearStaleImages(): Promise<void> {
  // Rooms are held only in memory, so every file from a previous process is
  // stale. Remove the directory itself and recreate it before accepting any
  // connections, rather than relying on a best-effort per-entry cleanup.
  await rm(uploadsDir, { recursive: true, force: true });
  await mkdir(uploadsDir, { recursive: true });
}