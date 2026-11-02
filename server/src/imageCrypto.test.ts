import { describe, it, expect } from "vitest";
import { decryptFile, deriveRoomKey, encryptFile, roomImageKey, setRoomPassword } from "./imageCrypto.js";
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

describe("setRoomPassword", () => {
  const image = Buffer.from("image bytes");

  it("keeps images readable when a password changes", async () => {
    const room = createRoom("first-password");
    const stored = encryptFile(image, (await roomImageKey(room))!);

    await setRoomPassword(room, "second-password");

    expect(room.password).toBe("second-password");
    expect(decryptFile(stored, (await roomImageKey(room))!)).toEqual(image);
  });

  it("keeps images readable when a password that was never used for one changes", async () => {
    const room = createRoom("first-password");

    await setRoomPassword(room, "second-password");

    const stored = encryptFile(image, (await roomImageKey(room))!);
    await setRoomPassword(room, "third-password");
    expect(decryptFile(stored, (await roomImageKey(room))!)).toEqual(image);
  });

  it("keeps them readable when the password is removed, and encrypting from then on", async () => {
    const room = createRoom("first-password");
    const stored = encryptFile(image, (await roomImageKey(room))!);

    await setRoomPassword(room, "");

    expect(room.password).toBeNull();
    expect(decryptFile(stored, (await roomImageKey(room))!)).toEqual(image);
  });

  it("starts encrypting when an open room gets a password, still reading older plain files", async () => {
    const room = createRoom();
    expect(roomImageKey(room)).toBeNull();

    await setRoomPassword(room, "first-password");

    const key = (await roomImageKey(room))!;
    expect(decryptFile(image, key)).toEqual(image);
    expect(decryptFile(encryptFile(image, key), key)).toEqual(image);
  });
});
