// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { asAppSocket, fakeSocket } from "../test/fakeSocket";
import type { ChatMessage, PollMessage } from "../types";
import { useChat } from "./useChat";

const message = (id: string, text = "hi"): ChatMessage => ({ id, senderId: "u", senderName: "Ana", text, timestamp: 0, reactions: {} });
const poll = (id: string): PollMessage =>
  ({ id, senderId: "u", senderName: "Ana", timestamp: 0, type: "poll", question: "?", options: [], allowMultiple: false }) as unknown as PollMessage;

function setup() {
  const socket = fakeSocket();
  const view = renderHook(() => useChat(asAppSocket(socket)));
  const fire = (event: string, data: unknown) => act(() => void socket.fire(event, data));
  return { socket, fire, ...view };
}

afterEach(cleanup);

describe("useChat", () => {
  it("is empty without a socket", () => {
    const { result } = renderHook(() => useChat(null));

    expect(result.current).toEqual({ history: [], pinnedMessageId: null });
  });

  it("loads the history and pin from the join", () => {
    const { result, fire } = setup();

    fire("room-joined", { chatHistory: [message("a")], pinnedMessageId: "a" });

    expect(result.current.history.map((m) => m.id)).toEqual(["a"]);
    expect(result.current.pinnedMessageId).toBe("a");
  });

  it("appends both messages and new polls", () => {
    const { result, fire } = setup();

    fire("chat-message", message("a"));
    fire("poll-create", poll("p"));

    expect(result.current.history.map((m) => m.id)).toEqual(["a", "p"]);
  });

  it("applies reactions, edits, deletes, pins and poll updates", () => {
    const { result, fire } = setup();
    fire("room-joined", { chatHistory: [message("a"), poll("p"), message("b")], pinnedMessageId: null });
    const reactions = { "👍": [{ userId: "u", name: "Ana" }] };

    fire("chat-reaction-update", { messageId: "a", reactions });
    fire("chat-message-edit", { messageId: "a", text: "new" });
    fire("chat-pin-update", { pinnedMessageId: "a" });
    fire("poll-update", { ...poll("p"), question: "updated" });
    fire("chat-message-delete", { messageId: "b" });

    const [a, p] = result.current.history as [ChatMessage, PollMessage];
    expect(a).toMatchObject({ reactions, text: "new", edited: true });
    expect(p.question).toBe("updated");
    expect(result.current.history).toHaveLength(2);
    expect(result.current.pinnedMessageId).toBe("a");
  });

  it("removes every listener on unmount", () => {
    const { socket, unmount } = setup();

    unmount();

    for (const event of ["room-joined", "chat-message", "poll-create", "chat-reaction-update", "chat-message-edit", "chat-message-delete", "chat-pin-update", "poll-update"]) {
      expect(socket.listening(event)).toBe(0);
    }
  });
});
