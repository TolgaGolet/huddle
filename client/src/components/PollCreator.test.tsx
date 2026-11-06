// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MAX_POLL_OPTIONS } from "../types";
import PollCreator from "./PollCreator";

function setup(onSubmit = vi.fn(() => true)) {
  const onClose = vi.fn();
  render(<PollCreator onSubmit={onSubmit} onClose={onClose} />);
  return { onSubmit, onClose };
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
const createButton = () => screen.getByRole("button", { name: "Create Poll" }) as HTMLButtonElement;
const addButton = () => screen.queryByRole("button", { name: "Add option" });

function fillValid() {
  type("Poll question", "Pizza?");
  type("Option 1", "Yes");
  type("Option 2", "No");
}

afterEach(cleanup);

describe("PollCreator", () => {
  it("can't be submitted empty", () => {
    const { onSubmit } = setup();

    fireEvent.click(createButton());

    expect(createButton().disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("needs a question", () => {
    setup();
    type("Option 1", "Yes");
    type("Option 2", "No");

    expect(createButton().disabled).toBe(true);
  });

  it("needs two non-blank options", () => {
    setup();
    type("Poll question", "Pizza?");
    type("Option 1", "Yes");
    type("Option 2", "   ");

    expect(createButton().disabled).toBe(true);
  });

  it("submits trimmed values, drops blank options and closes", () => {
    const { onSubmit, onClose } = setup();
    type("Poll question", "  Pizza?  ");
    type("Option 1", " Yes ");
    fireEvent.click(addButton()!);
    type("Option 3", "No");

    fireEvent.click(createButton());

    expect(onSubmit).toHaveBeenCalledWith({ question: "Pizza?", options: ["Yes", "No"], allowMultiple: false, lockVotes: false });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("passes the multiple-selection choice", () => {
    const { onSubmit } = setup();
    fillValid();

    fireEvent.click(screen.getByRole("checkbox", { name: "Allow multiple selections" }));
    fireEvent.click(createButton());

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ allowMultiple: true }));
  });

  it("passes the locked-votes choice and an end time", () => {
    const { onSubmit } = setup();
    fillValid();

    fireEvent.click(screen.getByRole("checkbox", { name: "Votes can't be changed" }));
    fireEvent.change(screen.getByLabelText("Ends after"), { target: { value: String(15 * 60_000) } });
    fireEvent.click(createButton());

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ lockVotes: true, durationMs: 15 * 60_000 }));
  });

  it("sends no end time by default", () => {
    const { onSubmit } = setup();
    fillValid();

    fireEvent.click(createButton());

    expect(onSubmit).toHaveBeenCalledWith(expect.not.objectContaining({ durationMs: expect.anything() }));
  });

  it("stays open with what's typed when the poll wasn't sent", () => {
    const { onClose } = setup(vi.fn(() => false));
    fillValid();

    fireEvent.click(createButton());

    expect(onClose).not.toHaveBeenCalled();
    expect(field("Poll question").value).toBe("Pizza?");
  });

  it("stops offering more options at the limit", () => {
    setup();

    for (let i = 2; i < MAX_POLL_OPTIONS; i++) fireEvent.click(addButton()!);

    expect(screen.getAllByLabelText(/^Option \d+$/)).toHaveLength(MAX_POLL_OPTIONS);
    expect(addButton()).toBeNull();
  });

  it("doesn't let the options go below two", () => {
    setup();

    expect(screen.queryByRole("button", { name: /Remove option/ })).toBeNull();
  });

  it("removes the chosen option and keeps the others' text", () => {
    setup();
    type("Option 1", "A");
    type("Option 2", "B");
    fireEvent.click(addButton()!);
    type("Option 3", "C");

    fireEvent.click(screen.getByRole("button", { name: "Remove option 2" }));

    expect(field("Option 1").value).toBe("A");
    expect(field("Option 2").value).toBe("C");
    expect(screen.queryByLabelText("Option 3")).toBeNull();
  });

  it("closes on the close button and on a press outside", () => {
    const { onClose } = setup();

    fireEvent.click(screen.getByRole("button", { name: "Close poll creator" }));
    fireEvent.mouseDown(document.body);

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("stays open on a press inside", () => {
    const { onClose } = setup();

    fireEvent.mouseDown(field("Poll question"));

    expect(onClose).not.toHaveBeenCalled();
  });
});
