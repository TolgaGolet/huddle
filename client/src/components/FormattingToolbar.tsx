import { Bold, Italic, Strikethrough, Code } from "lucide-react";

interface Props {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (value: string) => void;
}

interface FormatAction {
  icon: React.ReactNode;
  label: string;
  prefix: string;
  suffix: string;
  shortcutLabel: string;
  /** `KeyboardEvent.key` of the Ctrl/Cmd shortcut; an uppercase key also needs Shift. */
  shortcutKey: string;
}

const FORMATS: FormatAction[] = [
  { icon: <Bold size={14} />, label: "Bold", prefix: "**", suffix: "**", shortcutLabel: "Ctrl+B", shortcutKey: "b" },
  { icon: <Italic size={14} />, label: "Italic", prefix: "*", suffix: "*", shortcutLabel: "Ctrl+I", shortcutKey: "i" },
  { icon: <Strikethrough size={14} />, label: "Strikethrough", prefix: "~~", suffix: "~~", shortcutLabel: "Ctrl+Shift+X", shortcutKey: "X" },
  { icon: <Code size={14} />, label: "Code", prefix: "`", suffix: "`", shortcutLabel: "Ctrl+E", shortcutKey: "e" },
];

/** The format a keydown triggers, if any. */
export function formatForShortcut(e: React.KeyboardEvent): FormatAction | null {
  if (!e.ctrlKey && !e.metaKey) return null;
  return FORMATS.find((f) => f.shortcutKey === e.key && (f.shortcutKey === f.shortcutKey.toLowerCase() || e.shiftKey)) ?? null;
}

/** Runs after the state update has rendered, which would otherwise reset the caret. */
export function restoreSelection(textarea: HTMLTextAreaElement, start: number, end: number): void {
  requestAnimationFrame(() => {
    textarea.focus();
    textarea.setSelectionRange(start, end);
  });
}

function applyFormat(
  textarea: HTMLTextAreaElement,
  text: string,
  prefix: string,
  suffix: string,
): { newText: string; cursorStart: number; cursorEnd: number } {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = text.slice(start, end);

  if (selected) {
    const wrapped = prefix + selected + suffix;
    const newText = text.slice(0, start) + wrapped + text.slice(end);
    return {
      newText,
      cursorStart: start + prefix.length,
      cursorEnd: end + prefix.length,
    };
  }

  const placeholder = prefix + suffix;
  const newText = text.slice(0, start) + placeholder + text.slice(end);
  const cursorPos = start + prefix.length;
  return { newText, cursorStart: cursorPos, cursorEnd: cursorPos };
}

/** Applies `format` to the textarea's selection and keeps the selection on the text. */
export function formatSelection(textarea: HTMLTextAreaElement, text: string, setText: (value: string) => void, format: FormatAction): void {
  const { newText, cursorStart, cursorEnd } = applyFormat(
    textarea,
    text,
    format.prefix,
    format.suffix,
  );

  setText(newText);
  restoreSelection(textarea, cursorStart, cursorEnd);
}

export default function FormattingToolbar({ textareaRef, text, setText }: Props) {
  function handleFormat(format: FormatAction) {
    const textarea = textareaRef.current;
    if (textarea) formatSelection(textarea, text, setText, format);
  }

  return (
    <div className="flex items-center gap-0.5 pointer-coarse:gap-0">
      {FORMATS.map((format) => (
        <button
          key={format.label}
          type="button"
          onClick={() => handleFormat(format)}
          className="touch-target p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors cursor-pointer"
          title={`${format.label} (${format.shortcutLabel})`}
          aria-label={format.label}
        >
          {format.icon}
        </button>
      ))}
    </div>
  );
}
