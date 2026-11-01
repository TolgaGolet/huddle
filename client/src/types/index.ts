import type { Socket } from "socket.io-client";
import type { ChatEntry, ClientToServerEvents, PollMessage, ServerToClientEvents } from "../../../server/src/protocol.ts";

// Limits and the wire protocol are defined once, in the server's limits.ts,
// rateLimit.ts, joinErrors.ts and protocol.ts; importing them keeps both sides in sync.
export * from "../../../server/src/limits.ts";
export * from "../../../server/src/rateLimit.ts";
export * from "../../../server/src/joinErrors.ts";
export type * from "../../../server/src/protocol.ts";

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function isPollMessage(entry: ChatEntry): entry is PollMessage {
  return "type" in entry && entry.type === "poll";
}

export type VoiceTransmissionThreshold = "off" | "low" | "medium" | "high" | "very-high" | "manual";

export interface AudioSettingsState {
  noiseCancellationEnabled: boolean;
  transmissionThreshold: VoiceTransmissionThreshold;
  manualThresholdDb: number;
}

export interface MicTelemetry {
  levelDb: number;
  noiseFloorDb: number;
  thresholdDb: number | null;
  isTransmitting: boolean;
  isMuted: boolean;
  hasInput: boolean;
}
