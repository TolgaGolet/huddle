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
/**
 * How long a play is taken for ours while the party is paused. YouTube's seekTo
 * starts any player that isn't paused, and loading a video starts it too, after
 * however long the video takes to load. Ends sooner, once the player pauses.
 */
const HOLD_PAUSED_MS = 15_000;
/** A play is confirmed once the player's time has moved this far past where it was reported. */
const PLAY_CONFIRM_S = 0.1;

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
 *
 * A member who may not control the party broadcasts nothing: whatever they do
 * to the player (a media key, picture-in-picture controls) is undone locally.
 */
export class WatchSync {
  private expected: Expected | null = null;
  /** The last time sample, for telling seeks from playback. */
  private baseline: { time: number; at: number } | null = null;
  private settleUntil = 0;
  private lastSent: { playback: WatchPlayback; at: number } | null = null;
  private canControl = true;
  /** See HOLD_PAUSED_MS. */
  private holdPausedUntil = 0;
  /**
   * A PLAYING report while the party is paused, waiting for the next tick to
   * show the video really plays. YouTube also reports PLAYING while it fetches
   * the frame for a seek made while paused (the arrow keys), and may then stay
   * paused without reporting PAUSED. Announced at once, that started the party
   * for everyone else while this player stayed paused.
   */
  private pendingPlay: { time: number } | null = null;
  /** Called when the player reaches the end of the video. */
  onEnded: (() => void) | null = null;

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

  /** False for a member who may only watch: see the class comment. */
  setCanControl(canControl: boolean): void {
    this.canControl = canControl;
  }

  /** The party's state, from the server: move the player there. */
  applyRemote(playback: WatchPlayback): void {
    this.expected = { ...playback, at: this.now() };
    this.enforce();
  }

  /** Moves the player to where the party is. */
  private enforce(): void {
    const playback = this.expected;
    if (!playback) return;
    this.settle();
    const { player } = this;
    // A player that isn't paused yet will start by itself (a seek, a load): ours, so it gets paused.
    const before = player.getPlayerState();
    this.holdPausedUntil = playback.state === "paused" && before !== YT_STATE.PAUSED ? this.now() + HOLD_PAUSED_MS : 0;
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
    if (state !== YT_STATE.PLAYING && state !== YT_STATE.BUFFERING) this.pendingPlay = null;
    if (state === YT_STATE.ENDED) {
      // Only the end is reported: the server plays what's next, or pauses the
      // party if nothing is. A pause broadcast here could reach it after the
      // next video started, and ending a little early is no reason to restart.
      this.onEnded?.();
      return;
    }
    if (state === YT_STATE.PAUSED) this.holdPausedUntil = 0;
    if (this.pauseIfHeld(state)) return;
    if (state === YT_STATE.PLAYING) {
      // Playing along with the party: catching up, never a change to announce.
      if (e.state === "playing") {
        this.seekIfOff();
        return;
      }
      if (this.isSettling()) return;
      // Confirmed by tick(), not announced on the report alone.
      this.pendingPlay ??= { time: this.player.getCurrentTime() };
    } else if (state === YT_STATE.PAUSED) {
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
    if (!e) return;
    const state = player.getPlayerState();
    // Also while settling: the start a seek caused can come at any time.
    if (this.pauseIfHeld(state)) return;
    if (this.isSettling()) return;
    if (this.confirmPlay(state)) return;
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

  /** Announces a pending play once the video really plays; drops it if the player stopped. True if announced. */
  private confirmPlay(state: number): boolean {
    const pending = this.pendingPlay;
    if (!pending) return false;
    if (this.expected?.state !== "paused" || (state !== YT_STATE.PLAYING && state !== YT_STATE.BUFFERING)) {
      this.pendingPlay = null;
      return false;
    }
    const time = this.player.getCurrentTime();
    // Still buffering, or not moving yet: wait for the next tick.
    if (state !== YT_STATE.PLAYING || time < pending.time + PLAY_CONFIRM_S) return false;
    this.pendingPlay = null;
    this.broadcast("playing", time);
    return true;
  }

  /** Pauses a player that started by itself while the party is paused (see HOLD_PAUSED_MS). True if it did. */
  private pauseIfHeld(state: number): boolean {
    if (this.expected?.state !== "paused" || this.now() >= this.holdPausedUntil) return false;
    if (state !== YT_STATE.PLAYING && state !== YT_STATE.BUFFERING) return false;
    this.settle();
    this.player.pauseVideo();
    return true;
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
    this.pendingPlay = null;
    if (!this.canControl) {
      this.enforce();
      return;
    }
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
