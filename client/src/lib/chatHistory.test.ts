import { describe, it, expect } from "vitest";
import { appendCapped, applyMessageDelete, applyMessageEdit } from "./chatHistory";
import { MAX_CHAT_HISTORY, type ChatEntry, type ChatMessage } from "../types";

const entry = (id: string): ChatEntry => ({
  id,
  senderId: "u",
  senderName: "Ana",
  text: "",
  timestamp: 0,
  reactions: {},
});

describe("quotes of a changed message", () => {
  const reply: ChatEntry = { ...entry("r"), replyTo: { id: "a", senderName: "Ana", text: "old" } };

  // Regression: a quote kept the original's words after an edit or a delete.
  it("updates a reply's quote on edit", () => {
    const [edited, quoting] = applyMessageEdit([entry("a"), reply], "a", "new") as ChatMessage[];
    expect(edited).toMatchObject({ text: "new", edited: true });
    expect(quoting.replyTo?.text).toBe("new");
    expect(quoting.edited).toBeUndefined();
  });

  it("removes a reply's quote on delete, keeping the reply", () => {
    const [remaining, ...rest] = applyMessageDelete([entry("a"), reply], "a") as ChatMessage[];
    expect(rest).toEqual([]);
    expect(remaining.id).toBe("r");
    expect(remaining.replyTo).toBeUndefined();
  });

  it("leaves a quote of another message alone", () => {
    expect(applyMessageDelete([reply], "b")).toEqual([reply]);
    expect(applyMessageEdit([reply], "b", "new")).toEqual([reply]);
  });
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
