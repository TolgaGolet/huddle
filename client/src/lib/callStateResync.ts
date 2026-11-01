import type { AppSocket } from "../types";

const CALL_STATE_EVENTS: ReadonlySet<string> = new Set(["mute-toggle", "screen-share-started", "screen-share-stopped"]);
/** Long enough for the server's bucket to refill; resets while drops keep coming. */
const RESYNC_DELAY_MS = 1000;

interface CallState {
  isMuted: boolean;
  isScreenSharing: boolean;
}

/**
 * A dropped call-state event would leave the others out of sync until the next
 * toggle, so re-send the current state once the limit has passed. All of these
 * events are safe to repeat. Returns the cleanup.
 */
export function resyncCallStateWhenLimited(socket: AppSocket, getState: () => CallState): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onLimited = ({ event }: { event: string }) => {
    if (!CALL_STATE_EVENTS.has(event)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Socket.IO would flush these before the rejoin, where the server ignores them.
      if (!socket.connected) return;
      const { isMuted, isScreenSharing } = getState();
      socket.emit("mute-toggle", { isMuted });
      socket.emit(isScreenSharing ? "screen-share-started" : "screen-share-stopped");
    }, RESYNC_DELAY_MS);
  };
  socket.on("rate-limited", onLimited);
  return () => {
    socket.off("rate-limited", onLimited);
    clearTimeout(timer);
  };
}
