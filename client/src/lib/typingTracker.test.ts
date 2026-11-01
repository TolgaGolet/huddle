import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TypingTracker } from "./typingTracker";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const onChange = vi.fn<(names: string[]) => void>();
  return { tracker: new TypingTracker(onChange), onChange, latest: () => onChange.mock.lastCall?.[0] };
}

describe("TypingTracker", () => {
  it("lists the most recent typer first", () => {
    const { tracker, latest } = setup();
    tracker.started("u1", "Ana");
    tracker.started("u2", "Bo");
    expect(latest()).toEqual(["Bo", "Ana"]);
  });

  it("expires a typer who stops without sending", () => {
    const { tracker, latest } = setup();
    tracker.started("u1", "Ana");
    vi.advanceTimersByTime(5000);
    expect(latest()).toEqual([]);
  });

  it("restarts the expiry on each event, without publishing the same names again", () => {
    const { tracker, onChange, latest } = setup();
    tracker.started("u1", "Ana");
    vi.advanceTimersByTime(3000);
    tracker.started("u1", "Ana");
    expect(onChange).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(3000);
    expect(latest()).toEqual(["Ana"]);
  });

  it("clears a user", () => {
    const { tracker, latest } = setup();
    tracker.started("u1", "Ana");
    tracker.started("u2", "Bo");
    tracker.clear("u1");
    expect(latest()).toEqual(["Bo"]);
    tracker.clear("u2");
    expect(latest()).toEqual([]);
  });

  it("stops its timers on dispose", () => {
    const { tracker } = setup();
    tracker.started("u1", "Ana");
    tracker.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
