import { describe, it, expect, vi, afterEach } from "vitest";
import { IMAGE_SESSION_RENEW_MS, IMAGE_SESSION_RETRY_MS, isImageFile, keepImageSessionOpen, openImageSession, uploadImages } from "./imageUpload";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function respondWith(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const png = () => new File([new Uint8Array(4)], "a.png", { type: "image/png" });

describe("isImageFile", () => {
  it("accepts allowed extensions, including HEIC with no reported type", () => {
    expect(isImageFile(png())).toBe(true);
    expect(isImageFile(new File([], "a.HEIC", { type: "" }))).toBe(true);
    expect(isImageFile(new File([], "a.heic", { type: "application/octet-stream" }))).toBe(true);
  });

  it("rejects other extensions and a mismatched type", () => {
    expect(isImageFile(new File([], "a.svg", { type: "image/svg+xml" }))).toBe(false);
    expect(isImageFile(new File([], "a.png", { type: "text/html" }))).toBe(false);
  });
});

describe("openImageSession", () => {
  it("sends the token and rejects a failed response", async () => {
    const fetchMock = respondWith(403, {});
    await expect(openImageSession("r", "tok")).rejects.toThrow("Failed to open image session");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/rooms/r/image-session");
    expect(init.headers).toEqual({ "X-Participant-Token": "tok" });
  });
});

describe("keepImageSessionOpen", () => {
  const stubStatuses = (...statuses: number[]) => {
    const fetchMock = vi.fn();
    for (const status of statuses) fetchMock.mockResolvedValueOnce(new Response(null, { status }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    return fetchMock;
  };

  it("renews the session before it expires", async () => {
    const fetchMock = stubStatuses(204, 204);
    const onSettled = vi.fn();
    const stop = keepImageSessionOpen("r", "tok", onSettled);
    await vi.advanceTimersByTimeAsync(0);
    expect(onSettled).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(IMAGE_SESSION_RENEW_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledTimes(2);
    stop();
  });

  it("settles after a failed first attempt, then retries until it opens", async () => {
    const fetchMock = stubStatuses(429, 429, 204);
    const onSettled = vi.fn();
    const stop = keepImageSessionOpen("r", "tok", onSettled);
    await vi.advanceTimersByTimeAsync(0);
    expect(onSettled).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(IMAGE_SESSION_RETRY_MS);
    expect(onSettled).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(IMAGE_SESSION_RETRY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onSettled).toHaveBeenCalledTimes(2);
    stop();
  });

  it("ignores a response that arrives after it was stopped", async () => {
    const fetchMock = stubStatuses(204);
    const onSettled = vi.fn();
    const stop = keepImageSessionOpen("r", "tok", onSettled);
    stop();
    await vi.advanceTimersByTimeAsync(IMAGE_SESSION_RENEW_MS);
    expect(onSettled).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("uploadImages", () => {
  it("returns the URLs and sends the sender's token", async () => {
    const fetchMock = respondWith(200, { urls: ["/api/rooms/r/images/a.png"] });

    await expect(uploadImages("r", "tok", [png()])).resolves.toEqual(["/api/rooms/r/images/a.png"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/rooms/r/images");
    expect(init.headers).toEqual({ "X-Participant-Token": "tok" });
  });

  it("rejects a response whose urls are not all strings", async () => {
    respondWith(200, { urls: ["/ok", 1] });
    await expect(uploadImages("r", "tok", [png()])).rejects.toThrow("Invalid image upload response");

    respondWith(200, {});
    await expect(uploadImages("r", "tok", [png()])).rejects.toThrow("Invalid image upload response");
  });

  it("surfaces the server's error text, with a fallback", async () => {
    respondWith(413, { error: "This room has reached its image storage limit" });
    await expect(uploadImages("r", "tok", [png()])).rejects.toThrow("storage limit");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 500 })));
    await expect(uploadImages("r", "tok", [png()])).rejects.toThrow("Failed to upload images");
  });
});
