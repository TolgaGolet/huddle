import { describe, it, expect } from "vitest";
import { nextFocusIndex } from "./focusTrap";

describe("nextFocusIndex", () => {
  it("moves forward and wraps from the last item to the first", () => {
    expect(nextFocusIndex(3, 0, false)).toBe(1);
    expect(nextFocusIndex(3, 2, false)).toBe(0);
  });

  it("moves backward and wraps from the first item to the last", () => {
    expect(nextFocusIndex(3, 2, true)).toBe(1);
    expect(nextFocusIndex(3, 0, true)).toBe(2);
  });

  it("pulls focus in from outside the items", () => {
    expect(nextFocusIndex(3, -1, false)).toBe(0);
    expect(nextFocusIndex(3, -1, true)).toBe(2);
  });

  it("stays on a single item", () => {
    expect(nextFocusIndex(1, 0, false)).toBe(0);
    expect(nextFocusIndex(1, 0, true)).toBe(0);
  });

  it("returns null when there is nothing to focus", () => {
    expect(nextFocusIndex(0, -1, false)).toBeNull();
  });
});
