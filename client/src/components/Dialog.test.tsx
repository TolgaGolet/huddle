// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Dialog from "./Dialog";

function setup(props: Partial<React.ComponentProps<typeof Dialog>> = {}, children: React.ReactNode = <><button>Cancel</button><button>Delete</button></>) {
  const onClose = vi.fn();
  const view = render(
    <Dialog onClose={onClose} label="Confirm" overlayClassName="overlay" {...props}>
      {children}
    </Dialog>,
  );
  return { onClose, ...view };
}

afterEach(cleanup);

describe("Dialog", () => {
  it("is announced as a modal with its label", () => {
    setup();

    const dialog = screen.getByRole("dialog", { name: "Confirm" });

    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("focuses the first control, which is the safest action", () => {
    setup();

    expect(document.activeElement).toBe(screen.getByText("Cancel"));
  });

  it("focuses the panel itself when it has no controls", () => {
    setup({}, <p>Text only</p>);

    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("skips disabled controls for initial focus", () => {
    setup({}, <><button disabled>Off</button><button>On</button></>);

    expect(document.activeElement).toBe(screen.getByText("On"));
  });

  it("closes on Escape with the latest handler", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const view = render(<Dialog onClose={first} label="x" overlayClassName="o"><button>a</button></Dialog>);
    view.rerender(<Dialog onClose={latest} label="x" overlayClassName="o"><button>a</button></Dialog>);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });

  it("keeps Tab inside the dialog, in both directions", () => {
    setup();
    const cancel = screen.getByText("Cancel");
    const del = screen.getByText("Delete");

    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(del);

    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(del);
  });

  it("ignores other keys", () => {
    const { onClose } = setup();

    fireEvent.keyDown(document, { key: "a" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on a backdrop press only when asked to", () => {
    const { onClose, container } = setup({ closeOnBackdrop: true });

    fireEvent.mouseDown(container.querySelector(".overlay")!);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays open on a backdrop press by default", () => {
    const { onClose, container } = setup();

    fireEvent.mouseDown(container.querySelector(".overlay")!);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("stays open on a press inside the panel", () => {
    const { onClose } = setup({ closeOnBackdrop: true });

    fireEvent.mouseDown(screen.getByText("Cancel"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("puts focus back on whatever opened it", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = setup();

    unmount();

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("prefers returnFocus when the opener is gone", () => {
    const target = document.createElement("button");
    document.body.appendChild(target);
    const { unmount } = setup({ returnFocus: () => target });

    unmount();

    expect(document.activeElement).toBe(target);
    target.remove();
  });

  it("stops listening once closed", () => {
    const { onClose, unmount } = setup();

    unmount();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });
});
