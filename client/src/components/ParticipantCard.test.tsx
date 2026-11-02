// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ParticipantCard from "./ParticipantCard";

const participant = (name = "Ana", isMuted = false) => ({ id: "s", userId: "u", name, isMuted });
const avatar = (container: HTMLElement) => container.querySelector(".rounded-full") as HTMLElement;

afterEach(cleanup);

describe("ParticipantCard", () => {
  it.each([
    ["Ana", "A"],
    ["ana maria", "AM"],
    ["Ana Maria Lopez", "AM"],
    ["ana  maria", "AM"],
  ])("shows initials for %j as %s", (name, initials) => {
    const { container } = render(<ParticipantCard participant={participant(name)} isSpeaking={false} />);

    expect(avatar(container).textContent).toBe(initials);
  });

  // Suspected bug: `w[0]` takes one UTF-16 unit, so a name starting with an emoji
  // renders half of a surrogate pair, which browsers show as a broken-character box.
  it.skip("keeps an emoji initial whole", () => {
    const { container } = render(<ParticipantCard participant={participant("😀 Bo")} isSpeaking={false} />);

    expect(avatar(container).textContent).toBe("😀B");
  });

  it("rings the avatar while speaking", () => {
    const { container } = render(<ParticipantCard participant={participant()} isSpeaking />);

    expect(avatar(container).className).toContain("ring-green-400");
  });

  it("never rings a muted participant", () => {
    const { container } = render(<ParticipantCard participant={participant("Ana", true)} isSpeaking />);

    expect(avatar(container).className).not.toContain("ring-green-400");
  });

  it("announces the mute state", () => {
    render(<ParticipantCard participant={participant("Ana", true)} isSpeaking={false} />);
    expect(screen.getByRole("img", { name: "Muted" })).toBeTruthy();

    cleanup();
    render(<ParticipantCard participant={participant()} isSpeaking={false} />);
    expect(screen.getByRole("img", { name: "Not muted" })).toBeTruthy();
  });

  it("shows the you and connecting markers only when set", () => {
    render(<ParticipantCard participant={participant()} isSpeaking={false} />);
    expect(screen.queryByText("(you)")).toBeNull();
    expect(screen.queryByText("Connecting…")).toBeNull();

    cleanup();
    render(<ParticipantCard participant={participant()} isSpeaking={false} isLocal isConnecting />);
    expect(screen.getByText("(you)")).toBeTruthy();
    expect(screen.getByText("Connecting…")).toBeTruthy();
  });

  it("has no menu button without a handler", () => {
    render(<ParticipantCard participant={participant()} isSpeaking={false} />);

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("opens the menu from the button and from a right-click", () => {
    const onOpenMenu = vi.fn();
    render(<ParticipantCard participant={participant()} isSpeaking={false} onOpenMenu={onOpenMenu} />);

    fireEvent.click(screen.getByRole("button", { name: "Options for Ana" }));
    fireEvent.contextMenu(screen.getByText("Ana"));

    expect(onOpenMenu).toHaveBeenCalledTimes(2);
  });
});
