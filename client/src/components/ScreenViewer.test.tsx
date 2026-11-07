// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import ScreenViewer from "./ScreenViewer";

const stream = { id: "s" } as unknown as MediaStream;

function setDocument(props: { fullscreenEnabled: boolean; fullscreenElement?: Element | null; exitFullscreen?: () => void }) {
  Object.defineProperty(document, "fullscreenEnabled", { value: props.fullscreenEnabled, configurable: true });
  Object.defineProperty(document, "fullscreenElement", { value: props.fullscreenElement ?? null, configurable: true });
  Object.defineProperty(document, "exitFullscreen", { value: props.exitFullscreen ?? vi.fn(), configurable: true });
}

let requestFullscreen: ReturnType<typeof vi.fn>;

beforeEach(() => {
  requestFullscreen = vi.fn();
  HTMLElement.prototype.requestFullscreen = requestFullscreen as never;
  setDocument({ fullscreenEnabled: true });
});

afterEach(cleanup);

describe("ScreenViewer", () => {
  it("plays the stream and names the sharer", () => {
    const { container } = render(<ScreenViewer stream={stream} sharerName="Ana" />);

    expect(container.querySelector("video")!.srcObject).toBe(stream);
    expect(screen.getByText("Ana's screen")).toBeTruthy();
  });

  it("switches to a new stream", () => {
    const next = { id: "n" } as unknown as MediaStream;
    const { container, rerender } = render(<ScreenViewer stream={stream} sharerName="Ana" />);

    rerender(<ScreenViewer stream={next} sharerName="Ana" />);

    expect(container.querySelector("video")!.srcObject).toBe(next);
  });

  it("enters fullscreen from the button", () => {
    render(<ScreenViewer stream={stream} sharerName="Ana" />);

    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));

    expect(requestFullscreen).toHaveBeenCalledOnce();
  });

  it("exits when already fullscreen, and reflects the browser's state", () => {
    const { container } = render(<ScreenViewer stream={stream} sharerName="Ana" />);
    const exitFullscreen = vi.fn();
    setDocument({ fullscreenEnabled: true, fullscreenElement: container.firstElementChild, exitFullscreen });
    act(() => void document.dispatchEvent(new Event("fullscreenchange")));

    fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));

    expect(exitFullscreen).toHaveBeenCalledOnce();
  });

  it("hides the button where fullscreen isn't available, like iPhone Safari", () => {
    setDocument({ fullscreenEnabled: false });

    render(<ScreenViewer stream={stream} sharerName="Ana" />);

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("toggles on the F key", () => {
    render(<ScreenViewer stream={stream} sharerName="Ana" />);

    fireEvent.keyDown(document.body, { key: "f" });

    expect(requestFullscreen).toHaveBeenCalledOnce();
  });

  it("ignores the shortcut where fullscreen isn't available", () => {
    setDocument({ fullscreenEnabled: false });
    render(<ScreenViewer stream={stream} sharerName="Ana" />);

    fireEvent.keyDown(document.body, { key: "f" });

    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it.each(["input", "textarea"])("doesn't steal an F typed into a %s", (tag) => {
    render(<ScreenViewer stream={stream} sharerName="Ana" />);
    const field = document.createElement(tag);
    document.body.appendChild(field);

    fireEvent.keyDown(field, { key: "f" });

    expect(requestFullscreen).not.toHaveBeenCalled();
    field.remove();
  });

  it("leaves Ctrl+F to the browser", () => {
    render(<ScreenViewer stream={stream} sharerName="Ana" />);

    fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });

    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it("stops listening once closed", () => {
    const { unmount } = render(<ScreenViewer stream={stream} sharerName="Ana" />);

    unmount();
    fireEvent.keyDown(document.body, { key: "f" });

    expect(requestFullscreen).not.toHaveBeenCalled();
  });
});
