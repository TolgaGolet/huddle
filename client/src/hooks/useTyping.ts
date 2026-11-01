import { useCallback, useEffect, useState } from "react";
import type { AppSocket, ServerToClientEvents } from "../types";
import { TypingTracker } from "../lib/typingTracker";

export function useTyping(socket: AppSocket | null) {
  // Names of other participants currently typing (most recent first).
  const [typingUsers, setTypingUsers] = useState<string[]>([]);

  useEffect(() => {
    if (!socket) return;
    const tracker = new TypingTracker(setTypingUsers);
    const onTyping: ServerToClientEvents["typing"] = ({ userId, senderName }) => tracker.started(userId, senderName);
    const onMessage: ServerToClientEvents["chat-message"] = (msg) => tracker.clear(msg.senderId);
    const onLeft: ServerToClientEvents["participant-left"] = ({ userId }) => tracker.clear(userId);
    socket.on("typing", onTyping);
    socket.on("chat-message", onMessage);
    socket.on("participant-left", onLeft);
    return () => {
      socket.off("typing", onTyping);
      socket.off("chat-message", onMessage);
      socket.off("participant-left", onLeft);
      tracker.dispose();
      setTypingUsers([]);
    };
  }, [socket]);

  const notifyTyping = useCallback(() => {
    socket?.emit("typing");
  }, [socket]);

  return { typingUsers, notifyTyping };
}
