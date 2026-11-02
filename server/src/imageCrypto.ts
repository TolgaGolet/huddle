import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { getParticipantsArray, type Room } from "./roomManager.js";

const ITERATIONS = 120_000;
const pbkdf2Async = promisify(pbkdf2);

/** Async (libuv thread pool) so the 120k-iteration derivation never blocks the event loop. */
export function deriveRoomKey(password: string, salt: string): Promise<Buffer> {
  return pbkdf2Async(password, Buffer.from(salt, "base64url"), ITERATIONS, 32, "sha256");
}

/**
 * Per-room AES key, derived once and cached on the room (so it goes away with
 * it); null for rooms without a password. The promise itself is cached so
 * concurrent image requests share a single derivation.
 */
export function roomImageKey(room: Room): Promise<Buffer> | null {
  // Before the password check: images stored so far need this key after a change.
  if (room.imageKey) return room.imageKey;
  if (!room.password || !room.encryptionSalt) return null;
  room.imageKey ??= deriveRoomKey(room.password, room.encryptionSalt).catch((err: unknown) => {
    room.imageKey = null; // let the next request retry
    throw err;
  });
  return room.imageKey;
}

/**
 * Changes the password, which never re-encrypts anything: a room keeps its first
 * key, and one that had no password starts encrypting from now on (decryptFile
 * passes older plain files through). Those outside the room need the new password.
 */
export async function setRoomPassword(room: Room, password: string): Promise<void> {
  await roomImageKey(room);
  if (password && !room.encryptionSalt) room.encryptionSalt = randomBytes(16).toString("base64url");
  room.password = password || null;
  room.memberIds = new Set(getParticipantsArray(room).map((p) => p.userId));
}

export function encryptFile(data: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([Buffer.from("HIMG1"), iv, cipher.getAuthTag(), encrypted]);
}

export function decryptFile(data: Buffer, key: Buffer): Buffer {
  if (data.subarray(0, 5).toString() !== "HIMG1") return data;
  const iv = data.subarray(5, 17);
  const tag = data.subarray(17, 33);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(33)), decipher.final()]);
}
