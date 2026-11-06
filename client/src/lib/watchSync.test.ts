import { describe, expect, it, vi } from "vitest";
import { SETTLE_MS, snapRate, WatchSync, type SyncPlayer } from "./watchSync";
import { YT_STATE } from "./youtubeApi";

/** A player whose time advances with the test clock while it plays. */
function setup() {
  let clock = 10_000;
  let time = 0;
  let state: number = YT_STATE.UNSTARTED;
  let rate = 1;
  let lastAdvance = clock;
  const advance = () => {
    if (state === YT_STATE.PLAYING) time += ((clock - lastAdvance) / 1000) * rate;
    lastAdvance = clock;
  };
  const player = {
    getCurrentTime: vi.fn(() => (advance(), time)),
    getPlayerState: vi.fn(() => state),
    getPlaybackRate: vi.fn(() => rate),
    seekTo: vi.fn((t: number) => { advance(); time = t; }),
    playVideo: vi.fn(() => { advance(); state = YT_STATE.PLAYING; }),
    pauseVideo: vi.fn(() => { advance(); state = YT_STATE.PAUSED; }),
    setPlaybackRate: vi.fn((r: number) => { advance(); rate = r; }),
  };
  const send = vi.fn();
  const sync = new WatchSync(player satisfies SyncPlayer, send, () => clock);
  return {
    sync,
    player,
    send,
    /** Moves the clock on, ticking every 500 ms like the panel does. */
    wait(ms: number) {
      for (let left = ms; left > 0; left -= 500) {
        clock += Math.min(500, left);
        sync.tick();
      }
    },
    /** The user does something in the player, which then reports it. */
    user: {
      pause() { advance(); state = YT_STATE.PAUSED; sync.onStateChange(state); },
      play() { advance(); state = YT_STATE.PLAYING; sync.onStateChange(state); },
      seek(t: number) { advance(); time = t; },
      rate(r: number) { advance(); rate = r; sync.onRateChange(r); },
    },
    set(next: { time?: number; state?: number }) {
      advance();
      if (next.time !== undefined) time = next.time;
      if (next.state !== undefined) state = next.state;
    },
    get time() { advance(); return time; },
  };
}

describe("WatchSync.applyRemote", () => {
  it("seeks, plays and sets the speed to match the party", () => {
    const t = setup();
    t.sync.applyRemote({ state: "playing", position: 30, rate: 1.5 });
    expect(t.player.seekTo).toHaveBeenCalledWith(30, true);
    expect(t.player.playVideo).toHaveBeenCalled();
    expect(t.player.setPlaybackRate).toHaveBeenCalledWith(1.5);
  });

  it("doesn't seek when already close enough", () => {
    const t = setup();
    t.set({ time: 30.4, state: YT_STATE.PAUSED });
    t.sync.applyRemote({ state: "paused", position: 30, rate: 1 });
    expect(t.player.seekTo).not.toHaveBeenCalled();
  });

  it("never echoes the change it applied", () => {
    const t = setup();
    t.sync.applyRemote({ state: "playing", position: 30, rate: 1 });
    t.sync.onStateChange(YT_STATE.BUFFERING);
    t.sync.onStateChange(YT_STATE.PLAYING);
    t.wait(5_000);
    t.sync.applyRemote({ state: "paused", position: 40, rate: 1 });
    t.sync.onStateChange(YT_STATE.PAUSED);
    t.wait(5_000);
    expect(t.send).not.toHaveBeenCalled();
  });
});

