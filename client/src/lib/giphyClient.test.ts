import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSearch, fetchTrending } from "./giphyClient";

const gif = { id: "1", title: "Cat", preview: "p", url: "u" };
const signal = () => new AbortController().signal;

function stubFetch(response: Response | Error) {
  const mock = response instanceof Error ? vi.fn().mockRejectedValue(response) : vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => vi.unstubAllGlobals());

describe("giphyClient", () => {
  it("requests trending and returns its items", async () => {
    const mock = stubFetch(new Response(JSON.stringify({ data: [gif] })));

    expect(await fetchTrending("token", signal())).toEqual([gif]);
    expect(mock.mock.calls[0][0]).toBe("/api/giphy/trending");
    expect((mock.mock.calls[0][1] as RequestInit).headers).toEqual({ "X-Participant-Token": "token" });
  });

  it("encodes the search query", async () => {
    const mock = stubFetch(new Response(JSON.stringify({ data: [] })));

    await fetchSearch("a&b c", "token", signal());

    expect(mock.mock.calls[0][0]).toBe("/api/giphy/search?q=a%26b%20c");
  });

  it("drops null items", async () => {
    stubFetch(new Response(JSON.stringify({ data: [null, gif, null] })));

    expect(await fetchTrending("token", signal())).toEqual([gif]);
  });

  it("treats a missing data field as no results", async () => {
    stubFetch(new Response("{}"));

    expect(await fetchTrending("token", signal())).toEqual([]);
  });

  it("surfaces the server's error text", async () => {
    stubFetch(new Response(JSON.stringify({ error: "GIPHY_API_KEY is not set" }), { status: 503 }));

    await expect(fetchTrending("token", signal())).rejects.toThrow("GIPHY_API_KEY is not set");
  });

  it("has a fallback for an error reply with no error field", async () => {
    stubFetch(new Response("{}", { status: 500 }));

    await expect(fetchTrending("token", signal())).rejects.toThrow("GIPHY request failed");
  });

  it("uses the status text for a non-JSON error reply", async () => {
    stubFetch(new Response("<html>", { status: 502, statusText: "Bad Gateway" }));

    await expect(fetchTrending("token", signal())).rejects.toThrow("Bad Gateway");
  });

  // Regression: an empty statusText gave Error(""), which GifPicker showed as "No GIFs found".
  it("has a message for a non-JSON error reply with an empty status text", async () => {
    stubFetch(new Response("<html>", { status: 502 }));

    await expect(fetchTrending("token", signal())).rejects.toThrow("GIPHY request failed");
  });

  it("turns a timeout into a readable message", async () => {
    stubFetch(new DOMException("timed out", "TimeoutError"));

    await expect(fetchTrending("token", signal())).rejects.toThrow("GIPHY took too long to respond");
  });

  it("passes other failures through, so the caller can recognise an abort", async () => {
    stubFetch(new DOMException("aborted", "AbortError"));

    await expect(fetchTrending("token", signal())).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts the request when the caller's signal aborts", async () => {
    const mock = stubFetch(new Response(JSON.stringify({ data: [] })));
    const controller = new AbortController();

    await fetchTrending("token", controller.signal);
    controller.abort();

    expect((mock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
  });
});
