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
}

export interface Room {
  id: string;
  participants: Participant[];
}
