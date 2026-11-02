// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { INITIAL_GATE_STATE } from "../lib/audioLevels";
import SettingsPopup from "./SettingsPopup";

const device = (deviceId: string, label = "") => ({ deviceId, label }) as MediaDeviceInfo;

function setup(overrides: Partial<React.ComponentProps<typeof SettingsPopup>> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onDeviceChange: vi.fn(),
    onNoiseCancellationChange: vi.fn(),
    onTransmissionThresholdChange: vi.fn(),
    onManualThresholdDbChange: vi.fn(),
  };
  render(
    <SettingsPopup
      audioInputs={[device("usb-microphone-1", "USB Mic"), device("abcdefghijkl")]}
      selectedDeviceId="usb-microphone-1"
      noiseCancellationEnabled
      isNoiseCancellationSupported
      transmissionThreshold="medium"
      manualThresholdDb={-20}
      localAnalyser={null}
      isMuted={false}
      isTransmitting={false}
      gateStateRef={{ current: INITIAL_GATE_STATE }}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

const select = (name: string) => screen.getByLabelText(name) as HTMLSelectElement;
const toggle = () => screen.getByRole("checkbox", { name: "Toggle noise cancellation" }) as HTMLInputElement;
const manualSlider = () => screen.queryByRole("slider", { name: "Custom threshold in decibels" }) as HTMLInputElement | null;

afterEach(cleanup);

describe("dialog", () => {
  it("is labelled by its title", () => {
    setup();

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  });

  it("closes from the button and Escape", () => {
    const { onClose } = setup();

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("feeds the meter from live telemetry", () => {
    setup({ localAnalyser: null });

    expect(screen.getByText("No microphone input detected")).toBeTruthy();
    expect(screen.getByText("Threshold: -36 dB")).toBeTruthy();
  });
});

describe("input device", () => {
  it("lists devices with the current one selected", () => {
    setup();

    expect(select("Input Device").value).toBe("usb-microphone-1");
    expect(screen.getByRole("option", { name: "USB Mic" })).toBeTruthy();
  });

  // Browsers hide labels until the mic is allowed.
  it("names an unlabelled device by a short id", () => {
    setup();

    expect(screen.getByRole("option", { name: "Microphone (abcdefgh...)" })).toBeTruthy();
  });

  it("says when there are none", () => {
    setup({ audioInputs: [], selectedDeviceId: "" });

    expect(screen.getByRole("option", { name: "No devices found" })).toBeTruthy();
  });

  it("reports a change", () => {
    const { onDeviceChange } = setup();

    fireEvent.change(select("Input Device"), { target: { value: "abcdefghijkl" } });

    expect(onDeviceChange).toHaveBeenCalledWith("abcdefghijkl");
  });
});

describe("transmission threshold", () => {
  it("reports a change", () => {
    const { onTransmissionThresholdChange } = setup();

    fireEvent.change(select("Voice Transmission Threshold"), { target: { value: "high" } });

    expect(onTransmissionThresholdChange).toHaveBeenCalledWith("high");
  });

  it("shows the slider in manual mode only", () => {
    setup();
    expect(manualSlider()).toBeNull();

    cleanup();
    setup({ transmissionThreshold: "manual" });
    expect(manualSlider()!.value).toBe("-20");
    expect(screen.getByText("-20 dB")).toBeTruthy();
  });

  it("reports the slider as a number", () => {
    const { onManualThresholdDbChange } = setup({ transmissionThreshold: "manual" });

    fireEvent.change(manualSlider()!, { target: { value: "-30" } });

    expect(onManualThresholdDbChange).toHaveBeenCalledWith(-30);
  });
});

describe("noise cancellation", () => {
  it("reports a toggle", () => {
    const { onNoiseCancellationChange } = setup();
    expect(toggle().checked).toBe(true);

    fireEvent.click(toggle());

    expect(onNoiseCancellationChange).toHaveBeenCalledWith(false);
  });

  it("is disabled, and says why, where the browser can't control it", () => {
    setup({ isNoiseCancellationSupported: false });

    expect(toggle().disabled).toBe(true);
    expect(screen.getByText(/not programmatically controllable/)).toBeTruthy();
    expect(screen.queryByText("Browser-native audio isolation active")).toBeNull();
  });
});
