import { describe, it, expect } from "vitest";
import { isPoliteFor } from "./negotiation";

// Regression (Q-01): the local id was captured before the socket connected, so
// `undefined > peerId` made every client impolite and offer collisions deadlocked.
describe("isPoliteFor", () => {
  const ids = ["Xk3_aB9cD0eFgHiJAAAB", "a1b2c3d4e5f6g7h8AAAC", "-zq8LmNoPqRsTuVwAAAD", "Zz00000000000000AAAE"];

  it("gives the two sides of every pair opposite roles", () => {
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        expect(isPoliteFor(a, b)).toBe(!isPoliteFor(b, a));
      }
    }
  });

  it("follows the new local id after a reconnect", () => {
    const peer = "m0000000000000000000";
    expect(isPoliteFor("a0000000000000000000", peer)).toBe(false);
    expect(isPoliteFor("z0000000000000000000", peer)).toBe(true);
  });
});
