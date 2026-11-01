import { describe, expect, it } from "vitest";
import { isDragLeavingContainer } from "./dragLeave";

const child = {} as Node;
const outside = {} as Node;
const container = { contains: (other: Node | null) => other === child };

describe("isDragLeavingContainer", () => {
  it("stays inside when moving between children", () => {
    expect(isDragLeavingContainer(container, child as unknown as EventTarget)).toBe(false);
  });

  it("leaves when moving to an element outside", () => {
    // Regression: the drop overlay stayed up after dragging out without dropping.
    expect(isDragLeavingContainer(container, outside as unknown as EventTarget)).toBe(true);
  });

  it("leaves when the drag exits the window or is cancelled", () => {
    expect(isDragLeavingContainer(container, null)).toBe(true);
  });
});
