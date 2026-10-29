import "./loadEnv.js";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { router as roomRouter, onRoomDestroyed, purgeExpiredRooms } from "./roomManager.js";
import { giphyRouter } from "./giphyRouter.js";
import { setupSignaling } from "./signaling.js";
import { setupChat } from "./chatHandler.js";
import { setupPolls } from "./pollHandler.js";
import { clearStaleImages, deleteRoomImages, imageRouter } from "./imageRouter.js";
import { errorSummary } from "./errorLog.js";

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
const io = new Server(httpServer, {
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

app.use("/api", roomRouter);
app.use("/api/giphy", giphyRouter);
app.use("/api", imageRouter);

setupSignaling(io);
setupChat(io);
setupPolls(io);

const clientDist = path.join(__dirname, "../../client/dist");
app.use(express.static(clientDist));
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

setInterval(() => {
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1024 / 1024).toFixed(1);
  const heapUsed = (mem.heapUsed / 1024 / 1024).toFixed(1);
  const heapTotal = (mem.heapTotal / 1024 / 1024).toFixed(1);
  const external = (mem.external / 1024 / 1024).toFixed(1);
  console.log(`[mem] rss=${rss}MB heap=${heapUsed}/${heapTotal}MB ext=${external}MB conns=${io.engine.clientsCount}`);
}, 30_000);

// Delete a room's uploaded images whenever the room is destroyed, whether by
// the lazy purge in getRoom() or the sweep below.
onRoomDestroyed((roomId) => void deleteRoomImages(roomId));

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
