import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

const realFetch = globalThis.fetch;
const rendition = { url: "https://media.giphy.com/a.gif" };
const upstreamBody = { data: [{ id: "1", title: "Cat", images: { fixed_width: rendition, preview_gif: rendition } }] };

let server: Server;
let baseUrl: string;
let upstream: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  // The cache lives in the router module, so each test imports a fresh copy.
  vi.resetModules();
  const { giphyRouter } = await import("./giphyRouter.js");
  vi.stubEnv("GIPHY_API_KEY", "test-key");
  upstream = vi.fn(async () => new Response(JSON.stringify(upstreamBody)));
  vi.stubGlobal("fetch", upstream);

  const app = express();
  app.use("/api/giphy", giphyRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}/api/giphy`;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const get = (path: string) => realFetch(`${baseUrl}${path}`);

describe("giphyRouter", () => {
  it("returns mapped results and passes a timeout signal upstream", async () => {
    const res = await get("/trending");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: "1", title: "Cat", preview: rendition.url, url: rendition.url }] });
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/trending?api_key=test-key");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("serves repeat trending requests from the cache", async () => {
    await get("/trending");
    await get("/trending");

    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("shares a cache entry between searches differing only in case and spacing", async () => {
    await get("/search?q=cats");
    const res = await get(`/search?q=${encodeURIComponent(" Cats ")}`);

    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("caches different searches separately", async () => {
    await get("/search?q=cats");
    await get("/search?q=dogs");

    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("returns 502 on an upstream error status and does not cache it", async () => {
    upstream.mockResolvedValueOnce(new Response("{}", { status: 429 }));

    expect((await get("/trending")).status).toBe(502);
    expect((await get("/trending")).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("returns 502 when the upstream call times out", async () => {
    upstream.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));

    expect((await get("/trending")).status).toBe(502);
  });

  it("returns 502 when the upstream response has no data array", async () => {
    upstream.mockResolvedValueOnce(new Response("{}"));

    expect((await get("/trending")).status).toBe(502);
  });

  it("rejects a missing or repeated q parameter", async () => {
    expect((await get("/search")).status).toBe(400);
    expect((await get("/search?q=a&q=b")).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("reports a missing API key without calling upstream", async () => {
    vi.stubEnv("GIPHY_API_KEY", "");

    expect((await get("/trending")).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });
});
