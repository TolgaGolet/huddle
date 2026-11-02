// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { asAppSocket, emitsOf, fakeSocket } from "../test/fakeSocket";
import type { AppSocket } from "../types";
import { useTyping } from "./useTyping";

function setup() {
  const socket = fakeSocket();
  const view = renderHook((s: AppSocket | null) => useTyping(s), { initialProps: asAppSocket(socket) as AppSocket | null });
  const fire = (event: string, data: unknown) => act(() => void socket.fire(event, data));
  return { socket, fire, ...view };
}

afterEach(cleanup);

describe("useTyping", () => {
  it("lists who is typing", () => {
    const { result, fire } = setup();

    fire("typing", { userId: "u1", senderName: "Ana" });

    expect(result.current.typingUsers).toEqual(["Ana"]);
  });

  it("clears someone once their message arrives", () => {
    const { result, fire } = setup();
    fire("typing", { userId: "u1", senderName: "Ana" });

    fire("chat-message", { senderId: "u1" });

    expect(result.current.typingUsers).toEqual([]);
  });

  it("clears someone who left", () => {
    const { result, fire } = setup();
    fire("typing", { userId: "u1", senderName: "Ana" });

    fire("participant-left", { id: "s1", userId: "u1" });

    expect(result.current.typingUsers).toEqual([]);
  });

  it("announces our own typing", () => {
    const { result, socket } = setup();

    result.current.notifyTyping();

    expect(emitsOf(socket, "typing")).toHaveLength(1);
  });

  it("does nothing to announce without a socket", () => {
    const { result } = renderHook(() => useTyping(null));

    expect(() => result.current.notifyTyping()).not.toThrow();
  });

  it("resets and stops listening when the socket goes", () => {
    const { result, socket, fire, rerender } = setup();
    fire("typing", { userId: "u1", senderName: "Ana" });

    rerender(null);

    expect(result.current.typingUsers).toEqual([]);
    expect(socket.listening("typing")).toBe(0);
  });
});
