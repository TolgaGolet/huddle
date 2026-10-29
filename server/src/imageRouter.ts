import { Router } from "express";
import multer from "multer";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { resolveParticipant } from "./roomManager.js";
import { decryptFile, encryptFile, roomImageKey } from "./imageCrypto.js";
import { MAX_IMAGE_SIZE, MAX_IMAGES_PER_MESSAGE } from "./limits.js";
import { errorSummary } from "./errorLog.js";

export const uploadsDir = path.resolve(process.cwd(), "uploads");
const EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif"]);
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
    cb(null, EXTENSIONS.has(ext) && (!file.mimetype || file.mimetype.startsWith("image/") || file.mimetype === "application/octet-stream"));
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

export const imageRouter = Router();

imageRouter.post("/rooms/:id/images", upload.array("images", MAX_IMAGES_PER_MESSAGE), async (req, res) => {
  const roomId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const room = authorizedRoom(roomId, socketId(req));
  if (!room) {
    res.status(403).json({ error: "Not authorized for this room" });
    return;
  }
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
      if (!EXTENSIONS.has(ext)) continue;
      const filename = `${nanoid(10).toLowerCase()}.${ext}`;
      const body = key ? encryptFile(file.buffer, key) : file.buffer;
      await writeFile(path.join(roomDir, filename), body, { flag: "wx" });
      urls.push(`/api/rooms/${roomId}/images/${filename}`);
    }
    res.json({ urls });
  } catch {
    res.status(500).json({ error: "Failed to store images" });
  }
});

imageRouter.get("/rooms/:id/images/:filename", async (req, res) => {
  const roomId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
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