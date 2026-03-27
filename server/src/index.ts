import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { router as roomRouter } from "./roomManager.js";
import { setupSignaling } from "./signaling.js";
import { setupChat } from "./chatHandler.js";

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
app.use("/api", roomRouter);

setupSignaling(io);
setupChat(io);

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

httpServer.listen(PORT, () => {
  console.log(`Huddle server running on http://localhost:${PORT}`);
});
