import { vi } from "vitest";
import type { AppSocket } from "../types";

type Handler = (data?: unknown) => unknown;

/** A socket whose events a test fires by hand. Not imported by app code, so it never reaches the bundle. */
export function fakeSocket(initialId = "self") {
  const handlers = new Map<string, Set<Handler>>();
  const socket = {
    id: initialId as string | undefined,
    connected: true,
    emit: vi.fn(),
    disconnect: vi.fn(),
    on(event: string, handler: Handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return socket;
    },
    off(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
      return socket;
    },
    removeAllListeners() {
      handlers.clear();
      return socket;
    },
    fire(event: string, data?: unknown) {
      return [...(handlers.get(event) ?? [])].map((handler) => handler(data));
    },
    listening(event: string) {
      return handlers.get(event)?.size ?? 0;
    },
  };
  return socket;
}

export type FakeSocket = ReturnType<typeof fakeSocket>;

export const asAppSocket = (socket: FakeSocket) => socket as unknown as AppSocket;

export const emitsOf = (socket: FakeSocket, event: string) => socket.emit.mock.calls.filter(([name]) => name === event);
