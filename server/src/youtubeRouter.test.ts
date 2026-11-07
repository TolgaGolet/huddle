import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Room } from "./roomManager.js";

const realFetch = globalThis.fetch;
const searchBody = {
  items: [
    { id: { videoId: "dQw4w9WgXcQ" }, snippet: { title: "Rick &amp; Roll&#39;s &quot;Song&quot;", channelTitle: "Rick", liveBroadcastContent: "none" } },
    { id: { videoId: "liveLiveLiv" }, snippet: { title: "A stream", channelTitle: "Live", liveBroadcastContent: "live" } },
  ],
};
const videosBody = { items: [{ id: "dQw4w9WgXcQ", contentDetails: { duration: "PT3M33S" } }] };

let server: Server;
let baseUrl: string;
let upstream: ReturnType<typeof vi.fn>;
let token: string;
let room: Room;

function respond(url: string): Response {
  if (url.includes("/youtube/v3/search")) return new Response(JSON.stringify(searchBody));
  if (url.includes("/youtube/v3/videos")) return new Response(JSON.stringify(videosBody));
  return new Response("not found", { status: 404 });
}

function quotaExceeded(): Response {
  return new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: "quotaExceeded" }] } }), { status: 403 });
}

/** Puts socket-1 in a party, as its host (allowed to control it) or as a guest. */
function inParty(asHost: boolean): void {
  room.watchParties.set("party", {
    id: "party",
    hostId: asHost ? "socket-1" : "someone-else",
    allowOthersToChange: false,
    videoId: "dQw4w9WgXcQ",
    entryId: "entry",
    title: null,
    members: new Map([
      ["socket-0", "someone-else"],
      ["socket-1", "socket-1"],
    ]),
    playback: { state: "playing", position: 0, rate: 1 },
    updatedAt: Date.now(),
    queue: [],
    endedBy: new Set<string>(),
  });
}

beforeEach(async () => {
  // The cache and budget live in youtubeData.ts, so each test imports a fresh copy.
  vi.resetModules();
  const { youtubeRouter } = await import("./youtubeRouter.js");
  const { addParticipant, createRoom, httpTokenFor } = await import("./roomManager.js");
  room = createRoom();
  addParticipant(room, "socket-0", "Host", "someone-else");
  addParticipant(room, "socket-1", "Ana");
  token = httpTokenFor("socket-1")!;
  vi.stubEnv("YOUTUBE_API_KEY", "test-key");
  upstream = vi.fn(async (url: string) => respond(url));
  vi.stubGlobal("fetch", upstream);

  const app = express();
  app.use("/api/youtube", youtubeRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}/api/youtube`;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const search = (q: string, headers: Record<string, string> = { "X-Participant-Token": token }) =>
  realFetch(`${baseUrl}/search?q=${encodeURIComponent(q)}`, { headers });

describe("youtubeRouter", () => {
  it("returns embeddable videos with decoded titles and durations, never streams", async () => {
    inParty(true);
    const res = await search("rick");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [{ videoId: "dQw4w9WgXcQ", title: `Rick & Roll's "Song"`, channel: "Rick", durationS: 213 }],
    });
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("videoEmbeddable=true");
    expect(url).toContain("key=test-key");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses anyone who isn't in a party they may control", async () => {
    expect((await search("rick", {})).status).toBe(403);
    expect((await search("rick")).status).toBe(403);
    inParty(false);
    const res = await search("rick");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "not-permitted" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects an empty or overlong query", async () => {
    inParty(true);
    expect((await search("  ")).status).toBe(400);
    expect((await search("x".repeat(101))).status).toBe(400);
  });

  it("serves a repeat search from the cache, whatever its case and spacing", async () => {
    inParty(true);
    await search("rick");
    await search(" Rick ");
    // One search and one durations call.
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("answers search-unavailable without a key", async () => {
    inParty(true);
    vi.stubEnv("YOUTUBE_API_KEY", "");
    const res = await search("rick");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "search-unavailable" });
  });

  it("answers search-unavailable once the daily budget is spent", async () => {
    inParty(true);
    vi.stubEnv("YOUTUBE_DAILY_SEARCH_LIMIT", "1");
    expect((await search("one")).status).toBe(200);
    const res = await search("two");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "search-unavailable" });
  });

  it("stops calling YouTube after it reports the quota used up", async () => {
    inParty(true);
    upstream.mockImplementationOnce(async () => quotaExceeded());
    const first = await search("one");
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ code: "search-unavailable" });

    expect((await search("two")).status).toBe(503);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("answers search-failed for other upstream errors, without caching them", async () => {
    inParty(true);
    upstream.mockImplementationOnce(async () => new Response("{}", { status: 500 }));
    const res = await search("rick");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "search-failed" });
    expect((await search("rick")).status).toBe(200);
  });

  it("keeps the results when the durations call fails", async () => {
    inParty(true);
    upstream.mockImplementation(async (url: string) =>
      url.includes("/videos") ? new Response("{}", { status: 500 }) : respond(url),
    );
    const body = (await (await search("rick")).json()) as { data: { durationS: number | null }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].durationS).toBeNull();
  });
});

describe("youtubeData", () => {
  it("parses ISO durations and decodes entities", async () => {
    const { parseIsoDuration, decodeEntities } = await import("./youtubeData.js");
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("P0D")).toBeNull();
    expect(parseIsoDuration("nonsense")).toBeNull();
    expect(decodeEntities("a &amp; b &#x41; &#65; &unknown;")).toBe("a & b A A &unknown;");
  });

  it("looks titles up through oEmbed, remembering ones YouTube won't give", async () => {
    const { lookupVideoTitle } = await import("./youtubeData.js");
    upstream.mockImplementation(async (url: string) =>
      url.includes("v%3DdQw4w9WgXcQ") ? new Response(JSON.stringify({ title: "Rick" })) : new Response("Unauthorized", { status: 401 }),
    );
    expect(await lookupVideoTitle("dQw4w9WgXcQ")).toBe("Rick");
    expect(await lookupVideoTitle("privatePriv")).toBeNull();
    expect(await lookupVideoTitle("privatePriv")).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("never rejects when the lookup fails", async () => {
    const { lookupVideoTitle } = await import("./youtubeData.js");
    upstream.mockRejectedValue(new TypeError("network down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(lookupVideoTitle("dQw4w9WgXcQ")).resolves.toBeNull();
  });
});
