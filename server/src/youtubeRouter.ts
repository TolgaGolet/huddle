import { Router, type Response } from "express";
import { MAX_YOUTUBE_QUERY_LENGTH } from "./limits.js";
import { participantFromRequest } from "./participantRequest.js";
import type { YouTubeSearchErrorCode } from "./protocol.js";
import { controlledPartyOf } from "./watchPartyHandler.js";
import { logSearchFailure, searchYouTube, SearchUnavailableError } from "./youtubeData.js";

function fail(res: Response, status: number, code: YouTubeSearchErrorCode, error: string): void {
  res.status(status).json({ code, error });
}

export const youtubeRouter = Router();

// Only those who may change a party's video can search: anyone else would be
// spending the key's small daily quota on results they can't use.
youtubeRouter.get("/search", async (req, res) => {
  const ctx = participantFromRequest(req);
  if (!ctx || !controlledPartyOf(ctx.room, ctx.participant.id, ctx.participant.userId)) {
    fail(res, 403, "not-permitted", "Only those who can change the video can search");
    return;
  }
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q || q.length > MAX_YOUTUBE_QUERY_LENGTH) {
    fail(res, 400, "invalid-query", q ? "Search is too long" : "Missing q parameter");
    return;
  }
  try {
    res.json({ data: await searchYouTube(q) });
  } catch (err) {
    if (err instanceof SearchUnavailableError) {
      fail(res, 503, "search-unavailable", "YouTube search is not available right now");
      return;
    }
    logSearchFailure(err);
    fail(res, 502, "search-failed", "YouTube search failed");
  }
});
