import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { connectionOriginRefusal, isAllowedOrigin, requireOwnOrigin } from "./originCheck.js";

const request = (headers: Record<string, string>, method = "POST") => ({ headers, method }) as unknown as IncomingMessage & Request;

afterEach(() => vi.unstubAllEnvs());

describe("isAllowedOrigin", () => {
  it("allows our own pages, whatever the domain", () => {
    expect(isAllowedOrigin(request({ origin: "https://huddle.example", host: "huddle.example" }))).toBe(true);
    expect(isAllowedOrigin(request({ origin: "https://huddle.example", host: "HUDDLE.example" }))).toBe(true);
    expect(isAllowedOrigin(request({ origin: "https://huddle.example", host: "internal:10000", "x-forwarded-host": "huddle.example" }))).toBe(true);
  });

  // Regression: `cors: false` looked like protection, but doesn't cover WebSockets.
  it("refuses other websites", () => {
    expect(isAllowedOrigin(request({ origin: "https://evil.example", host: "huddle.example" }))).toBe(false);
    expect(isAllowedOrigin(request({ origin: "null", host: "huddle.example" }))).toBe(false);
    expect(isAllowedOrigin(request({ origin: "https://huddle.example.evil.example", host: "huddle.example" }))).toBe(false);
  });

  it("allows a request with no Origin, which isn't from a browser", () => {
    expect(isAllowedOrigin(request({ host: "huddle.example" }))).toBe(true);
  });

  it("allows PUBLIC_ORIGIN, for a proxy that rewrites the Host headers", () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://huddle.example");
    expect(isAllowedOrigin(request({ origin: "https://huddle.example", host: "internal" }))).toBe(true);
  });

  it("allows the Vite dev server only in development", () => {
    const dev = request({ origin: "http://localhost:4173", host: "localhost:3001" });
    expect(isAllowedOrigin(dev)).toBe(false);
    vi.stubEnv("NODE_ENV", "development");
    expect(isAllowedOrigin(dev)).toBe(true);
  });
});

describe("requireOwnOrigin", () => {
  function call(req: Request) {
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    const next = vi.fn();
    void requireOwnOrigin(req, res as unknown as Response, next as NextFunction);
    return { res, next };
  }

  it("answers 403 to a cross-site POST", () => {
    const { res, next } = call(request({ origin: "https://evil.example", host: "huddle.example" }));
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("leaves reads alone, as a cross-site page can't see the answer", () => {
    expect(call(request({ origin: "https://evil.example", host: "huddle.example" }, "GET")).next).toHaveBeenCalledOnce();
  });
});

describe("connectionOriginRefusal", () => {
  it("refuses a cross-site WebSocket and allows our own", () => {
    expect(connectionOriginRefusal(request({ origin: "https://evil.example", host: "huddle.example" }))).toEqual(expect.any(String));
    expect(connectionOriginRefusal(request({ origin: "https://huddle.example", host: "huddle.example" }))).toBeNull();
  });
});
