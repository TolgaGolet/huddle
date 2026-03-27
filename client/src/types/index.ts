export interface Participant {
  id: string;
  name: string;
  isMuted: boolean;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  reactions: Record<string, string[]>;
  replyTo?: {
    id: string;
    senderName: string;
    text: string;
  };
  gifUrl?: string;
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
