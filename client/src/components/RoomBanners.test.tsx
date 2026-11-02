// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { micErrorMessage } from "../lib/micError";
import RoomBanners from "./RoomBanners";

function setup(overrides: Partial<React.ComponentProps<typeof RoomBanners>> = {}) {
  const handlers = { onRetryMic: vi.fn(), onDismissMicError: vi.fn(), onResumeAudio: vi.fn(), onResumeRemotePlayback: vi.fn() };
  render(<RoomBanners micError={null} micRetrying={false} needsAudioGesture={false} remotePlaybackBlocked={false} {...handlers} {...overrides} />);
  return handlers;
}

afterEach(cleanup);

describe("RoomBanners", () => {
  const person = { id: "s1", name: "Bo", wasRemoved: false };

  it("asks an owner about someone waiting, and says if they were removed earlier", () => {
    const onAdmit = vi.fn();
    setup({ waitingList: [person, { id: "s2", name: "Cy", wasRemoved: true }], onAdmit });

    expect(screen.getByText("Bo is waiting to join.")).toBeTruthy();
    expect(screen.getByText(/Cy is waiting to join\. They, or someone on their network, were removed earlier/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Accept Bo" }));
    expect(onAdmit).toHaveBeenCalledWith("s1");
  });

  it("ignoring only hides the request here, sending nothing", () => {
    const onAdmit = vi.fn();
    setup({ waitingList: [person], onAdmit });

    fireEvent.click(screen.getByRole("button", { name: "Ignore Bo" }));

    expect(screen.queryByText(/Bo is waiting/)).toBeNull();
    expect(onAdmit).not.toHaveBeenCalled();
  });

  it("explains why someone couldn't come in", () => {
    setup({ waitingList: [person], admitRefusedId: "s1", onAdmit: vi.fn() });

    expect(screen.getByText(/room is full/)).toBeTruthy();
  });

  it("warns that the room is closing, with a countdown hidden from screen readers", () => {
    setup({ closing: { reason: "inactive", closesAt: Date.now() + 90_000 } });

    expect(screen.getByRole("alert").textContent).toMatch(/Speak or send a message/);
    expect(screen.getByText(/^1:(29|30)$/).getAttribute("aria-hidden")).toBe("true");
  });

  it("shows nothing when all is well", () => {
    setup();

    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("announces a mic error and offers a retry", () => {
    const { onRetryMic } = setup({ micError: "denied" });

    expect(screen.getByRole("alert").textContent).toContain(micErrorMessage("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetryMic).toHaveBeenCalledOnce();
  });

  it("disables the retry while one is running", () => {
    setup({ micError: "denied", micRetrying: true });

    expect((screen.getByRole("button", { name: "Retrying..." }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers no retry on an insecure page, where it can't help", () => {
    setup({ micError: "insecure" });

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("lets a failed switch be dismissed, since the old mic still works", () => {
    const { onDismissMicError } = setup({ micError: "switch-failed" });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onDismissMicError).toHaveBeenCalledOnce();
  });

  it.each(["denied", "not-found", "busy", "ended"] as const)("doesn't let the %s error be dismissed", (micError) => {
    setup({ micError });

    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("asks for a gesture to re-enable outgoing audio", () => {
    const { onResumeAudio } = setup({ needsAudioGesture: true });

    fireEvent.click(screen.getByRole("button", { name: "Enable audio" }));

    expect(onResumeAudio).toHaveBeenCalledOnce();
  });

  it("asks for a gesture to hear others", () => {
    const { onResumeRemotePlayback } = setup({ remotePlaybackBlocked: true });

    fireEvent.click(screen.getByRole("button", { name: "Enable audio" }));

    expect(onResumeRemotePlayback).toHaveBeenCalledOnce();
  });

  it("can show every banner at once", () => {
    setup({ micError: "busy", needsAudioGesture: true, remotePlaybackBlocked: true });

    expect(screen.getAllByRole("button", { name: "Enable audio" })).toHaveLength(2);
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
