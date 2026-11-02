// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ImageSessionContext } from "../lib/imageSessionContext";
import type { ChatMessage } from "../types";
import MessageItem, { HIGHLIGHT_CLASS, type MessageActions } from "./MessageItem";

const base: ChatMessage = { id: "m1", senderId: "u1", senderName: "Ana", text: "hello", timestamp: 0, reactions: {} };

function setup(overrides: Partial<ChatMessage> = {}, props: Partial<React.ComponentProps<typeof MessageItem>> = {}) {
  const actions: { [K in keyof MessageActions]: ReturnType<typeof vi.fn> } = {
    registerRef: vi.fn(),
    react: vi.fn(),
    reply: vi.fn(),
    openMenu: vi.fn(),
    scrollTo: vi.fn(),
    viewImage: vi.fn(),
    imageLoaded: vi.fn(),
    submitEdit: vi.fn(),
    cancelEdit: vi.fn(),
  };
  const msg = { ...base, ...overrides };
  const view = render(
    <ImageSessionContext.Provider value={1}>
      <MessageItem msg={msg} isPinned={false} isEditing={false} isHighlighted={false} localUserId="me" actions={actions as unknown as MessageActions} {...props} />
    </ImageSessionContext.Provider>,
  );
  return { actions, msg, ...view };
}

afterEach(cleanup);

