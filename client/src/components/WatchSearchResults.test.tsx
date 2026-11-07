// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import WatchSearchResults, { formatDuration, SEARCH_UNAVAILABLE_TEXT } from "./WatchSearchResults";

const results = [
  { videoId: "dQw4w9WgXcQ", title: "Rick", channel: "Rick Astley", durationS: 213 },
  { videoId: "9bZkp7q19f0", title: "Gangnam", channel: "PSY", durationS: 3725 },
];

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setup() {
  const props = { onPlay: vi.fn(), onQueue: vi.fn(), onClose: vi.fn(), onUnavailable: vi.fn() };
  render(<WatchSearchResults query="rick" httpToken="token" canQueue {...props} />);
  return props;
}

function expectYouTubeLink(link: HTMLElement) {
  expect(link.getAttribute("href")).toBe("https://www.youtube.com/");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WatchSearchResults", () => {
  it("shows a skeleton, then the results, which can be played or queued", async () => {
    const fetchMock = respond(200, { data: results });
    const { onPlay, onQueue } = setup();
    expect(screen.getByLabelText("Searching")).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "Play now: Rick" }));
    expect(onPlay).toHaveBeenCalledWith("dQw4w9WgXcQ");
    fireEvent.click(screen.getByRole("button", { name: "Add to queue: Gangnam" }));
    expect(onQueue).toHaveBeenCalledWith("9bZkp7q19f0");
    expect((screen.getByRole("button", { name: "Added to queue: Gangnam" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/1:02:05/)).toBeTruthy();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/youtube/search?q=rick");
    expect(new Headers(init.headers).get("X-Participant-Token")).toBe("token");
  });

  it("points to links when search isn't available", async () => {
    respond(503, { code: "search-unavailable", error: "unavailable" });
    const { onUnavailable } = setup();
    expect((await screen.findByRole("status")).textContent).toBe(SEARCH_UNAVAILABLE_TEXT);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expectYouTubeLink(screen.getByRole("link", { name: /Find a video on YouTube/ }));
  });

  it("offers a retry when the search failed", async () => {
    const fetchMock = respond(502, { code: "search-failed" });
    setup();
    expect((await screen.findByRole("alert")).textContent).toContain("Search failed");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: results })));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Play now: Rick" })).toBeTruthy();
  });

  it("says when nothing was found", async () => {
    respond(200, { data: [] });
    setup();
    expect(await screen.findByText(/No videos found/)).toBeTruthy();
  });

  it("closes on Escape and moves between rows with the arrow keys", async () => {
    respond(200, { data: results });
    const { onClose } = setup();
    const first = await screen.findByRole("button", { name: "Play now: Rick" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Play now: Gangnam" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("formatDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatDuration(5)).toBe("0:05");
    expect(formatDuration(213)).toBe("3:33");
    expect(formatDuration(3725)).toBe("1:02:05");
  });
});
