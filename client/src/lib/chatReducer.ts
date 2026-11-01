import type { ChatEntry, PollMessage, ReactionUser } from "../types";
import { isPollMessage, MAX_CHAT_HISTORY } from "../types";
import { appendCapped, applyMessageDelete, applyMessageEdit } from "./chatHistory";

export interface ChatState {
  history: ChatEntry[];
  pinnedMessageId: string | null;
}

export type ChatAction =
  | { type: "joined"; history: ChatEntry[]; pinnedMessageId: string | null }
  | { type: "added"; entry: ChatEntry }
  | { type: "reactions"; messageId: string; reactions: Record<string, ReactionUser[]> }
  | { type: "edited"; messageId: string; text: string }
  | { type: "deleted"; messageId: string }
  | { type: "pinned"; pinnedMessageId: string | null }
  | { type: "poll-updated"; poll: PollMessage };

export const INITIAL_CHAT_STATE: ChatState = { history: [], pinnedMessageId: null };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "joined":
      return { history: action.history.slice(-MAX_CHAT_HISTORY), pinnedMessageId: action.pinnedMessageId };
    case "added":
      return { ...state, history: appendCapped(state.history, action.entry) };
    case "reactions":
      return {
        ...state,
        history: state.history.map((entry) =>
          entry.id === action.messageId && !isPollMessage(entry) ? { ...entry, reactions: action.reactions } : entry,
        ),
      };
    case "edited":
      return { ...state, history: applyMessageEdit(state.history, action.messageId, action.text) };
    case "deleted":
      return {
        history: applyMessageDelete(state.history, action.messageId),
        // The server clears the pin on delete without sending a pin update.
        pinnedMessageId: state.pinnedMessageId === action.messageId ? null : state.pinnedMessageId,
      };
    case "pinned":
      return { ...state, pinnedMessageId: action.pinnedMessageId };
    case "poll-updated":
      return { ...state, history: state.history.map((entry) => (entry.id === action.poll.id ? action.poll : entry)) };
  }
}
