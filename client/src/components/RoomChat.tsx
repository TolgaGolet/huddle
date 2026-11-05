import { memo } from "react";
import type { AppSocket } from "../types";
import { useChat } from "../hooks/useChat";
import { ImageSessionContext } from "../lib/imageSessionContext";
import ChatPanel from "./ChatPanel";
import ErrorBoundary, { ChatCrashed } from "./ErrorBoundary";

interface Props {
  socket: AppSocket | null;
  httpToken: string | null;
  imageSession: number;
  localUserId: string;
  roomId: string;
  canPin?: boolean;
  canSendMessages?: boolean;
}

/**
 * Holds chat state below RoomCall, so a message doesn't re-render the call UI.
 * Outside the boundary, so "Reload chat" keeps the history. As RoomCall's child,
 * its effects run before useWebRTC's, which sends the join, so `room-joined` can't
 * arrive before useChat is listening.
 */
function RoomChat({ socket, httpToken, imageSession, localUserId, roomId, canPin, canSendMessages }: Props) {
  const { history, pinnedMessageId } = useChat(socket);
  return (
    <ErrorBoundary fallback={ChatCrashed}>
      <ImageSessionContext value={imageSession}>
        <ChatPanel
          socket={socket}
          httpToken={httpToken}
          chatHistory={history}
          pinnedMessageId={pinnedMessageId}
          localUserId={localUserId}
          roomId={roomId}
          canPin={canPin}
          canSendMessages={canSendMessages}
        />
      </ImageSessionContext>
    </ErrorBoundary>
  );
}

export default memo(RoomChat);
