// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { fetchSearch, fetchTrending } from "../lib/giphyClient";
import type { GifItem } from "../types";
import GifPicker from "./GifPicker";

vi.mock("../lib/giphyClient", () => ({ fetchSearch: vi.fn(), fetchTrending: vi.fn() }));

const gif = (id: string): GifItem => ({ id, title: `Gif ${id}`, preview: `https://p/${id}`, url: `https://u/${id}` });

function setup() {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(<GifPicker onSelect={onSelect} onClose={onClose} />);
  return { onSelect, onClose };
}

const flush = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
const search = (value: string) => fireEvent.change(screen.getByLabelText("Search GIFs"), { target: { value } });
const spinner = () => document.querySelector(".animate-spin");

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(fetchTrending).mockReset().mockResolvedValue([gif("t")]);
  vi.mocked(fetchSearch).mockReset().mockResolvedValue([gif("s")]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("GifPicker", () => {
  it("shows a spinner, then trending", async () => {
    setup();
    expect(spinner()).not.toBeNull();

    await flush();

    expect(spinner()).toBeNull();
    expect(screen.getByText("Trending")).toBeTruthy();
    expect(screen.getByAltText("Gif t")).toBeTruthy();
  });

  it("debounces a search", async () => {
    setup();
    await flush();

    search("c");
    search("ca");
    search("cat");
    await flush(399);
    expect(fetchSearch).not.toHaveBeenCalled();

    await flush(1);

    expect(fetchSearch).toHaveBeenCalledOnce();
    expect(vi.mocked(fetchSearch).mock.calls[0][0]).toBe("cat");
    expect(screen.getByAltText("Gif s")).toBeTruthy();
    expect(screen.getByText('Results for "cat"')).toBeTruthy();
  });

  it("trims the query and doesn't search on spaces alone", async () => {
    setup();
    await flush();

    search("   ");
    await flush(1000);

    expect(fetchSearch).not.toHaveBeenCalled();
  });

  it("returns to trending on clear", async () => {
    setup();
    await flush();
    search("cat");
    await flush(400);

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await flush();

    expect(fetchTrending).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Trending")).toBeTruthy();
  });

  it("aborts the old request and ignores its late answer", async () => {
    setup();
    await flush();
    let finishOld!: (gifs: GifItem[]) => void;
    vi.mocked(fetchSearch).mockReturnValueOnce(new Promise((resolve) => (finishOld = resolve)));
    search("old");
    await flush(400);
    const oldSignal = vi.mocked(fetchSearch).mock.calls[0][1];

    search("new");
    expect(oldSignal.aborted).toBe(true);
    await flush(400);
    await act(async () => finishOld([gif("old")]));

    expect(screen.queryByAltText("Gif old")).toBeNull();
    expect(screen.getByAltText("Gif s")).toBeTruthy();
  });

  it("doesn't show an error for an aborted request", async () => {
    setup();
    await flush();
    let failOld!: (err: Error) => void;
    vi.mocked(fetchSearch).mockReturnValueOnce(new Promise((_, reject) => (failOld = reject)));
    search("old");
    await flush(400);

    search("new");
    await flush(400);
    await act(async () => failOld(new DOMException("aborted", "AbortError")));

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the empty state", async () => {
    vi.mocked(fetchTrending).mockResolvedValue([]);
    setup();

    await flush();

    expect(screen.getByText("No GIFs found")).toBeTruthy();
  });

  it("shows the error and drops the old results", async () => {
    setup();
    await flush();
    vi.mocked(fetchSearch).mockRejectedValueOnce(new Error("GIPHY took too long to respond"));

    search("cat");
    await flush(400);

    expect(screen.getByRole("alert").textContent).toBe("GIPHY took too long to respond");
    expect(screen.queryByAltText("Gif t")).toBeNull();
  });

  it("explains a missing API key", async () => {
    vi.mocked(fetchTrending).mockRejectedValue(new Error("GIPHY_API_KEY is not configured"));
    setup();

    await flush();

    expect(screen.getByText(/server's environment variables/)).toBeTruthy();
  });

  it("selects a GIF and closes", async () => {
    const { onSelect, onClose } = setup();
    await flush();

    fireEvent.click(screen.getByTitle("Gif t"));

    expect(onSelect).toHaveBeenCalledWith("https://u/t", "Gif t");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on a press outside but not inside", async () => {
    const { onClose } = setup();
    await flush();

    fireEvent.mouseDown(screen.getByLabelText("Search GIFs"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the attribution Giphy's terms require", async () => {
    setup();
    await flush();

    expect(screen.getByRole("link", { name: "Powered by GIPHY" })).toBeTruthy();
  });
});
