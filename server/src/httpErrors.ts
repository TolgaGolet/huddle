import type { ErrorRequestHandler, RequestHandler } from "express";
import { errorSummary } from "./errorLog.js";

export const apiNotFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "Not found" });
};

function statusOf(err: unknown): number {
  const { status, statusCode } = (err ?? {}) as { status?: unknown; statusCode?: unknown };
  const code = status ?? statusCode;
  return typeof code === "number" && code >= 400 && code <= 599 ? code : 500;
}

/**
 * The last handler. Replies with fixed text and logs through errorSummary, since
 * these errors' messages can quote the request body (which can hold a password).
 * Never hand an error on to Express: its default handler logs the raw stack.
 */
export const httpErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = statusOf(err);
  if (status >= 500) console.error("[http] error", errorSummary(err));
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(status).json({ error: status === 413 ? "Request is too large" : "Request failed" });
};
