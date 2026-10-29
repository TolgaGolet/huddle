import { describe, it, expect } from "vitest";
import { decryptFile, deriveRoomKey, encryptFile, roomImageKey } from "./imageCrypto.js";
import { createRoom } from "./roomManager.js";

describe("image encryption", () => {
  const plain = Buffer.from("fake image bytes");

  it("round-trips with the room key", async () => {
    const key = (await roomImageKey(createRoom("pw")))!;
    const enc = encryptFile(plain, key);
    expect(enc.subarray(0, 5).toString()).toBe("HIMG1");
    expect(enc.includes(plain)).toBe(false);
    expect(decryptFile(enc, key)).toEqual(plain);
  });

  it("rejects another room's key", async () => {
    const enc = encryptFile(plain, (await roomImageKey(createRoom("pw")))!);
    const otherKey = (await roomImageKey(createRoom("pw")))!; // same password, different salt
    expect(() => decryptFile(enc, otherKey)).toThrow();
  });

  it("passes unencrypted data through", async () => {
    const key = (await roomImageKey(createRoom("pw")))!;
    expect(decryptFile(plain, key)).toEqual(plain);
  });
});

describe("roomImageKey", () => {
  it("is null for rooms without a password", () => {
    expect(roomImageKey(createRoom())).toBeNull();
  });

  // Regression (Q-03): the key was re-derived with synchronous PBKDF2 on every
  // image request, blocking the event loop. It is now derived once per room.
  it("derives the key once and shares it across requests", async () => {
    const room = createRoom("pw");
    const first = roomImageKey(room);
    expect(roomImageKey(room)).toBe(first);
    expect(await first).toEqual(await deriveRoomKey("pw", room.encryptionSalt!));
  });
});
