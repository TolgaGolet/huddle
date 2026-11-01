import { describe, it, expect, vi } from "vitest";
import { createSendLock, isSameConnection, replyToSend } from "./sendLock";

describe("isSameConnection", () => {
  it("accepts only the connected socket the upload started on", () => {
    expect(isSameConnection({ connected: true, id: "a" }, "a")).toBe(true);
    expect(isSameConnection({ connected: false }, "a")).toBe(false);
    expect(isSameConnection({ connected: true, id: "b" }, "a")).toBe(false);
  });
});

describe("replyToSend", () => {
  const a = { id: "a" };
  const b = { id: "b" };

  it("keeps a reply that is unchanged", () => {
    expect(replyToSend(a, a)).toBe(a);
  });

  it("drops a reply cancelled or replaced during the upload", () => {
    expect(replyToSend(a, null)).toBeNull();
    expect(replyToSend(a, b)).toBeNull();
  });

  it("doesn't pick up a reply started during the upload", () => {
    expect(replyToSend(null, b)).toBeNull();
  });
});

describe("createSendLock", () => {
  it("ignores calls while a task is in flight", async () => {
    const lock = createSendLock();
    let finish = () => {};
    const first = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const second = vi.fn(async () => {});

    const running = lock.run(first);
    await lock.run(second);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    finish();
    await running;
  });

  it("allows a new task after the previous one finishes", async () => {
    const lock = createSendLock();
    const task = vi.fn(async () => {});

    await lock.run(task);
    await lock.run(task);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("releases after a task rejects, so the user can retry", async () => {
    const lock = createSendLock();
    await expect(lock.run(() => Promise.reject(new Error("upload failed")))).rejects.toThrow("upload failed");

    const retry = vi.fn(async () => {});
    await lock.run(retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
