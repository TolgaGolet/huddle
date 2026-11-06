import { useState, useRef } from "react";
import { X, Plus, Trash2 } from "lucide-react";
import { MAX_POLL_OPTION_LENGTH, MAX_POLL_OPTIONS, MAX_POLL_QUESTION_LENGTH, POLL_DURATIONS_MS, type PollCreate } from "../types";
import { useClickOutside } from "../hooks/useClickOutside";

function durationLabel(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

interface Props {
  /** Returns false if the poll wasn't sent, which keeps the form and what's typed in it. */
  onSubmit: (data: PollCreate) => boolean;
  onClose: () => void;
}

export default function PollCreator({ onSubmit, onClose }: Props) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [lockVotes, setLockVotes] = useState(false);
  /** "" for no end time; select values are strings. */
  const [duration, setDuration] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, onClose);

  function addOption() {
    if (options.length < MAX_POLL_OPTIONS) {
      setOptions([...options, ""]);
    }
  }

  function removeOption(index: number) {
    if (options.length > 2) {
      setOptions(options.filter((_, i) => i !== index));
    }
  }

  function updateOption(index: number, value: string) {
    setOptions(options.map((o, i) => (i === index ? value : o)));
  }

  function handleSubmit() {
    const trimmedQ = question.trim();
    const validOptions = options.map((o) => o.trim()).filter(Boolean);
    if (!trimmedQ || validOptions.length < 2) return;
    const poll: PollCreate = { question: trimmedQ, options: validOptions, allowMultiple, lockVotes };
    if (duration) poll.durationMs = Number(duration);
    if (onSubmit(poll)) onClose();
  }

  const canSubmit = question.trim() && options.filter((o) => o.trim()).length >= 2;

  return (
    <div
      ref={ref}
      className="absolute bottom-full mb-2 left-0 right-0 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl z-50 max-h-[70dvh] overflow-y-auto"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h3 className="text-sm font-semibold text-gray-200">Create Poll</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close poll creator"
          className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors cursor-pointer"
        >
          <X size={14} />
        </button>
      </div>

      <div className="p-4 space-y-3">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question..."
          aria-label="Poll question"
          className="w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-600 text-base md:text-sm text-white placeholder-gray-400 focus:outline-none focus:border-indigo-500"
          autoFocus
          maxLength={MAX_POLL_QUESTION_LENGTH}
        />

        <div className="space-y-2">
          {options.map((option, i) => (
            <div key={i} className="flex gap-2">
              <input
                type="text"
                value={option}
                onChange={(e) => updateOption(i, e.target.value)}
                placeholder={`Option ${i + 1}`}
                aria-label={`Option ${i + 1}`}
                className="flex-1 px-3 py-1.5 rounded-lg bg-gray-900 border border-gray-600 text-base md:text-sm text-white placeholder-gray-400 focus:outline-none focus:border-indigo-500"
                maxLength={MAX_POLL_OPTION_LENGTH}
              />
              {options.length > 2 && (
                <button
                  type="button"
                  onClick={() => removeOption(i)}
                  aria-label={`Remove option ${i + 1}`}
                  className="p-1.5 rounded text-gray-400 hover:text-red-400 hover:bg-gray-700 transition-colors cursor-pointer"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>

        {options.length < MAX_POLL_OPTIONS && (
          <button
            type="button"
            onClick={addOption}
            className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 transition-colors cursor-pointer"
          >
            <Plus size={12} />
            Add option
          </button>
        )}

        <label className="flex items-center gap-2 cursor-pointer">
          {/* eslint-disable-next-line jsx-a11y/control-has-associated-label -- labelled by the wrapping <label>, which the rule can't see. */}
          <input
            type="checkbox"
            checked={allowMultiple}
            onChange={(e) => setAllowMultiple(e.target.checked)}
            className="rounded border-gray-600 bg-gray-900 text-indigo-500 focus:ring-indigo-500 cursor-pointer"
          />
          <span className="text-xs text-gray-400">Allow multiple selections</span>
        </label>

        <label className="flex items-center gap-2 cursor-pointer">
          {/* eslint-disable-next-line jsx-a11y/control-has-associated-label -- labelled by the wrapping <label>, which the rule can't see. */}
          <input
            type="checkbox"
            checked={lockVotes}
            onChange={(e) => setLockVotes(e.target.checked)}
            className="rounded border-gray-600 bg-gray-900 text-indigo-500 focus:ring-indigo-500 cursor-pointer"
          />
          <span className="text-xs text-gray-400">Votes can't be changed</span>
        </label>

        <div className="flex items-center gap-2">
          <label htmlFor="poll-duration" className="text-xs text-gray-400">
            Ends after
          </label>
          <select
            id="poll-duration"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            className="px-2 py-1 rounded-lg bg-gray-900 border border-gray-600 text-base md:text-xs text-gray-200 focus:outline-none focus:border-indigo-500 cursor-pointer"
          >
            <option value="">No time limit</option>
            {POLL_DURATIONS_MS.map((ms) => (
              <option key={ms} value={ms}>
                {durationLabel(ms)}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="w-full py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium transition-colors cursor-pointer"
        >
          Create Poll
        </button>
      </div>
    </div>
  );
}
