import type { Socket } from "socket.io";
import { resolveParticipant, socketRoomMap, type RoomCtx } from "./roomManager.js";
import { parseRelay } from "./validation.js";
import { errorSummary } from "./errorLog.js";

/**
 * Register a socket handler that only runs on a payload accepted by `parse`;
 * otherwise `onInvalid` (if given) runs instead. Socket.IO invokes listeners
 * from process.nextTick, so an exception thrown in a handler is uncaught and
 * would exit the process (ending every call in every room). Errors are caught
 * and logged here instead. Only the event name, error name and stack frames
 * are logged, never the payload or the error message (either can contain
 * names or chat text).
 */
export function on<T>(
  socket: Socket,
  event: string,
  parse: (raw: unknown) => T | null,
  handler: (data: T) => void,
  onInvalid?: () => void,
): void {
  socket.on(event, (raw: unknown) => {
    try {
      const data = parse(raw);
      if (data === null) onInvalid?.();
      else handler(data);
    } catch (err) {
      console.error("[socket] handler error", { event, ...errorSummary(err) });
    }
  });
}

/** Like `on`, but drops the event unless the socket is a participant of a room. */
export function onRoom<T>(
  socket: Socket,
  event: string,
  parse: (raw: unknown) => T | null,
  handler: (ctx: RoomCtx, data: T) => void,
): void {
  on(socket, event, parse, (data) => {
    const ctx = resolveParticipant(socket.id);
    if (ctx) handler(ctx, data);
  });
}

/**
 * Relay an SDP/ICE message (`{ to, [key] }`) to a peer as `{ from, [key] }`.
 * The sender must have joined a room and `to` must be a different socket in
 * the SAME room. This prevents a stale or unauthenticated client from
 * injecting offers/candidates into unrelated peers, which could otherwise
 * desynchronize a victim's negotiation.
 */
export function onRelay(socket: Socket, event: string, key: "offer" | "answer" | "candidate"): void {
  on(socket, event, parseRelay(key), ({ to, body }) => {
    const roomId = socketRoomMap.get(socket.id);
    if (!roomId || to === socket.id || socketRoomMap.get(to) !== roomId) return;
    socket.to(to).emit(event, { from: socket.id, [key]: body });
  });
}
