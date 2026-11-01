import type { Server, Socket } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "./protocol.js";
import { resolveParticipant, socketRoomMap, type RoomCtx } from "./roomManager.js";
import { createBucket, EVENT_LIMITS, RATE_LIMITS, type Bucket, type RateLimitGroup } from "./rateLimit.js";
import { parseRelay } from "./validation.js";
import { errorSummary } from "./errorLog.js";

export type AppServer = Server<ClientToServerEvents, ServerToClientEvents>;
export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

// "disconnect" is Socket.IO's own event, not client input (see signaling.ts).
type RouteEvents = ClientToServerEvents & { disconnect: () => void };
type RoutePayload<E extends keyof RouteEvents> = Parameters<RouteEvents[E]> extends [infer P] ? P : Record<string, never>;

const NOTICE_INTERVAL_MS = 1000;
/**
 * Groups the sender is told about; the rest have no visible effect worth
 * reporting. A dropped callState event leaves peers out of sync, so the client
 * re-sends its state on this notice (callStateResync.ts).
 */
const NOTICE_GROUPS: ReadonlySet<RateLimitGroup> = new Set(["messages", "messageActions", "reactions", "callState"]);

// Per-socket state goes away with the socket, with no cleanup path to forget.
const socketBuckets = new WeakMap<object, Map<RateLimitGroup, Bucket>>();
const lastNotice = new WeakMap<object, number>();

function withinLimit(socket: AppSocket, group: RateLimitGroup): boolean {
  let buckets = socketBuckets.get(socket);
  if (!buckets) {
    buckets = new Map();
    socketBuckets.set(socket, buckets);
  }
  let bucket = buckets.get(group);
  if (!bucket) {
    bucket = createBucket(RATE_LIMITS[group]);
    buckets.set(group, bucket);
  }
  return bucket.take();
}

/** Throttled, so that flooding can't make the server send a reply per event. */
function sendLimitNotice(socket: AppSocket, event: string, group: RateLimitGroup): void {
  if (!NOTICE_GROUPS.has(group)) return;
  const now = Date.now();
  if (now - (lastNotice.get(socket) ?? 0) < NOTICE_INTERVAL_MS) return;
  lastNotice.set(socket, now);
  socket.emit("rate-limited", { event });
}

function register<T>(
  socket: AppSocket,
  event: keyof RouteEvents,
  parse: (raw: unknown) => T | null,
  handler: (data: T) => void,
  onInvalid?: () => void,
  onLimited?: () => void,
): void {
  const group = event === "disconnect" ? undefined : EVENT_LIMITS[event];
  // Raw input is unknown whatever the protocol claims, so listen untyped.
  (socket as unknown as Socket).on(event, (raw: unknown) => {
    try {
      // Before parsing, so a flood costs as little as possible.
      if (group && !withinLimit(socket, group)) {
        if (onLimited) onLimited();
        else sendLimitNotice(socket, event, group);
        return;
      }
      const data = parse(raw);
      if (data === null) onInvalid?.();
      else handler(data);
    } catch (err) {
      console.error("[socket] handler error", { event, ...errorSummary(err) });
    }
  });
}

/**
 * Register a socket handler that only runs on a payload accepted by `parse`;
 * otherwise `onInvalid` (if given) runs instead. Socket.IO invokes listeners
 * from process.nextTick, so an exception thrown in a handler is uncaught and
 * would exit the process (ending every call in every room). Errors are caught
 * and logged here instead. Only the event name, error name and stack frames
 * are logged, never the payload or the error message (either can contain
 * names or chat text). The parser must produce the event's payload from
 * protocol.ts, so the two can't drift. Events over their limit in rateLimit.ts
 * are dropped, running `onLimited` if given.
 */
export function on<E extends keyof RouteEvents>(
  socket: AppSocket,
  event: E,
  parse: (raw: unknown) => RoutePayload<E> | null,
  handler: (data: RoutePayload<E>) => void,
  onInvalid?: () => void,
  onLimited?: () => void,
): void {
  register(socket, event, parse, handler, onInvalid, onLimited);
}

/** Like `on`, but drops the event unless the socket is a participant of a room. */
export function onRoom<E extends keyof ClientToServerEvents>(
  socket: AppSocket,
  event: E,
  parse: (raw: unknown) => RoutePayload<E> | null,
  handler: (ctx: RoomCtx, data: RoutePayload<E>) => void,
): void {
  register(socket, event, parse, (data) => {
    const ctx = resolveParticipant(socket.id);
    if (ctx) handler(ctx, data);
  });
}

/**
 * Relay an SDP/ICE message (`{ to, [key] }`) to a peer as `{ from, [key] }`.
 * The sender must have joined a room and `to` must be a different socket in
 * the SAME room. This prevents a stale or unauthenticated client from
 * injecting offers/candidates into unrelated peers, which could otherwise
 * desynchronize a victim's negotiation. The body is forwarded opaquely, so its
 * protocol type is not checked here.
 */
export function onRelay(socket: AppSocket, event: "offer" | "answer" | "ice-candidate", key: "offer" | "answer" | "candidate"): void {
  register(socket, event, parseRelay(key), ({ to, body }) => {
    const roomId = socketRoomMap.get(socket.id);
    if (!roomId || to === socket.id || socketRoomMap.get(to) !== roomId) return;
    (socket as unknown as Socket).to(to).emit(event, { from: socket.id, [key]: body });
  });
}
