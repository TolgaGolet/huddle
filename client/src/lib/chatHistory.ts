import { isPollMessage, MAX_CHAT_HISTORY, quoteText, type ChatEntry } from "../types";

/** Applies an edit to the message and to its replies' quotes, as the server does. */
export function applyMessageEdit(history: ChatEntry[], messageId: string, text: string): ChatEntry[] {
  return history.map((entry) => {
    if (isPollMessage(entry)) return entry;
    if (entry.id === messageId) return { ...entry, text, edited: true };
    if (entry.replyTo?.id === messageId) return { ...entry, replyTo: { ...entry.replyTo, text: quoteText(text) } };
    return entry;
  });
}

/** Removes the message and its replies' quotes, as the server does. */
export function applyMessageDelete(history: ChatEntry[], messageId: string): ChatEntry[] {
  return history
    .filter((entry) => entry.id !== messageId)
    .map((entry) => (!isPollMessage(entry) && entry.replyTo?.id === messageId ? { ...entry, replyTo: undefined } : entry));
}

/** `history` plus `entry`, dropping the oldest entries beyond MAX_CHAT_HISTORY. */
export function appendCapped(history: ChatEntry[], entry: ChatEntry): ChatEntry[] {
  const next = [...history, entry];
  return next.length > MAX_CHAT_HISTORY ? next.slice(-MAX_CHAT_HISTORY) : next;
}
