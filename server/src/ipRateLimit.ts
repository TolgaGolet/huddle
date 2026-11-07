import type { IncomingMessage } from "node:http";
import { isIPv6 } from "node:net";
import type { RequestHandler } from "express";
import { createBucket, type Bucket, type RateLimit } from "./rateLimit.js";
import { countSecurityEvent } from "./securityLog.js";

const SWEEP_INTERVAL_MS = 60_000;

const perMinute = (n: number): RateLimit => ({ burst: n, perSecond: n / 60 });

export const IP_LIMITS = {
  connections: perMinute(30),
  createRoom: perMinute(20),
  lookupRoom: perMinute(60),
  uploadImages: perMinute(30),
  imageSession: perMinute(60),
  giphy: perMinute(60),
  /** Searches only; the key's daily budget (youtubeData.ts) is the tighter limit. */
  youtube: perMinute(20),
  /** Wrong passwords per room and IP. Per socket would reset on every new connection. */
  passwordGuesses: perMinute(12),
  /** Wrong passwords per room from all IPs, so that many addresses don't mean many more guesses. */
  roomPasswordGuesses: perMinute(60),
};

/** The 8 groups of a valid IPv6 address, which may use `::` or end in dotted IPv4. */
function ipv6Groups(address: string): number[] {
  const parse = (part: string | undefined) =>
    (part ? part.split(":") : []).flatMap((group) => {
      if (!group.includes(".")) return [parseInt(group, 16)];
      const [a, b, c, d] = group.split(".").map(Number);
      return [(a << 8) | b, (c << 8) | d];
    });
  const [head, tail] = address.split("::");
  const left = parse(head);
  const right = parse(tail);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/**
 * What a limit should count as one client. A customer normally controls a whole
 * IPv6 /64 and could use a new address per request, so the /64 is the client.
 * IPv4-mapped addresses are the IPv4 client they stand for.
 */
function clientKey(ip: string): string {
  const address = ip.split("%")[0];
  if (!isIPv6(address)) return ip;
  const groups = ipv6Groups(address);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/**
 * The client's IP, as the key limits count it by (see clientKey). X-Forwarded-For
 * is client-controlled except for the entries our own proxies appended, so with
 * `hops` trusted proxies only the entry `hops` from the end is used, and with none
 * the header is ignored. Otherwise anyone could dodge a limit by sending a
 * different header each time.
 */
export function clientIp(remoteAddress: string | undefined, forwardedFor: string | string[] | undefined, hops: number): string {
  const fallback = remoteAddress ?? "unknown";
  if (hops <= 0 || !forwardedFor) return clientKey(fallback);
  const list = (Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor).split(",").map((s) => s.trim());
  return clientKey(list[list.length - hops] || fallback);
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
    countSecurityEvent("http_rate_limited");
    res.setHeader("Retry-After", String(Math.ceil(1 / limit.perSecond)));
    res.status(429).json({ error: "Too many requests, please try again shortly" });
  };
}

/**
 * For Socket.IO's `allowRequest`. Unlike `io.use`, a rejection here fails the
 * transport, so the client keeps auto-reconnecting with backoff; a middleware
 * rejection would leave it disconnected for good. Returns why it's refused, or null.
 */
export function connectionRateLimit(limit: RateLimit, hops: number, now?: () => number) {
  const limiter = createIpLimiter(limit, now);
  return (req: IncomingMessage): string | null => {
    if (limiter.take(requestIp(req, hops))) return null;
    countSecurityEvent("connection_refused");
    return "Too many connections";
  };
}

/**
 * Caps connections open at once, per IP and in total, which a rate alone can't:
 * a connection stays open for free, so they would add up until memory ran out.
 * Each is counted until its underlying socket closes, however that happens.
 */
export function openConnectionLimit(maxPerIp: number, maxTotal: number, hops: number) {
  const openByIp = new Map<string, number>();
  let total = 0;
  return (req: IncomingMessage): string | null => {
    const ip = requestIp(req, hops);
    const open = openByIp.get(ip) ?? 0;
    // Already closed: the release below would never run, leaking the count for good.
    if (req.socket.destroyed || open >= maxPerIp || total >= maxTotal) {
      countSecurityEvent("connection_refused");
      return "Too many connections";
    }
    openByIp.set(ip, open + 1);
    total++;
    req.socket.once("close", () => {
      total--;
      const remaining = (openByIp.get(ip) ?? 1) - 1;
      if (remaining > 0) openByIp.set(ip, remaining);
      else openByIp.delete(ip);
    });
    return null;
  };
}
