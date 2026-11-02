// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { MicTelemetry } from "../types";
import { MicLevelPreview } from "./MicLevelPreview";

const telemetry = (overrides: Partial<MicTelemetry> = {}): MicTelemetry => ({
  levelDb: -35,
  noiseFloorDb: -56,
  thresholdDb: -36,
  isTransmitting: false,
  isMuted: false,
  hasInput: true,
  ...overrides,
});

function setup(overrides: Partial<MicTelemetry> = {}) {
  return render(<MicLevelPreview telemetry={telemetry(overrides)} />);
}

const meter = () => screen.getByRole("meter", { name: "Microphone input level" });

afterEach(cleanup);

describe("MicLevelPreview status", () => {
  it.each<[string, Partial<MicTelemetry>]>([
    ["No microphone input detected", { hasInput: false, isMuted: true, isTransmitting: true }],
    ["Microphone is muted", { isMuted: true, isTransmitting: true }],
    ["Voice transmitting", { isTransmitting: true }],
    ["Noise suppressed (below threshold)", {}],
    ["Ambient / quiet", { thresholdDb: null }],
  ])("reads %s, taking the first state that applies", (text, overrides) => {
    setup(overrides);

    expect(screen.getByText(text)).toBeTruthy();
  });
});

describe("MicLevelPreview meter", () => {
  it("maps the level from -70..0 dB to a percentage, for screen readers too", () => {
    setup({ levelDb: -35 });

    expect(meter().getAttribute("aria-valuenow")).toBe("50");
    expect(meter().getAttribute("aria-valuetext")).toContain("50%");
  });

  it.each<[string, Partial<MicTelemetry>]>([
    ["muted", { isMuted: true }],
    ["without input", { hasInput: false }],
  ])("reads empty when %s", (_label, overrides) => {
    setup(overrides);

    expect(meter().getAttribute("aria-valuenow")).toBe("0");
    expect(screen.getByText("Level: --")).toBeTruthy();
    expect(screen.getByText("Noise floor: --")).toBeTruthy();
  });

  it("shows rounded readings", () => {
    setup({ levelDb: -35.6, noiseFloorDb: -56.4 });

    expect(screen.getByText("Level: -36 dB")).toBeTruthy();
    expect(screen.getByText("Noise floor: -56 dB")).toBeTruthy();
  });

  it("places the threshold marker at its percentage", () => {
    setup({ thresholdDb: -35 });

    expect(screen.getByTitle("Voice transmission threshold: -35 dB").style.left).toBe("50%");
    expect(screen.getByText("Threshold: -35 dB")).toBeTruthy();
  });

  it("has no marker with the threshold off", () => {
    setup({ thresholdDb: null });

    expect(screen.queryByTitle(/Voice transmission threshold/)).toBeNull();
    expect(screen.getByText("Threshold: Off")).toBeTruthy();
  });

  it("shows the noise floor marker only when there is one to show", () => {
    setup({ noiseFloorDb: -35 });
    expect(screen.getByTitle("Ambient noise floor: ~-35 dB").style.width).toBe("50%");

    cleanup();
    setup({ noiseFloorDb: -80 });
    expect(screen.queryByTitle(/Ambient noise floor/)).toBeNull();
  });
});
