import type { IncomingMessage } from "node:http";
import type { RequestHandler } from "express";
import { createBucket, type Bucket, type RateLimit } from "./rateLimit.js";

const SWEEP_INTERVAL_MS = 60_000;

const perMinute = (n: number): RateLimit => ({ burst: n, perSecond: n / 60 });

export const IP_LIMITS = {
  connections: perMinute(30),
  createRoom: perMinute(20),
  lookupRoom: perMinute(60),
  uploadImages: perMinute(30),
  imageSession: perMinute(60),
  giphy: perMinute(60),
  /** Wrong passwords per room and IP. Per socket would reset on every new connection. */
  passwordGuesses: perMinute(12),
};

/**
 * The client's IP. X-Forwarded-For is client-controlled except for the entries
 * our own proxies appended, so with `hops` trusted proxies only the entry
 * `hops` from the end is used, and with none the header is ignored. Otherwise
 * anyone could dodge a limit by sending a different header each time.
 */
export function clientIp(remoteAddress: string | undefined, forwardedFor: string | string[] | undefined, hops: number): string {
  const fallback = remoteAddress ?? "unknown";
  if (hops <= 0 || !forwardedFor) return fallback;
  const list = (Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor).split(",").map((s) => s.trim());
  return list[list.length - hops] || fallback;
}

// Proxies in front of a Render web service, confirmed on the live service on
// 2026-11-01 (client, Cloudflare, Render internal). Not documented by Render, so it
// can change: if normal users get "Too many requests", or limits stop working,
// re-check the position of a real client IP in X-Forwarded-For, counted from the end.
const RENDER_PROXY_HOPS = 3;

/** Trusted reverse proxies for this host. Render sets RENDER on its services. */
export function proxyHopsFor(env: { RENDER?: string }): number {
  return env.RENDER ? RENDER_PROXY_HOPS : 0;
}

export function createIpLimiter(limit: RateLimit, now: () => number = Date.now) {
  const buckets = new Map<string, Bucket>();
  let lastSweep = now();

  // A full bucket is the same as no bucket, so this bounds the map by the IPs
  // active recently without needing a timer.
  const sweep = () => {
    for (const [ip, bucket] of buckets) {
      if (bucket.isFull()) buckets.delete(ip);
    }
    lastSweep = now();
  };

  return {
    take(ip: string): boolean {
      if (now() - lastSweep >= SWEEP_INTERVAL_MS) sweep();
      let bucket = buckets.get(ip);
      if (!bucket) {
        bucket = createBucket(limit, now);
        buckets.set(ip, bucket);
      }
      return bucket.take();
    },
    /** True if `take` would succeed, without spending anything. */
    canTake(ip: string): boolean {
      return buckets.get(ip)?.hasToken() ?? true;
    },
    get size() {
      return buckets.size;
    },
  };
}

export function requestIp(req: IncomingMessage, hops: number): string {
  return clientIp(req.socket.remoteAddress, req.headers["x-forwarded-for"], hops);
}

export function httpRateLimit(limit: RateLimit, hops: number, now?: () => number): RequestHandler {
  const limiter = createIpLimiter(limit, now);
  return (req, res, next) => {
    if (limiter.take(requestIp(req, hops))) {
      next();
      return;
    }
    res.setHeader("Retry-After", String(Math.ceil(1 / limit.perSecond)));
    res.status(429).json({ error: "Too many requests, please try again shortly" });
  };
}

/**
 * For Socket.IO's `allowRequest`. Unlike `io.use`, a rejection here fails the
 * transport, so the client keeps auto-reconnecting with backoff; a middleware
 * rejection would leave it disconnected for good.
 */
export function connectionRateLimit(limit: RateLimit, hops: number, now?: () => number) {
  const limiter = createIpLimiter(limit, now);
  return (req: IncomingMessage, callback: (err: string | null | undefined, success: boolean) => void) => {
    const allowed = limiter.take(requestIp(req, hops));
    callback(allowed ? null : "Too many connections", allowed);
  };
}
