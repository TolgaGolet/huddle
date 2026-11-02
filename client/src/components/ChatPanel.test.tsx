// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import type { ChatMessage } from "../types";
import ChatPanel from "./ChatPanel";

// Both children have their own tests. This covers what the panel connects between them.
const children = vi.hoisted(() => ({
  list: {} as { onReply: (msg: unknown) => void; onFocusComposer: () => void; isAtBottomRef: { current: boolean } },
  composer: {} as { replyingTo: unknown; onReplyingToChange: (msg: unknown) => void; onBeforeSend: () => void },
  handle: { focus: vi.fn(), addImages: vi.fn() },
}));

vi.mock("./MessageList", () => ({
  default: (props: typeof children.list) => {
    children.list = props;
    return <div data-testid="inside" />;
  },
}));
vi.mock("./Composer", () => ({
  default: ({ ref, ...props }: typeof children.composer & { ref: { current: unknown } }) => {
    ref.current = children.handle;
    children.composer = props;
    return null;
  },
}));

const message = { id: "m1", senderName: "Ana", text: "hi" } as ChatMessage;
const DROP_TEXT = "Drop images to send";

function setup() {
  const { container } = render(<ChatPanel socket={null} httpToken={null} chatHistory={[]} pinnedMessageId={null} localUserId="me" roomId="room" />);
  return container.firstElementChild as HTMLElement;
}

function dragLeave(panel: HTMLElement, relatedTarget: EventTarget | null) {
  const event = createEvent.dragLeave(panel);
  Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
  fireEvent(panel, event);
}

beforeEach(() => {
  children.handle.focus.mockReset();
  children.handle.addImages.mockReset();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("replying", () => {
  it("hands the message to the composer and focuses it", () => {
    setup();

    act(() => children.list.onReply(message));

    expect(children.composer.replyingTo).toBe(message);
    expect(children.handle.focus).toHaveBeenCalledOnce();
  });

  it("lets the composer cancel the reply", () => {
    setup();
    act(() => children.list.onReply(message));

    act(() => children.composer.onReplyingToChange(null));

    expect(children.composer.replyingTo).toBeNull();
  });
});

describe("focus and scroll", () => {
  it("lets the list send focus to the composer", () => {
    setup();

    children.list.onFocusComposer();

    expect(children.handle.focus).toHaveBeenCalledOnce();
  });

  // Your own message must always bring you to the bottom.
  it("treats the view as at the bottom before a send", () => {
    setup();
    children.list.isAtBottomRef.current = false;

    children.composer.onBeforeSend();

    expect(children.list.isAtBottomRef.current).toBe(true);
  });
});

describe("dropping images", () => {
  it("shows the drop target during a drag, and allows the drop", () => {
    const panel = setup();
    expect(screen.queryByText(DROP_TEXT)).toBeNull();
    const event = createEvent.dragOver(panel);

    fireEvent(panel, event);

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByText(DROP_TEXT)).toBeTruthy();
  });

  it("hides it when the drag leaves the panel", () => {
    const panel = setup();
    fireEvent.dragOver(panel);

    dragLeave(panel, document.body);

    expect(screen.queryByText(DROP_TEXT)).toBeNull();
  });

  // dragleave also fires when moving onto a child, which would make the overlay flicker.
  it("keeps it when the drag moves onto a child", () => {
    const panel = setup();
    fireEvent.dragOver(panel);

    dragLeave(panel, screen.getByTestId("inside"));

    expect(screen.getByText(DROP_TEXT)).toBeTruthy();
  });

  it("passes dropped files to the composer, and stops the browser opening them", () => {
    const panel = setup();
    fireEvent.dragOver(panel);
    const files = [new File(["x"], "a.png", { type: "image/png" })];
    const event = createEvent.drop(panel, { dataTransfer: { files } });

    fireEvent(panel, event);

    expect(event.defaultPrevented).toBe(true);
    expect(children.handle.addImages).toHaveBeenCalledWith(files);
    expect(screen.queryByText(DROP_TEXT)).toBeNull();
  });
});
