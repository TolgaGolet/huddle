import { countSecurityEvent } from "./securityLog.js";
import type { AppServer, AppSocket } from "./socketRoute.js";

// Packets waiting in engine.io's queue, and bytes in the socket's own buffer. A
// client reading normally stays far below both; a queue this long means it has stopped.
const MAX_BACKLOG_PACKETS = 256;
const MAX_BACKLOG_BYTES = 1024 * 1024;

export const BACKLOG_SWEEP_INTERVAL_MS = 5000;

/** Nothing else stops data queueing for a client that doesn't read, until the process runs out of memory. */
export function isBacklogged(socket: AppSocket): boolean {
  // Private in engine.io's types, with no public equivalent. Recheck it when upgrading.
  const { writeBuffer } = socket.conn as unknown as { writeBuffer: unknown[] };
  return writeBuffer.length > MAX_BACKLOG_PACKETS || socket.conn.request.socket.writableLength > MAX_BACKLOG_BYTES;
}

/**
 * Closes the connection and frees its queue at once. `disconnect(true)` would
 * wait for the queue to drain, which is the one thing this client won't let
 * happen. The usual disconnect handling then cleans up, and a real client on a
 * bad link reconnects by itself.
 */
export function evict(socket: AppSocket): void {
  countSecurityEvent("slow_client_evicted");
  socket.conn.request.socket.destroy();
}

/** Covers what the relay's own check can't: room broadcasts, such as chat and polls. */
export function evictBacklogged(io: AppServer): void {
  for (const socket of io.sockets.sockets.values()) {
    if (isBacklogged(socket)) evict(socket);
  }
}
