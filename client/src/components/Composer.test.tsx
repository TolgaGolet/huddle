// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AppSocket, ChatMessage } from "../types";
import { uploadImages } from "../lib/imageUpload";
import { GamePartyContext } from "../lib/gamePartyContext";
import { gameContextValue, RAGAMUFFIN } from "../test/gameParty";
import Composer, { type ComposerHandle } from "./Composer";

vi.mock("../lib/imageUpload", async (original) => ({
  ...(await original<typeof import("../lib/imageUpload")>()),
  uploadImages: vi.fn(),
}));

function fakeSocket() {
  const handlers = new Map<string, Set<(data?: unknown) => void>>();
  return {
    id: "socket-1",
    connected: true,
    emit: vi.fn(),
    on(event: string, handler: (data?: unknown) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off(event: string, handler: (data?: unknown) => void) {
      handlers.get(event)?.delete(handler);
    },
    fire(event: string, data?: unknown) {
      handlers.get(event)?.forEach((handler) => handler(data));
    },
  };
}

const message = { id: "m1", senderName: "Bo", text: "hi" } as unknown as ChatMessage;
const imageFile = () => new File(["x"], "a.png", { type: "image/png" });

function setup(replyingTo: ChatMessage | null = null, canSend = true) {
  const socket = fakeSocket();
  const ref = { current: null as ComposerHandle | null };
  const onReplyingToChange = vi.fn();
  const element = (reply: ChatMessage | null, allowed = canSend) => (
    <Composer
      ref={ref}
      socket={socket as unknown as AppSocket}
      httpToken="token"
      roomId="room"
      canSend={allowed}
      replyingTo={reply}
      onReplyingToChange={onReplyingToChange}
      onBeforeSend={() => {}}
    />
  );
  const view = render(element(replyingTo));
  const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
  return {
    socket,
    ref,
    box,
    onReplyingToChange,
    rerenderWith: (reply: ChatMessage | null) => view.rerender(element(reply)),
    setCanSend: (allowed: boolean) => view.rerender(element(replyingTo, allowed)),
  };
}

const chatEmits = (socket: ReturnType<typeof fakeSocket>) => socket.emit.mock.calls.filter(([event]) => event === "chat-message");

beforeEach(() => {
  vi.mocked(uploadImages).mockReset();
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(cleanup);

describe("Composer", () => {
  it("sends on Enter and clears the draft", async () => {
    const { socket, box } = setup();
    fireEvent.change(box, { target: { value: " hello " } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(box.value).toBe(""));
    expect(chatEmits(socket)).toEqual([["chat-message", { text: "hello" }]]);
  });

  it("sends, types and adds images only with permission to send", () => {
    const { socket, ref, box } = setup(null, false);

    expect(box.readOnly).toBe(true);
    expect(box.getAttribute("aria-disabled")).toBe("true");
    expect(box.placeholder).toBe("Only owners can send messages");
    expect(screen.getByLabelText("Create poll").matches(":disabled")).toBe(true);
    act(() => ref.current!.addImages([imageFile()]));
    fireEvent.keyDown(box, { key: "Enter" });

    expect(screen.queryByText(/Images ready to send/)).toBeNull();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  // Regression: disabling the focused box dropped focus to the page.
  it("keeps focus in the box when the permission goes", () => {
    const { box, setCanSend } = setup();
    box.focus();

    setCanSend(false);

    expect(box.disabled).toBe(false);
    expect(document.activeElement).toBe(box);
  });

  // Regression: the server would drop the message after the draft was cleared.
  it("keeps the draft if the permission goes during an upload", async () => {
    let finishUpload!: (urls: string[]) => void;
    vi.mocked(uploadImages).mockReturnValue(new Promise((resolve) => { finishUpload = resolve; }));
    const { socket, ref, box, setCanSend } = setup();
    fireEvent.change(box, { target: { value: "look" } });
    act(() => ref.current!.addImages([imageFile()]));
    fireEvent.keyDown(box, { key: "Enter" });

    setCanSend(false);
    await act(async () => finishUpload(["/api/rooms/room/images/a.png"]));

    expect(chatEmits(socket)).toEqual([]);
    expect(screen.getByRole("alert").textContent).toContain("Not sent");
    expect(box.value).toBe("look");
    expect(screen.getByAltText("a.png")).toBeTruthy();
  });

  it("says so when the server refused a send as the setting changed", () => {
    const { socket } = setup();
    act(() => socket.fire("not-permitted", { event: "chat-message" }));

    expect(screen.getByRole("alert").textContent).toContain("only owners");
  });

  it("doesn't send on Shift+Enter", () => {
    const { socket, box } = setup();
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });

    expect(chatEmits(socket)).toEqual([]);
  });

  it("keeps the draft when an upload fails", async () => {
    vi.mocked(uploadImages).mockRejectedValue(new Error("nope"));
    const { socket, ref, box } = setup();
    fireEvent.change(box, { target: { value: "caption" } });
    act(() => ref.current!.addImages([imageFile()]));

    fireEvent.keyDown(box, { key: "Enter" });

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(box.value).toBe("caption");
    expect(screen.getByAltText("a.png")).toBeTruthy();
    expect(chatEmits(socket)).toEqual([]);
  });

  it("sends the uploaded URLs and clears the images", async () => {
    vi.mocked(uploadImages).mockResolvedValue(["/api/rooms/room/images/a.png"]);
    const { socket, ref, box } = setup();
    act(() => ref.current!.addImages([imageFile()]));

    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(chatEmits(socket)).toHaveLength(1));
    expect(chatEmits(socket)[0][1]).toMatchObject({ imageUrls: ["/api/rooms/room/images/a.png"] });
    await waitFor(() => expect(screen.queryByAltText("a.png")).toBeNull());
  });

  it("sends once when Enter is pressed again during an upload", async () => {
    let finishUpload!: (urls: string[]) => void;
    vi.mocked(uploadImages).mockReturnValue(new Promise((resolve) => { finishUpload = resolve; }));
    const { socket, ref, box } = setup();
    act(() => ref.current!.addImages([imageFile()]));

    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter" });
    await act(async () => finishUpload(["/api/rooms/room/images/a.png"]));

    expect(uploadImages).toHaveBeenCalledOnce();
    expect(chatEmits(socket)).toHaveLength(1);
  });

  it("rejects a file that isn't an image and keeps the rest of the draft", () => {
    const { ref } = setup();
    act(() => ref.current!.addImages([imageFile(), new File(["x"], "notes.txt", { type: "text/plain" })]));

    expect(screen.getByRole("alert").textContent).toContain("notes.txt");
    expect(screen.getByAltText("a.png")).toBeTruthy();
  });

  it("shows the server's rate-limit notice", () => {
    const { socket } = setup();
    act(() => socket.fire("rate-limited"));

    expect(screen.getByRole("alert").textContent).toContain("too fast");
  });

  it("shows who is typing, and clears them when their message arrives", () => {
    const { socket } = setup();
    act(() => socket.fire("typing", { userId: "u2", senderName: "Bo" }));
    expect(screen.getByText("Bo is typing...")).toBeTruthy();

    act(() => socket.fire("chat-message", { senderId: "u2", senderName: "Bo" }));
    expect(screen.queryByText("Bo is typing...")).toBeNull();
  });

  it("clears the reply it sent", async () => {
    const { socket, box, onReplyingToChange } = setup(message);
    fireEvent.change(box, { target: { value: "answer" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(chatEmits(socket)).toHaveLength(1));
    expect(chatEmits(socket)[0][1]).toMatchObject({ replyToId: "m1" });
    const update = onReplyingToChange.mock.calls[0][0] as (current: ChatMessage | null) => ChatMessage | null;
    expect(update(message)).toBeNull();
  });

  it("keeps a reply started while the upload was running", async () => {
    let finishUpload!: (urls: string[]) => void;
    vi.mocked(uploadImages).mockReturnValue(new Promise((resolve) => { finishUpload = resolve; }));
    const { ref, box, onReplyingToChange, rerenderWith } = setup();
    act(() => ref.current!.addImages([imageFile()]));
    fireEvent.keyDown(box, { key: "Enter" });

    const later = { ...message, id: "m2" };
    rerenderWith(later);
    await act(async () => finishUpload(["/api/rooms/room/images/a.png"]));

    const update = onReplyingToChange.mock.lastCall![0] as (current: ChatMessage | null) => ChatMessage | null;
    expect(update(later)).toBe(later);
  });

  it("starts a watch party from its popover and reports the limit", async () => {
    const { socket } = setup();
    fireEvent.click(screen.getByLabelText("Watch together"));
    fireEvent.change(screen.getByLabelText("YouTube link"), { target: { value: "https://youtu.be/dQw4w9WgXcQ" } });
    fireEvent.click(screen.getByRole("button", { name: "Start watch party" }));

    expect(socket.emit).toHaveBeenCalledWith("watch-start", { videoId: "dQw4w9WgXcQ", allowOthersToChange: true });
    expect(screen.queryByLabelText("YouTube link")).toBeNull();

    // Another party started meanwhile, filling the room.
    act(() => socket.fire("watch-start-refused", { reason: "limit", max: 2 }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/At most 2 watch parties/);
  });

  it("starts a game party from its popover and reports the limit", async () => {
    const socket = fakeSocket();
    render(
      <GamePartyContext value={gameContextValue({ games: [RAGAMUFFIN] })}>
        <Composer
          ref={{ current: null }}
          socket={socket as unknown as AppSocket}
          httpToken="token"
          roomId="room"
          canSend
          replyingTo={null}
          onReplyingToChange={() => {}}
          onBeforeSend={() => {}}
        />
      </GamePartyContext>,
    );
    fireEvent.click(screen.getByLabelText("Play together"));
    fireEvent.click(screen.getByRole("button", { name: "Start a game party: RagaMuffin" }));

    expect(socket.emit).toHaveBeenCalledWith("game-start", { gameId: "ragamuffin" });
    expect(screen.queryByRole("button", { name: /Start a game party/ })).toBeNull();

    act(() => socket.fire("game-start-refused", { reason: "limit", max: 2 }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/At most 2 game parties/);
  });
});
