// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PollMessage } from "../types";
import PollDisplay from "./PollDisplay";

const voters = (...ids: string[]) => ids.map((userId) => ({ userId, name: userId }));

function poll(overrides: Partial<PollMessage> = {}): PollMessage {
  return {
    id: "p1",
    senderId: "u",
    senderName: "Ana",
    timestamp: 0,
    type: "poll",
    question: "Pizza?",
    allowMultiple: false,
    options: [
      { id: "a", text: "Yes", voters: voters("me", "bo", "cem") },
      { id: "b", text: "No", voters: voters("ece") },
    ],
    ...overrides,
  } as PollMessage;
}

function setup(p = poll(), extra: Partial<React.ComponentProps<typeof PollDisplay>> = {}) {
  const onVote = vi.fn();
  const view = render(<PollDisplay poll={p} isPinned={false} localUserId="me" onVote={onVote} {...extra} />);
  return { onVote, ...view };
}

const option = (name: RegExp) => screen.getByRole("button", { name });

afterEach(cleanup);

describe("PollDisplay", () => {
  it("shows each option's count and share of the vote", () => {
    setup();

    expect(option(/Yes/).textContent).toContain("3");
    expect(option(/Yes/).textContent).toContain("75%");
    expect(option(/No/).textContent).toContain("25%");
  });

  it("rounds shares and hides them before any votes", () => {
    setup(poll({ options: [{ id: "a", text: "Yes", voters: [] }, { id: "b", text: "No", voters: [] }] }));

    expect(option(/Yes/).textContent).not.toContain("%");
    expect(screen.getByText(/0 votes/)).toBeTruthy();
  });

  it("uses the singular for one vote", () => {
    setup(poll({ options: [{ id: "a", text: "Yes", voters: voters("bo") }, { id: "b", text: "No", voters: [] }] }));

    expect(screen.getByText(/^1 vote$/)).toBeTruthy();
  });

  it("marks only the options the local user voted for", () => {
    setup();

    expect(option(/Yes/).getAttribute("aria-pressed")).toBe("true");
    expect(option(/No/).getAttribute("aria-pressed")).toBe("false");
  });

  it("votes with the poll and option ids", () => {
    const { onVote } = setup();

    fireEvent.click(option(/No/));

    expect(onVote).toHaveBeenCalledWith("p1", "b");
  });

  it("says when multiple selections are allowed", () => {
    setup(poll({ allowMultiple: true }));

    expect(screen.getByText(/Multiple selections allowed/)).toBeTruthy();
  });

  it("shows the pinned marker only when pinned", () => {
    const { rerender, onVote } = setup();
    expect(screen.queryByText("Pinned")).toBeNull();

    rerender(<PollDisplay poll={poll()} isPinned localUserId="me" onVote={onVote} />);

    expect(screen.getByText("Pinned")).toBeTruthy();
  });

  it("offers the actions menu only when a handler is given", () => {
    setup();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();

    cleanup();
    const onContextMenu = vi.fn();
    const p = poll();
    setup(p, { onContextMenu });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));

    expect(onContextMenu).toHaveBeenCalledWith(p, expect.anything());
  });
});
