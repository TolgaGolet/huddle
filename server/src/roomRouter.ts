import { Router } from "express";
import { requestIp } from "./ipRateLimit.js";
import { isValidNewPassword, MAX_PARTICIPANTS, MAX_PASSWORD_LENGTH, MAX_ROOMS, MAX_ROOMS_PER_IP, MIN_PASSWORD_LENGTH } from "./limits.js";
import { createRoom, getRoom, purgeExpiredRooms, roomCount, roomCountForIp } from "./roomManager.js";
import { countSecurityEvent } from "./securityLog.js";
import { parseCreateRoom } from "./validation.js";

export function createRoomRouter(proxyHops = 0): Router {
  const roomRouter = Router();

  roomRouter.post("/rooms", (req, res) => {
    const body = parseCreateRoom(req.body ?? {});
    if (!body) {
      // Only the password field is user-controlled; anything else is a malformed request.
      const isPassword = typeof req.body?.password === "string" && !isValidNewPassword(req.body.password);
      const tooLong = isPassword && req.body.password.trim().length > MAX_PASSWORD_LENGTH;
      const error = !isPassword
        ? "Invalid request"
        : tooLong
          ? `Password must be at most ${MAX_PASSWORD_LENGTH} characters`
          : `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
      res.status(400).json({ error });
      return;
    }
    // Expired rooms may still be waiting for the sweep, and shouldn't count.
    purgeExpiredRooms();
    const ip = requestIp(req, proxyHops);
    if (roomCountForIp(ip) >= MAX_ROOMS_PER_IP) {
      countSecurityEvent("capacity_refused");
      res.status(429).json({ error: "You have too many open rooms, please close one and try again" });
      return;
    }
    if (roomCount() >= MAX_ROOMS) {
      countSecurityEvent("capacity_refused");
      res.status(503).json({ error: "The server is full, please try again later" });
      return;
    }
    const room = createRoom(body.password, ip, body.permissions);
    // Only ever sent here, to the creator, whose first join makes them owner.
    res.json({ roomId: room.id, ownerToken: room.ownerToken });
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
