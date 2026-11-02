// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ErrorBoundary, { AppCrashed, ChatCrashed } from "./ErrorBoundary";

let shouldThrow = true;

function Flaky() {
  if (shouldThrow) throw new Error("text with a secret");
  return <p>Content</p>;
}

beforeEach(() => {
  shouldThrow = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("renders its children when nothing is wrong", () => {
    shouldThrow = false;

    render(<ErrorBoundary fallback={() => <p>Failed</p>}><Flaky /></ErrorBoundary>);

    expect(screen.getByText("Content")).toBeTruthy();
    expect(screen.queryByText("Failed")).toBeNull();
  });

  it("shows the fallback when a child throws while rendering", () => {
    render(<ErrorBoundary fallback={() => <p>Failed</p>}><Flaky /></ErrorBoundary>);

    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("logs the error's name, not its message", () => {
    render(<ErrorBoundary fallback={() => <p>Failed</p>}><Flaky /></ErrorBoundary>);

    expect(console.warn).toHaveBeenCalledWith("[huddle:ui]", { event: "render-crash", error: "Error" });
  });

  it("renders the children again after a reset", () => {
    render(<ErrorBoundary fallback={ChatCrashed}><Flaky /></ErrorBoundary>);
    shouldThrow = false;

    fireEvent.click(screen.getByRole("button", { name: "Reload chat" }));

    expect(screen.getByText("Content")).toBeTruthy();
  });

  it("falls back again if the reset's render still throws", () => {
    render(<ErrorBoundary fallback={ChatCrashed}><Flaky /></ErrorBoundary>);

    fireEvent.click(screen.getByRole("button", { name: "Reload chat" }));

    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("leaves the rest of the page alone", () => {
    render(
      <>
        <p>Call controls</p>
        <ErrorBoundary fallback={ChatCrashed}><Flaky /></ErrorBoundary>
      </>,
    );

    expect(screen.getByText("Call controls")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Your call is still connected");
  });
});

describe("AppCrashed", () => {
  it("offers a page reload and announces itself", () => {
    render(<AppCrashed />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });
});
