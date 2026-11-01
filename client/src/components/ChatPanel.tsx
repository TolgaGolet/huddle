import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Send, Loader2, Smile, BarChart3, Reply, X, ChevronDown, Image as ImageIcon, MoreVertical, Pencil, Trash2, Pin, PinOff } from "lucide-react";
import type { Socket } from "socket.io-client";
import type { ChatMessage, ChatEntry } from "../types";
import { isPollMessage, MAX_CHAT_TEXT_LENGTH, MAX_IMAGE_SIZE, MAX_IMAGES_PER_MESSAGE } from "../types";
import { formatMessage } from "../lib/messageFormatter";
import { avatarTextColor } from "../lib/avatarColor";
import FormattingToolbar, { applyFormat } from "./FormattingToolbar";
import EmojiPicker from "./EmojiPicker";
import GifPicker from "./GifPicker";
import PollCreator from "./PollCreator";
import PollDisplay from "./PollDisplay";
import { isImageFile, uploadImages } from "../lib/imageUpload";
import { createSendLock } from "../lib/sendLock";
import { hasReacted } from "../lib/reactions";
import { cycleFocus } from "../lib/focusTrap";
import { isSameConnection, replyToSend } from "../lib/sendLock";
import Dialog from "./Dialog";

interface Props {
  socket: Socket | null;
  chatHistory: ChatEntry[];
  pinnedMessageId: string | null;
  /** socket id, for authorizing image requests. */
  localId: string;
  /** Stable identity, for "is this mine?" checks. */
  localUserId: string;
  roomId: string;
  typingUsers: string[];
  notifyTyping: () => void;
}

interface PendingImage { id: string; file: File; previewUrl: string; }

const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "👌"];

interface ContextMenuState {
  messageId: string;
  x: number;
  y: number;
  isOwn: boolean;
  isPinned: boolean;
  isPoll: boolean;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Extract image files from clipboard data (e.g. screenshots copied via
// Snipping Tool, or copied image files in Explorer).
function extractClipboardImages(clipboardData: DataTransfer | null): File[] {
  if (!clipboardData) return [];
  return Array.from(clipboardData.items)
    .map((item) => (item.kind === "file" ? item.getAsFile() : null))
    .filter((file): file is File => !!file && isImageFile(file) && file.size > 0);
}

const CONNECTION_LOST_ERROR = "Connection lost, please try again.";

export default function ChatPanel({ socket, chatHistory, pinnedMessageId, localId, localUserId, roomId, typingUsers, notifyTyping }: Props) {
  const [text, setText] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [showPollCreator, setShowPollCreator] = useState(false);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  // Read after an upload, when the `replyingTo` a send captured may be outdated.
  const replyingToRef = useRef(replyingTo);
  replyingToRef.current = replyingTo;
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const isAtBottomRef = useRef(true);
  const prevHistoryLenRef = useRef(chatHistory.length);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [sendLock] = useState(createSendLock);
  const [sending, setSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const lastTypingSentRef = useRef(0);

  // Human-readable typing indicator, WhatsApp-style:
  // "A is typing..." / "A and B are typing..." / "A, B and 2 others are typing..."
  const typingLabel = useMemo(() => {
    const count = typingUsers.length;
    if (count === 0) return null;
    if (count === 1) return `${typingUsers[0]} is typing...`;
    if (count === 2) return `${typingUsers[0]} and ${typingUsers[1]} are typing...`;
    const shown = typingUsers.slice(0, 2).join(", ");
    const others = count - 2;
    return `${shown} and ${others} ${others === 1 ? "other" : "others"} are typing...`;
  }, [typingUsers]);

  // Throttle typing emissions to at most one per second while the user types.
  const handleTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingSentRef.current >= 1000) {
      lastTypingSentRef.current = now;
      notifyTyping();
    }
  }, [notifyTyping]);

  const pinnedMessage = useMemo(
    () => chatHistory.find((entry) => entry.id === pinnedMessageId) ?? null,
    [chatHistory, pinnedMessageId],
  );