describe("MessageItem", () => {
  it("shows the sender and text, labelled for keyboard users", () => {
    setup();

    expect(screen.getByRole("group", { name: "Message from Ana" })).toBeTruthy();
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("registers its element for scroll-to and focus", () => {
    const { actions } = setup();

    expect(actions.registerRef).toHaveBeenCalledWith("m1", expect.any(HTMLDivElement));
  });

  it("marks an edited message", () => {
    setup({ edited: true });

    expect(screen.getByText("(edited)")).toBeTruthy();
  });

  it("marks a pinned or highlighted message", () => {
    const { container } = setup({}, { isPinned: true, isHighlighted: true });

    expect(screen.getByText("Pinned")).toBeTruthy();
    expect(container.firstElementChild!.className).toContain(HIGHLIGHT_CLASS);
  });

  describe("attachments", () => {
    it("shows a GIF with its attribution", () => {
      const { actions } = setup({ text: "", gifUrl: "https://media.giphy.com/a.gif" });
      const gif = screen.getByAltText("GIF") as HTMLImageElement;

      expect(gif.src).toBe("https://media.giphy.com/a.gif");
      expect(screen.getByRole("link", { name: "GIPHY" })).toBeTruthy();

      fireEvent.load(gif);
      expect(actions.imageLoaded).toHaveBeenCalled();
    });

    it("uses a GIF's title as its alt text", () => {
      setup({ text: "cat", gifUrl: "https://media.giphy.com/a.gif" });

      expect(screen.getByAltText("cat")).toBeTruthy();
    });

    it("opens an image in the viewer", () => {
      const { actions } = setup({ text: "", imageUrls: ["/a.png", "/b.png"] });

      fireEvent.click(screen.getAllByTitle("View image")[1]);

      expect(actions.viewImage).toHaveBeenCalledWith("/b.png", "Ana");
    });

    it("shows images and text together", () => {
      setup({ text: "look", imageUrls: ["/a.png"] });

      expect(screen.getByRole("img")).toBeTruthy();
      expect(screen.getByText("look")).toBeTruthy();
    });

    it("renders nothing for an empty text with no attachment", () => {
      setup({ text: "" });

      expect(screen.queryByText("(edited)")).toBeNull();
    });
  });

  describe("replies", () => {
    it("jumps to the quoted message", () => {
      const { actions } = setup({ replyTo: { id: "m0", senderName: "Bo", text: "earlier" } });

      fireEvent.click(screen.getByRole("button", { name: "Go to the message from Bo this replies to" }));

      expect(screen.getByText("earlier")).toBeTruthy();
      expect(actions.scrollTo).toHaveBeenCalledWith("m0");
    });

    it("shows a quoted image instead of its text, openable in the viewer", () => {
      const { actions } = setup({ replyTo: { id: "m0", senderName: "Bo", text: "unused", imageUrl: "/q.png" } });

      expect(screen.queryByText("unused")).toBeNull();
      fireEvent.click(screen.getByTitle("View image"));

      expect(actions.viewImage).toHaveBeenCalledWith("/q.png", "Bo");
    });

    it("hides a quoted image that has gone, and brings it back if a retry loads", () => {
      setup({ replyTo: { id: "m0", senderName: "Bo", text: "", imageUrl: "/q.png" } });
      const image = screen.getByAltText("Sent by Bo");
      const button = screen.getByTitle("View image");

      fireEvent.error(image);
      expect(button.classList.contains("hidden")).toBe(true);

      fireEvent.load(image);
      expect(button.classList.contains("hidden")).toBe(false);
    });
  });

  describe("reactions", () => {
    const users = (...ids: string[]) => ids.map((userId) => ({ userId, name: userId.toUpperCase() }));

    it("describes who reacted", () => {
      setup({ reactions: { "👍": users("me", "bo") } });

      expect(screen.getByRole("button", { name: "👍 reaction, 2 people: ME, BO" })).toBeTruthy();
    });

    it("uses the singular for one person", () => {
      setup({ reactions: { "👍": users("bo") } });

      expect(screen.getByRole("button", { name: "👍 reaction, 1 person: BO" })).toBeTruthy();
    });

    it("marks reactions the local user made", () => {
      setup({ reactions: { "👍": users("me"), "😂": users("bo") } });

      expect(screen.getByRole("button", { name: /👍 reaction/ }).getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByRole("button", { name: /😂 reaction/ }).getAttribute("aria-pressed")).toBe("false");
    });

    it("hides a reaction nobody holds any more", () => {
      setup({ reactions: { "👍": [] } });

      expect(screen.queryByRole("button", { name: /👍 reaction/ })).toBeNull();
    });

    it("tolerates a message with no reactions object", () => {
      expect(() => setup({ reactions: undefined as unknown as ChatMessage["reactions"] })).not.toThrow();
    });

    it("toggles from a badge and from the action bar", () => {
      const { actions } = setup({ reactions: { "👍": users("bo") } });

      fireEvent.click(screen.getByRole("button", { name: /👍 reaction/ }));
      fireEvent.click(screen.getByRole("button", { name: "React with 😂" }));

      expect(actions.react).toHaveBeenNthCalledWith(1, "m1", "👍");
      expect(actions.react).toHaveBeenNthCalledWith(2, "m1", "😂");
    });
  });

  describe("actions", () => {
    it("starts a reply with the whole message", () => {
      const { actions, msg } = setup();

      fireEvent.click(screen.getByRole("button", { name: "Reply" }));

      expect(actions.reply).toHaveBeenCalledWith(msg);
    });

    it("opens the menu", () => {
      const { actions, msg } = setup();

      fireEvent.click(screen.getByRole("button", { name: "More actions" }));

      expect(actions.openMenu).toHaveBeenCalledWith(msg, expect.anything());
    });
  });

  describe("editing", () => {
    it("replaces the text with an editor holding it", () => {
      setup({ edited: true }, { isEditing: true });

      expect((screen.getByLabelText("Edit message") as HTMLTextAreaElement).value).toBe("hello");
      expect(screen.queryByText("(edited)")).toBeNull();
    });

    it("submits with the message's id", () => {
      const { actions } = setup({}, { isEditing: true });

      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(actions.submitEdit).toHaveBeenCalledWith("m1", "hello");
    });

    it("cancels", () => {
      const { actions } = setup({}, { isEditing: true });

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(actions.cancelEdit).toHaveBeenCalledOnce();
    });
  });
});
