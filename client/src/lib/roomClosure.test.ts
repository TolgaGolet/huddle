import { describe, expect, it } from "vitest";
import { bufferCandidate } from "./candidateBuffer";
import { closingDeadline, formatCountdown, roomClosedMessage, roomClosingMessage } from "./roomClosure";
import { createVoiceReporter, VOICE_REPORT_INTERVAL_MS } from "./voiceActivityReport";

describe("roomClosure", () => {
  it("turns the server's remaining time into a deadline on this client's clock", () => {
    expect(closingDeadline({ reason: "inactive", remainingMs: 5000 }, 1000)).toEqual({ reason: "inactive", closesAt: 6000 });
    expect(closingDeadline(null)).toBeNull();
  });

  it("formats a countdown, never below zero", () => {
    expect(formatCountdown(600_000)).toBe("10:00");
    expect(formatCountdown(61_000)).toBe("1:01");
    expect(formatCountdown(-5)).toBe("0:00");
  });

  it("explains each reason, before and after, and how to avoid an inactive close", () => {
    expect(roomClosingMessage("inactive")).toMatch(/Speak or send a message/);
    expect(roomClosingMessage("lifetime")).toMatch(/10-hour limit/);
    expect(roomClosedMessage("inactive")).toMatch(/31 minutes/);
    expect(roomClosedMessage("lifetime")).toMatch(/10-hour limit/);
  });
});

describe("createVoiceReporter", () => {
  it("reports at once, then at most once per interval", () => {
    let t = 0;
    let reports = 0;
    const report = createVoiceReporter(() => reports++, () => t);

    report();
    report();
    expect(reports).toBe(1);

    t += VOICE_REPORT_INTERVAL_MS - 1;
    report();
    expect(reports).toBe(1);

    t += 1;
    report();
    expect(reports).toBe(2);
  });
});

// Regression: a room member could grow these lists without limit in another member's browser.
describe("bufferCandidate", () => {
  it("keeps the newest 100", () => {
    const list: RTCIceCandidateInit[] = [];
    for (let i = 0; i < 150; i++) bufferCandidate(list, { candidate: String(i) });

    expect(list).toHaveLength(100);
    expect(list[0].candidate).toBe("50");
    expect(list[99].candidate).toBe("149");
  });
});
