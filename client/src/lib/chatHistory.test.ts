import { describe, it, expect } from "vitest";
import { appendCapped } from "./chatHistory";
import { MAX_CHAT_HISTORY, type ChatEntry } from "../types";

const entry = (id: string): ChatEntry => ({
  id,
  senderId: "u",
  senderName: "Ana",
  text: "",
  timestamp: 0,
  reactions: {},
});

describe("appendCapped", () => {
  it("appends without touching the original", () => {
    const history = [entry("a")];
    expect(appendCapped(history, entry("b")).map((e) => e.id)).toEqual(["a", "b"]);
    expect(history).toHaveLength(1);
  });

  it("drops the oldest entry once full", () => {
    const full = Array.from({ length: MAX_CHAT_HISTORY }, (_, i) => entry(String(i)));
    const next = appendCapped(full, entry("new"));
    expect(next).toHaveLength(MAX_CHAT_HISTORY);
    expect(next[0].id).toBe("1");
    expect(next.at(-1)?.id).toBe("new");
  });
});
