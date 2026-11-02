import { useEffect, useMemo } from "react";
import type { AppSocket } from "../types";
import { createVoiceReporter, VOICE_REPORT_INTERVAL_MS } from "../lib/voiceActivityReport";

/**
 * Tells the server while this user is speaking. Media is peer-to-peer, so it can't
 * see that itself, and a room with only voice in it would otherwise close as inactive.
 */
export function useVoiceActivityReport(socket: AppSocket | null, speaking: boolean): void {
  const report = useMemo(
    () => createVoiceReporter(() => {
      if (socket?.connected) socket.emit("voice-activity");
    }),
    [socket],
  );

  useEffect(() => {
    if (!speaking) return;
    report();
    const timer = setInterval(report, VOICE_REPORT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [speaking, report]);
}
