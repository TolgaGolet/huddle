import { describe, it, expect } from "vitest";
import type { ChatEntry, ChatMessage, PollMessage } from "../types";
import { MAX_CHAT_HISTORY } from "../types";
import { chatReducer, INITIAL_CHAT_STATE, type ChatState } from "./chatReducer";

const message = (id: string, text = id) => ({ id, text, senderId: "u", senderName: "Ana", timestamp: 0 }) as unknown as ChatMessage;
const poll = (id: string, question: string) => ({ id, type: "poll", question, options: [] }) as unknown as PollMessage;
const stateWith = (...history: ChatEntry[]): ChatState => ({ history, pinnedMessageId: null });

describe("chatReducer", () => {
  it("replaces history and pin on join, keeping the newest entries", () => {
    const history = Array.from({ length: MAX_CHAT_HISTORY + 1 }, (_, i) => message(String(i)));

    const state = chatReducer(stateWith(message("old")), { type: "joined", history, pinnedMessageId: "5" });

    expect(state.history).toHaveLength(MAX_CHAT_HISTORY);
    expect(state.history[0].id).toBe("1");
    expect(state.pinnedMessageId).toBe("5");
  });

  it("appends entries", () => {
    const state = chatReducer(INITIAL_CHAT_STATE, { type: "added", entry: message("a") });
    expect(state.history.map((m) => m.id)).toEqual(["a"]);
  });

  it("applies reactions to the matching message only", () => {
    const reactions = { "+1": [] };
    const state = chatReducer(stateWith(message("a"), message("b")), { type: "reactions", messageId: "b", reactions });

    expect((state.history[0] as ChatMessage).reactions).toBeUndefined();
    expect((state.history[1] as ChatMessage).reactions).toBe(reactions);
  });

  it("edits a message", () => {
    const state = chatReducer(stateWith(message("a")), { type: "edited", messageId: "a", text: "new" });
    expect((state.history[0] as ChatMessage).text).toBe("new");
  });

  // The server clears the pin on delete without sending a pin update.
  it("clears the pin when the pinned message is deleted", () => {
    const state = chatReducer({ history: [message("a")], pinnedMessageId: "a" }, { type: "deleted", messageId: "a" });

    expect(state.history).toEqual([]);
    expect(state.pinnedMessageId).toBeNull();
  });

  it("keeps the pin when another message is deleted", () => {
    const state = chatReducer({ history: [message("a"), message("b")], pinnedMessageId: "a" }, { type: "deleted", messageId: "b" });
    expect(state.pinnedMessageId).toBe("a");
  });

  it("updates the pin", () => {
    expect(chatReducer(INITIAL_CHAT_STATE, { type: "pinned", pinnedMessageId: "a" }).pinnedMessageId).toBe("a");
  });

  it("replaces an updated poll", () => {
    const state = chatReducer(stateWith(poll("p", "old")), { type: "poll-updated", poll: poll("p", "new") });
    expect((state.history[0] as PollMessage).question).toBe("new");
  });
});
