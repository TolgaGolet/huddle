import type { ChatEntry } from "../types";
import { isPollMessage } from "../types";

/** Matches the server's chat-edit check: GIFs and messages with images can't be edited. */
export function isEditable(entry: ChatEntry): boolean {
  return !isPollMessage(entry) && !!entry.text && !entry.gifUrl && !entry.imageUrls?.length;
}
