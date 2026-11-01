import { describe, it, expect } from "vitest";
import { classifyMicError, micErrorAfterTrackEnded, micErrorMessage, type MicError } from "./micError";

const named = (name: string) => Object.assign(new Error("details"), { name });

describe("classifyMicError", () => {
  it.each([
    ["NotAllowedError", "denied"],
    ["SecurityError", "denied"],
    ["NotFoundError", "not-found"],
    ["OverconstrainedError", "not-found"],
    ["NotReadableError", "busy"],
    ["AbortError", "busy"],
  ])("treats %s as %s", (name, expected) => {
    expect(classifyMicError(named(name))).toBe(expected);
  });

  it("treats anything unknown as busy, including a browser with no mediaDevices", () => {
    expect(classifyMicError(new TypeError("undefined"))).toBe("busy");
    expect(classifyMicError("not an error")).toBe("busy");
  });
});

describe("micErrorAfterTrackEnded", () => {
  // Regression: a revoked permission told the user to reconnect their mic.
  it("keeps the specific cause the re-acquire found", () => {
    expect(micErrorAfterTrackEnded("denied")).toBe("denied");
    expect(micErrorAfterTrackEnded("busy")).toBe("busy");
    expect(micErrorAfterTrackEnded("not-found")).toBe("not-found");
  });

  it("reports the mic as gone otherwise", () => {
    expect(micErrorAfterTrackEnded(null)).toBe("ended");
    expect(micErrorAfterTrackEnded("switch-failed")).toBe("ended");
  });
});

describe("micErrorMessage", () => {
  it("has a message for every state", () => {
    const errors: MicError[] = ["denied", "not-found", "busy", "ended", "switch-failed"];
    for (const error of errors) expect(micErrorMessage(error)).toBeTruthy();
  });

  it("says the previous mic still works only when it does", () => {
    expect(micErrorMessage("switch-failed")).toMatch(/still using/);
    expect(micErrorMessage("ended")).toMatch(/nobody can hear you/);
  });
});
