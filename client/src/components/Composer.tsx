import { useState, useRef, useEffect, useImperativeHandle, useLayoutEffect } from "react";
import { Send, Loader2, Smile, BarChart3, Reply, X, Image as ImageIcon } from "lucide-react";
import type { AppSocket, ChatMessage, ClientToServerEvents } from "../types";
import { createBucket, MAX_CHAT_TEXT_LENGTH, MAX_IMAGES_PER_MESSAGE, RATE_LIMITS } from "../types";
import FormattingToolbar, { formatForShortcut, formatSelection, restoreSelection } from "./FormattingToolbar";
import EmojiPicker from "./EmojiPicker";
import GifPicker from "./GifPicker";
import PollCreator from "./PollCreator";
import RoomImage from "./RoomImage";
import { useImageDraft } from "../hooks/useImageDraft";
import { useTyping } from "../hooks/useTyping";
import { isImageFile, uploadImages } from "../lib/imageUpload";
import { CONNECTION_LOST_ERROR, createSendLock, isSameConnection, replyToSend, reusableUploadUrls, uploadErrorMessage, type UploadedImages } from "../lib/sendLock";
import { fitToContent } from "../lib/textareaHeight";

export interface ComposerHandle {
  addImages: (fileList: FileList | File[]) => void;
  focus: () => void;
}

interface Props {
  ref: React.Ref<ComposerHandle>;
  socket: AppSocket | null;
  httpToken: string | null;
  roomId: string;
  replyingTo: ChatMessage | null;
  onReplyingToChange: React.Dispatch<React.SetStateAction<ChatMessage | null>>;
  /** Called just before anything is sent, so the list follows the new entry. */
  onBeforeSend: () => void;
}

type Popover = "emoji" | "gif" | "poll";
type ChatMessagePayload = Parameters<ClientToServerEvents["chat-message"]>[0];

// Human-readable typing indicator, WhatsApp-style:
// "A is typing..." / "A and B are typing..." / "A, B and 2 others are typing..."
function typingText(typingUsers: string[]): string | null {
  const count = typingUsers.length;
  if (count === 0) return null;
  if (count === 1) return `${typingUsers[0]} is typing...`;
  if (count === 2) return `${typingUsers[0]} and ${typingUsers[1]} are typing...`;
  const shown = typingUsers.slice(0, 2).join(", ");
  const others = count - 2;
  return `${shown} and ${others} ${others === 1 ? "other" : "others"} are typing...`;
}

// Extract image files from clipboard data (e.g. screenshots copied via
// Snipping Tool, or copied image files in Explorer).
function extractClipboardImages(clipboardData: DataTransfer | null): File[] {
  if (!clipboardData) return [];
  return Array.from(clipboardData.items)
    .map((item) => (item.kind === "file" ? item.getAsFile() : null))
    .filter((file): file is File => !!file && isImageFile(file) && file.size > 0);
}

const SENDING_TOO_FAST_ERROR = "You're sending messages too fast.";
const SERVER_LIMIT_ERROR = "You're doing that too fast.";
const SERVER_LIMIT_ERROR_MS = 4000;

