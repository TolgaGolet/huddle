// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ParticipantContextMenu from "./ParticipantContextMenu";

function setup(overrides: Partial<React.ComponentProps<typeof ParticipantContextMenu>> = {}) {
  const onVolumeChange = vi.fn();
  const onClose = vi.fn();
  const view = render(<ParticipantContextMenu x={10} y={20} name="Ana" volume={0.5} onVolumeChange={onVolumeChange} onClose={onClose} {...overrides} />);
  const slider = screen.getByRole("slider", { name: "Volume for Ana" }) as HTMLInputElement;
  return { onVolumeChange, onClose, slider, ...view };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ParticipantContextMenu", () => {
  it("shows the volume as a percentage, focused for keyboard users", () => {
    const { slider } = setup();

    expect(slider.value).toBe("50");
    expect(screen.getByText("50%")).toBeTruthy();
    expect(document.activeElement).toBe(slider);
  });

  it("reports the slider as a gain, up to 200%", () => {
    const { onVolumeChange, slider } = setup();

    fireEvent.change(slider, { target: { value: "200" } });

    expect(onVolumeChange).toHaveBeenCalledWith(2);
  });

  it("closes on Escape", () => {
    const { onClose } = setup();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on a press outside but not on the slider", () => {
    const { onClose, slider } = setup();

    fireEvent.mouseDown(slider);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("puts focus back on the opener when closed", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = setup();

    unmount();

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  function panel() {
    return screen.getByRole("slider").closest(".fixed") as HTMLElement;
  }

  it("stays where it was opened when it fits", () => {
    setup();

    expect(panel().style.left).toBe("10px");
    expect(panel().style.top).toBe("20px");
  });

  // Regression: an off-screen menu looked as if the button did nothing.
  it("moves back inside the viewport when it would overflow", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 200, height: 100 } as DOMRect);

    setup({ x: window.innerWidth - 10, y: window.innerHeight - 10 });

    expect(panel().style.left).toBe(`${window.innerWidth - 208}px`);
    expect(panel().style.top).toBe(`${window.innerHeight - 108}px`);
  });

  it("never goes past the top-left margin", () => {
    setup({ x: -50, y: -50 });

    expect(panel().style.left).toBe("8px");
    expect(panel().style.top).toBe("8px");
  });
});
