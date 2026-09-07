import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

const ITERATIONS = 120_000;

export function deriveRoomKey(password: string, salt: string): Buffer {
  return pbkdf2Sync(password, Buffer.from(salt, "base64url"), ITERATIONS, 32, "sha256");
}

export function encryptFile(data: Buffer, password: string, salt: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveRoomKey(password, salt), iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([Buffer.from("HIMG1"), iv, cipher.getAuthTag(), encrypted]);
}

export function decryptFile(data: Buffer, password: string, salt: string): Buffer {
  if (data.subarray(0, 5).toString() !== "HIMG1") return data;
  const iv = data.subarray(5, 17);
  const tag = data.subarray(17, 33);
  const decipher = createDecipheriv("aes-256-gcm", deriveRoomKey(password, salt), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(33)), decipher.final()]);
}