// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import VoiceControls from "./VoiceControls";

function setup(overrides: Partial<React.ComponentProps<typeof VoiceControls>> = {}) {
  const onToggleMute = vi.fn();
  const onToggleScreenShare = vi.fn();
  render(<VoiceControls isMuted={false} micUnavailable={false} isScreenSharing={false} onToggleMute={onToggleMute} onToggleScreenShare={onToggleScreenShare} {...overrides} />);
  return { onToggleMute, onToggleScreenShare };
}

function stubDisplayMedia(available: boolean) {
  Object.defineProperty(navigator, "mediaDevices", { value: available ? { getDisplayMedia: vi.fn() } : undefined, configurable: true });
}

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => stubDisplayMedia(true));
afterEach(cleanup);

describe("microphone button", () => {
  it.each<[string, Partial<React.ComponentProps<typeof VoiceControls>>]>([
    ["Mute", {}],
    ["Unmute", { isMuted: true }],
    ["Microphone unavailable, retry", { isMuted: true, micUnavailable: true }],
  ])("reads %s and calls the handler", (name, overrides) => {
    const { onToggleMute } = setup(overrides);

    fireEvent.click(button(name));

    expect(onToggleMute).toHaveBeenCalledOnce();
  });
});

describe("screen share button", () => {
  it("starts and stops", () => {
    const { onToggleScreenShare } = setup();
    fireEvent.click(button("Share screen"));
    expect(onToggleScreenShare).toHaveBeenCalledOnce();

    cleanup();
    const sharing = setup({ isScreenSharing: true });
    fireEvent.click(button("Stop sharing"));
    expect(sharing.onToggleScreenShare).toHaveBeenCalledOnce();
  });

  it("is disabled while someone else shares", () => {
    const { onToggleScreenShare } = setup({ screenShareDisabled: true });
    const share = button("Someone is already sharing");

    fireEvent.click(share);

    expect(share.disabled).toBe(true);
    expect(onToggleScreenShare).not.toHaveBeenCalled();
  });

  it("can always stop your own share", () => {
    setup({ isScreenSharing: true, screenShareDisabled: true });

    expect(button("Stop sharing").disabled).toBe(false);
  });

  it("is absent where the browser can't capture the screen, like most phones", () => {
    stubDisplayMedia(false);

    setup();

    expect(screen.queryByRole("button", { name: /shar/i })).toBeNull();
    expect(button("Mute")).toBeTruthy();
  });
});
