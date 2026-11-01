import { Router } from "express";
import { requestIp } from "./ipRateLimit.js";
import { MAX_PARTICIPANTS, MAX_PASSWORD_LENGTH, MAX_ROOMS, MAX_ROOMS_PER_IP } from "./limits.js";
import { createRoom, getRoom, purgeExpiredRooms, roomCount, roomCountForIp } from "./roomManager.js";
import { parseCreateRoom } from "./validation.js";

export function createRoomRouter(proxyHops = 0): Router {
  const roomRouter = Router();

  roomRouter.post("/rooms", (req, res) => {
    const body = parseCreateRoom(req.body ?? {});
    if (!body) {
      // Only the password field is user-controlled; anything else is a malformed request.
      const tooLong = typeof req.body?.password === "string" && req.body.password.length > MAX_PASSWORD_LENGTH;
      res.status(400).json({ error: tooLong ? `Password must be at most ${MAX_PASSWORD_LENGTH} characters` : "Invalid request" });
      return;
    }
    // Expired rooms may still be waiting for the sweep, and shouldn't count.
    purgeExpiredRooms();
    const ip = requestIp(req, proxyHops);
    if (roomCountForIp(ip) >= MAX_ROOMS_PER_IP) {
      res.status(429).json({ error: "You have too many open rooms, please close one and try again" });
      return;
    }
    if (roomCount() >= MAX_ROOMS) {
      res.status(503).json({ error: "The server is full, please try again later" });
      return;
    }
    const room = createRoom(body.password, ip);
    res.json({ roomId: room.id });
  });

  roomRouter.get("/rooms/:id", (req, res) => {
    const room = getRoom(req.params.id);
    if (!room) {
      res.json({ exists: false, hasPassword: false, participantCount: 0, maxParticipants: MAX_PARTICIPANTS });
      return;
    }
    res.json({
      exists: true,
      hasPassword: !!room.password,
      participantCount: room.participants.size,
      maxParticipants: MAX_PARTICIPANTS,
    });
  });

  return roomRouter;
}
