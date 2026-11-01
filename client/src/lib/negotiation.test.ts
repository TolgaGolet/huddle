import { describe, it, expect } from "vitest";
import { isPoliteFor, resolveInboundOffer } from "./negotiation";

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

describe("resolveInboundOffer", () => {
  it("accepts an offer when there is no collision, whatever the role", () => {
    for (const isPolite of [true, false]) {
      expect(resolveInboundOffer({ isPolite, makingOffer: false, signalingState: "stable" })).toBe("accept");
    }
  });

  it("treats making an offer and a non-stable state each as a collision", () => {
    const collisions = [
      { makingOffer: true, signalingState: "stable" },
      { makingOffer: false, signalingState: "have-local-offer" },
      { makingOffer: true, signalingState: "have-local-offer" },
    ] as const;
    for (const c of collisions) {
      expect(resolveInboundOffer({ isPolite: true, ...c })).toBe("rollback");
      expect(resolveInboundOffer({ isPolite: false, ...c })).toBe("ignore");
    }
  });
});
