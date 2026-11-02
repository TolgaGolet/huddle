// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Participant } from "../types";
import ParticipantsList from "./ParticipantsList";

const me: Participant = { id: "s-me", userId: "u-me", name: "Me", isMuted: false };
const bo: Participant = { id: "s-bo", userId: "u-bo", name: "Bo", isMuted: false };

function setup(overrides: Partial<React.ComponentProps<typeof ParticipantsList>> = {}) {
  const onSetOwner = vi.fn();
  const onKick = vi.fn();
  render(
    <ParticipantsList
      participants={[me, bo]}
      localId="s-me"
      speaking={new Set()}
      peerVolumes={new Map()}
      onSetPeerVolume={vi.fn()}
      ownerIds={new Set(["u-me"])}
      canModerate
      onSetOwner={onSetOwner}
      onKick={onKick}
      {...overrides}
    />,
  );
  return { onSetOwner, onKick };
}

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "Options for Bo" }));

afterEach(cleanup);

describe("ParticipantsList moderation", () => {
  it("marks owners", () => {
    setup();

    expect(screen.getAllByRole("img", { name: "Owner" })).toHaveLength(1);
  });

  it("lets an owner make someone an owner, and remove them", () => {
    const { onSetOwner } = setup();
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Make owner" }));
    expect(onSetOwner).toHaveBeenCalledWith("u-bo", true);
    cleanup();

    const again = setup({ ownerIds: new Set(["u-me", "u-bo"]) });
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Remove as owner" }));
    expect(again.onSetOwner).toHaveBeenCalledWith("u-bo", false);
  });

  it("asks before kicking", () => {
    const { onKick } = setup();
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Kick from room" }));
    expect(onKick).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Kick" }));
    expect(onKick).toHaveBeenCalledWith("u-bo");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("can be cancelled", () => {
    const { onKick } = setup();
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Kick from room" }));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onKick).not.toHaveBeenCalled();
  });

  it("offers a non-owner only the volume", () => {
    setup({ canModerate: false });
    openMenu();

    expect(screen.getByRole("slider", { name: "Volume for Bo" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Kick from room" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make owner" })).toBeNull();
  });
});
