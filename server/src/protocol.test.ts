import { describe, it, expect } from "vitest";
import { hasReacted } from "./protocol.js";

describe("hasReacted", () => {
  const ana = { userId: "u-ana", name: "Ana" };
  const sam = { userId: "u-sam", name: "Sam" };

  it("matches the local user's own reaction", () => {
    expect(hasReacted([ana, sam], "u-sam")).toBe(true);
  });

  it("does not match reactions from other people", () => {
    expect(hasReacted([ana], "u-sam")).toBe(false);
    expect(hasReacted([], "u-sam")).toBe(false);
  });

  // Regression (Q-04): matching by name gave a newcomer a departed user's reactions.
  it("does not match someone else with the same name", () => {
    expect(hasReacted([{ userId: "u-old", name: "Sam" }], "u-sam")).toBe(false);
  });
});
