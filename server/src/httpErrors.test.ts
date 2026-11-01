import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { apiNotFound, httpErrorHandler } from "./httpErrors.js";

const SECRET = "secret-in-the-body";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.post("/api/echo", (_req, res) => {
    res.status(204).end();
  });
  app.get("/api/boom", () => {
    throw new Error(SECRET);
  });
  app.use("/api", apiNotFound);
  app.get("/page", (_req, res) => {
    res.send("<html></html>");
  });
  app.use(httpErrorHandler);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const logged = (spy: { mock: { calls: unknown[][] } }) => JSON.stringify(spy.mock.calls);

// Regression (F08): the default handler quoted the request body into the log.
describe("httpErrorHandler", () => {
  it("answers a malformed JSON body in JSON, without logging or echoing it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await fetch(`${base}/api/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: SECRET,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Request failed" });
    expect(log).not.toHaveBeenCalled();
  });

  it("answers a body over the parser's limit as too large", async () => {
    const res = await fetch(`${base}/api/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "a".repeat(200 * 1024) }),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request is too large" });
  });

  it("logs an unexpected error without its message and replies with fixed text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await fetch(`${base}/api/boom`);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Request failed" });
    expect(log).toHaveBeenCalledOnce();
    expect(logged(log)).not.toContain(SECRET);
  });
});

// Regression (F08): unknown API paths fell through to the SPA with a 200.
describe("apiNotFound", () => {
  it("answers an unknown API path with a JSON 404 and leaves other paths alone", async () => {
    const res = await fetch(`${base}/api/nothing`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });

    expect((await fetch(`${base}/page`)).status).toBe(200);
  });
});
