import { memo, useState, useRef, useEffect, useCallback, useMemo } from "react";
import { ChevronDown, Pin, X } from "lucide-react";
import type { AppSocket, ChatEntry, ChatMessage } from "../types";
import { isPollMessage } from "../types";
import { avatarTextColor } from "../lib/avatarColor";
import { isEditable } from "../lib/messageEdit";
import PollDisplay from "./PollDisplay";
import MessageItem, { type MessageActions } from "./MessageItem";
import MessageContextMenu from "./MessageContextMenu";
import ImageLightbox from "./ImageLightbox";
import DeleteMessageDialog from "./DeleteMessageDialog";

interface Props {
  socket: AppSocket | null;
  chatHistory: ChatEntry[];
  pinnedMessageId: string | null;
  /** socket id, for authorizing image requests. */
  localId: string;
  /** Stable identity, for "is this mine?" checks. */
  localUserId: string;
  isAtBottomRef: React.RefObject<boolean>;
  onReply: (msg: ChatMessage) => void;
  /** Sends focus to the composer once the focused message is gone. */
  onFocusComposer: () => void;
}

interface ContextMenuState {
  messageId: string;
  x: number;
  y: number;
}

function MessageList({ socket, chatHistory, pinnedMessageId, localId, localUserId, isAtBottomRef, onReply, onFocusComposer }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevHistoryLenRef = useRef(chatHistory.length);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const pinnedMessage = useMemo(
    () => chatHistory.find((entry) => entry.id === pinnedMessageId) ?? null,
    [chatHistory, pinnedMessageId],
  );
  const contextMenuEntry = contextMenu && chatHistory.find((entry) => entry.id === contextMenu.messageId);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 50;
    isAtBottomRef.current = atBottom;
    setShowScrollDown(!atBottom);
    if (atBottom) setNewMessageCount(0);
  }, [isAtBottomRef]);

  const scrollPinnedToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el || !isAtBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [isAtBottomRef]);

  useEffect(() => {
    const prevLen = prevHistoryLenRef.current;
    const newLen = chatHistory.length;
    prevHistoryLenRef.current = newLen;
    if (newLen <= prevLen) return;

    if (isAtBottomRef.current) {
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }));
    } else {
      setNewMessageCount((c) => c + (newLen - prevLen));
    }
  }, [chatHistory.length, isAtBottomRef]);

  // Observe the inner content column (not the overflow viewport): the scroll
  // container's box stays fixed height, so RO on it never fires when GIFs load
  // and grow scrollHeight. The inner wrapper's block size does change.
  useEffect(() => {
    const scrollEl = scrollContainerRef.current;
    const contentEl = messagesContentRef.current;
    if (!scrollEl || !contentEl) return;
    const ro = new ResizeObserver(() => {
      if (isAtBottomRef.current) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
      }
    });
    ro.observe(contentEl);
    return () => ro.disconnect();
  }, [isAtBottomRef]);

  function scrollToBottom() {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    setNewMessageCount(0);
    setShowScrollDown(false);
  }

  const scrollToMessage = useCallback((messageId: string) => {
    const el = messageRefs.current.get(messageId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("bg-indigo-500/10");
      setTimeout(() => el.classList.remove("bg-indigo-500/10"), 1500);
    }
  }, []);

  const setMessageRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) {
      messageRefs.current.set(id, el);
    } else {
      messageRefs.current.delete(id);
    }
  }, []);

  /** The element of a message that takes keyboard focus. */
  function messageFocusTarget(id: string): HTMLElement | null {
    const el = messageRefs.current.get(id);
    if (!el) return null;
    return el.matches("[tabindex]") ? el : el.querySelector<HTMLElement>("[tabindex]");
  }

  function closeContextMenu() {
    if (contextMenu) messageFocusTarget(contextMenu.messageId)?.focus();
    setContextMenu(null);
  }

  const dismissContextMenu = useCallback(() => setContextMenu(null), []);

  const openContextMenu = useCallback((entry: ChatEntry, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const container = scrollContainerRef.current?.getBoundingClientRect();
    // Estimated menu size (min-w-40 = 160px wide, up to ~130px tall) used to
    // keep the menu clamped inside the scroll container.
    const MENU_W = 160;
    const MENU_H = 130;
    let x = container ? rect.left - container.left : rect.left;
    let y = container ? rect.bottom - container.top : rect.bottom;
    if (container) {
      x = Math.min(x, container.width - MENU_W - 8);
      y = Math.min(y, container.height - MENU_H - 8);
    }
    x = Math.max(8, x);
    y = Math.max(8, y);
    setContextMenu({ messageId: entry.id, x, y });
  }, []);

  const handleReaction = useCallback((messageId: string, emoji: string) => {
    if (!socket) return;
    socket.emit("chat-reaction", { messageId, emoji });
  }, [socket]);

  const handlePollVote = useCallback((pollId: string, optionId: string) => {
    if (!socket) return;
    socket.emit("poll-vote", { pollId, optionId });
  }, [socket]);

  function handleDeleteMessage(messageId: string) {
    setContextMenu(null);
    setConfirmDeleteId(messageId);
  }

  function confirmDelete() {
    const messageId = confirmDeleteId;
    setConfirmDeleteId(null);
    if (!messageId) return;
    if (editingMessageId === messageId) setEditingMessageId(null);
    socket?.emit("chat-delete", { messageId });
    // The message is about to disappear, so focus can't go back to it.
    requestAnimationFrame(onFocusComposer);
  }

  function startEdit(messageId: string) {
    setContextMenu(null);
    setEditingMessageId(messageId);
  }

  const submitEdit = useCallback((messageId: string, text: string) => {
    if (!socket) return;
    socket.emit("chat-edit", { messageId, text });
    setEditingMessageId(null);
  }, [socket]);

  const cancelEdit = useCallback(() => setEditingMessageId(null), []);

  function handlePinMessage(messageId: string) {
    closeContextMenu();
    socket?.emit("chat-pin", { messageId });
  }

  const actions = useMemo<MessageActions>(() => ({
    registerRef: setMessageRef,
    react: handleReaction,
    reply: onReply,
    openMenu: openContextMenu,
    scrollTo: scrollToMessage,
    viewImage: setLightboxUrl,
    imageLoaded: scrollPinnedToBottom,
    submitEdit,
    cancelEdit,
  }), [setMessageRef, handleReaction, onReply, openContextMenu, scrollToMessage, scrollPinnedToBottom, submitEdit, cancelEdit]);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      {/* Sticky pinned message banner */}
      {pinnedMessage && (
        <div className="z-10 flex items-start gap-2 px-4 py-2 bg-gray-900/95 backdrop-blur border-b border-amber-400/30 shadow-sm shrink-0">
          <Pin size={12} className="text-amber-400 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <button
              type="button"
              onClick={() => scrollToMessage(pinnedMessage.id)}
              className="block w-full text-left cursor-pointer"
            >
              <span className={`text-[11px] font-medium ${avatarTextColor(pinnedMessage.senderName)}`}>
                {pinnedMessage.senderName}
              </span>
              <p className="text-xs text-gray-300 truncate">
                {isPollMessage(pinnedMessage)
                  ? `Poll: ${pinnedMessage.question}`
                  : pinnedMessage.text || (pinnedMessage.imageUrls?.length ? "[Image]" : "[GIF]")}
              </p>
            </button>
          </div>
          <button
            type="button"
            onClick={() => handlePinMessage(pinnedMessage.id)}
            className="touch-target p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors cursor-pointer shrink-0"
            title="Unpin message"
            aria-label="Unpin message"
          >
            <X size={12} />
          </button>
        </div>
      )}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-4 py-3"
      >
        <div ref={messagesContentRef} className="space-y-3">
          {chatHistory.length === 0 && (
            <p className="text-gray-600 text-sm text-center mt-8">No messages yet. Say something!</p>
          )}
          {chatHistory.map((entry) =>
            isPollMessage(entry) ? (
              <div key={entry.id} ref={(el) => setMessageRef(entry.id, el)}>
                <PollDisplay
                  poll={entry}
                  isPinned={entry.id === pinnedMessageId}
                  localUserId={localUserId}
                  onVote={handlePollVote}
                  onContextMenu={openContextMenu}
                />
              </div>
            ) : (
              <MessageItem
                key={entry.id}
                msg={entry}
                isPinned={entry.id === pinnedMessageId}
                isEditing={entry.id === editingMessageId}
                localId={localId}
                localUserId={localUserId}
                actions={actions}
              />
            ),
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Message context menu */}
      {contextMenu && contextMenuEntry && (
        <MessageContextMenu
          messageId={contextMenu.messageId}
          x={contextMenu.x}
          y={contextMenu.y}
          isOwn={contextMenuEntry.senderId === localUserId}
          isPinned={contextMenuEntry.id === pinnedMessageId}
          canEdit={contextMenuEntry.senderId === localUserId && isEditable(contextMenuEntry)}
          onEdit={() => startEdit(contextMenu.messageId)}
          onDelete={() => handleDeleteMessage(contextMenu.messageId)}
          onTogglePin={() => handlePinMessage(contextMenu.messageId)}
          onClose={closeContextMenu}
          onDismiss={dismissContextMenu}
        />
      )}

      {showScrollDown && (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label={newMessageCount > 0 ? `Scroll to the ${newMessageCount} new ${newMessageCount === 1 ? "message" : "messages"}` : "Scroll to the latest message"}
          className="absolute bottom-3 right-4 flex items-center gap-1.5 pl-3 pr-2.5 py-1.5 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium shadow-lg transition-colors cursor-pointer z-10"
        >
          {newMessageCount > 0 && (
            <>
              {newMessageCount} new {newMessageCount === 1 ? "message" : "messages"}
            </>
          )}
          <ChevronDown size={14} />
        </button>
      )}

      {/* Image lightbox */}
      {lightboxUrl && <ImageLightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}

      {/* Delete confirmation dialog */}
      {confirmDeleteId && (
        <DeleteMessageDialog
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={confirmDelete}
          returnFocus={() => messageFocusTarget(confirmDeleteId)}
        />
      )}
    </div>
  );
}

export default memo(MessageList);
