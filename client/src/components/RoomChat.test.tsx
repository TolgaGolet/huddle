// @vitest-environment jsdom
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { asAppSocket, fakeSocket, type FakeSocket } from "../test/fakeSocket";
import type { ChatMessage } from "../types";
import RoomChat from "./RoomChat";

const state = vi.hoisted(() => ({ crash: false }));

vi.mock("./ChatPanel", async () => {
  const { useContext } = await import("react");
  const { ImageSessionContext } = await import("../lib/imageSessionContext");
  function FakeChatPanel({ chatHistory, pinnedMessageId, httpToken, localUserId, roomId }: { chatHistory: ChatMessage[]; pinnedMessageId: string | null; httpToken: string; localUserId: string; roomId: string }) {
    const session = useContext(ImageSessionContext);
    if (state.crash) throw new Error("render failed");
    return <output data-testid="panel">{JSON.stringify({ ids: chatHistory.map((m) => m.id), pinnedMessageId, httpToken, localUserId, roomId, session })}</output>;
  }
  return { default: FakeChatPanel };
});

const message = (id: string) => ({ id, senderId: "u", senderName: "Ana", text: "hi", timestamp: 0, reactions: {} });

let socket: FakeSocket;

const element = () => <RoomChat socket={asAppSocket(socket)} httpToken="token" imageSession={3} localUserId="me" roomId="room" />;
const panel = () => JSON.parse(screen.getByTestId("panel").textContent!);

beforeEach(() => {
  state.crash = false;
  socket = fakeSocket();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RoomChat", () => {
  it("passes chat state, the room's details and the image session down", () => {
    render(element());

    act(() => void socket.fire("room-joined", { chatHistory: [message("a")], pinnedMessageId: "a" }));

    expect(panel()).toEqual({ ids: ["a"], pinnedMessageId: "a", httpToken: "token", localUserId: "me", roomId: "room", session: 3 });
  });

  // useWebRTC's effect in the parent sends the join, so this must already be listening.
  it("is listening for room-joined before its parent's effects run", () => {
    let listening = -1;
    function Parent() {
      useEffect(() => {
        listening = socket.listening("room-joined");
      }, []);
      return element();
    }

    render(<Parent />);

    expect(listening).toBe(1);
  });

  it("keeps the call running when the chat crashes", () => {
    state.crash = true;

    render(element());

    expect(screen.getByRole("alert").textContent).toContain("Your call is still connected");
  });

  it("keeps the history through a crash and a reload", () => {
    render(element());
    act(() => void socket.fire("chat-message", message("a")));

    state.crash = true;
    act(() => void socket.fire("chat-message", message("b")));
    expect(screen.getByRole("alert")).toBeTruthy();

    state.crash = false;
    act(() => void socket.fire("chat-message", message("c")));
    fireEvent.click(screen.getByRole("button", { name: "Reload chat" }));

    expect(panel().ids).toEqual(["a", "b", "c"]);
  });
});