  function addImages(fileList: FileList | File[]) {
    // A successful send clears the draft, which would lose images added now.
    if (sending) return;
    setUploadError(null);
    const accepted: PendingImage[] = [];
    const errors: string[] = [];
    for (const file of Array.from(fileList)) {
      if (pendingImages.length + accepted.length >= MAX_IMAGES_PER_MESSAGE) { errors.push(`You can send up to ${MAX_IMAGES_PER_MESSAGE} images at once.`); break; }
      if (!isImageFile(file)) { errors.push(`${file.name} is not a supported image file.`); continue; }
      if (file.size > MAX_IMAGE_SIZE) { errors.push(`${file.name} is larger than ${MAX_IMAGE_SIZE / (1024 * 1024)} MB.`); continue; }
      accepted.push({ id: `${file.name}-${file.lastModified}-${Math.random()}`, file, previewUrl: URL.createObjectURL(file) });
    }
    if (accepted.length) setPendingImages((current) => [...current, ...accepted]);
    if (errors.length) setUploadError(errors[0]);
  }

  // Extract image files from clipboard data (e.g. screenshots copied via
  // Snipping Tool, or copied image files in Explorer).
  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const images = extractClipboardImages(e.clipboardData);
    if (!images.length) return;
    e.preventDefault();
    addImages(images);
  }

  function removeImage(id: string) {
    setPendingImages((current) => {
      const image = current.find((item) => item.id === id);
      if (image) URL.revokeObjectURL(image.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  }

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 50;
    isAtBottomRef.current = atBottom;
    setShowScrollDown(!atBottom);
    if (atBottom) setNewMessageCount(0);
  }, []);

  const scrollPinnedToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el || !isAtBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, []);

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
  }, [chatHistory.length]);

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
  }, []);

  function scrollToBottom() {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    setNewMessageCount(0);
    setShowScrollDown(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void doSend();
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) return;

    let format: { prefix: string; suffix: string } | null = null;
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "b") format = { prefix: "**", suffix: "**" };
      else if (e.key === "i") format = { prefix: "*", suffix: "*" };
      else if (e.key === "e") format = { prefix: "`", suffix: "`" };
      else if (e.key === "X" && e.shiftKey) format = { prefix: "~~", suffix: "~~" };
    }

    if (format) {
      e.preventDefault();
      if (sending) return;
      const { newText, cursorStart, cursorEnd } = applyFormat(
        textarea,
        text,
        format.prefix,
        format.suffix,
      );
      setText(newText);
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(cursorStart, cursorEnd);
      });
    }
  }

  async function doSend() {
    if ((!text.trim() && !pendingImages.length) || !socket || !socket.id) return;
    // The textarea's maxLength only limits typing; emoji and formatting
    // insertions can push past it. The server drops over-limit messages
    // without a reply, so stop here before clearing (or uploading) anything.
    if (text.trim().length > MAX_CHAT_TEXT_LENGTH) {
      setUploadError(`Message is too long (max ${MAX_CHAT_TEXT_LENGTH} characters).`);
      return;
    }
    const socketId = socket.id;
    const activeSocket = socket;
    await sendLock.run(async () => {
      setSending(true);
      setUploadError(null);
      try {
        await sendDraft(activeSocket, socketId);
      } finally {
        setSending(false);
      }
    });
  }

  /** Uploads the draft's images and sends it; a failed upload keeps the draft. */
  async function sendDraft(activeSocket: Socket, socketId: string) {
    let imageUrls: string[] = [];
    try {
      if (pendingImages.length) imageUrls = await uploadImages(roomId, socketId, pendingImages.map((image) => image.file));
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Failed to upload images");
      return;
    }
    if (!isSameConnection(activeSocket, socketId)) {
      setUploadError(CONNECTION_LOST_ERROR);
      return;
    }
    const payload: { text: string; imageUrls?: string[]; replyTo?: { id: string; senderName: string; text: string; imageUrl?: string } } = {
      text: text.trim(),
    };
    if (imageUrls.length) payload.imageUrls = imageUrls;
    const reply = replyToSend(replyingTo, replyingToRef.current);
    if (reply) {
      payload.replyTo = {
        id: reply.id,
        senderName: reply.senderName,
        text: reply.text || (reply.imageUrls?.length ? "[Image]" : ""),
        imageUrl: reply.imageUrls?.[0],
      };
    }
    isAtBottomRef.current = true;
    activeSocket.emit("chat-message", payload);
    pendingImages.forEach((image) => URL.revokeObjectURL(image.previewUrl));
    setPendingImages([]);
    setText("");
    // Keep a reply the user started while the upload was running.
    setReplyingTo((current) => (current === replyingTo ? null : current));
    textareaRef.current?.focus();
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    void doSend();
  }

  function handleReaction(messageId: string, emoji: string) {
    if (!socket) return;
    socket.emit("chat-reaction", { messageId, emoji });
  }

  function handlePollVote(pollId: string, optionId: string) {
    if (!socket) return;
    socket.emit("poll-vote", { pollId, optionId });
  }

  function handleCreatePoll(data: { question: string; options: string[]; allowMultiple: boolean }) {
    if (!socket) return;
    isAtBottomRef.current = true;
    socket.emit("poll-create", data);
  }

  function handleGifSelect(gifUrl: string, gifTitle: string) {
    if (!socket || sending) return;
    if (!socket.connected) {
      setUploadError(CONNECTION_LOST_ERROR);
      return;
    }
    const payload: { text: string; gifUrl: string; replyTo?: { id: string; senderName: string; text: string } } = {
      text: gifTitle,
      gifUrl,
    };
    if (replyingTo) {
      payload.replyTo = {
        id: replyingTo.id,
        senderName: replyingTo.senderName,
        text: replyingTo.text,
      };
      setReplyingTo(null);
    }
    isAtBottomRef.current = true;
    socket.emit("chat-message", payload);
  }

  function handleEmojiSelect(emoji: string) {
    if (sending) return;
    const textarea = textareaRef.current;
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newText = text.slice(0, start) + emoji + text.slice(end);
      setText(newText);
      const newPos = start + emoji.length;
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(newPos, newPos);
      });
    } else {
      setText(text + emoji);
    }
  }

  function scrollToMessage(messageId: string) {
    const el = messageRefs.current.get(messageId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("bg-indigo-500/10");
      setTimeout(() => el.classList.remove("bg-indigo-500/10"), 1500);
    }
  }

  function setMessageRef(id: string, el: HTMLDivElement | null) {
    if (el) {
      messageRefs.current.set(id, el);
    } else {
      messageRefs.current.delete(id);
    }
  }

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

  function handleContextMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" || e.key === "Tab") {
      // Tab isn't prevented: it carries on from the message the menu belongs to.
      closeContextMenu();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      cycleFocus([...e.currentTarget.querySelectorAll("button")], e.key === "ArrowUp");
    }
  }

  function startReply(msg: ChatMessage) {
    setReplyingTo(msg);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function openContextMenu(entry: ChatEntry, e: React.MouseEvent) {
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
    setContextMenu({
      messageId: entry.id,
      x,
      isOwn: entry.senderId === localUserId,
      y,
      isPinned: entry.id === pinnedMessageId,
      isPoll: isPollMessage(entry),
    });
  }

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
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function startEdit(msg: ChatMessage) {
    setContextMenu(null);
    setEditingMessageId(msg.id);
    setEditText(msg.text);
    requestAnimationFrame(() => editTextareaRef.current?.focus());
  }

  function submitEdit() {
    // Over-limit edits would be dropped by the server; keep the editor open.
    const trimmed = editText.trim();
    if (!editingMessageId || !socket || !trimmed || trimmed.length > MAX_CHAT_TEXT_LENGTH) return;
    socket.emit("chat-edit", { messageId: editingMessageId, text: trimmed });
    setEditingMessageId(null);
    setEditText("");
  }

  function handlePinMessage(messageId: string) {
    closeContextMenu();
    socket?.emit("chat-pin", { messageId });
  }

  // Close the emoji, GIF and poll popovers with Escape while one is open.
  const popoverOpen = showEmojiPicker || showGifPicker || showPollCreator;
  useEffect(() => {
    if (!popoverOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setShowEmojiPicker(false);
      setShowGifPicker(false);
      setShowPollCreator(false);
      textareaRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [popoverOpen]);

  // Move focus into the context menu when it opens, so keyboard users land on
  // it rather than having to Tab past every later message.
  const contextMenuMessageId = contextMenu?.messageId;
  useEffect(() => {
    if (contextMenuMessageId) contextMenuRef.current?.querySelector("button")?.focus();
  }, [contextMenuMessageId]);

  // Close the context menu on any click outside of it.
  useEffect(() => {
    if (!contextMenu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-context-menu]")) setContextMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [contextMenu]);

  function renderChatMessage(msg: ChatMessage) {
    const reactions = msg.reactions || {};
    const reactionEntries = Object.entries(reactions).filter(([, users]) => users.length > 0);
    const isEditing = editingMessageId === msg.id;
    const isPinned = msg.id === pinnedMessageId;
    const editTooLong = isEditing && editText.trim().length > MAX_CHAT_TEXT_LENGTH;

    return (
      <div
        key={msg.id}
        ref={(el) => setMessageRef(msg.id, el)}
        role="group"
        aria-label={`Message from ${msg.senderName}`}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard route to a message; focusing it reveals the action bar and adds its buttons to the Tab order.
        tabIndex={0}
        className={`group relative rounded-lg px-2 py-1 -mx-2 transition-colors hover:bg-gray-800/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 ${
          isPinned ? "border-l-2 border-amber-400/70" : ""
        }`}
      >
        {isPinned && (
          <span className="inline-flex items-center gap-1 text-[10px] text-amber-400 mb-0.5">
            <Pin size={9} /> Pinned
          </span>
        )}
        {/* Reply quote */}
        {msg.replyTo && (
          <div className="flex items-center gap-1.5 mb-1 pl-2 border-l-2 border-indigo-500/50 rounded-r py-0.5 pr-2">
            <button
              type="button"
              onClick={() => scrollToMessage(msg.replyTo!.id)}
              aria-label={`Go to the message from ${msg.replyTo.senderName} this replies to`}
              className="flex items-center gap-1.5 min-w-0 cursor-pointer hover:bg-gray-800/60 rounded transition-colors"
            >
              <Reply size={10} className="text-gray-500 shrink-0" />
              <span className="text-[11px] text-indigo-400 font-medium shrink-0">{msg.replyTo.senderName}</span>
              {!msg.replyTo.imageUrl && (
                <span className="text-[11px] text-gray-500 truncate max-w-48">{msg.replyTo.text || "[Image]"}</span>
              )}
            </button>
            {msg.replyTo.imageUrl && (
              <button
                type="button"
                onClick={() => setLightboxUrl(`${msg.replyTo!.imageUrl}?socketId=${encodeURIComponent(localId)}`)}
                className="shrink-0 cursor-zoom-in"
                title="View image"
              >
                <img
                  src={`${msg.replyTo.imageUrl}?socketId=${encodeURIComponent(localId)}`}
                  alt={`Sent by ${msg.replyTo.senderName}`}
                  className="h-8 w-8 rounded object-cover"
                  // The quoted image may have been deleted since.
                  onError={(e) => e.currentTarget.parentElement?.classList.add("hidden")}
                />
              </button>
            )}
          </div>
        )}

        <div className="flex items-baseline gap-2">
          <span className={`text-sm font-semibold ${avatarTextColor(msg.senderName)}`}>
            {msg.senderName}
          </span>
          <span className="text-[10px] text-gray-600">{formatTime(msg.timestamp)}</span>
        </div>

        {msg.gifUrl ? (
          <div className="mt-1">
            <a href="https://giphy.com" target="_blank" rel="noopener noreferrer" className="group/gif inline-block">
              <img
                src={msg.gifUrl}
                alt={msg.text || "GIF"}
                className="rounded-lg max-w-full object-cover group-hover/gif:brightness-90 transition-all"
                style={{ maxHeight: 200, maxWidth: 260 }}
                loading="eager"
                onLoad={scrollPinnedToBottom}
              />
            </a>
            <p className="text-[10px] text-gray-600 mt-0.5">
              via{" "}
              <a href="https://giphy.com" target="_blank" rel="noopener noreferrer" className="hover:text-gray-400 transition-colors">
                GIPHY
              </a>
            </p>
          </div>
        ) : (
          <>
            {msg.imageUrls?.length ? (
              <div className="mt-1 grid grid-cols-2 gap-1.5 max-w-sm">
                {msg.imageUrls.map((url) => {
                  const imageUrl = `${url}?socketId=${encodeURIComponent(localId)}`;
                  return (
                    <button
                      key={url}
                      type="button"
                      onClick={() => setLightboxUrl(imageUrl)}
                      className="cursor-zoom-in"
                      title="View image"
                    >
                      <img src={imageUrl} alt={`Sent by ${msg.senderName}`} className="rounded-lg max-h-48 w-full object-cover hover:brightness-90 transition-all" loading="lazy" onLoad={scrollPinnedToBottom} />
                    </button>
                  );
                })}
              </div>
            ) : null}
            {isEditing ? (
              <>
              <div className="mt-1 flex items-center gap-1.5">
                <textarea
                  ref={editTextareaRef}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  maxLength={MAX_CHAT_TEXT_LENGTH}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitEdit(); }
                    if (e.key === "Escape") { setEditingMessageId(null); setEditText(""); }
                  }}
                  rows={1}
                  aria-label="Edit message"
                  className="flex-1 px-2 py-1 rounded bg-gray-800 border border-indigo-500 text-sm text-white focus:outline-none resize-none"
                  autoFocus
                />
                <button type="button" onClick={submitEdit} disabled={editTooLong} className="disabled:opacity-50 disabled:cursor-not-allowed px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-xs text-white cursor-pointer transition-colors">Save</button>
                <button type="button" onClick={() => { setEditingMessageId(null); setEditText(""); }} className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-xs text-gray-200 cursor-pointer transition-colors">Cancel</button>
              </div>
              {editTooLong && (
                <p role="alert" className="mt-1 text-xs text-red-400">Message is too long (max {MAX_CHAT_TEXT_LENGTH} characters).</p>
              )}
              </>
            ) : (
              msg.text && (
                <div className="text-sm text-gray-300 leading-relaxed">
                  {formatMessage(msg.text)}
                  {msg.edited && <span className="text-[10px] text-gray-500 ml-1.5">(edited)</span>}
                </div>
              )
            )}
          </>
        )}

        {/* Reaction badges */}
        {reactionEntries.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {reactionEntries.map(([emoji, users]) => {
              const names = users.map((u) => u.name).join(", ");
              const reacted = hasReacted(users, localUserId);
              return (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => handleReaction(msg.id, emoji)}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs border transition-colors cursor-pointer ${
                    reacted
                      ? "border-indigo-500/50 bg-indigo-500/10"
                      : "border-gray-700 bg-gray-800/60 hover:border-gray-600"
                  }`}
                  title={names}
                  aria-pressed={reacted}
                  aria-label={`${emoji} reaction, ${users.length} ${users.length === 1 ? "person" : "people"}: ${names}`}
                >
                  <span>{emoji}</span>
                  <span className="text-gray-400">{users.length}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Action bar on hover or keyboard focus */}
        <div className="absolute -top-3 right-0 hidden group-hover:flex group-has-[:focus-visible]:flex items-center bg-gray-800 border border-gray-700 rounded-lg shadow-lg overflow-hidden">
          {REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => handleReaction(msg.id, emoji)}
              className="px-1.5 py-1 hover:bg-gray-700 transition-colors cursor-pointer text-sm"
              title={emoji}
              aria-label={`React with ${emoji}`}
            >
              {emoji}
            </button>
          ))}
          <button
            type="button"
            onClick={() => startReply(msg)}
            className="px-2 py-1 hover:bg-gray-700 transition-colors cursor-pointer text-gray-400 hover:text-gray-200 border-l border-gray-700"
            title="Reply"
            aria-label="Reply"
          >
            <Reply size={13} />
          </button>
          <button
            type="button"
            onClick={(e) => openContextMenu(msg, e)}
            className="px-1.5 py-1 hover:bg-gray-700 transition-colors cursor-pointer text-gray-400 hover:text-gray-200 border-l border-gray-700"
            title="More actions"
            aria-label="More actions"
            aria-haspopup="menu"
          >
            <MoreVertical size={13} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col h-full" onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }} onDrop={(event) => { event.preventDefault(); setIsDragging(false); addImages(event.dataTransfer.files); }}>
      {isDragging && <div className="absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-indigo-400 bg-gray-950/90 text-indigo-300 pointer-events-none">Drop images to send</div>}
      {/* Messages list */}
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
                  {"type" in pinnedMessage
                    ? `Poll: ${pinnedMessage.question}`
                    : pinnedMessage.text || (pinnedMessage.imageUrls?.length ? "[Image]" : "[GIF]")}
                </p>
              </button>
            </div>
            <button
              type="button"
              onClick={() => handlePinMessage(pinnedMessage.id)}
              className="p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors cursor-pointer shrink-0"
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
                renderChatMessage(entry)
              ),
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Message context menu */}
        {contextMenu && (
          <div
            ref={contextMenuRef}
            data-context-menu
            role="menu"
            aria-label="Message actions"
            tabIndex={-1}
            onKeyDown={handleContextMenuKeyDown}
            style={{ left: contextMenu.x, top: contextMenu.y }}
            className="absolute z-30 min-w-40 py-1 rounded-lg bg-gray-800 border border-gray-700 shadow-xl"
          >
            {contextMenu.isOwn && !contextMenu.isPoll && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const msg = chatHistory.find((m) => m.id === contextMenu.messageId);
                  if (msg && !isPollMessage(msg) && msg.text) startEdit(msg);
                  else setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 transition-colors cursor-pointer"
              >
                <Pencil size={12} /> Edit message
              </button>
            )}
            {contextMenu.isOwn && (
              <button
                type="button"
                role="menuitem"
                onClick={() => handleDeleteMessage(contextMenu.messageId)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-gray-700 transition-colors cursor-pointer"
              >
                <Trash2 size={12} /> Delete message
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => handlePinMessage(contextMenu.messageId)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 transition-colors cursor-pointer"
            >
              {contextMenu.isPinned ? <PinOff size={12} /> : <Pin size={12} />}
              {contextMenu.isPinned ? "Unpin message" : "Pin message"}
            </button>
          </div>
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
        {lightboxUrl && (
          <Dialog
            onClose={() => setLightboxUrl(null)}
            label="Image preview"
            closeOnBackdrop
            overlayClassName="absolute inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
            panelClassName="relative max-h-full max-w-full focus:outline-none"
          >
            <button
              type="button"
              onClick={() => setLightboxUrl(null)}
              className="absolute -top-2 -right-2 z-10 rounded-full bg-gray-800 border border-gray-600 p-1.5 text-gray-300 hover:text-white hover:bg-gray-700 transition-colors cursor-pointer shadow-lg"
              title="Close"
              aria-label="Close image preview"
            >
              <X size={16} />
            </button>
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- click-to-close is a mouse shortcut; the Close button and Escape are the keyboard routes. */}
            <img
              src={lightboxUrl}
              alt="Preview"
              className="max-h-full max-w-full rounded-lg shadow-2xl"
              onClick={() => setLightboxUrl(null)}
            />
          </Dialog>
        )}

        {/* Delete confirmation dialog */}
        {confirmDeleteId && (
          <Dialog
            onClose={() => setConfirmDeleteId(null)}
            labelledBy="delete-dialog-title"
            closeOnBackdrop
            returnFocus={() => messageFocusTarget(confirmDeleteId)}
            overlayClassName="absolute inset-0 z-40 flex items-center justify-center bg-black/60"
            panelClassName="mx-4 w-72 rounded-xl bg-gray-800 border border-gray-700 shadow-2xl p-4 focus:outline-none"
          >
            <div className="flex items-center gap-2 mb-2">
              <Trash2 size={14} className="text-red-400" />
              <h3 id="delete-dialog-title" className="text-sm font-semibold text-white">Delete message?</h3>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              This message will be removed for everyone in the room. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteId(null)}
                className="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-xs text-gray-200 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-xs text-white transition-colors cursor-pointer"
              >
                Delete
              </button>
            </div>
          </Dialog>
        )}
      </div>

      {/* Input area */}
      <div className="px-4 pb-4 relative">
        {/* Typing indicator */}
        {typingLabel && (
          <p className="mb-1 h-4 text-[11px] text-indigo-400 italic truncate" aria-live="polite">
            {typingLabel}
          </p>
        )}

        {/* Reply preview */}
        {replyingTo && (
          <div className="flex items-center gap-2 mb-2 px-3 py-2 bg-gray-800/60 border border-gray-700 rounded-lg">
            <Reply size={12} className="text-indigo-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="text-xs text-indigo-400 font-medium">{replyingTo.senderName}</span>
              {replyingTo.imageUrls?.[0] ? (
                <img
                  src={`${replyingTo.imageUrls[0]}?socketId=${encodeURIComponent(localId)}`}
                  alt={`Sent by ${replyingTo.senderName}`}
                  className="mt-1 h-8 w-8 rounded object-cover"
                />
              ) : (
                <p className="text-xs text-gray-500 truncate">{replyingTo.text || "[Image]"}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setReplyingTo(null)}
              aria-label="Cancel reply"
              className="p-1 rounded hover:bg-gray-700 text-gray-500 hover:text-gray-300 transition-colors cursor-pointer"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {/* Popovers — outside the form to avoid nested-form issues */}
        {showEmojiPicker && (
          <EmojiPicker
            onSelect={handleEmojiSelect}
            onClose={() => setShowEmojiPicker(false)}
          />
        )}
        {showGifPicker && (
          <GifPicker
            onSelect={handleGifSelect}
            onClose={() => setShowGifPicker(false)}
          />
        )}
        {showPollCreator && (
          <PollCreator
            onSubmit={handleCreatePoll}
            onClose={() => setShowPollCreator(false)}
          />
        )}

        <input ref={fileInputRef} type="file" accept="image/*" multiple aria-label="Choose images to send" className="hidden" onChange={(event) => {
          if (event.target.files) addImages(event.target.files);
          event.target.value = "";
        }} />
        {pendingImages.length > 0 && <div className="mb-2 rounded-lg border border-indigo-500/40 bg-indigo-500/10 p-2">
          <div className="mb-1 text-[11px] font-medium text-indigo-300">Images ready to send ({pendingImages.length}/{MAX_IMAGES_PER_MESSAGE})</div>
          <div className="flex gap-2 overflow-x-auto">
            {pendingImages.map((image) => <div key={image.id} className="relative shrink-0 rounded-md border border-gray-600 bg-gray-900/70 p-1">
              <img src={image.previewUrl} alt={image.file.name} className="h-16 w-16 rounded object-cover" />
              <button type="button" onClick={() => removeImage(image.id)} disabled={sending} className="absolute -right-1.5 -top-1.5 rounded-full bg-gray-900 border border-gray-600 p-0.5 text-gray-300 hover:text-white cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed" title="Remove image" aria-label={`Remove ${image.file.name}`}><X size={11} /></button>
            </div>)}
          </div>
        </div>}
        {uploadError && <p className="mb-1 text-xs text-red-400">{uploadError}</p>}
        {pendingImages.length > 0 && <p className="mb-1 text-[10px] text-gray-600">Images are temporarily stored and deleted when the room ends. Password-protected rooms encrypt uploaded images at rest; chat messages are not encrypted.</p>}
        <form onSubmit={send} className="space-y-1">
          {/* Formatting toolbar row */}
          <fieldset disabled={sending} className="min-w-0 disabled:opacity-50">
          <div className="flex items-center justify-between">
            <FormattingToolbar textareaRef={textareaRef} text={text} setText={setText} />
            <div className="flex items-center gap-0.5">
              <button type="button" onClick={() => fileInputRef.current?.click()} className="p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors cursor-pointer" title="Send images" aria-label="Send images">
                <ImageIcon size={14} />
              </button>
              <button
                type="button"
                onClick={() => { setShowPollCreator((v) => !v); setShowEmojiPicker(false); setShowGifPicker(false); }}
                className="p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors cursor-pointer"
                title="Create poll"
                aria-label="Create poll"
              >
                <BarChart3 size={14} />
              </button>
              <button
                type="button"
                onClick={() => { setShowGifPicker((v) => !v); setShowEmojiPicker(false); setShowPollCreator(false); }}
                className={`px-1.5 py-1 rounded text-xs font-bold tracking-tight transition-colors cursor-pointer ${
                  showGifPicker
                    ? "bg-indigo-600 text-white"
                    : "text-gray-400 hover:text-gray-200 hover:bg-gray-700"
                }`}
                title="Send a GIF"
              >
                GIF
              </button>
              <button
                type="button"
                onClick={() => { setShowEmojiPicker((v) => !v); setShowPollCreator(false); setShowGifPicker(false); }}
                className="p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors cursor-pointer"
                title="Emoji"
                aria-label="Emoji"
              >
                <Smile size={14} />
              </button>
            </div>
          </div>
          </fieldset>

          {/* Textarea + send */}
          <div className="flex gap-2">
            <textarea
              ref={textareaRef}
              value={text}
              readOnly={sending}
              onChange={(e) => { setText(e.target.value); handleTyping(); }}
              maxLength={MAX_CHAT_TEXT_LENGTH}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="Type a message..."
              aria-label="Message"
              rows={1}
              className="flex-1 px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors resize-none min-h-[36px] max-h-28 overflow-y-auto"
              style={{ height: "auto" }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = "auto";
                target.style.height = Math.min(target.scrollHeight, 112) + "px";
              }}
            />
            <button
              type="submit"
              disabled={sending || (!text.trim() && !pendingImages.length)}
              aria-busy={sending}
              aria-label="Send message"
              className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer self-end"
            >
              {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
