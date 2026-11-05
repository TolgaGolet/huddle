// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ImageSessionContext } from "../lib/imageSessionContext";
import { asAppSocket, emitsOf, fakeSocket } from "../test/fakeSocket";
import { MAX_CHAT_HISTORY, type ChatEntry, type ChatMessage, type PollMessage } from "../types";
import MessageList from "./MessageList";

const ME = "me";

const message = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  senderId: "other",
  senderName: "Ana",
  text: `text of ${id}`,
  timestamp: 0,
  reactions: {},
  ...overrides,
});

const poll = (id: string, overrides: Partial<PollMessage> = {}): PollMessage =>
  ({
    id,
    senderId: "other",
    senderName: "Ana",
    timestamp: 0,
    type: "poll",
    question: "Pizza?",
    allowMultiple: false,
    options: [{ id: "a", text: "Yes", voters: [] }],
    ...overrides,
  }) as PollMessage;

const scrollIntoView = vi.fn();

function setup(history: ChatEntry[] = [], pinnedMessageId: string | null = null, { noSocket = false } = {}) {
  const socket = fakeSocket();
  const isAtBottomRef = { current: true };
  const onReply = vi.fn();
  const onFocusComposer = vi.fn();
  const element = (h: ChatEntry[], pinned: string | null, canSendMessages = true) => (
    <ImageSessionContext.Provider value={1}>
      <MessageList
        socket={noSocket ? null : asAppSocket(socket)}
        chatHistory={h}
        pinnedMessageId={pinned}
        localUserId={ME}
        canSendMessages={canSendMessages}
        isAtBottomRef={isAtBottomRef}
        onReply={onReply}
        onFocusComposer={onFocusComposer}
      />
    </ImageSessionContext.Provider>
  );
  const view = render(element(history, pinnedMessageId));
  return {
    socket,
    isAtBottomRef,
    onReply,
    onFocusComposer,
    ...view,
    update: (h: ChatEntry[], pinned: string | null = pinnedMessageId) => view.rerender(element(h, pinned)),
    setCanSend: (allowed: boolean) => view.rerender(element(history, pinnedMessageId, allowed)),
  };
}

