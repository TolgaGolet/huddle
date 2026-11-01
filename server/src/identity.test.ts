import { describe, it, expect } from "vitest";
import { deriveUserId } from "./identity.js";

describe("deriveUserId", () => {
  const key = "secret-client-key-0123456789";

  it("is stable for the same key and room", () => {
    expect(deriveUserId("room1", key)).toBe(deriveUserId("room1", key));
  });

  it("differs across rooms and keys", () => {
    expect(deriveUserId("room2", key)).not.toBe(deriveUserId("room1", key));
    expect(deriveUserId("room1", `${key}x`)).not.toBe(deriveUserId("room1", key));
  });

  it("does not expose the key", () => {
    expect(deriveUserId("room1", key)).not.toContain("secret");
  });
});
