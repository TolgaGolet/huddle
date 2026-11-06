// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    lockVotes: false,
    options: [
      { id: "a", text: "Yes", voters: voters("me", "bo", "cem") },
      { id: "b", text: "No", voters: voters("ece") },
    ],
    ...overrides,
  } as PollMessage;
}

function setup(p = poll(), extra: Partial<React.ComponentProps<typeof PollDisplay>> = {}) {
  const onVote = vi.fn();
  const onSubmit = vi.fn();
  const view = render(<PollDisplay poll={p} isPinned={false} localUserId="me" onVote={onVote} onSubmit={onSubmit} {...extra} />);
  return { onVote, onSubmit, ...view };
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

    rerender(<PollDisplay poll={poll()} isPinned localUserId="me" onVote={onVote} onSubmit={vi.fn()} />);

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

  it("takes no votes once the poll has closed", () => {
    const { onVote } = setup(poll({ closed: true, endsAt: 1 }));

    expect((option(/No/) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(option(/No/));
    expect(onVote).not.toHaveBeenCalled();
    expect(screen.getByText(/Closed/)).toBeTruthy();
  });

  // Regression: the client closed the poll by its own clock, so a fast clock
  // refused votes the server still took, and a slow one offered refused ones.
  it("counts down by this clock but closes only when the server says so", () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const { rerender } = setup(poll({ endsAt: 125_000 }));
      expect(screen.getByText(/Ends in 2m 5s/)).toBeTruthy();

      act(() => vi.advanceTimersByTime(125_000));
      expect(screen.getByText(/Ending…/)).toBeTruthy();
      expect((option(/No/) as HTMLButtonElement).disabled).toBe(false);

      rerender(<PollDisplay poll={poll({ endsAt: 125_000, closed: true })} isPinned={false} localUserId="me" onVote={vi.fn()} onSubmit={vi.fn()} />);
      expect(screen.getByText(/Closed/)).toBeTruthy();
      expect((option(/No/) as HTMLButtonElement).disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression: a submit the server dropped without an update left every button disabled.
  it("lets a vote be sent again when the server never answers", () => {
    vi.useFakeTimers();
    try {
      const { onSubmit } = setup(poll({ lockVotes: true, options: [{ id: "a", text: "Yes", voters: [] }] }));
      fireEvent.click(option(/Yes/));
      fireEvent.click(screen.getByRole("button", { name: "Submit vote" }));
      expect(screen.getByRole("button", { name: "Submitting…" })).toBeTruthy();

      act(() => vi.advanceTimersByTime(5000));
      fireEvent.click(screen.getByRole("button", { name: "Submit vote" }));
      expect(onSubmit).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression: one tap cast a final vote, so a mis-tap couldn't be corrected.
  it("lets a locked single-select choice change until it's submitted, then takes no more", () => {
    const fresh = poll({ lockVotes: true, options: [{ id: "a", text: "Yes", voters: [] }, { id: "b", text: "No", voters: [] }] });
    const { onSubmit, onVote, rerender } = setup(fresh);

    fireEvent.click(option(/Yes/));
    fireEvent.click(option(/No/));
    expect(option(/Yes/).getAttribute("aria-pressed")).toBe("false");
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Submit vote" }));
    expect(onSubmit).toHaveBeenCalledWith("p1", ["b"]);
    expect(onVote).not.toHaveBeenCalled();

    rerender(<PollDisplay poll={poll({ lockVotes: true })} isPinned={false} localUserId="me" onVote={onVote} onSubmit={onSubmit} />);
    expect((option(/No/) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Votes are final/)).toBeTruthy();
  });

  it("collects locked multi-select choices and submits them together", () => {
    const fresh = poll({
      lockVotes: true,
      allowMultiple: true,
      options: [
        { id: "a", text: "Yes", voters: [] },
        { id: "b", text: "No", voters: [] },
        { id: "c", text: "Maybe", voters: [] },
      ],
    });
    const { onSubmit } = setup(fresh);
    const submit = () => screen.getByRole("button", { name: "Submit vote" }) as HTMLButtonElement;
    expect(submit().disabled).toBe(true);

    fireEvent.click(option(/Maybe/));
    fireEvent.click(option(/Yes/));
    fireEvent.click(option(/No/));
    fireEvent.click(option(/No/));
    expect(option(/Yes/).getAttribute("aria-pressed")).toBe("true");
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(submit());
    expect(onSubmit).toHaveBeenCalledWith("p1", ["a", "c"]);
    expect(screen.getByRole("button", { name: "Submitting…" })).toBeTruthy();
  });
});
