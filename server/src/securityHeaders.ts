import type { RequestHandler } from "express";

// Inline styles are for React `style` attributes, and blob: workers for
// workerTimer.ts. YouTube's script and frame are the watch party's player
// (lib/youtubeApi.ts). Add any new external host here, or the browser will block it.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https://*.giphy.com",
  "connect-src 'self'",
  "frame-src https://www.youtube-nocookie.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
  "Permissions-Policy": "microphone=(self), display-capture=(self), camera=()",
};

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.set(HEADERS);
  next();
};
