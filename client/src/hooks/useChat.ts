import { useEffect, useReducer } from "react";
import type { AppSocket, ChatEntry, ServerToClientEvents } from "../types";
import { chatReducer, INITIAL_CHAT_STATE } from "../lib/chatReducer";

/** Chat history and the pin. Must be subscribed before the join is sent (see RoomChat). */
export function useChat(socket: AppSocket | null) {
  const [state, dispatch] = useReducer(chatReducer, INITIAL_CHAT_STATE);

  useEffect(() => {
    if (!socket) return;
    const onRoomJoined: ServerToClientEvents["room-joined"] = (data) =>
      dispatch({ type: "joined", history: data.chatHistory, pinnedMessageId: data.pinnedMessageId });
    const onAdded = (entry: ChatEntry) => dispatch({ type: "added", entry });
    const onReactions: ServerToClientEvents["chat-reaction-update"] = ({ messageId, reactions }) =>
      dispatch({ type: "reactions", messageId, reactions });
    const onEdited: ServerToClientEvents["chat-message-edit"] = ({ messageId, text }) => dispatch({ type: "edited", messageId, text });
    const onDeleted: ServerToClientEvents["chat-message-delete"] = ({ messageId }) => dispatch({ type: "deleted", messageId });
    const onPinned: ServerToClientEvents["chat-pin-update"] = ({ pinnedMessageId }) => dispatch({ type: "pinned", pinnedMessageId });
    const onPollUpdated: ServerToClientEvents["poll-update"] = (poll) => dispatch({ type: "poll-updated", poll });

    socket.on("room-joined", onRoomJoined);
    socket.on("chat-message", onAdded);
    socket.on("poll-create", onAdded);
    socket.on("chat-reaction-update", onReactions);
    socket.on("chat-message-edit", onEdited);
    socket.on("chat-message-delete", onDeleted);
    socket.on("chat-pin-update", onPinned);
    socket.on("poll-update", onPollUpdated);
    return () => {
      socket.off("room-joined", onRoomJoined);
      socket.off("chat-message", onAdded);
      socket.off("poll-create", onAdded);
      socket.off("chat-reaction-update", onReactions);
      socket.off("chat-message-edit", onEdited);
      socket.off("chat-message-delete", onDeleted);
      socket.off("chat-pin-update", onPinned);
      socket.off("poll-update", onPollUpdated);
    };
  }, [socket]);

  return state;
}
