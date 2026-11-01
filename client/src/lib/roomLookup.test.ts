import { describe, it, expect, vi, afterEach } from "vitest";
import { lookupRoom } from "./roomLookup";

afterEach(() => vi.unstubAllGlobals());

function respondWith(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
}

describe("lookupRoom", () => {
  it("returns the room info, including for a room that doesn't exist", async () => {
    const info = { exists: false, hasPassword: false, participantCount: 0, maxParticipants: 6 };
    respondWith(200, info);
    await expect(lookupRoom("r")).resolves.toEqual(info);
  });

  it("encodes the room id, which is typed by the user", async () => {
    respondWith(200, {});
    await lookupRoom("a/b?c");
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/rooms/a%2Fb%3Fc");
  });

  it("reports a rate limit as an error rather than a missing room", async () => {
    respondWith(429, { error: "Too many requests, please try again shortly" });
    await expect(lookupRoom("r")).resolves.toEqual({ error: "Too many requests, please try again shortly" });
  });

  it("falls back to a generic error when the response has none", async () => {
    respondWith(500, {});
    await expect(lookupRoom("r")).resolves.toEqual({ error: "Failed to connect. Please try again." });
  });
});