export default function Composer({ ref, socket, httpToken, roomId, replyingTo, onReplyingToChange, onBeforeSend }: Props) {
  const [text, setText] = useState("");
  const [openPopover, setOpenPopover] = useState<Popover | null>(null);
  // Read after an upload, when the `replyingTo` a send captured may be outdated.
  const replyingToRef = useRef(replyingTo);
  replyingToRef.current = replyingTo;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { images: pendingImages, add: addToDraft, remove: removeImage, clear: clearDraft } = useImageDraft();
  const { typingUsers, notifyTyping } = useTyping(socket);
  const uploadedRef = useRef<UploadedImages | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [sendLock] = useState(createSendLock);
  // Same limit as the server, checked first: the draft is cleared on send, so a
  // message the server dropped would be lost.
  const [sendBucket] = useState(() => createBucket(RATE_LIMITS.messages));
  const [sending, setSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastTypingSentRef = useRef(0);

  const typingLabel = typingText(typingUsers);

  // Throttle typing emissions to at most one per second while the user types.
  function handleTyping() {
    const now = Date.now();
    if (now - lastTypingSentRef.current >= 1000) {
      lastTypingSentRef.current = now;
      notifyTyping();
    }
  }

  function togglePopover(popover: Popover) {
    setOpenPopover((current) => (current === popover ? null : popover));
  }

  /** Spends a send token, or shows the error and returns false. */
  function takeSendToken(): boolean {
    if (sendBucket.take()) return true;
    setUploadError(SENDING_TOO_FAST_ERROR);
    return false;
  }

  function addImages(fileList: FileList | File[]) {
    // A successful send clears the draft, which would lose images added now.
    if (sending) return;
    setUploadError(null);
    const problem = addToDraft(fileList);
    if (problem) setUploadError(problem);
  }

  useImperativeHandle(ref, () => ({
    addImages,
    focus: () => textareaRef.current?.focus(),
  }));

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const images = extractClipboardImages(e.clipboardData);
    if (!images.length) return;
    e.preventDefault();
    addImages(images);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void doSend();
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) return;

    const format = formatForShortcut(e);
    if (format) {
      e.preventDefault();
      if (!sending) formatSelection(textarea, text, setText, format);
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
    // No token between a reconnect and the rejoin; uploading would be refused.
    if (pendingImages.length && !httpToken) {
      setUploadError(CONNECTION_LOST_ERROR);
      return;
    }
    const socketId = socket.id;
    const activeSocket = socket;
    await sendLock.run(async () => {
      if (!takeSendToken()) return;
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
  async function sendDraft(activeSocket: AppSocket, socketId: string) {
    let imageUrls: string[] = [];
    try {
      if (pendingImages.length) {
        const files = pendingImages.map((image) => image.file);
        imageUrls = reusableUploadUrls(uploadedRef.current, files) ?? await uploadImages(roomId, httpToken!, files);
        uploadedRef.current = { files, urls: imageUrls };
      }
    } catch (error) {
      setUploadError(uploadErrorMessage(error, isSameConnection(activeSocket, socketId)));
      return;
    }
    if (!isSameConnection(activeSocket, socketId)) {
      setUploadError(CONNECTION_LOST_ERROR);
      return;
    }
    const payload: ChatMessagePayload = {
      text: text.trim(),
    };
    if (imageUrls.length) payload.imageUrls = imageUrls;
    const reply = replyToSend(replyingTo, replyingToRef.current);
    if (reply) payload.replyToId = reply.id;
    onBeforeSend();
    activeSocket.emit("chat-message", payload);
    uploadedRef.current = null;
    clearDraft();
    setText("");
    // Keep a reply the user started while the upload was running.
    onReplyingToChange((current) => (current === replyingTo ? null : current));
    textareaRef.current?.focus();
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    void doSend();
  }

  function handleCreatePoll(data: { question: string; options: string[]; allowMultiple: boolean }): boolean {
    if (!socket?.connected) {
      setUploadError(CONNECTION_LOST_ERROR);
      return false;
    }
    if (!takeSendToken()) return false;
    onBeforeSend();
    socket.emit("poll-create", data);
    return true;
  }

  function handleGifSelect(gifUrl: string, gifTitle: string) {
    if (!socket || sending) return;
    if (!socket.connected) {
      setUploadError(CONNECTION_LOST_ERROR);
      return;
    }
    if (!takeSendToken()) return;
    const payload: ChatMessagePayload = {
      text: gifTitle,
      gifUrl,
    };
    if (replyingTo) {
      payload.replyToId = replyingTo.id;
      onReplyingToChange(null);
    }
    onBeforeSend();
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
      restoreSelection(textarea, newPos, newPos);
    } else {
      setText(text + emoji);
    }
  }

  // On every text change, not onInput: sending, emoji and formatting don't fire that.
  useLayoutEffect(() => {
    if (textareaRef.current) fitToContent(textareaRef.current);
  }, [text]);

  // The server dropped something other than a draft (a reaction, vote, edit or call state).
  useEffect(() => {
    if (!socket) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onLimited = () => {
      setUploadError(SERVER_LIMIT_ERROR);
      clearTimeout(timer);
      timer = setTimeout(() => setUploadError((current) => (current === SERVER_LIMIT_ERROR ? null : current)), SERVER_LIMIT_ERROR_MS);
    };
    socket.on("rate-limited", onLimited);
    return () => {
      socket.off("rate-limited", onLimited);
      clearTimeout(timer);
    };
  }, [socket]);

  // Close the emoji, GIF and poll popovers with Escape while one is open.
  const popoverOpen = openPopover !== null;
  useEffect(() => {
    if (!popoverOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpenPopover(null);
      textareaRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [popoverOpen]);

  return (
    <div className="px-4 pb-4 relative">
      {/* Typing indicator */}
      {/* Always mounted: screen readers often miss a live region added with its content. */}
      <p className={`${typingLabel ? "mb-1 h-4" : ""} text-[11px] text-indigo-400 italic truncate`} aria-live="polite">
        {typingLabel}
      </p>

      {/* Reply preview */}
      {replyingTo && (
        <div className="flex items-center gap-2 mb-2 px-3 py-2 bg-gray-800/60 border border-gray-700 rounded-lg">
          <Reply size={12} className="text-indigo-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-xs text-indigo-400 font-medium">{replyingTo.senderName}</span>
            {replyingTo.imageUrls?.[0] ? (
              <RoomImage
                src={replyingTo.imageUrls[0]}
                alt={`Sent by ${replyingTo.senderName}`}
                className="mt-1 h-8 w-8 rounded object-cover"
                skeletonClassName="mt-1 h-8 w-8 rounded"
              />
            ) : (
              <p className="text-xs text-gray-400 truncate">{replyingTo.text || "[Image]"}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => onReplyingToChange(null)}
            aria-label="Cancel reply"
            className="touch-target p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-gray-300 transition-colors cursor-pointer"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Popovers — outside the form to avoid nested-form issues */}
      {openPopover === "emoji" && (
        <EmojiPicker
          onSelect={handleEmojiSelect}
          onClose={() => setOpenPopover(null)}
        />
      )}
      {openPopover === "gif" && (
        <GifPicker
          onSelect={handleGifSelect}
          onClose={() => setOpenPopover(null)}
        />
      )}
      {openPopover === "poll" && (
        <PollCreator
          onSubmit={handleCreatePoll}
          onClose={() => setOpenPopover(null)}
        />
      )}

      <input ref={fileInputRef} type="file" accept="image/*" multiple aria-label="Choose images to send" className="hidden" onChange={(event) => {
        if (event.target.files) addImages(event.target.files);
        event.target.value = "";
      }} />
      {pendingImages.length > 0 && (
        <div className="mb-2 rounded-lg border border-indigo-500/40 bg-indigo-500/10 p-2">
          <div className="mb-1 text-[11px] font-medium text-indigo-300">Images ready to send ({pendingImages.length}/{MAX_IMAGES_PER_MESSAGE})</div>
          <div className="flex gap-2 overflow-x-auto">
            {pendingImages.map((image) => (
              <div key={image.id} className="relative shrink-0 rounded-md border border-gray-600 bg-gray-900/70 p-1">
                <img src={image.previewUrl} alt={image.file.name} className="h-16 w-16 rounded object-cover" />
                <button
                  type="button"
                  onClick={() => removeImage(image.id)}
                  disabled={sending}
                  className="absolute -right-1.5 -top-1.5 rounded-full bg-gray-900 border border-gray-600 p-0.5 text-gray-300 hover:text-white cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Remove image"
                  aria-label={`Remove ${image.file.name}`}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {uploadError && <p role="alert" className="mb-1 text-xs text-red-400">{uploadError}</p>}
      {pendingImages.length > 0 && <p className="mb-1 text-[10px] text-gray-400">Images are temporarily stored and deleted when the room ends. Password-protected rooms encrypt uploaded images at rest; chat messages are not encrypted.</p>}
      <form onSubmit={send} className="space-y-1">
        {/* Formatting toolbar row */}
        <fieldset disabled={sending} className="min-w-0 disabled:opacity-50">
        <div className="flex flex-wrap items-center justify-between">
          <FormattingToolbar textareaRef={textareaRef} text={text} setText={setText} />
          <div className="flex items-center gap-0.5 pointer-coarse:gap-0">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="touch-target p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors cursor-pointer"
              title="Send images"
              aria-label="Send images"
            >
              <ImageIcon size={14} />
            </button>
            <button
              type="button"
              onClick={() => togglePopover("poll")}
              className="touch-target p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors cursor-pointer"
              title="Create poll"
              aria-label="Create poll"
            >
              <BarChart3 size={14} />
            </button>
            <button
              type="button"
              onClick={() => togglePopover("gif")}
              className={`touch-target px-1.5 py-1 rounded text-xs font-bold tracking-tight transition-colors cursor-pointer ${
                openPopover === "gif"
                  ? "bg-indigo-600 text-white"
                  : "text-gray-400 hover:text-gray-200 hover:bg-gray-700"
              }`}
              title="Send a GIF"
            >
              GIF
            </button>
            <button
              type="button"
              onClick={() => togglePopover("emoji")}
              className="touch-target p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors cursor-pointer"
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
            className="flex-1 px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-base md:text-sm text-white placeholder-gray-400 focus:outline-none focus:border-indigo-500 transition-colors resize-none min-h-[36px] max-h-28 overflow-y-auto"
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
  );
}
