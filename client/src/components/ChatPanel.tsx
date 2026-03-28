import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Smile, BarChart3, Reply, X, ChevronDown } from "lucide-react";
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

interface Props {
  socket: Socket | null;
  chatHistory: ChatEntry[];
  localId: string;
}

const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "👌"];

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function ChatPanel({ socket, chatHistory, localId }: Props) {
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
        doSend();
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

  function doSend() {
    if (!text.trim() || !socket) return;
    const payload: { text: string; replyTo?: { id: string; senderName: string; text: string } } = {
      text: text.trim(),
    };
    if (replyingTo) {
      payload.replyTo = {
        id: replyingTo.id,
        senderName: replyingTo.senderName,
        text: replyingTo.text,
      };
    }
    isAtBottomRef.current = true;
    socket.emit("chat-message", payload);
    setText("");
    setReplyingTo(null);
    textareaRef.current?.focus();
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    doSend();
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
            <span className="text-[11px] text-gray-500 truncate max-w-48">{msg.replyTo.text}</span>
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
          <div className="text-sm text-gray-300 leading-relaxed">{formatMessage(msg.text)}</div>
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
    <div className="flex flex-col h-full">
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
              <p className="text-xs text-gray-500 truncate">{replyingTo.text}</p>
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

        <form onSubmit={send} className="space-y-1">
          {/* Formatting toolbar row */}
          <div className="flex items-center justify-between">
            <FormattingToolbar textareaRef={textareaRef} text={text} setText={setText} />
            <div className="flex items-center gap-0.5">
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
              disabled={!text.trim()}
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
