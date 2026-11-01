export interface Participant {
  id: string;
  userId: string;
  name: string;
  isMuted: boolean;
}

export interface ReactionUser {
  userId: string;
  name: string;
}

// Room and input limits are defined once, in the server's limits.ts, and
// enforced by its parsers; importing them keeps both sides in sync.
export * from "../../../server/src/limits.ts";
export * from "../../../server/src/joinErrors.ts";

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  reactions: Record<string, ReactionUser[]>;
  replyTo?: {
    id: string;
    senderName: string;
    text: string;
    imageUrl?: string;
  };
  gifUrl?: string;
  imageUrls?: string[];
  edited?: boolean;
}

export interface PollOption {
  id: string;
  text: string;
  voterIds: string[];
  voterNames: string[];
}

export interface PollMessage {
  id: string;
  type: "poll";
  senderId: string;
  senderName: string;
  question: string;
  options: PollOption[];
  allowMultiple: boolean;
  timestamp: number;
}

export type ChatEntry = ChatMessage | PollMessage;

export function isPollMessage(entry: ChatEntry): entry is PollMessage {
  return "type" in entry && entry.type === "poll";
}

export interface Room {
  id: string;
  participants: Participant[];
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
