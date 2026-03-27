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
}

const FORMATS: FormatAction[] = [
  { icon: <Bold size={14} />, label: "Bold", prefix: "**", suffix: "**", shortcutLabel: "Ctrl+B" },
  { icon: <Italic size={14} />, label: "Italic", prefix: "*", suffix: "*", shortcutLabel: "Ctrl+I" },
  { icon: <Strikethrough size={14} />, label: "Strikethrough", prefix: "~~", suffix: "~~", shortcutLabel: "Ctrl+Shift+X" },
  { icon: <Code size={14} />, label: "Code", prefix: "`", suffix: "`", shortcutLabel: "Ctrl+E" },
];

export function applyFormat(
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

export default function FormattingToolbar({ textareaRef, text, setText }: Props) {
  function handleFormat(format: FormatAction) {
    const textarea = textareaRef.current;
    if (!textarea) return;

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

  return (
    <div className="flex items-center gap-0.5">
      {FORMATS.map((format) => (
        <button
          key={format.label}
          type="button"
          onClick={() => handleFormat(format)}
          className="p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors cursor-pointer"
          title={`${format.label} (${format.shortcutLabel})`}
        >
          {format.icon}
        </button>
      ))}
    </div>
  );
}
