import { describe, it, expect, vi, afterEach } from "vitest";
import { isImageFile, uploadImages } from "./imageUpload";

afterEach(() => vi.unstubAllGlobals());

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

describe("uploadImages", () => {
  it("returns the URLs and identifies the sender's socket", async () => {
    const fetchMock = respondWith(200, { urls: ["/api/rooms/r/images/a.png"] });

    await expect(uploadImages("r", "sock", [png()])).resolves.toEqual(["/api/rooms/r/images/a.png"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/rooms/r/images");
    expect(init.headers).toEqual({ "X-Socket-Id": "sock" });
  });

  it("rejects a response whose urls are not all strings", async () => {
    respondWith(200, { urls: ["/ok", 1] });
    await expect(uploadImages("r", "sock", [png()])).rejects.toThrow("Invalid image upload response");

    respondWith(200, {});
    await expect(uploadImages("r", "sock", [png()])).rejects.toThrow("Invalid image upload response");
  });

  it("surfaces the server's error text, with a fallback", async () => {
    respondWith(413, { error: "This room has reached its image storage limit" });
    await expect(uploadImages("r", "sock", [png()])).rejects.toThrow("storage limit");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 500 })));
    await expect(uploadImages("r", "sock", [png()])).rejects.toThrow("Failed to upload images");
  });
});
