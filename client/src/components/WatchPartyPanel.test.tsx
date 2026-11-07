// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Participant } from "../types";
import { MAX_WATCH_QUEUE } from "../types";
import { asAppSocket, fakeSocket } from "../test/fakeSocket";
import { makeParty } from "../test/watchParty";
import type { WatchPartyActions } from "../hooks/useWatchParty";
import WatchPartyPanel from "./WatchPartyPanel";

// The real player loads YouTube's script, which has no place in a unit test.
vi.mock("./WatchPlayer", () => ({
  default: ({ canControl }: { canControl: boolean }) => <div data-testid="player" data-can-control={String(canControl)} />,
}));

const participants: Participant[] = [
  { id: "s1", userId: "host", name: "Ana", isMuted: false },
  { id: "s2", userId: "guest", name: "Ben", isMuted: false },
];

function setup({ localUserId = "host", isOwner = false, party = makeParty({ memberIds: ["host", "guest"] }) } = {}) {
  const actions: WatchPartyActions = {
    changeVideo: vi.fn(),
    queueAdd: vi.fn(),
    queueRemove: vi.fn(),
    queuePlay: vi.fn(),
    queueMove: vi.fn(),
    reportEnded: vi.fn(),
  };
  const onEnd = vi.fn();
  render(
    <WatchPartyPanel
      socket={asAppSocket(fakeSocket())}
      snapshot={{ party, receivedAt: 0 }}
      playbackFeed={{ latest: () => null, subscribe: () => () => {} }}
      localUserId={localUserId}
      httpToken="token"
      isOwner={isOwner}
      participants={participants}
      onLeave={() => {}}
      onEnd={onEnd}
      actions={actions}
    />,
  );
  return { actions, onEnd };
}

const input = () => screen.getByLabelText("Search YouTube or paste a link") as HTMLInputElement;
const type = (value: string) => fireEvent.change(input(), { target: { value } });

function expectYouTubeLink(link: HTMLElement) {
  expect(link.getAttribute("href")).toBe("https://www.youtube.com/");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WatchPartyPanel", () => {
  it("offers Play now and Add to queue for a link", () => {
    const { actions } = setup();
    type("https://youtu.be/9bZkp7q19f0");
    fireEvent.click(screen.getByRole("button", { name: /Add to queue/ }));
    expect(actions.queueAdd).toHaveBeenCalledWith("9bZkp7q19f0");
    expect(input().value).toBe("");

    type("https://youtu.be/9bZkp7q19f0");
    fireEvent.submit(input());
    expect(actions.changeVideo).toHaveBeenCalledWith("9bZkp7q19f0");
  });

  it("searches for text instead", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }))));
    setup();
    type("never gonna");
    expect(screen.queryByRole("button", { name: /Play now/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText(/No videos found/)).toBeTruthy();
  });

  it("refuses something that looks like a link but isn't a video", () => {
    const { actions } = setup();
    type("https://www.youtube.com/live/abc");
    fireEvent.submit(input());
    expect(screen.getByRole("alert").textContent).toMatch(/Paste a YouTube video link/);
    expect(actions.changeVideo).not.toHaveBeenCalled();
  });

  it("won't queue past the limit", () => {
    const queue = Array.from({ length: MAX_WATCH_QUEUE }, (_, i) => ({ id: `e${i}`, videoId: "dQw4w9WgXcQ", title: null, addedBy: "host" }));
    setup({ party: makeParty({ memberIds: ["host"], queue }) });
    type("https://youtu.be/9bZkp7q19f0");
    expect((screen.getByRole("button", { name: /Add to queue/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("gives a guest of a host-only party no input and a player without controls", () => {
    setup({ localUserId: "guest" });
    expect(screen.queryByLabelText("Search YouTube or paste a link")).toBeNull();
    expect(screen.getByText("Only Ana can control the video.")).toBeTruthy();
    expect(screen.getByTestId("player").dataset.canControl).toBe("false");
  });

  it("gives everyone control when the party allows it", () => {
    setup({ localUserId: "guest", party: makeParty({ memberIds: ["host", "guest"], allowOthersToChange: true }) });
    expect(input()).toBeTruthy();
    expect(screen.getByTestId("player").dataset.canControl).toBe("true");
  });

  it("lets an owner end the party after confirming", () => {
    const { onEnd } = setup({ localUserId: "guest", isOwner: true });
    fireEvent.click(screen.getByRole("button", { name: "End party" }));
    expect(onEnd).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "End party" }).at(-1)!);
    expect(onEnd).toHaveBeenCalledWith("p1");
  });

  it("links to YouTube at the start of the input", () => {
    setup();
    expectYouTubeLink(screen.getByRole("link", { name: "Open YouTube in a new tab" }));
  });

  it("shows no End button to others", () => {
    setup();
    expect(screen.queryByRole("button", { name: "End party" })).toBeNull();
  });
});
