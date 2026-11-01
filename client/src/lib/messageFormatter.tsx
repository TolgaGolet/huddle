import React from "react";

// Matches strings composed entirely of emoji + modifier/ZWJ/variation characters.
// This lets us detect "emoji-only" messages like 😂 or 🍕🍕 for big rendering.
const ONLY_EMOJI_RE =
  // eslint-disable-next-line no-misleading-character-class -- a set of individual code points, not a sequence.
  /^[\p{Extended_Pictographic}\uFE0F\u20E3\u200D\u{1F3FB}-\u{1F3FF}]+$/u;

export function detectEmojiOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || !ONLY_EMOJI_RE.test(trimmed)) return false;
  // Count grapheme clusters so ZWJ sequences (e.g. 🐻‍❄️) count as one emoji.
  let count: number;
  try {
    count = [...new Intl.Segmenter().segment(trimmed)].length;
  } catch {
    count = (trimmed.match(/\p{Extended_Pictographic}/gu) ?? []).length || 1;
  }
  return count <= 2;
}

interface Token {
  type: "text" | "bold" | "italic" | "strike" | "code" | "url";
  content: string;
}

const URL_SOURCE = String.raw`https?:\/\/[^\s<>'")\]]+`;

function UrlLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-indigo-400 hover:underline break-all"
    >
      {url}
    </a>
  );
}

/** Emphasized text can hold a URL; split's capture group puts each at an odd index. */
function linkify(text: string): React.ReactNode[] {
  return text
    .split(new RegExp(`(${URL_SOURCE})`))
    .map((part, i) => (i % 2 ? <UrlLink key={i} url={part} /> : part));
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  // Order matters: **bold** before *italic*, ~~strike~~, `code`, then URLs
  const COMBINED = new RegExp(String.raw`(\*\*(.+?)\*\*)|(\*(.+?)\*)|(\`(.+?)\`)|(~~(.+?)~~)|(${URL_SOURCE})`, "g");

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = COMBINED.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }

    if (match[1]) {
      tokens.push({ type: "bold", content: match[2] });
    } else if (match[3]) {
      tokens.push({ type: "italic", content: match[4] });
    } else if (match[5]) {
      tokens.push({ type: "code", content: match[6] });
    } else if (match[7]) {
      tokens.push({ type: "strike", content: match[8] });
    } else if (match[9]) {
      tokens.push({ type: "url", content: match[9] });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    tokens.push({ type: "text", content: text.slice(lastIndex) });
  }

  return tokens;
}

export function formatMessage(text: string): React.ReactNode[] {
  if (detectEmojiOnly(text)) {
    return [
      <span key="emoji-big" className="text-5xl leading-none select-text">
        {text.trim()}
      </span>,
    ];
  }

  const tokens = tokenize(text);
  return tokens.map((token, i) => {
    switch (token.type) {
      case "bold":
        return <strong key={i} className="font-bold">{linkify(token.content)}</strong>;
      case "italic":
        return <em key={i} className="italic">{linkify(token.content)}</em>;
      case "strike":
        return <s key={i} className="line-through">{linkify(token.content)}</s>;
      case "code":
        return (
          <code key={i} className="px-1 py-0.5 rounded bg-gray-700 text-pink-300 text-xs font-mono">
            {token.content}
          </code>
        );
      case "url":
        return <UrlLink key={i} url={token.content} />;
      default:
        return <React.Fragment key={i}>{token.content}</React.Fragment>;
    }
  });
}
