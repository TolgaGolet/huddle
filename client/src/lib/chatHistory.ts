import { MAX_CHAT_HISTORY, type ChatEntry } from "../types";

/** `history` plus `entry`, dropping the oldest entries beyond MAX_CHAT_HISTORY. */
export function appendCapped(history: ChatEntry[], entry: ChatEntry): ChatEntry[] {
  const next = [...history, entry];
  return next.length > MAX_CHAT_HISTORY ? next.slice(-MAX_CHAT_HISTORY) : next;
}
