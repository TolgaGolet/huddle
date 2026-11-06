import { WATCH_RATES, projectPosition, type WatchPlayback, type WatchPlaybackState } from "../types";
import { YT_STATE, type YouTubePlayer } from "./youtubeApi";

/** What WatchSync needs from the YouTube player, so tests can use a fake. */
export type SyncPlayer = Pick<
  YouTubePlayer,
  "getCurrentTime" | "getPlayerState" | "getPlaybackRate" | "seekTo" | "playVideo" | "pauseVideo" | "setPlaybackRate"
>;

/** Closer than this to where the party is counts as in sync. */
const SYNC_TOLERANCE_S = 1;
/** Falling this far behind while playing (e.g. buffering) is corrected locally. */
const DRIFT_LIMIT_S = 2;
/** A position change this much beyond what playback explains is a seek. */
const SEEK_JUMP_S = 1.5;
/**
 * After we change the player ourselves, its state events and times lag behind
 * (the iframe reports them asynchronously), so for this long they are ours, not
 * the user's.
 */
export const SETTLE_MS = 1500;
const DEDUPE_MS = 300;

interface Expected extends WatchPlayback {
  /** Local clock (ms) when `position` was true. */
  at: number;
}

/** The nearest speed the server accepts. YouTube's custom speeds fall between them. */
export function snapRate(rate: number): number {
  return WATCH_RATES.reduce((best, r) => (Math.abs(r - rate) < Math.abs(best - rate) ? r : best), 1);
}

/**
 * Keeps a YouTube player in step with the party and reports what the local user
 * does. The rule that keeps members from echoing each other: only *transitions*
 * are broadcast (play while the party is paused, pause while it plays, a seek
 * or a speed change). A player that disagrees with the party for any other
 * reason, such as buffering or a browser that blocked autoplay, is brought back
 * to the party's position locally and never broadcast.
 */
export class WatchSync {
  private expected: Expected | null = null;
  /** The last time sample, for telling seeks from playback. */
  private baseline: { time: number; at: number } | null = null;
  private settleUntil = 0;
  private lastSent: { playback: WatchPlayback; at: number } | null = null;

  constructor(
    private readonly player: SyncPlayer,
    private readonly send: (playback: WatchPlayback) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Where the party is now, by our own clock. */
  projected(): number {
    const e = this.expected;
    return e ? projectPosition(e, this.now() - e.at) : 0;
  }

  /** The party's state, from the server: move the player there. */
  applyRemote(playback: WatchPlayback): void {
    this.expected = { ...playback, at: this.now() };
    this.settle();
    const { player } = this;
    if (Math.abs(player.getPlaybackRate() - playback.rate) > 0.01) player.setPlaybackRate(playback.rate);
    this.seekIfOff();
    const state = player.getPlayerState();
    const moving = state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING;
    if (playback.state === "playing" && !moving) player.playVideo();
    if (playback.state === "paused" && moving) player.pauseVideo();
  }

  onStateChange(state: number): void {
    const e = this.expected;
    if (!e) return;
    if (state === YT_STATE.PLAYING) {
      // Playing along with the party: catching up, never a change to announce.
      if (e.state === "playing") {
        this.seekIfOff();
        return;
      }
      if (this.isSettling()) return;
      this.broadcast("playing", this.player.getCurrentTime());
    } else if (state === YT_STATE.PAUSED || state === YT_STATE.ENDED) {
      // A blocked autoplay can report a pause just after we asked it to play.
      if (e.state === "paused" || this.isSettling()) return;
      this.broadcast("paused", this.player.getCurrentTime());
    }
  }

  onRateChange(rate: number): void {
    const e = this.expected;
    if (!e || Math.abs(rate - e.rate) < 0.01 || this.isSettling()) return;
    this.broadcast(e.state, this.player.getCurrentTime(), snapRate(rate));
  }

  /** Call every ~500 ms: finds seeks, which the player has no event for, and corrects drift. */
  tick(): void {
    const { player } = this;
    const e = this.expected;
    if (!e || this.isSettling()) return;
    const state = player.getPlayerState();
    const previous = this.baseline;
    // After a change of ours, a player still loading or seeking can report the
    // old time, which the next sample would take for the user seeking. So the
    // first sample after one waits for the player to settle, however long it takes.
    if (!previous && state !== YT_STATE.PLAYING && state !== YT_STATE.PAUSED) return;
    const time = player.getCurrentTime();
    const at = this.now();
    this.baseline = { time, at };
    if (!previous || state === YT_STATE.UNSTARTED || state === YT_STATE.CUED) return;

    const elapsed = (at - previous.at) / 1000;
    const moved = time - previous.time;
    // Buffering only ever falls behind, so a jump either way past playback is the user's.
    if (moved < -SEEK_JUMP_S || moved > elapsed * player.getPlaybackRate() + SEEK_JUMP_S) {
      this.broadcast(e.state, time);
      return;
    }
    if (e.state === "playing" && state === YT_STATE.PLAYING && Math.abs(time - this.projected()) > DRIFT_LIMIT_S) {
      this.settle();
      player.seekTo(this.projected(), true);
    }
  }

  /** The party is playing but this player isn't, as when the browser blocked autoplay. */
  isBlocked(): boolean {
    const state = this.player.getPlayerState();
    return (
      this.expected?.state === "playing" &&
      !this.isSettling() &&
      (state === YT_STATE.PAUSED || state === YT_STATE.UNSTARTED || state === YT_STATE.CUED)
    );
  }

  private isSettling(): boolean {
    return this.now() < this.settleUntil;
  }

  private settle(): void {
    this.settleUntil = this.now() + SETTLE_MS;
    this.baseline = null;
  }

  private seekIfOff(): void {
    const target = this.projected();
    if (Math.abs(this.player.getCurrentTime() - target) <= SYNC_TOLERANCE_S) return;
    this.settle();
    this.player.seekTo(target, true);
  }

  private broadcast(state: WatchPlaybackState, position: number, rate = this.expected?.rate ?? 1): void {
    const at = this.now();
    const playback: WatchPlayback = { state, position: Math.max(0, position), rate };
    this.expected = { ...playback, at };
    this.baseline = { time: playback.position, at };
    const last = this.lastSent;
    if (
      last &&
      at - last.at < DEDUPE_MS &&
      last.playback.state === state &&
      last.playback.rate === rate &&
      Math.abs(last.playback.position - playback.position) < SYNC_TOLERANCE_S
    ) {
      return;
    }
    this.lastSent = { playback, at };
    this.send(playback);
  }
}
