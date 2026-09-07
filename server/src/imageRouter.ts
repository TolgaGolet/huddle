import { Router } from "express";
import multer from "multer";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { getRoom } from "./roomManager.js";
import { socketRoomMap } from "./signaling.js";
import { decryptFile, encryptFile } from "./imageCrypto.js";

export const uploadsDir = path.resolve(process.cwd(), "uploads");
const MAX_SIZE = 8 * 1024 * 1024;
const EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif"]);
// nanoid filenames may contain letters, digits, `_`, and `-`. Keep the
// complete filename constrained to this allowlist so path traversal remains
// impossible while every generated filename can be served.
const filenamePattern = /^[a-z0-9_-]{10}\.(jpg|jpeg|png|gif|webp|bmp|avif|heic|heif)$/;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE, files: 10 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(1).toLowerCase();
    cb(null, EXTENSIONS.has(ext) && (!file.mimetype || file.mimetype.startsWith("image/") || file.mimetype === "application/octet-stream"));
  },
});

function authorized(roomId: string, socketId: string | undefined): boolean {
  return !!socketId && socketRoomMap.get(socketId) === roomId && !!getRoom(roomId)?.participants.has(socketId);
}

function socketId(req: { headers: Record<string, string | string[] | undefined>; query: Record<string, unknown> }): string | undefined {
  const header = req.headers["x-socket-id"];
  return (Array.isArray(header) ? header[0] : header) || (typeof req.query.socketId === "string" ? req.query.socketId : undefined);
}

export const imageRouter = Router();

imageRouter.post("/rooms/:id/images", upload.array("images", 10), async (req, res) => {
  const roomId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const room = getRoom(roomId);
  if (!room || !authorized(roomId, socketId(req))) {
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
    const urls: string[] = [];
    for (const file of files) {
      const ext = path.extname(file.originalname).slice(1).toLowerCase();
      if (!EXTENSIONS.has(ext)) continue;
      const filename = `${nanoid(10).toLowerCase()}.${ext}`;
      const body = room.password && room.encryptionSalt
        ? encryptFile(file.buffer, room.password, room.encryptionSalt)
        : file.buffer;
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
  const room = getRoom(roomId);
  if (!room || !filenamePattern.test(filename) || !authorized(roomId, socketId(req))) {
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
    if (room.password && room.encryptionSalt) body = decryptFile(body, room.password, room.encryptionSalt);
    const ext = path.extname(filename).slice(1);
    const contentType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "heic" || ext === "heif" ? "image/heic" : `image/${ext}`;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(body);
  } catch {
    res.status(404).end();
  }
});

export async function deleteRoomImages(roomId: string): Promise<void> {
  await rm(path.join(uploadsDir, roomId), { recursive: true, force: true });
}

export async function clearStaleImages(): Promise<void> {
  // Rooms are held only in memory, so every file from a previous process is
  // stale. Remove the directory itself and recreate it before accepting any
  // connections, rather than relying on a best-effort per-entry cleanup.
  await rm(uploadsDir, { recursive: true, force: true });
  await mkdir(uploadsDir, { recursive: true });
}