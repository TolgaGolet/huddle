// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ImageSessionContext } from "../lib/imageSessionContext";
import RoomImage from "./RoomImage";

const SRC = "/api/rooms/r/images/a.png";

function element(session: number, props: Partial<React.ComponentProps<typeof RoomImage>> = {}) {
  return (
    <ImageSessionContext.Provider value={session}>
      <RoomImage src={SRC} alt="Sent by Ana" skeletonClassName="skeleton" loading="lazy" {...props} />
    </ImageSessionContext.Provider>
  );
}

const img = () => screen.getByRole("img") as HTMLImageElement;
const src = () => img().getAttribute("src");

function fail() {
  fireEvent.error(img());
}

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RoomImage", () => {
  it("shows a skeleton until the session opens, so it never requests a 404", () => {
    const { container } = render(element(0));

    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector(".skeleton")).not.toBeNull();
  });

  it("loads the plain URL once the session is open", () => {
    render(element(1));

    expect(src()).toBe(SRC);
    expect(img().alt).toBe("Sent by Ana");
    expect(img().getAttribute("loading")).toBe("lazy");
  });

  it("doesn't retry instantly after a failure", () => {
    render(element(1));

    fail();
    wait(999);

    expect(src()).toBe(SRC);
  });

  it("retries after the backoff with a URL the browser will re-request", () => {
    render(element(1));

    fail();
    wait(1000);

    expect(src()).toBe(`${SRC}?session=1&retry=1`);
  });

  it("backs off further after each failure", () => {
    render(element(1));
    fail();
    wait(1000);

    fail();
    wait(1999);
    expect(src()).toBe(`${SRC}?session=1&retry=1`);

    wait(1);
    expect(src()).toBe(`${SRC}?session=1&retry=2`);
  });

  it("gives up once the retries are exhausted", () => {
    render(element(1));
    for (const delay of [1000, 2000, 4000, 8000, 15000, 30000]) {
      fail();
      wait(delay);
    }
    const last = src();

    fail();
    wait(600_000);

    expect(src()).toBe(last);
  });

  it("retries at once when the session reopens, even after giving up", () => {
    const view = render(element(1));
    for (const delay of [1000, 2000, 4000, 8000, 15000, 30000]) {
      fail();
      wait(delay);
    }
    fail();

    view.rerender(element(2));

    expect(src()).toBe(`${SRC}?session=2&retry=6`);
  });

  it("goes eager after a failure, since a lazy image in a hidden parent never retries", () => {
    render(element(1));

    fail();

    expect(img().getAttribute("loading")).toBe("eager");
  });

  it("goes back to lazy after a successful retry", () => {
    render(element(1));
    fail();
    wait(1000);

    fireEvent.load(img());

    expect(img().getAttribute("loading")).toBe("lazy");
  });

  it("doesn't re-download a recovered image when the session renews", () => {
    const view = render(element(1));
    fail();
    wait(1000);
    const recovered = src();
    fireEvent.load(img());

    view.rerender(element(2));

    expect(src()).toBe(recovered);
  });

  it("doesn't change the URL of a healthy image when the session renews", () => {
    const view = render(element(1));
    fireEvent.load(img());

    view.rerender(element(2));

    expect(src()).toBe(SRC);
  });

  it("calls the caller's handlers", () => {
    const onLoad = vi.fn();
    const onError = vi.fn();
    render(element(1, { onLoad, onError }));

    fireEvent.error(img());
    fireEvent.load(img());

    expect(onError).toHaveBeenCalledOnce();
    expect(onLoad).toHaveBeenCalledOnce();
  });

  it("cancels a pending retry on unmount", () => {
    const { unmount } = render(element(1));
    fail();

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
