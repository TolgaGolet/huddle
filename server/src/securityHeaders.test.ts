import { describe, it, expect, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { isDevelopment } from "./env.js";
import { securityHeaders } from "./securityHeaders.js";

describe("securityHeaders", () => {
  it("forbids framing and foreign scripts, and calls next", () => {
    const set = vi.fn();
    const next = vi.fn();

    void securityHeaders({} as Request, { set } as unknown as Response, next as NextFunction);

    const headers = set.mock.calls[0][0] as Record<string, string>;
    // Regression: 'unsafe-eval' was only there for heic2any, which is gone.
    expect(headers["Content-Security-Policy"]).toContain("script-src 'self';");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(next).toHaveBeenCalledOnce();
  });
});

// Regression: an unset NODE_ENV dropped the image cookie's Secure flag.
describe("isDevelopment", () => {
  it("is true only when explicitly set, so the default is the safe one", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isDevelopment()).toBe(true);
    vi.stubEnv("NODE_ENV", "");
    expect(isDevelopment()).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(isDevelopment()).toBe(false);
    vi.unstubAllEnvs();
  });
});
