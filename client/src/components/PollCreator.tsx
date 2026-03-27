import { useState, useRef, useEffect } from "react";
import { X, Plus, Trash2 } from "lucide-react";

interface Props {
  onSubmit: (data: { question: string; options: string[]; allowMultiple: boolean }) => void;
  onClose: () => void;
}

export default function PollCreator({ onSubmit, onClose }: Props) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  function addOption() {
    if (options.length < 10) {
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
    onSubmit({ question: trimmedQ, options: validOptions, allowMultiple });
    onClose();
  }

  const canSubmit = question.trim() && options.filter((o) => o.trim()).length >= 2;

  return (
    <div
      ref={ref}
      className="absolute bottom-full mb-2 left-0 right-0 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl z-50 overflow-hidden"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h3 className="text-sm font-semibold text-gray-200">Create Poll</h3>
        <button
          type="button"
          onClick={onClose}
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
          className="w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-600 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
          autoFocus
          maxLength={200}
        />

        <div className="space-y-2">
          {options.map((option, i) => (
            <div key={i} className="flex gap-2">
              <input
                type="text"
                value={option}
                onChange={(e) => updateOption(i, e.target.value)}
                placeholder={`Option ${i + 1}`}
                className="flex-1 px-3 py-1.5 rounded-lg bg-gray-900 border border-gray-600 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
                maxLength={100}
              />
              {options.length > 2 && (
                <button
                  type="button"
                  onClick={() => removeOption(i)}
                  className="p-1.5 rounded text-gray-500 hover:text-red-400 hover:bg-gray-700 transition-colors cursor-pointer"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>

        {options.length < 10 && (
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
          <input
            type="checkbox"
            checked={allowMultiple}
            onChange={(e) => setAllowMultiple(e.target.checked)}
            className="rounded border-gray-600 bg-gray-900 text-indigo-500 focus:ring-indigo-500 cursor-pointer"
          />
          <span className="text-xs text-gray-400">Allow multiple selections</span>
        </label>

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
