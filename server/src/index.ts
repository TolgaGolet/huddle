import "./loadEnv.js";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { router as roomRouter, onMessageRemoved, onRoomDestroyed, purgeExpiredRooms } from "./roomManager.js";
import { giphyRouter } from "./giphyRouter.js";
import { setupSignaling } from "./signaling.js";
import { setupChat } from "./chatHandler.js";
import { setupPolls } from "./pollHandler.js";
import { clearStaleImages, deleteRoomImages, imageRouter, releaseMessageImages } from "./imageRouter.js";
import { errorSummary } from "./errorLog.js";
import { apiNotFound, httpErrorHandler } from "./httpErrors.js";
import { connectionRateLimit, httpRateLimit, IP_LIMITS, proxyHopsFor } from "./ipRateLimit.js";
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
const io: AppServer = new Server(httpServer, {
  allowRequest: connectionRateLimit(IP_LIMITS.connections, proxyHops),
  cors: {
    origin: process.env.NODE_ENV === "production" ? false : "http://localhost:4173",
  },
  transports: ["websocket"],
  perMessageDeflate: false,
  maxHttpBufferSize: 64 * 1024,
});

app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Image downloads have no rate limit: a chat can load many at once, they require
// room membership, and imageRouter.ts bounds the memory they use.
app.post("/api/rooms", httpRateLimit(IP_LIMITS.createRoom, proxyHops));
app.get("/api/rooms/:id", httpRateLimit(IP_LIMITS.lookupRoom, proxyHops));
app.post("/api/rooms/:id/images", httpRateLimit(IP_LIMITS.uploadImages, proxyHops));
app.post("/api/rooms/:id/image-session", httpRateLimit(IP_LIMITS.imageSession, proxyHops));
app.use("/api/giphy", httpRateLimit(IP_LIMITS.giphy, proxyHops));

app.use("/api", roomRouter);
app.use("/api/giphy", giphyRouter);
app.use("/api", imageRouter);
app.use("/api", apiNotFound);

setupSignaling(io, proxyHops);
setupChat(io);
setupPolls(io);

const clientDist = path.join(__dirname, "../../client/dist");
app.use(express.static(clientDist));
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});
app.use(httpErrorHandler);

// Close to the limit of a 512 MB Render instance; below this the line is noise.
const MEM_LOG_RSS_BYTES = 400 * 1024 * 1024;

setInterval(() => {
  const mem = process.memoryUsage();
  if (mem.rss < MEM_LOG_RSS_BYTES) return;
  const rss = (mem.rss / 1024 / 1024).toFixed(1);
  const heapUsed = (mem.heapUsed / 1024 / 1024).toFixed(1);
  const heapTotal = (mem.heapTotal / 1024 / 1024).toFixed(1);
  const external = (mem.external / 1024 / 1024).toFixed(1);
  console.log(`[mem] rss=${rss}MB heap=${heapUsed}/${heapTotal}MB ext=${external}MB conns=${io.engine.clientsCount}`);
}, 30_000);

// Delete a room's uploaded images whenever the room is destroyed, whether by
// the lazy purge in getRoom() or the sweep below.
onRoomDestroyed((roomId) => void deleteRoomImages(roomId));
onMessageRemoved(releaseMessageImages);

// Periodically destroy rooms that stayed empty past their grace period. This
// is the backstop for the lazy purge in getRoom(); without it, abandoned rooms
// (and their images) would never be deleted because nothing calls getRoom()
// for a room nobody references.
setInterval(purgeExpiredRooms, 30_000);

void clearStaleImages().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`Huddle server running on http://localhost:${PORT}`);
  });
});
