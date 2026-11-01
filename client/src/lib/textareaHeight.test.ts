import { describe, it, expect } from "vitest";
import { fitToContent } from "./textareaHeight";

/** Like a real textarea, scrollHeight never reports less than the current explicit height. */
function fakeTextarea(contentHeight: number, height = "auto") {
  const textarea = {
    style: { height },
    get scrollHeight() {
      return Math.max(contentHeight, parseInt(this.style.height, 10) || 0);
    },
  };
  return textarea as unknown as HTMLTextAreaElement;
}

describe("fitToContent", () => {
  it("grows to the content", () => {
    const textarea = fakeTextarea(60);
    fitToContent(textarea);
    expect(textarea.style.height).toBe("60px");
  });

  // Regression: the box stayed tall after sending a multi-line message.
  it("shrinks once the content does", () => {
    const textarea = fakeTextarea(36, "112px");
    fitToContent(textarea);
    expect(textarea.style.height).toBe("36px");
  });
});
