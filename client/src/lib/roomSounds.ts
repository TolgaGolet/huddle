import type { AppSocket, ChatMessage } from "../types";
import { playJoinSound, playLeaveSound, playMessageSound } from "./notificationSounds";

/** Plays room event sounds for the socket's lifetime. A message's cue is only for messages from others, as the server broadcasts to all. */
export function subscribeRoomSounds(socket: Pick<AppSocket, "on">, getUserId: () => string | null): void {
  socket.on("participant-joined", () => playJoinSound());
  socket.on("participant-left", () => playLeaveSound());
  socket.on("chat-message", (msg: ChatMessage) => {
    if (msg.senderId !== getUserId()) playMessageSound();
  });
}
