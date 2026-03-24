import { useState, useRef, useEffect } from "react";
import { Send } from "lucide-react";
import type { Socket } from "socket.io-client";
import type { ChatMessage } from "../types";

interface Props {
  socket: Socket | null;
  chatHistory: ChatMessage[];
  localId: string;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function ChatPanel({ socket, chatHistory, localId }: Props) {
  const [text, setText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory.length]);

  function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || !socket) return;
    socket.emit("chat-message", { text: text.trim() });
    setText("");
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {chatHistory.length === 0 && (
          <p className="text-gray-600 text-sm text-center mt-8">No messages yet. Say something!</p>
        )}
        {chatHistory.map((msg) => (
          <div key={msg.id} className="group">
            <div className="flex items-baseline gap-2">
              <span
                className={`text-sm font-semibold ${
                  msg.senderId === localId ? "text-indigo-400" : "text-gray-300"
                }`}
              >
                {msg.senderName}
              </span>
              <span className="text-[10px] text-gray-600">{formatTime(msg.timestamp)}</span>
            </div>
            <p className="text-sm text-gray-300 leading-relaxed">{msg.text}</p>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={send} className="px-4 pb-4">
        <div className="flex gap-2">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message..."
            className="flex-1 px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors"
          />
          <button
            type="submit"
            disabled={!text.trim()}
            className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            <Send size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
