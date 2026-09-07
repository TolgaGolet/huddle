import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Smile, BarChart3, Reply, X, ChevronDown, Image as ImageIcon } from "lucide-react";
import type { Socket } from "socket.io-client";
import type { ChatMessage, ChatEntry } from "../types";
import { isPollMessage } from "../types";
import { formatMessage } from "../lib/messageFormatter";
import { avatarTextColor } from "../lib/avatarColor";
import FormattingToolbar, { applyFormat } from "./FormattingToolbar";
import EmojiPicker from "./EmojiPicker";
import GifPicker from "./GifPicker";
import PollCreator from "./PollCreator";
import PollDisplay from "./PollDisplay";
import { isImageFile, MAX_IMAGE_SIZE, MAX_IMAGES_PER_SEND, uploadImages } from "../lib/imageUpload";

interface Props {
  socket: Socket | null;
  chatHistory: ChatEntry[];
  localId: string;
  roomId: string;
}

interface PendingImage { id: string; file: File; previewUrl: string; }

const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "👌"];

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function ChatPanel({ socket, chatHistory, localId, roomId }: Props) {
  const [text, setText] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [showPollCreator, setShowPollCreator] = useState(false);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const isAtBottomRef = useRef(true);
  const prevHistoryLenRef = useRef(chatHistory.length);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function addImages(fileList: FileList | File[]) {
    setUploadError(null);
    const accepted: PendingImage[] = [];
    const errors: string[] = [];
    for (const file of Array.from(fileList)) {
      if (pendingImages.length + accepted.length >= MAX_IMAGES_PER_SEND) { errors.push(`You can send up to ${MAX_IMAGES_PER_SEND} images at once.`); break; }
      if (!isImageFile(file)) { errors.push(`${file.name} is not a supported image file.`); continue; }
      if (file.size > MAX_IMAGE_SIZE) { errors.push(`${file.name} is larger than 8 MB.`); continue; }
      accepted.push({ id: `${file.name}-${file.lastModified}-${Math.random()}`, file, previewUrl: URL.createObjectURL(file) });
    }
    if (accepted.length) setPendingImages((current) => [...current, ...accepted]);
    if (errors.length) setUploadError(errors[0]);
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
  }

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
    },
    [text],
  );

  async function doSend() {
    if ((!text.trim() && !pendingImages.length) || !socket || !socket.id) return;
    setUploadError(null);
    let imageUrls: string[] = [];
    try {
      if (pendingImages.length) imageUrls = await uploadImages(roomId, socket.id, pendingImages.map((image) => image.file));
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Failed to upload images");
      return;
    }
    const payload: { text: string; imageUrls?: string[]; replyTo?: { id: string; senderName: string; text: string; imageUrl?: string } } = {
      text: text.trim(),
    };
    if (imageUrls.length) payload.imageUrls = imageUrls;
    if (replyingTo) {
      payload.replyTo = {
        id: replyingTo.id,
        senderName: replyingTo.senderName,
        text: replyingTo.text || (replyingTo.imageUrls?.length ? "[Image]" : ""),
        imageUrl: replyingTo.imageUrls?.[0],
      };
    }
    isAtBottomRef.current = true;
    socket.emit("chat-message", payload);
    pendingImages.forEach((image) => URL.revokeObjectURL(image.previewUrl));
    setPendingImages([]);
    setText("");
    setReplyingTo(null);
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
    if (!socket) return;
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

  function startReply(msg: ChatMessage) {
    setReplyingTo(msg);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function renderChatMessage(msg: ChatMessage) {
    const reactions = msg.reactions || {};
    const reactionEntries = Object.entries(reactions).filter(([, names]) => names.length > 0);

    return (
      <div
        key={msg.id}
        ref={(el) => setMessageRef(msg.id, el)}
        className="group relative rounded-lg px-2 py-1 -mx-2 transition-colors hover:bg-gray-800/40"
      >
        {/* Reply quote */}
        {msg.replyTo && (
          <button
            type="button"
            onClick={() => scrollToMessage(msg.replyTo!.id)}
            className="flex items-center gap-1.5 mb-1 pl-2 border-l-2 border-indigo-500/50 cursor-pointer hover:bg-gray-800/60 rounded-r py-0.5 pr-2 transition-colors"
          >
            <Reply size={10} className="text-gray-500 shrink-0" />
            <span className="text-[11px] text-indigo-400 font-medium shrink-0">{msg.replyTo.senderName}</span>
            {msg.replyTo.imageUrl ? (
              <img
                src={`${msg.replyTo.imageUrl}?socketId=${encodeURIComponent(localId)}`}
                alt="Replied image"
                className="h-8 w-8 rounded object-cover shrink-0"
              />
            ) : (
              <span className="text-[11px] text-gray-500 truncate max-w-48">{msg.replyTo.text || "[Image]"}</span>
            )}
          </button>
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
                  return <a key={url} href={imageUrl} target="_blank" rel="noopener noreferrer">
                    <img src={imageUrl} alt="Shared image" className="rounded-lg max-h-48 w-full object-cover hover:brightness-90 transition-all" loading="lazy" onLoad={scrollPinnedToBottom} />
                  </a>;
                })}
              </div>
            ) : null}
            {msg.text && <div className="text-sm text-gray-300 leading-relaxed">{formatMessage(msg.text)}</div>}
          </>
        )}

        {/* Reaction badges */}
        {reactionEntries.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {reactionEntries.map(([emoji, names]) => (
              <button
                key={emoji}
                type="button"
                onClick={() => handleReaction(msg.id, emoji)}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs border transition-colors cursor-pointer ${
                  names.includes(msg.senderName === localId ? msg.senderName : "")
                    ? "border-indigo-500/50 bg-indigo-500/10"
                    : "border-gray-700 bg-gray-800/60 hover:border-gray-600"
                }`}
                title={names.join(", ")}
              >
                <span>{emoji}</span>
                <span className="text-gray-400">{names.length}</span>
              </button>
            ))}
          </div>
        )}

        {/* Action bar on hover */}
        <div className="absolute -top-3 right-0 hidden group-hover:flex items-center bg-gray-800 border border-gray-700 rounded-lg shadow-lg overflow-hidden">
          {REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => handleReaction(msg.id, emoji)}
              className="px-1.5 py-1 hover:bg-gray-700 transition-colors cursor-pointer text-sm"
              title={emoji}
            >
              {emoji}
            </button>
          ))}
          <button
            type="button"
            onClick={() => startReply(msg)}
            className="px-2 py-1 hover:bg-gray-700 transition-colors cursor-pointer text-gray-400 hover:text-gray-200 border-l border-gray-700"
            title="Reply"
          >
            <Reply size={13} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col h-full" onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }} onDrop={(event) => { event.preventDefault(); setIsDragging(false); addImages(event.dataTransfer.files); }}>
      {isDragging && <div className="absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-indigo-400 bg-gray-950/90 text-indigo-300 pointer-events-none">Drop images to send</div>}
      {/* Messages list */}
      <div className="relative flex-1 min-h-0">
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
                <PollDisplay
                  key={entry.id}
                  poll={entry}
                  localId={localId}
                  onVote={handlePollVote}
                />
              ) : (
                renderChatMessage(entry)
              ),
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        {newMessageCount > 0 && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-3 right-4 flex items-center gap-1.5 pl-3 pr-2.5 py-1.5 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium shadow-lg transition-colors cursor-pointer z-10"
          >
            {newMessageCount} new {newMessageCount === 1 ? "message" : "messages"}
            <ChevronDown size={14} />
          </button>
        )}
      </div>

      {/* Input area */}
      <div className="px-4 pb-4 relative">
        {/* Reply preview */}
        {replyingTo && (
          <div className="flex items-center gap-2 mb-2 px-3 py-2 bg-gray-800/60 border border-gray-700 rounded-lg">
            <Reply size={12} className="text-indigo-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="text-xs text-indigo-400 font-medium">{replyingTo.senderName}</span>
              {replyingTo.imageUrls?.[0] ? (
                <img
                  src={`${replyingTo.imageUrls[0]}?socketId=${encodeURIComponent(localId)}`}
                  alt="Reply image"
                  className="mt-1 h-8 w-8 rounded object-cover"
                />
              ) : (
                <p className="text-xs text-gray-500 truncate">{replyingTo.text || "[Image]"}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setReplyingTo(null)}
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

        <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => {
          if (event.target.files) addImages(event.target.files);
          event.target.value = "";
        }} />
        {pendingImages.length > 0 && <div className="mb-2 rounded-lg border border-indigo-500/40 bg-indigo-500/10 p-2">
          <div className="mb-1 text-[11px] font-medium text-indigo-300">Images ready to send ({pendingImages.length}/{MAX_IMAGES_PER_SEND})</div>
          <div className="flex gap-2 overflow-x-auto">
            {pendingImages.map((image) => <div key={image.id} className="relative shrink-0 rounded-md border border-gray-600 bg-gray-900/70 p-1">
              <img src={image.previewUrl} alt={image.file.name} className="h-16 w-16 rounded object-cover" />
              <button type="button" onClick={() => removeImage(image.id)} className="absolute -right-1.5 -top-1.5 rounded-full bg-gray-900 border border-gray-600 p-0.5 text-gray-300 hover:text-white cursor-pointer" title="Remove image"><X size={11} /></button>
            </div>)}
          </div>
        </div>}
        {uploadError && <p className="mb-1 text-xs text-red-400">{uploadError}</p>}
        {pendingImages.length > 0 && <p className="mb-1 text-[10px] text-gray-600">Images are temporarily stored and deleted when the room ends. Password-protected rooms encrypt chat messages and images; other rooms do not.</p>}
        <form onSubmit={send} className="space-y-1">
          {/* Formatting toolbar row */}
          <div className="flex items-center justify-between">
            <FormattingToolbar textareaRef={textareaRef} text={text} setText={setText} />
            <div className="flex items-center gap-0.5">
              <button type="button" onClick={() => fileInputRef.current?.click()} className="p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors cursor-pointer" title="Send images">
                <ImageIcon size={14} />
              </button>
              <button
                type="button"
                onClick={() => { setShowPollCreator((v) => !v); setShowEmojiPicker(false); setShowGifPicker(false); }}
                className="p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors cursor-pointer"
                title="Create poll"
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
              >
                <Smile size={14} />
              </button>
            </div>
          </div>

          {/* Textarea + send */}
          <div className="flex gap-2">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
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
              disabled={!text.trim() && !pendingImages.length}
              className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer self-end"
            >
              <Send size={16} />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
