import { describe, it, expect } from "vitest";
import { JOIN_ERROR } from "../types";
import { isTransientJoinError, joinRetryDelay, shouldRetryJoin } from "./joinRetry";

describe("isTransientJoinError", () => {
  it("retries a room that isn't available yet", () => {
    expect(isTransientJoinError(JOIN_ERROR.ROOM_NOT_FOUND)).toBe(true);
  });

  it("treats errors that retrying cannot fix as fatal", () => {
    expect(isTransientJoinError(JOIN_ERROR.NAME_TAKEN)).toBe(false);
    expect(isTransientJoinError(JOIN_ERROR.INCORRECT_PASSWORD)).toBe(false);
    expect(isTransientJoinError(JOIN_ERROR.ROOM_FULL)).toBe(false);
    expect(isTransientJoinError(JOIN_ERROR.INVALID_JOIN)).toBe(false);
  });
});

describe("shouldRetryJoin", () => {
  it("reports a dead link at once on the first join", () => {
    expect(shouldRetryJoin(false, JOIN_ERROR.ROOM_NOT_FOUND)).toBe(false);
  });

  it("retries a transient error on a rejoin only", () => {
    expect(shouldRetryJoin(true, JOIN_ERROR.ROOM_NOT_FOUND)).toBe(true);
    expect(shouldRetryJoin(true, JOIN_ERROR.ROOM_FULL)).toBe(false);
  });
});

describe("joinRetryDelay", () => {
  it("backs off on each attempt, then gives up", () => {
    expect([0, 1, 2, 3, 4].map(joinRetryDelay)).toEqual([1000, 2000, 4000, 8000, 15000]);
    expect(joinRetryDelay(5)).toBeNull();
  });
});