function scrollList(container: HTMLElement, { scrollTop, scrollHeight = 1000, clientHeight = 100 }: { scrollTop: number; scrollHeight?: number; clientHeight?: number }) {
  const list = container.querySelector(".overflow-y-auto") as HTMLElement;
  Object.defineProperty(list, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(list, "clientHeight", { value: clientHeight, configurable: true });
  list.scrollTop = scrollTop;
  fireEvent.scroll(list);
  return list;
}

const scrollUp = (container: HTMLElement) => scrollList(container, { scrollTop: 0 });

const moreActions = (messageName = "Message from Ana") =>
  fireEvent.click(screen.getAllByRole("group", { name: messageName })[0].querySelector('[aria-label="More actions"]')!);
const menuItems = () => screen.queryAllByRole("menuitem").map((el) => el.textContent?.trim());

beforeEach(() => {
  vi.useFakeTimers();
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("contents", () => {
  it("invites the first message when empty", () => {
    setup();

    expect(screen.getByText("No messages yet. Say something!")).toBeTruthy();
  });

  it("renders messages and polls in order", () => {
    setup([message("a"), poll("p"), message("b")]);

    expect(screen.getAllByRole("group").map((el) => el.getAttribute("aria-label"))).toEqual(["Message from Ana", "Poll from Ana", "Message from Ana"]);
    expect(screen.queryByText("No messages yet. Say something!")).toBeNull();
  });
});

describe("emitting", () => {
  it("sends a reaction", () => {
    const { socket } = setup([message("a")]);

    fireEvent.click(screen.getByRole("button", { name: "React with 👍" }));

    expect(emitsOf(socket, "chat-reaction")).toEqual([["chat-reaction", { messageId: "a", emoji: "👍" }]]);
  });

  it("sends a poll vote", () => {
    const { socket } = setup([poll("p")]);

    fireEvent.click(screen.getByRole("button", { name: /Yes/ }));

    expect(emitsOf(socket, "poll-vote")).toEqual([["poll-vote", { pollId: "p", optionId: "a" }]]);
  });

  it("does nothing without a socket", () => {
    setup([message("a")], null, { noSocket: true });

    expect(() => fireEvent.click(screen.getByRole("button", { name: "React with 👍" }))).not.toThrow();
  });

  it("hands a reply to the parent", () => {
    const entry = message("a");
    const { onReply } = setup([entry]);

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(onReply).toHaveBeenCalledWith(entry);
  });
});

describe("context menu", () => {
  it("offers edit and delete on your own text message", () => {
    setup([message("a", { senderId: ME })]);

    moreActions();

    expect(menuItems()).toEqual(["Edit message", "Delete message", "Pin message"]);
  });

  it("offers only pin on someone else's", () => {
    setup([message("a")]);

    moreActions();

    expect(menuItems()).toEqual(["Pin message"]);
  });

  it("doesn't offer edit on your own image, as the server would refuse it", () => {
    setup([message("a", { senderId: ME, imageUrls: ["/a.png"] })]);

    moreActions();

    expect(menuItems()).toEqual(["Delete message", "Pin message"]);
  });

  it("works on a poll", () => {
    setup([poll("p", { senderId: ME })]);

    moreActions("Poll from Ana");

    expect(menuItems()).toEqual(["Delete message", "Pin message"]);
  });

  it("closes with focus back on the message when closed by keyboard", () => {
    setup([message("a")]);
    moreActions();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Message from Ana" }));
  });

  it("closes on a press elsewhere", () => {
    setup([message("a")]);
    moreActions();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("disappears if its message is deleted meanwhile", () => {
    const { update } = setup([message("a"), message("b")]);
    moreActions();

    update([message("b")]);

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps inside the list at the bottom-right corner", () => {
    const { container } = setup([message("a")]);
    const list = container.querySelector(".overflow-y-auto") as HTMLElement;
    list.getBoundingClientRect = () => ({ left: 100, top: 100, width: 300, height: 400 }) as DOMRect;
    const button = screen.getByRole("button", { name: "More actions" });
    button.getBoundingClientRect = () => ({ left: 390, bottom: 490 }) as DOMRect;

    fireEvent.click(button);

    const { left, top } = screen.getByRole("menu").style;
    expect(left).toBe(`${300 - 160 - 8}px`);
    expect(top).toBe(`${400 - 130 - 8}px`);
  });
});

describe("editing", () => {
  function startEditing() {
    const view = setup([message("a", { senderId: ME })]);
    moreActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit message" }));
    return view;
  }

  it("opens the editor and closes the menu", () => {
    startEditing();

    expect(screen.getByLabelText("Edit message")).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("sends the edit and closes the editor", () => {
    const { socket } = startEditing();
    fireEvent.change(screen.getByLabelText("Edit message"), { target: { value: "new" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(emitsOf(socket, "chat-edit")).toEqual([["chat-edit", { messageId: "a", text: "new" }]]);
    expect(screen.queryByLabelText("Edit message")).toBeNull();
  });

  it("closes without sending on cancel", () => {
    const { socket } = startEditing();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(emitsOf(socket, "chat-edit")).toEqual([]);
    expect(screen.queryByLabelText("Edit message")).toBeNull();
  });

  // Regression: the edit was thrown away, while the composer keeps its draft.
  it("keeps an open edit while the permission is gone, and saves it once it's back", () => {
    const { socket, setCanSend } = startEditing();
    fireEvent.change(screen.getByLabelText("Edit message"), { target: { value: "new" } });

    setCanSend(false);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(emitsOf(socket, "chat-edit")).toEqual([]);
    expect((screen.getByLabelText("Edit message") as HTMLTextAreaElement).value).toBe("new");

    setCanSend(true);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(emitsOf(socket, "chat-edit")).toEqual([["chat-edit", { messageId: "a", text: "new" }]]);
  });
});

describe("deleting", () => {
  function askToDelete() {
    const view = setup([message("a", { senderId: ME })]);
    moreActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete message" }));
    return view;
  }

  it("asks first", () => {
    const { socket } = askToDelete();

    expect(screen.getByRole("dialog", { name: "Delete message?" })).toBeTruthy();
    expect(emitsOf(socket, "chat-delete")).toEqual([]);
  });

  it("deletes on confirmation and sends focus to the composer", () => {
    const { socket, onFocusComposer } = askToDelete();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(emitsOf(socket, "chat-delete")).toEqual([["chat-delete", { messageId: "a" }]]);
    expect(onFocusComposer).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the message on cancel, with focus back on it", () => {
    const { socket } = askToDelete();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(emitsOf(socket, "chat-delete")).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Message from Ana" }));
  });
});

describe("pinning", () => {
  it("pins from the menu", () => {
    const { socket } = setup([message("a")]);
    moreActions();

    fireEvent.click(screen.getByRole("menuitem", { name: "Pin message" }));

    expect(emitsOf(socket, "chat-pin")).toEqual([["chat-pin", { messageId: "a" }]]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each<[string, ChatEntry, string]>([
    ["a message's text", message("a", { text: "important" }), "important"],
    ["a poll's question", poll("a"), "Poll: Pizza?"],
    ["an image", message("a", { text: "", imageUrls: ["/a.png"] }), "[Image]"],
    ["a GIF", message("a", { text: "", gifUrl: "https://g/a.gif" }), "[GIF]"],
  ])("summarizes %s in the banner", (_label, entry, summary) => {
    setup([entry], "a");

    expect(screen.getAllByText(summary).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Unpin message" })).toBeTruthy();
  });

  it("has no banner for a pin that's no longer in the history", () => {
    setup([message("a")], "gone");

    expect(screen.queryByRole("button", { name: "Unpin message" })).toBeNull();
  });

  it("unpins from the banner", () => {
    const { socket } = setup([message("a")], "a");

    fireEvent.click(screen.getByRole("button", { name: "Unpin message" }));

    expect(emitsOf(socket, "chat-pin")).toEqual([["chat-pin", { messageId: "a" }]]);
  });

  it("jumps to the pinned message and highlights it briefly", () => {
    setup([message("a", { text: "important" }), message("b")], "a");
    const target = screen.getAllByRole("group", { name: "Message from Ana" })[0];
    scrollIntoView.mockClear();

    fireEvent.click(screen.getAllByText("important")[0].closest("button")!);

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(target.className).toContain("bg-indigo-500/10");

    act(() => vi.advanceTimersByTime(1500));
    expect(target.className).not.toContain("bg-indigo-500/10");
  });
});

describe("following the conversation", () => {
  const scrollButton = (name: RegExp | string) => screen.queryByRole("button", { name });

  it("follows new messages while at the bottom", () => {
    const { update } = setup([message("a")]);
    scrollIntoView.mockClear();

    update([message("a"), message("b")]);

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth" });
    expect(scrollButton(/Scroll to/)).toBeNull();
  });

  it("offers a way back after scrolling up", () => {
    const { container, isAtBottomRef } = setup([message("a")]);

    scrollUp(container);

    expect(isAtBottomRef.current).toBe(false);
    expect(scrollButton("Scroll to the latest message")).toBeTruthy();
  });

  it("counts as at the bottom within 50px", () => {
    const { container, isAtBottomRef } = setup([message("a")]);

    scrollList(container, { scrollTop: 850 });
    expect(isAtBottomRef.current).toBe(true);

    scrollList(container, { scrollTop: 849 });
    expect(isAtBottomRef.current).toBe(false);
  });

  it("counts messages that arrive while scrolled up, without moving the view", () => {
    const { container, update } = setup([message("a")]);
    scrollUp(container);
    scrollIntoView.mockClear();

    update([message("a"), message("b")]);
    expect(scrollButton("Scroll to the 1 new message")).toBeTruthy();

    update([message("a"), message("b"), message("c")]);
    expect(scrollButton("Scroll to the 2 new messages")).toBeTruthy();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("doesn't count a deletion as new", () => {
    const { container, update } = setup([message("a"), message("b")]);
    scrollUp(container);

    update([message("a")]);

    expect(scrollButton("Scroll to the latest message")).toBeTruthy();
  });

  it("clears the count and the button when the button is used", () => {
    const { container, update } = setup([message("a")]);
    scrollUp(container);
    update([message("a"), message("b")]);

    fireEvent.click(scrollButton(/Scroll to/)!);

    expect(scrollIntoView).toHaveBeenCalled();
    expect(scrollButton(/Scroll to/)).toBeNull();
  });

  it("clears the count on scrolling back down by hand", () => {
    const { container, update } = setup([message("a")]);
    scrollUp(container);
    update([message("a"), message("b")]);

    scrollList(container, { scrollTop: 900 });

    expect(scrollButton(/Scroll to/)).toBeNull();
  });

  it("keeps to the bottom when an image loads and grows the list", () => {
    const { container } = setup([message("a", { gifUrl: "https://g/a.gif", text: "" })]);
    const list = container.querySelector(".overflow-y-auto") as HTMLElement;
    Object.defineProperty(list, "scrollHeight", { value: 1234, configurable: true });

    fireEvent.load(screen.getByRole("img"));

    expect(list.scrollTop).toBe(1234);
  });

  it("doesn't pull the view down when an image loads while scrolled up", () => {
    const { container } = setup([message("a", { gifUrl: "https://g/a.gif", text: "" })]);
    const list = scrollUp(container);

    fireEvent.load(screen.getByRole("img"));

    expect(list.scrollTop).toBe(0);
  });

  // Regression: at MAX_CHAT_HISTORY the length stays flat, so new messages went unnoticed.
  it("counts a new message once the history is at its cap", () => {
    const full = Array.from({ length: MAX_CHAT_HISTORY }, (_, i) => message(`m${i}`));
    const { container, update } = setup(full);
    scrollUp(container);

    update([...full.slice(1), message("new")]);

    expect(scrollButton("Scroll to the 1 new message")).toBeTruthy();
  });

  it("follows a new message once the history is at its cap", () => {
    const full = Array.from({ length: MAX_CHAT_HISTORY }, (_, i) => message(`m${i}`));
    const { update } = setup(full);
    scrollIntoView.mockClear();

    update([...full.slice(1), message("new")]);

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth" });
  });

  it("doesn't count an edit or reaction as new", () => {
    const { container, update } = setup([message("a")]);
    scrollUp(container);

    update([message("a", { text: "edited" })]);

    expect(scrollButton("Scroll to the latest message")).toBeTruthy();
  });

  it("counts a message that arrives along with a deletion", () => {
    const { container, update } = setup([message("a"), message("b")]);
    scrollUp(container);

    update([message("a"), message("c")]);

    expect(scrollButton("Scroll to the 1 new message")).toBeTruthy();
  });
});

describe("image viewer", () => {
  it("opens an image and closes again", () => {
    setup([message("a", { text: "", imageUrls: ["/a.png"] })]);

    fireEvent.click(screen.getByTitle("View image"));
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
