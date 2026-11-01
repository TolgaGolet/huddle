import { useState } from "react";
import { MAX_CHAT_TEXT_LENGTH } from "../types";

interface Props {
  initialText: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

export default function MessageEditor({ initialText, onSubmit, onCancel }: Props) {
  const [text, setText] = useState(initialText);
  const trimmed = text.trim();
  const tooLong = trimmed.length > MAX_CHAT_TEXT_LENGTH;

  function submit() {
    // Over-limit edits would be dropped by the server; keep the editor open.
    if (!trimmed || tooLong) return;
    onSubmit(trimmed);
  }

  return (
    <>
      <div className="mt-1 flex items-center gap-1.5">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={MAX_CHAT_TEXT_LENGTH}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            if (e.key === "Escape") onCancel();
          }}
          rows={1}
          aria-label="Edit message"
          className="flex-1 px-2 py-1 rounded bg-gray-800 border border-indigo-500 text-base md:text-sm text-white focus:outline-none resize-none"
          autoFocus
        />
        <button type="button" onClick={submit} disabled={tooLong} className="disabled:opacity-50 disabled:cursor-not-allowed px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-xs text-white cursor-pointer transition-colors">Save</button>
        <button type="button" onClick={onCancel} className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-xs text-gray-200 cursor-pointer transition-colors">Cancel</button>
      </div>
      {tooLong && (
        <p role="alert" className="mt-1 text-xs text-red-400">Message is too long (max {MAX_CHAT_TEXT_LENGTH} characters).</p>
      )}
    </>
  );
}