describe("WatchSync local actions", () => {
  it("broadcasts a pause and a play", () => {
    const t = setup();
    t.sync.applyRemote({ state: "playing", position: 0, rate: 1 });
    t.wait(SETTLE_MS + 500);
    t.user.pause();
    expect(t.send).toHaveBeenLastCalledWith({ state: "paused", position: expect.closeTo(2, 0), rate: 1 });
    t.wait(1_000);
    t.user.play();
    expect(t.send).toHaveBeenLastCalledWith({ state: "playing", position: expect.closeTo(2, 0), rate: 1 });
    expect(t.send).toHaveBeenCalledTimes(2);
  });

  it("broadcasts a seek found between ticks, while playing or paused", () => {
    const t = setup();
    t.sync.applyRemote({ state: "playing", position: 0, rate: 1 });
    t.wait(SETTLE_MS + 500);
    t.user.seek(120);
    t.wait(500);
    expect(t.send).toHaveBeenLastCalledWith({ state: "playing", position: expect.closeTo(120.5, 1), rate: 1 });

    t.user.pause();
    t.user.seek(10);
    t.wait(500);
    expect(t.send).toHaveBeenLastCalledWith({ state: "paused", position: 10, rate: 1 });
  });

  it("broadcasts a speed change, snapped to a speed the server takes", () => {
    const t = setup();
    t.sync.applyRemote({ state: "playing", position: 0, rate: 1 });
    t.wait(SETTLE_MS + 500);
    t.user.rate(1.3);
    expect(t.send).toHaveBeenLastCalledWith(expect.objectContaining({ rate: 1.25 }));
  });

  it("sends a repeated report only once", () => {
    const t = setup();
    t.sync.applyRemote({ state: "playing", position: 0, rate: 1 });
    t.wait(SETTLE_MS + 500);
    t.user.pause();
    t.sync.onStateChange(YT_STATE.ENDED);
    expect(t.send).toHaveBeenCalledTimes(1);
  });
});

describe("WatchSync catching up", () => {
  it("corrects falling behind while playing without telling anyone", () => {
    const t = setup();
    t.sync.applyRemote({ state: "playing", position: 0, rate: 1 });
    t.wait(SETTLE_MS + 500);
    // Three seconds of buffering: the player stands still while the party moves on.
    t.set({ state: YT_STATE.BUFFERING });
    t.wait(3_000);
    t.set({ state: YT_STATE.PLAYING });
    t.wait(500);
    expect(t.player.seekTo).toHaveBeenLastCalledWith(expect.closeTo(5.5, 0), true);
    expect(t.send).not.toHaveBeenCalled();
  });

  // Regression guard: a slow load reporting the old time was taken for the user seeking back.
  it("doesn't take a seek that outlasts the settle time for the user's", () => {
    const t = setup();
    t.set({ time: 300, state: YT_STATE.PLAYING });
    // Still reports the old time while it buffers.
    t.player.seekTo.mockImplementation(() => t.set({ state: YT_STATE.BUFFERING }));
    t.sync.applyRemote({ state: "playing", position: 0, rate: 1 });
    t.wait(SETTLE_MS + 1_500);
    t.set({ time: 0, state: YT_STATE.PLAYING });
    t.wait(1_000);
    expect(t.send).not.toHaveBeenCalled();
  });

  // Regression guard: pressing play after a blocked autoplay must not pull everyone back.
  it("treats play while the party plays as catching up, not a broadcast", () => {
    const t = setup();
    t.player.playVideo.mockImplementation(() => {}); // the browser blocks it
    t.sync.applyRemote({ state: "playing", position: 60, rate: 1 });
    t.sync.onStateChange(YT_STATE.PAUSED);
    t.wait(SETTLE_MS + 500);
    expect(t.sync.isBlocked()).toBe(true);

    t.user.play();

    expect(t.send).not.toHaveBeenCalled();
    expect(t.time).toBeCloseTo(62, 0);
    expect(t.sync.isBlocked()).toBe(false);
  });
});

describe("snapRate", () => {
  it("picks the nearest offered speed", () => {
    expect(snapRate(1.3)).toBe(1.25);
    expect(snapRate(3)).toBe(2);
    expect(snapRate(0.1)).toBe(0.25);
    expect(snapRate(1)).toBe(1);
  });
});
