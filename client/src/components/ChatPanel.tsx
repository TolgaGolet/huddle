import { useState, useRef, useCallback } from "react";
import type { AppSocket, ChatMessage, ChatEntry } from "../types";
import { isDragLeavingContainer } from "../lib/dragLeave";
import MessageList from "./MessageList";
import Composer, { type ComposerHandle } from "./Composer";

interface Props {
  socket: AppSocket | null;
  httpToken: string | null;
  chatHistory: ChatEntry[];
  pinnedMessageId: string | null;
  /** Stable identity, for "is this mine?" checks. */
  localUserId: string;
  roomId: string;
  canPin?: boolean;
}

export default function ChatPanel({ socket, httpToken, chatHistory, pinnedMessageId, localUserId, roomId, canPin }: Props) {
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const composerRef = useRef<ComposerHandle>(null);
  const isAtBottomRef = useRef(true);

  const focusComposer = useCallback(() => composerRef.current?.focus(), []);

  const startReply = useCallback((msg: ChatMessage) => {
    setReplyingTo(msg);
    requestAnimationFrame(focusComposer);
  }, [focusComposer]);

  return (
    <div
      className="relative flex flex-col h-full"
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(event) => {
        if (isDragLeavingContainer(event.currentTarget, event.relatedTarget)) setIsDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragging(false);
        composerRef.current?.addImages(event.dataTransfer.files);
      }}
    >
      {isDragging && (
        <div className="absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-indigo-400 bg-gray-950/90 text-indigo-300 pointer-events-none">
          Drop images to send
        </div>
      )}
      <MessageList
        socket={socket}
        chatHistory={chatHistory}
        pinnedMessageId={pinnedMessageId}
        localUserId={localUserId}
        canPin={canPin}
        isAtBottomRef={isAtBottomRef}
        onReply={startReply}
        onFocusComposer={focusComposer}
      />
      <Composer
        ref={composerRef}
        socket={socket}
        httpToken={httpToken}
        roomId={roomId}
        replyingTo={replyingTo}
        onReplyingToChange={setReplyingTo}
        onBeforeSend={() => { isAtBottomRef.current = true; }}
      />
    </div>
  );
}
