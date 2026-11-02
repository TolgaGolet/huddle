import { describe, expect, it } from "vitest";
import { countSecurityEvent, STATUS_LOG_INTERVAL_MS, takeSecurityCounts } from "./securityLog.js";

describe("securityLog", () => {
  it("reports what happened since the last report, then starts again", () => {
    takeSecurityCounts();
    countSecurityEvent("wrong_password");
    countSecurityEvent("wrong_password");
    countSecurityEvent("socket_limited_messages");

    expect(takeSecurityCounts()).toEqual({ wrong_password: 2, socket_limited_messages: 1 });
    expect(takeSecurityCounts()).toEqual({});
  });

  it("reports every 30 minutes", () => {
    expect(STATUS_LOG_INTERVAL_MS).toBe(30 * 60_000);
  });
});
