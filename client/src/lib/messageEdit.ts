import type { ChatEntry } from "../types";
import { hasEditableContent, isPollMessage } from "../types";

/** Matches the server's chat-edit check (`hasEditableContent`), for messages with text. */
export function isEditable(entry: ChatEntry): boolean {
  return !isPollMessage(entry) && !!entry.text && hasEditableContent(entry);
}
