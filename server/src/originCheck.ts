import type { IncomingMessage } from "node:http";
import type { RequestHandler } from "express";
import { isDevelopment } from "./env.js";
import { countSecurityEvent } from "./securityLog.js";

export const DEV_CLIENT_ORIGIN = "http://localhost:4173";

/**
 * Whether a browser request comes from our own pages. CORS doesn't cover
 * WebSockets or simple POSTs, so without this any website could spend its
 * visitors' per-IP allowances here. A missing Origin isn't a browser, which this
 * can't stop anyway. A page can't set either Host header on these requests.
 * Set PUBLIC_ORIGIN if a proxy in front rewrites both.
 */
export function isAllowedOrigin(req: IncomingMessage): boolean {
  const { origin, host } = req.headers;
  if (!origin) return true;
  if (origin === process.env.PUBLIC_ORIGIN) return true;
  if (isDevelopment() && origin === DEV_CLIENT_ORIGIN) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false; // Includes "null", from sandboxed frames and file pages.
  }
  const forwardedHost = req.headers["x-forwarded-host"];
  const forwarded = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)?.split(",")[0].trim();
  return originHost === host?.toLowerCase() || originHost === forwarded?.toLowerCase();
}

/** For requests that change something; a cross-site GET can't read the answer. */
export const requireOwnOrigin: RequestHandler = (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || isAllowedOrigin(req)) {
    next();
    return;
  }
  countSecurityEvent("origin_refused");
  res.status(403).json({ error: "Request refused" });
};

/** For Socket.IO's `allowRequest` (see connectionRateLimit). Why it's refused, or null. */
export function connectionOriginRefusal(req: IncomingMessage): string | null {
  if (isAllowedOrigin(req)) return null;
  countSecurityEvent("origin_refused");
  return "Origin not allowed";
}
