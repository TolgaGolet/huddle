// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import ParticipantsList from "./ParticipantsList";

const participant = (id: string, name: string) => ({ id, userId: `user-${id}`, name, isMuted: false });
const people = [participant("me", "Ana"), participant("peer", "Bo")];

function setup(props: Partial<React.ComponentProps<typeof ParticipantsList>> = {}) {
  const onSetPeerVolume = vi.fn();
  render(<ParticipantsList participants={people} localId="me" speaking={new Set()} peerVolumes={new Map()} onSetPeerVolume={onSetPeerVolume} {...props} />);
  return { onSetPeerVolume };
}

const slider = () => screen.queryByRole("slider", { name: "Volume for Bo" }) as HTMLInputElement | null;
const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "Options for Bo" }));

afterEach(cleanup);

describe("ParticipantsList", () => {
  // Regression: the local card had a menu button that opened nothing.
  it("offers options for remote participants only", () => {
    const html = renderToStaticMarkup(
      <ParticipantsList
        participants={[participant("me", "Ana"), participant("peer", "Bo")]}
        localId="me"
        speaking={new Set()}
        peerVolumes={new Map()}
        onSetPeerVolume={() => {}}
      />,
    );

    expect(html).toContain("Options for Bo");
    expect(html).not.toContain("Options for Ana");
  });

  it("shows the count without a cap", () => {
    setup();

    expect(screen.getByRole("heading").textContent).toBe("Participants — 2");
  });

  it("shows the count against the cap", () => {
    setup({ maxParticipants: 6 });

    expect(screen.getByRole("heading").textContent).toBe("Participants — 2/6");
  });

  it("says when the room is full", () => {
    setup({ maxParticipants: 2 });

    expect(screen.getByRole("heading").textContent).toBe("Participants — 2/2 (full)");
  });

  it("marks only the local participant as you", () => {
    setup();

    expect(screen.getAllByText("(you)")).toHaveLength(1);
  });

  it("marks only the participants still connecting", () => {
    setup({ connecting: new Set(["peer"]) });

    expect(screen.getAllByText("Connecting…")).toHaveLength(1);
  });

  it("opens the volume menu from the button, at full volume by default", () => {
    setup();

    openMenu();

    expect(slider()!.value).toBe("100");
  });

  it("opens the volume menu on right-click, instead of the browser's", () => {
    setup();

    const notPrevented = fireEvent.contextMenu(screen.getByText("Bo"));

    expect(notPrevented).toBe(false);
    expect(slider()).not.toBeNull();
  });

  it("offers no menu on right-clicking ourselves", () => {
    setup();

    fireEvent.contextMenu(screen.getByText("Ana"));

    expect(screen.queryByRole("slider")).toBeNull();
  });

  // By identity: a reconnect changes the socket id but must keep the choice.
  it("reads and writes the volume by userId, not socket id", () => {
    const { onSetPeerVolume } = setup({ peerVolumes: new Map([["user-peer", 0.5]]) });
    openMenu();
    expect(slider()!.value).toBe("50");

    fireEvent.change(slider()!, { target: { value: "150" } });

    expect(onSetPeerVolume).toHaveBeenCalledWith("user-peer", 1.5);
  });

  it("closes the menu on Escape", () => {
    setup();
    openMenu();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(slider()).toBeNull();
  });
});
