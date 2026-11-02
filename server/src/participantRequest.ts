import type { Request } from "express";
import { resolveParticipantByHttpToken, type RoomCtx } from "./roomManager.js";

/** Who sent this request, by their token. Not the socket id: every room member can see that (see httpTokenFor). */
export function participantFromRequest(req: Request): RoomCtx | null {
  const token = req.get("x-participant-token");
  return token ? resolveParticipantByHttpToken(token) : null;
}
