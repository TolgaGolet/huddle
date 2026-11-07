import "./loadEnv.js";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { onMessageRemoved, onRoomDestroyed, purgeExpiredRooms, roomCount, totalImageBytes } from "./roomManager.js";
import { createRoomRouter } from "./roomRouter.js";
import { giphyRouter } from "./giphyRouter.js";
import { youtubeRouter } from "./youtubeRouter.js";
import { setupSignaling } from "./signaling.js";
import { setupChat } from "./chatHandler.js";
import { setupPolls } from "./pollHandler.js";
import { setupWatchParty } from "./watchPartyHandler.js";
import { setupGameParty } from "./gamePartyHandler.js";
import { clearStaleImages, createImageRouter, deleteRoomImages, releaseMessageImages } from "./imageRouter.js";
import { errorSummary } from "./errorLog.js";
import { apiNotFound, httpErrorHandler } from "./httpErrors.js";
import { connectionRateLimit, httpRateLimit, IP_LIMITS, openConnectionLimit, proxyHopsFor } from "./ipRateLimit.js";
import { isDevelopment } from "./env.js";
import { MAX_CONNECTIONS_PER_IP, MAX_CONNECTIONS_TOTAL } from "./limits.js";
import { connectionOriginRefusal, DEV_CLIENT_ORIGIN, requireOwnOrigin } from "./originCheck.js";
import { setupRoomLifetime } from "./roomLifetime.js";
import { setupModeration } from "./roomModeration.js";
import { securityHeaders } from "./securityHeaders.js";
import { STATUS_LOG_INTERVAL_MS, takeSecurityCounts } from "./securityLog.js";
import { BACKLOG_SWEEP_INTERVAL_MS, evictBacklogged } from "./socketBacklog.js";
import type { AppServer } from "./socketRoute.js";

// Socket handlers catch their own errors (socketRoute.ts), so client input
// cannot crash the process. Anything reaching here is a real bug or a startup
// failure (e.g. port in use, uploads dir unwritable): log it without the
// message (see errorLog.ts) and exit so a supervisor restarts the server
// instead of leaving a half-broken process that serves nothing.
process.on("uncaughtException", (err) => {
  console.error("[process] uncaughtException", errorSummary(err));
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandledRejection", errorSummary(reason));
  process.exit(1);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
const httpServer = createServer(app);
const proxyHops = proxyHopsFor(process.env);
const connectionRateRefusal = connectionRateLimit(IP_LIMITS.connections, proxyHops);
const openConnectionRefusal = openConnectionLimit(MAX_CONNECTIONS_PER_IP, MAX_CONNECTIONS_TOTAL, proxyHops);
const io: AppServer = new Server(httpServer, {
  // Each only if the one before allowed it: origin costs nothing, and a connection
  // the rate limit refuses must never count as open.
  allowRequest: (req, callback) => {
    const refusal = connectionOriginRefusal(req) ?? connectionRateRefusal(req) ?? openConnectionRefusal(req);
    callback(refusal, !refusal);
  },
  cors: {
    origin: isDevelopment() ? DEV_CLIENT_ORIGIN : false,
  },
  transports: ["websocket"],
  perMessageDeflate: false,
  maxHttpBufferSize: 64 * 1024,
});

app.disable("x-powered-by");
app.use(securityHeaders);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Image downloads have no rate limit: a chat can load many at once, they require
// room membership, and imageRouter.ts bounds the memory they use.
app.use("/api", requireOwnOrigin);
app.post("/api/rooms", httpRateLimit(IP_LIMITS.createRoom, proxyHops));
app.get("/api/rooms/:id", httpRateLimit(IP_LIMITS.lookupRoom, proxyHops));
app.post("/api/rooms/:id/images", httpRateLimit(IP_LIMITS.uploadImages, proxyHops));
app.post("/api/rooms/:id/image-session", httpRateLimit(IP_LIMITS.imageSession, proxyHops));
app.use("/api/giphy", httpRateLimit(IP_LIMITS.giphy, proxyHops));
app.use("/api/youtube", httpRateLimit(IP_LIMITS.youtube, proxyHops));

app.use("/api", createRoomRouter(proxyHops));
app.use("/api/giphy", giphyRouter);
app.use("/api/youtube", youtubeRouter);
app.use("/api", createImageRouter(proxyHops));
app.use("/api", apiNotFound);

setupSignaling(io, proxyHops);
setupModeration(io, proxyHops);
setupChat(io);
setupPolls(io);
setupWatchParty(io);
setupGameParty(io);

const clientDist = path.join(__dirname, "../../client/dist");
app.use(express.static(clientDist));
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});
app.use(httpErrorHandler);

// One line for what happened lately: memory, for spotting a leak, and security
// counts (see securityLog.ts), which never identify anyone.
setInterval(() => {
  const mem = process.memoryUsage();
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  console.log(
    `[status] rss=${mb(mem.rss)}MB heap=${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB ext=${mb(mem.external)}MB conns=${io.engine.clientsCount} rooms=${roomCount()} images=${mb(totalImageBytes())}MB security=${JSON.stringify(takeSecurityCounts())}`,
  );
}, STATUS_LOG_INTERVAL_MS);

// Delete a room's uploaded images whenever the room is destroyed, whether by
// the lazy purge in getRoom() or the sweep below.
onRoomDestroyed((roomId) => void deleteRoomImages(roomId));
onMessageRemoved(releaseMessageImages);

// Periodically destroy rooms that stayed empty past their grace period. This
// is the backstop for the lazy purge in getRoom(); without it, abandoned rooms
// (and their images) would never be deleted because nothing calls getRoom()
// for a room nobody references.
setInterval(purgeExpiredRooms, 30_000);

setInterval(() => evictBacklogged(io), BACKLOG_SWEEP_INTERVAL_MS);
setupRoomLifetime(io);

void clearStaleImages().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`Huddle server running on http://localhost:${PORT}`);
  });
});
