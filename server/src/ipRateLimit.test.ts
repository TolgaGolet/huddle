import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { EventEmitter } from "node:events";
import { clientIp, connectionRateLimit, createIpLimiter, httpRateLimit, openConnectionLimit, proxyHopsFor } from "./ipRateLimit.js";

function clock() {
  let t = 1000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function request(ip: string, forwardedFor?: string) {
  return { socket: { remoteAddress: ip }, headers: { "x-forwarded-for": forwardedFor } } as unknown as Request & IncomingMessage;
}

function callHttp(handler: ReturnType<typeof httpRateLimit>, req: Request) {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  const next = vi.fn();
  void handler(req, res as unknown as Response, next as NextFunction);
  return { res, next };
}

describe("clientIp", () => {
  it("ignores the header without a trusted proxy, so it can't be spoofed", () => {
    expect(clientIp("10.0.0.1", "1.2.3.4", 0)).toBe("10.0.0.1");
  });

  it("uses the entry appended by the trusted proxy, not ones the client sent", () => {
    expect(clientIp("10.0.0.1", "6.6.6.6, 1.2.3.4", 1)).toBe("1.2.3.4");
    expect(clientIp("10.0.0.1", "6.6.6.6, 1.2.3.4, 10.0.0.2", 2)).toBe("1.2.3.4");
  });

  it("falls back to the socket address when the header is missing or too short", () => {
    expect(clientIp("10.0.0.1", undefined, 1)).toBe("10.0.0.1");
    expect(clientIp("10.0.0.1", "1.2.3.4", 2)).toBe("10.0.0.1");
    expect(clientIp(undefined, undefined, 0)).toBe("unknown");
  });

  // Regression: each address in a /64 had its own limits, so one customer had no limits at all.
  it("counts a whole IPv6 /64 as one client", () => {
    const key = clientIp("2001:db8:1:1::1", undefined, 0);
    expect(key).toBe("2001:db8:1:1::/64");
    expect(clientIp("2001:0db8:0001:0001:aaaa:bbbb:cccc:dddd", undefined, 0)).toBe(key);
    expect(clientIp("proxy", "2001:db8:1:1::ffff", 1)).toBe(key);
    expect(clientIp("2001:db8:1:2::1", undefined, 0)).not.toBe(key);
  });

  it("handles the compressed and zoned forms of IPv6", () => {
    expect(clientIp("::1", undefined, 0)).toBe("0:0:0:0::/64");
    expect(clientIp("fe80::1%eth0", undefined, 0)).toBe("fe80:0:0:0::/64");
  });

  it("treats an IPv4-mapped address as the IPv4 client, in either notation", () => {
    expect(clientIp("::ffff:1.2.3.4", undefined, 0)).toBe("1.2.3.4");
    expect(clientIp("::ffff:102:304", undefined, 0)).toBe("1.2.3.4");
  });

  it("leaves anything that isn't an IPv6 address alone", () => {
    expect(clientIp("1.2.3.4", undefined, 0)).toBe("1.2.3.4");
    expect(clientIp("proxy", "not-an-ip", 1)).toBe("not-an-ip");
  });
});

describe("proxyHopsFor", () => {
  it("trusts Render's proxies only when running on Render", () => {
    expect(proxyHopsFor({ RENDER: "true" })).toBe(3);
    expect(proxyHopsFor({})).toBe(0);
  });

  it("reads the client's entry from a Render-style header, not a forged one", () => {
    const hops = proxyHopsFor({ RENDER: "true" });
    expect(clientIp("10.0.0.1", "6.6.6.6, 1.2.3.4, 10.0.0.2, 10.0.0.3", hops)).toBe("1.2.3.4");
  });
});

describe("createIpLimiter", () => {
  it("keeps a separate limit per IP", () => {
    const limiter = createIpLimiter({ burst: 1, perSecond: 1 }, clock().now);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    expect(limiter.take("b")).toBe(true);
  });

  it("forgets idle IPs, so the map stays bounded", () => {
    const { now, advance } = clock();
    const limiter = createIpLimiter({ burst: 1, perSecond: 1 }, now);
    for (let i = 0; i < 100; i++) limiter.take(`ip-${i}`);
    expect(limiter.size).toBe(100);

    advance(60_000);
    limiter.take("new");
    expect(limiter.size).toBe(1);
  });

  it("does not reset a limit by sweeping while the IP is still limited", () => {
    const { now, advance } = clock();
    const limiter = createIpLimiter({ burst: 120, perSecond: 1 }, now);
    for (let i = 0; i < 120; i++) limiter.take("a");
    advance(60_000);
    limiter.take("b");
    expect(limiter.size).toBe(2);
  });
});

describe("httpRateLimit", () => {
  it("answers 429 with Retry-After once over the limit", () => {
    const handler = httpRateLimit({ burst: 1, perSecond: 0.5 }, 0, clock().now);
    expect(callHttp(handler, request("a")).next).toHaveBeenCalledOnce();

    const { res, next } = callHttp(handler, request("a"));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "2");
    expect(res.json).toHaveBeenCalledWith({ error: expect.any(String) });
  });

  it("can't be dodged with a forged header when no proxy is trusted", () => {
    const handler = httpRateLimit({ burst: 1, perSecond: 1 }, 0, clock().now);
    callHttp(handler, request("a", "1.1.1.1"));
    expect(callHttp(handler, request("a", "2.2.2.2")).next).not.toHaveBeenCalled();
  });

  it("limits each client separately behind a trusted proxy", () => {
    const handler = httpRateLimit({ burst: 1, perSecond: 1 }, 1, clock().now);
    callHttp(handler, request("proxy", "1.1.1.1"));
    expect(callHttp(handler, request("proxy", "2.2.2.2")).next).toHaveBeenCalledOnce();
  });
});

describe("connectionRateLimit", () => {
  it("rejects connections over the limit, and allows them again later", () => {
    const { now, advance } = clock();
    const allow = connectionRateLimit({ burst: 1, perSecond: 1 }, 0, now);

    expect(allow(request("a"))).toBeNull();
    expect(allow(request("a"))).toEqual(expect.any(String));

    advance(1000);
    expect(allow(request("a"))).toBeNull();
  });
});

describe("openConnectionLimit", () => {
  function connection(ip: string) {
    const socket = Object.assign(new EventEmitter(), { remoteAddress: ip, destroyed: false });
    return { req: { socket, headers: {} } as unknown as IncomingMessage, socket };
  }

  it("caps open connections per IP, and frees a place when one closes", () => {
    const allow = openConnectionLimit(1, 10, 0);
    const first = connection("a");

    expect(allow(first.req)).toBeNull();
    expect(allow(connection("a").req)).toEqual(expect.any(String));
    expect(allow(connection("b").req)).toBeNull();

    first.socket.emit("close");
    expect(allow(connection("a").req)).toBeNull();
  });

  it("caps open connections in total", () => {
    const allow = openConnectionLimit(5, 1, 0);

    allow(connection("a").req);

    expect(allow(connection("b").req)).toEqual(expect.any(String));
  });

  it("counts an IPv6 /64 as one client", () => {
    const allow = openConnectionLimit(1, 10, 0);

    allow(connection("2001:db8::1").req);

    expect(allow(connection("2001:db8::2").req)).toEqual(expect.any(String));
  });

  it("refuses a connection that already closed, whose place would never be freed", () => {
    const allow = openConnectionLimit(1, 10, 0);
    const closed = connection("a");
    closed.socket.destroyed = true;

    expect(allow(closed.req)).toEqual(expect.any(String));
    expect(allow(connection("a").req)).toBeNull();
  });
});
