// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MAX_CHAT_TEXT_LENGTH } from "../types";
import MessageEditor from "./MessageEditor";

function setup(initialText = "hello") {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(<MessageEditor initialText={initialText} onSubmit={onSubmit} onCancel={onCancel} />);
  const box = screen.getByLabelText("Edit message") as HTMLTextAreaElement;
  const type = (value: string) => fireEvent.change(box, { target: { value } });
  return { onSubmit, onCancel, box, type };
}

afterEach(cleanup);

describe("MessageEditor", () => {
  it("keeps the text but can't save while the user may not send", () => {
    const onCancel = vi.fn();
    render(<MessageEditor initialText="draft" onCancel={onCancel} />);
    const box = screen.getByLabelText("Edit message") as HTMLTextAreaElement;

    fireEvent.keyDown(box, { key: "Enter" });

    expect(box.value).toBe("draft");
    expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Only owners");
  });

  it("starts with the message's text", () => {
    expect(setup("original").box.value).toBe("original");
  });

  it("submits trimmed text on Enter", () => {
    const { onSubmit, box, type } = setup();
    type("  edited  ");

    fireEvent.keyDown(box, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("edited");
  });

  it("keeps Shift+Enter for a new line", () => {
    const { onSubmit, box } = setup();

    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits with the Save button", () => {
    const { onSubmit } = setup();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledWith("hello");
  });

  it.each(["", "   ", "\n\n"])("refuses to save the blank text %j", (blank) => {
    const { onSubmit, box, type } = setup();
    type(blank);

    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("cancels on Escape and on the Cancel button", () => {
    const { onCancel, box } = setup();

    fireEvent.keyDown(box, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("allows text exactly at the limit", () => {
    const { onSubmit, box, type } = setup();
    type("x".repeat(MAX_CHAT_TEXT_LENGTH));

    fireEvent.keyDown(box, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // The server would drop it; the editor must stay open with the text intact.
  it("explains and refuses text over the limit", () => {
    const { onSubmit, box, type } = setup();
    type("x".repeat(MAX_CHAT_TEXT_LENGTH + 1));

    fireEvent.keyDown(box, { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(String(MAX_CHAT_TEXT_LENGTH));
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("measures the limit after trimming", () => {
    const { onSubmit, box, type } = setup();
    type(`  ${"x".repeat(MAX_CHAT_TEXT_LENGTH)}  `);

    fireEvent.keyDown(box, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
