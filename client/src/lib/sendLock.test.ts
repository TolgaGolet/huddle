import { describe, it, expect, vi } from "vitest";
import { CONNECTION_LOST_ERROR, createSendLock, isSameConnection, replyToSend, reusableUploadUrls, UPLOAD_TIMEOUT_ERROR, uploadErrorMessage } from "./sendLock";

describe("isSameConnection", () => {
  it("accepts only the connected socket the upload started on", () => {
    expect(isSameConnection({ connected: true, id: "a" }, "a")).toBe(true);
    expect(isSameConnection({ connected: false }, "a")).toBe(false);
    expect(isSameConnection({ connected: true, id: "b" }, "a")).toBe(false);
  });
});

describe("uploadErrorMessage", () => {
  // Regression: a token revoked by a drop showed "Not authorized for this room".
  it("blames the lost connection, whatever the upload failed with", () => {
    expect(uploadErrorMessage(new Error("Not authorized for this room"), false)).toBe(CONNECTION_LOST_ERROR);
  });

  it("explains a timeout instead of showing the browser's message", () => {
    expect(uploadErrorMessage(new DOMException("signal timed out", "TimeoutError"), true)).toBe(UPLOAD_TIMEOUT_ERROR);
  });

  it("shows the server's reason while still connected", () => {
    expect(uploadErrorMessage(new Error("Image is too large"), true)).toBe("Image is too large");
    expect(uploadErrorMessage("odd", true)).toBe("Failed to upload images");
  });
});

describe("reusableUploadUrls", () => {
  const a = new File(["a"], "a.png");
  const b = new File(["b"], "b.png");
  const uploaded = { files: [a, b], urls: ["/a", "/b"] };

  // Regression: each retry after a drop uploaded again, using up the room's quota.
  it("reuses the URLs when the draft holds the same files", () => {
    expect(reusableUploadUrls(uploaded, [a, b])).toEqual(["/a", "/b"]);
  });

  it("uploads again when the images changed", () => {
    expect(reusableUploadUrls(uploaded, [a])).toBeNull();
    expect(reusableUploadUrls(uploaded, [b, a])).toBeNull();
    expect(reusableUploadUrls(uploaded, [a, new File(["b"], "b.png")])).toBeNull();
  });

  it("has nothing to reuse before the first upload", () => {
    expect(reusableUploadUrls(null, [a])).toBeNull();
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
