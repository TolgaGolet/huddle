// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WatchPartyState } from "../types";
import { WatchPartyContext } from "../lib/watchPartyContext";
import { makeParty, watchContextValue } from "../test/watchParty";
import WatchInviteCard from "./WatchInviteCard";

const party = makeParty({ videoId: "9bZkp7q19f0", memberIds: ["u1", "u2"] });

function setup(active: WatchPartyState | null, isMember = false) {
  const join = vi.fn(() => true);
  const parties = active ? [active] : [];
  render(
    <WatchPartyContext value={watchContextValue({ parties, joinedPartyId: isMember && active ? active.id : null, join })}>
      <WatchInviteCard partyId="p1" videoId="dQw4w9WgXcQ" senderName="Ana" />
    </WatchPartyContext>,
  );
  return { join };
}

afterEach(cleanup);

describe("WatchInviteCard", () => {
  it("joins a running party and links its current video", () => {
    const { join } = setup(party);
    expect(screen.getByText("2 watching")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://www.youtube.com/watch?v=9bZkp7q19f0");
    fireEvent.click(screen.getByRole("button", { name: "Join Watch Together" }));
    expect(join).toHaveBeenCalledWith("p1");
  });

  it("shows a member they're watching, with no join button", () => {
    setup(party, true);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/You're watching/)).toBeTruthy();
  });

  it("shows the current video's title once known", () => {
    setup({ ...party, title: "Gangnam Style" });
    expect(screen.getByRole("link").textContent).toBe("Gangnam Style");
  });

  it("shows an ended party, including when a newer one is running", () => {
    setup({ ...party, id: "p2" });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("This watch party has ended.")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});
