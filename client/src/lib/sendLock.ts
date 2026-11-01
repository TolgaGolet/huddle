/**
 * False once the socket has dropped or reconnected. Socket.IO buffers emits made
 * while disconnected and flushes them before the rejoin, so the server would
 * ignore them while the sender believes the message went out.
 */
export function isSameConnection(socket: { connected: boolean; id?: string }, socketId: string): boolean {
  return socket.connected && socket.id === socketId;
}

export const CONNECTION_LOST_ERROR = "Connection lost, please try again.";

/**
 * What to show for a failed upload. A drop revokes the token the upload was sent
 * with, so a refusal then means the connection was lost, not that the user may not post.
 */
export function uploadErrorMessage(error: unknown, sameConnection: boolean): string {
  if (!sameConnection) return CONNECTION_LOST_ERROR;
  return error instanceof Error ? error.message : "Failed to upload images";
}

/** The reply to send: none if it was cancelled or replaced while uploading. */
export function replyToSend<T>(started: T | null, current: T | null): T | null {
  return current === started ? started : null;
}

/**
 * Drops calls made while an earlier task is still running. The flag is set
 * synchronously, so a second Enter before React re-renders can't get through
 * (a state value alone would still read as idle at that point).
 */
export function createSendLock() {
  let busy = false;
  return {
    async run(task: () => Promise<void>): Promise<void> {
      if (busy) return;
      busy = true;
      try {
        await task();
      } finally {
        busy = false;
      }
    },
  };
}
