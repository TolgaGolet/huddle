import { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from "express";
import multer from "multer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { isPollMessage } from "./protocol.js";
import { getRoom, hasPermission, totalImageBytes, type ChatEntry, type Room } from "./roomManager.js";
import { participantFromRequest } from "./participantRequest.js";
import { decryptFile, encryptFile, roomImageKey } from "./imageCrypto.js";
import { holdImageMemory, imageMemoryFits, reserveRoomImageBytes, tryReserveClientImageBytes, type ImageMemoryHold, type Reservation } from "./imageQuota.js";
import { requestIp } from "./ipRateLimit.js";
import { countSecurityEvent } from "./securityLog.js";
import { isAllowedImage, MAX_IMAGE_SIZE, MAX_IMAGES_PER_MESSAGE, MAX_ROOM_IMAGE_BYTES, MAX_ROOM_INFLIGHT_READ_BYTES, MAX_TOTAL_IMAGE_BYTES } from "./limits.js";
import { errorSummary } from "./errorLog.js";
import { processImage, UnreadableImageError } from "./imageProcessing.js";
import { isDevelopment } from "./env.js";

export const uploadsDir = process.env.HUDDLE_UPLOADS_DIR ?? path.resolve(process.cwd(), "uploads");
// nanoid filenames may contain letters, digits, `_`, and `-`. Keep the
// complete filename constrained to this allowlist so path traversal remains
// impossible while every generated filename can be served.
const filenamePattern = /^[a-z0-9_-]{10}\.webp$/;
const IMAGE_CONTENT_TYPE = "image/webp";
const NO_BYTES = Buffer.alloc(0);

function roomImagesPath(roomId: string): string {
  return `/api/rooms/${roomId}/images`;
}

/** True if `url` is the served path of an image uploaded to this room. */
export function isRoomImageUrl(roomId: string, url: string): boolean {
  const prefix = `${roomImagesPath(roomId)}/`;
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

function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

/** The requester's participant context in the route's room, or undefined after sending the 403. */
function requireParticipant(req: Request, res: Response) {
  const ctx = participantFromRequest(req);
  if (ctx?.roomId === param(req.params.id)) return ctx;
  res.status(403).json({ error: "Not authorized for this room" });
  return undefined;
}

/** A member who may also send messages, which images are part of. */
function requireSender(req: Request, res: Response) {
  const ctx = requireParticipant(req, res);
  if (!ctx) return undefined;
  if (hasPermission(ctx.room, "messagePermission", ctx.participant.userId)) return ctx;
  res.status(403).json({ error: "Only owners can send messages in this room" });
  return undefined;
}

// An <img> can't send headers, and a token in its URL would end up in access
// logs, so image reads are authorized by a cookie scoped to the room's images.
const IMAGE_COOKIE = "huddle_images";
const IMAGE_COOKIE_PATTERN = new RegExp(String.raw`(?:^|;\s*)${IMAGE_COOKIE}=([^;]+)`);
const IMAGE_SESSION_MS = 12 * 60 * 60 * 1000;
// Rooms don't survive a restart either, so neither need the sessions.
const imageSessionSecret = randomBytes(32);

function signImageSession(roomId: string, userId: string, expiry: string): Buffer {
  return createHmac("sha256", imageSessionSecret).update(`${roomId}.${userId}.${expiry}`).digest();
}

/** The room, if the request's cookie is valid and its user is still a participant. */
function roomFromImageCookie(req: Request, roomId: string): Room | undefined {
  const value = req.headers.cookie?.match(IMAGE_COOKIE_PATTERN)?.[1];
  const [userId, expiry, signature] = value?.split(".") ?? [];
  if (!signature || !(Number(expiry) > Date.now())) return undefined;
  const expected = signImageSession(roomId, userId, expiry);
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  const room = getRoom(roomId);
  if (!room) return undefined;
  // Checked on every read so that leaving the room ends access.
  return [...room.participants.values()].some((p) => p.userId === userId) ? room : undefined;
}

const QUOTA_ERROR = "This room has reached its image storage limit";
/** Room for the multipart boundaries and part headers around the files. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_UPLOAD_BYTES = MAX_IMAGE_SIZE * MAX_IMAGES_PER_MESSAGE + MULTIPART_OVERHEAD_BYTES;

/** Longer than an 8 MB image takes on a slow mobile link. */
export const IMAGE_READ_TIMEOUT_MS = 2 * 60 * 1000;

function refuseAsBusy(res: Response): void {
  countSecurityEvent("capacity_refused");
  res.status(503).json({ error: "The server is busy, please try again" });
}

/** Multer's errors: its limits, or a client that abandoned the upload (nobody to answer). */
const onUploadError: ErrorRequestHandler = (err, req, res, next) => {
  if (req.socket.destroyed) return;
  if (!(err instanceof multer.MulterError)) {
    next(err);
    return;
  }
  if (err.code === "LIMIT_FILE_SIZE") res.status(413).json({ error: "Image is too large" });
  else res.status(400).json({ error: "Request failed" });
};

/** Never rejects. */
async function removeWritten(roomDir: string, filenames: string[]): Promise<void> {
  await Promise.all(filenames.map((filename) => rm(path.join(roomDir, filename), { force: true }).catch((err) => {
    console.error("[images] delete failed", errorSummary(err));
  })));
}

/** Never rejects: the reservation's release waits for it (see rejectEarly). */
async function storeImages(room: Room, files: Express.Multer.File[], reservation: Reservation, memory: ImageMemoryHold, res: Response): Promise<void> {
  const roomDir = path.join(uploadsDir, room.id);
  const written: string[] = [];
  try {
    const key = await roomImageKey(room);
    // All before storing any, so that one bad file in a batch stores nothing.
    const images: Buffer[] = [];
    for (const file of files) {
      // Nobody will receive the result, and others are waiting for the encoder.
      if (res.closed) return;
      const image = await processImage(file.buffer);
      // Finished with, and the outputs are all held until the batch is done.
      memory.give(file.buffer.length);
      file.buffer = NO_BYTES;
      if (res.closed) return;
      if (!memory.take(image.length)) {
        refuseAsBusy(res);
        return;
      }
      images.push(image);
    }
    // Re-encoding can make an image larger than the size that was reserved.
    const totalBytes = images.reduce((sum, image) => sum + image.length, 0);
    const extraBytes = Math.max(0, totalBytes - reservation.reservedBytes());
    if (room.imageBytes + extraBytes > MAX_ROOM_IMAGE_BYTES) {
      res.status(413).json({ error: QUOTA_ERROR });
      return;
    }
    if (totalImageBytes() + extraBytes > MAX_TOTAL_IMAGE_BYTES) {
      refuseAsBusy(res);
      return;
    }
    reservation.grow(extraBytes);

    await mkdir(roomDir, { recursive: true });
    const stored = images.map((image) => ({ image, filename: `${nanoid(10).toLowerCase()}.webp` }));
    for (const { image, filename } of stored) {
      // Nobody will receive the URLs, so nothing could ever reference these files.
      if (res.closed) break;
      const body = key ? encryptFile(image, key) : image;
      written.push(filename);
      await writeFile(path.join(roomDir, filename), body, { flag: "wx" });
    }
    if (res.closed) {
      await removeWritten(roomDir, written);
      return;
    }
    // Only now: the batch counts as stored all together or not at all.
    for (const { image, filename } of stored) {
      room.imageSizes.set(filename, image.length);
      reservation.commit(image.length);
    }
    res.json({ urls: stored.map(({ filename }) => `${roomImagesPath(room.id)}/${filename}`) });
  } catch (err) {
    await removeWritten(roomDir, written);
    if (err instanceof UnreadableImageError) {
      if (!res.closed) res.status(400).json({ error: "Couldn't read that image. Please try a JPEG, PNG, WebP or GIF." });
      return;
    }
    console.error("[images] store failed", errorSummary(err));
    res.status(500).json({ error: "Failed to store images" });
  }
}

/** A file deleted during the read is normal; anything else is a real failure. */
function endFailedRead(res: Response, err: unknown): void {
  if (res.headersSent || res.closed) return;
  const { code, status } = err as { code?: string; status?: number };
  if (code === "ENOENT" || status === 404) {
    res.status(404).end();
    return;
  }
  console.error("[images] read failed", errorSummary(err));
  res.status(500).end();
}

/** How long an upload may send nothing before it is dropped, freeing what it holds. */
const UPLOAD_STALL_TIMEOUT_MS = 15_000;

export function createImageRouter(proxyHops = 0): Router {
  const router = Router();

  /**
   * Rejects before multer reads the body, so a request that will be refused never
   * gets buffered. Node stops reading at Content-Length, which bounds what an upload
   * can buffer and store, and is counted in full against the room's quota and the
   * sender's share. Memory is taken from the shared budget only as bytes arrive, so
   * stalling costs other rooms nothing. When the response closes, however it ended,
   * only the bytes actually stored stay counted, which is known only once any store
   * still running has finished.
   */
  const rejectEarly: RequestHandler = (req, res, next) => {
    const room = requireSender(req, res)?.room;
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
    if (
      totalImageBytes() + declaredBytes > MAX_TOTAL_IMAGE_BYTES ||
      !imageMemoryFits(declaredBytes) ||
      !tryReserveClientImageBytes(res, requestIp(req, proxyHops), declaredBytes)
    ) {
      refuseAsBusy(res);
      return;
    }
    const reservation = reserveRoomImageBytes(room, declaredBytes);
    res.locals.reservation = reservation;
    res.once("close", () => void reservation.release());

    const memory = holdImageMemory(res);
    res.locals.imageMemory = memory;
    const stall = setTimeout(() => {
      countSecurityEvent("upload_stalled");
      res.destroy();
    }, UPLOAD_STALL_TIMEOUT_MS);
    const onChunk = (chunk: Buffer) => {
      stall.refresh();
      if (memory.take(chunk.length)) return;
      // Other uploads filled the budget meanwhile.
      clearTimeout(stall);
      req.off("data", onChunk);
      // Discards the rest instead of destroying the request, which could lose this answer.
      req.unpipe();
      req.resume();
      res.setHeader("Connection", "close");
      refuseAsBusy(res);
    };
    req.on("data", onChunk);
    req.once("end", () => clearTimeout(stall));
    res.once("close", () => clearTimeout(stall));
    next();
  };

  router.post("/rooms/:id/images", rejectEarly, upload.array("images", MAX_IMAGES_PER_MESSAGE), async (req: Request, res: Response) => {
    // The client left as the body finished: the reservation is already released.
    if (res.closed) return;
    // Checked again: a slow upload can outlast the sender's membership, their
    // permission to send or the room itself, and writing then would leave
    // files no message will use, or that no cleanup will remove.
    const room = requireSender(req, res)?.room;
    if (!room) return;
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) {
      res.status(400).json({ error: "No valid image files supplied" });
      return;
    }
    // These are set by rejectEarly, which runs first on this route.
    const reservation = res.locals.reservation as Reservation;
    const storing = storeImages(room, files, reservation, res.locals.imageMemory as ImageMemoryHold, res);
    reservation.trackStore(storing);
    await storing;
  }, onUploadError);

  router.post("/rooms/:id/image-session", (req, res) => {
    const ctx = requireParticipant(req, res);
    if (!ctx) return;
    const { roomId } = ctx;
    const { userId } = ctx.participant;
    const expiry = String(Date.now() + IMAGE_SESSION_MS);
    const signature = signImageSession(roomId, userId, expiry).toString("base64url");
    res.cookie(IMAGE_COOKIE, `${userId}.${expiry}.${signature}`, {
      httpOnly: true,
      sameSite: "strict",
      secure: !isDevelopment(),
      path: roomImagesPath(roomId),
      maxAge: IMAGE_SESSION_MS,
    });
    res.status(204).end();
  });

  router.get("/rooms/:id/images/:filename", async (req, res) => {
    const roomId = param(req.params.id);
    const filename = param(req.params.filename);
    const room = roomFromImageCookie(req, roomId);
    if (!room || !filenamePattern.test(filename)) {
      res.status(404).end();
      return;
    }
    const roomDir = path.join(uploadsDir, roomId);
    const filePath = path.join(roomDir, filename);
    try {
      const key = await roomImageKey(room);
      if (!key) {
        // Streamed, with ETag and 304 from the file's metadata, so reads take no
        // memory budget. Revalidated rather than cached outright, so that leaving
        // the room or deleting the message also ends access to a cached copy.
        const headers = { "Content-Type": IMAGE_CONTENT_TYPE, "Cache-Control": "private, no-cache" };
        res.sendFile(filename, { root: roomDir, cacheControl: false, headers }, (err) => {
          if (err) endFailedRead(res, err);
        });
        return;
      }
      // The encrypted and decrypted copies are in memory together.
      const reservedBytes = (await stat(filePath)).size * 2;
      if (
        room.inFlightReadBytes + reservedBytes > MAX_ROOM_INFLIGHT_READ_BYTES ||
        !imageMemoryFits(reservedBytes) ||
        !tryReserveClientImageBytes(res, requestIp(req, proxyHops), reservedBytes)
      ) {
        res.setHeader("Retry-After", "1");
        refuseAsBusy(res);
        return;
      }
      holdImageMemory(res).take(reservedBytes);
      room.inFlightReadBytes += reservedBytes;
      // The reservation lasts until the client has it all, so one that stops
      // reading must not be able to hold it forever.
      const deadline = setTimeout(() => res.destroy(), IMAGE_READ_TIMEOUT_MS);
      res.once("close", () => {
        clearTimeout(deadline);
        room.inFlightReadBytes -= reservedBytes;
      });
      const body = decryptFile(await readFile(filePath), key);
      res.setHeader("Content-Type", IMAGE_CONTENT_TYPE);
      // These images stay out of the browser's disk cache, where they would be
      // stored decrypted.
      res.setHeader("Cache-Control", "private, no-store");
      // Not res.send: it would hash the whole image for an ETag no-store never uses.
      res.setHeader("Content-Length", body.length);
      res.end(body);
    } catch (err) {
      endFailedRead(res, err);
    }
  });

  return router;
}

/**
 * Deletes a removed message's images and frees their quota. Any member can post
 * an existing room image URL, so one still used by another message stays.
 */
export function releaseMessageImages(room: Room, entry: ChatEntry): void {
  if (isPollMessage(entry) || !entry.imageUrls) return;
  const stillUsed = new Set(room.chatHistory.flatMap((m) => (isPollMessage(m) ? [] : m.imageUrls ?? [])));
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