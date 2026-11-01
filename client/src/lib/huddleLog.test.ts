import { describe, it, expect } from "vitest";
import { errorName } from "./huddleLog";

// Regression (Q-21): negotiation errors were logged whole, and Chromium's
// messages can quote SDP lines holding ICE candidates.
describe("errorName", () => {
  const sdpLine = "a=candidate:1 1 udp 2122260223 203.0.113.7 54321 typ host";

  it("keeps the name and drops a message quoting SDP", () => {
    const err = new DOMException(`Failed to parse SessionDescription. ${sdpLine}`, "OperationError");
    expect(errorName(err)).toBe("OperationError");
  });

  it("does not read a message from a plain Error", () => {
    expect(errorName(new TypeError(sdpLine))).toBe("TypeError");
  });

  it("never echoes a non-error value", () => {
    expect(errorName(sdpLine)).toBe("UnknownError");
    expect(errorName(undefined)).toBe("UnknownError");
  });
});
