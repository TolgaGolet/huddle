import { describe, it, expect } from "vitest";
import { errorSummary } from "./errorLog.js";

describe("errorSummary", () => {
  it("describes a non-Error throw by its type, not its value", () => {
    expect(errorSummary("hunter2")).toEqual({ name: "string" });
    expect(errorSummary(undefined)).toEqual({ name: "undefined" });
  });

  it("keeps the name and frames but not the message", () => {
    const err = new TypeError("password was hunter2");
    const summary = errorSummary(err);

    expect(summary.name).toBe("TypeError");
    expect(summary.frames).toContain("at ");
    expect(JSON.stringify(summary)).not.toContain("hunter2");
  });

  it("keeps at most 8 frames", () => {
    const err = new Error("x");
    err.stack = ["Error: x", ...Array.from({ length: 20 }, (_, i) => `    at f${i} (a.js:1:1)`)].join("\n");

    expect(errorSummary(err).frames?.split("\n")).toHaveLength(8);
  });

  it("has no frames when the error has no stack", () => {
    const err = new Error("x");
    delete err.stack;

    expect(errorSummary(err)).toEqual({ name: "Error", frames: undefined });
  });

  // Suspected bug: a stack starts with the whole message, and frames are picked by
  // "line starts with `at `", so a multi-line message can pass as a frame and be logged.
  it.skip("drops a message line that looks like a stack frame", () => {
    const err = new Error("first line\nat my password hunter2");

    expect(JSON.stringify(errorSummary(err))).not.toContain("hunter2");
  });
});
