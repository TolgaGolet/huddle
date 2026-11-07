import { nanoid } from "nanoid";
import { MAX_WATCH_PARTIES, MAX_WATCH_QUEUE, WATCH_PARTY_GRACE_MS } from "./limits.js";
import { mayControlWatchParty, partiesBesidesNew, projectPosition, type WatchPartyState } from "./protocol.js";
import { maySendMessages } from "./chatHandler.js";
import { createPartyMembership, hostOf, partyInvite, partyWith } from "./partyMembership.js";
import { ownerOnly } from "./roomModeration.js";
import { addChatMessage, getRoom, onRoomDestroyed, touchRoom, type Room, type RoomCtx, type WatchParty } from "./roomManager.js";
import { onRoom, type AppServer } from "./socketRoute.js";
import {
  noPayload,
  parseWatchChangeVideo,
  parseWatchEnd,
  parseWatchEntry,
  parseWatchJoin,
  parseWatchPlayback,
  parseWatchQueueAdd,
  parseWatchQueueMove,
  parseWatchStart,
} from "./validation.js";
import { lookupVideoTitle } from "./youtubeData.js";

/** Who controls the video: the party's host (hostOf), so there is always someone who can change it. */
const controllerOf = hostOf;

function projectedPlayback(party: WatchParty, now: number): WatchPartyState["playback"] {
  return { ...party.playback, position: projectPosition(party.playback, now - party.updatedAt) };
}

function stateOf(party: WatchParty, now: number): WatchPartyState {
  return {
    id: party.id,
    hostId: controllerOf(party),
    allowOthersToChange: party.allowOthersToChange,
    videoId: party.videoId,
    entryId: party.entryId,
    title: party.title,
    memberIds: [...new Set(party.members.values())],
    playback: projectedPlayback(party, now),
    queue: party.queue.map((entry) => ({ ...entry })),
  };
}

/** The room's watch parties as clients see them, with playback projected to `now`. */
export function watchPartiesOf(room: Room, now = Date.now()): WatchPartyState[] {
  return [...room.watchParties.values()].map((party) => stateOf(party, now));
}

function permitted(party: WatchParty, userId: string): boolean {
  return mayControlWatchParty({ hostId: controllerOf(party), allowOthersToChange: party.allowOthersToChange }, userId);
}

/** The party this socket is in, if its user may control it: for search, which only they can use. */
export function controlledPartyOf(room: Room, socketId: string, userId: string): WatchParty | undefined {
  const party = partyWith(room.watchParties, socketId);
  return party && permitted(party, userId) ? party : undefined;
}

/** How long titles wait to be announced together (see announceSoon). */
const TITLE_ANNOUNCE_DELAY_MS = 250;

/** Finds a queued entry and takes it out of the queue. */
function takeQueued(party: WatchParty, entryId: string): WatchParty["queue"][number] | undefined {
  const index = party.queue.findIndex((entry) => entry.id === entryId);
  return index < 0 ? undefined : party.queue.splice(index, 1)[0];
}

interface WatchPartyOptions {
  /** Injected by tests, which mustn't reach YouTube. Must never reject. */
  lookupTitle?: (videoId: string) => Promise<string | null>;
}

/**
 * Up to MAX_WATCH_PARTIES per room, with membership shared with game parties
 * (partyMembership.ts). The server
 * holds each party's playback and projects it when sending, so a late joiner
 * starts at the right second without trusting anyone's clock. Members are
 * sockets: a client that reconnects joins again.
 */
export function setupWatchParty(io: AppServer, { lookupTitle = lookupVideoTitle }: WatchPartyOptions = {}): void {
  // Rooms with a title waiting to be announced (see announceSoon).
  const pendingAnnounces = new Map<string, NodeJS.Timeout>();

  function announce(room: Room): void {
    // This carries any title waiting for announceSoon too.
    clearTimeout(pendingAnnounces.get(room.id));
    pendingAnnounces.delete(room.id);
    io.to(room.id).emit("watch-parties", watchPartiesOf(room));
  }

  /**
   * Announces within TITLE_ANNOUNCE_DELAY_MS, once for any number of calls:
   * for titles, which arrive one lookup at a time (a burst of queued videos)
   * and are worth a broadcast of every party to the room only together.
   */
  function announceSoon(room: Room): void {
    if (pendingAnnounces.has(room.id)) return;
    const roomId = room.id;
    const timer = setTimeout(() => {
      pendingAnnounces.delete(roomId);
      const current = getRoom(roomId);
      if (current) announce(current);
    }, TITLE_ANNOUNCE_DELAY_MS).unref();
    pendingAnnounces.set(roomId, timer);
  }

  const { partyOf, end, removeMember, leaveCurrent, join } = createPartyMembership({
    io,
    kind: "watch",
    partiesOf: (room) => room.watchParties,
    graceMs: WATCH_PARTY_GRACE_MS,
    announce,
  });

  /** Records a change made by a member and tells the room. */
  function changed(room: Room): void {
    touchRoom(room);
    announce(room);
  }
  /** Fills in a title once YouTube gives it, if the video it's for is still there. */
  function fillTitle(roomId: string, partyId: string, entryId: string, videoId: string): void {
    void lookupTitle(videoId)
      .then((title) => {
        const room = getRoom(roomId);
        const party = room?.watchParties.get(partyId);
        if (!room || !party || !title) return;
        const queued = party.queue.find((entry) => entry.id === entryId);
        if (party.entryId === entryId) party.title = title;
        else if (queued) queued.title = title;
        else return;
        announceSoon(room);
      })
      // lookupTitle never rejects, but a rejection here would exit the process.
      .catch(() => {});
  }

  /** Starts `videoId` from 0. A known title saves a lookup. */
  function play(room: Room, party: WatchParty, videoId: string, title: string | null = null): void {
    party.videoId = videoId;
    party.entryId = nanoid(10);
    party.title = title;
    party.playback = { state: "playing", position: 0, rate: 1 };
    party.updatedAt = Date.now();
    party.endedBy.clear();
    if (!title) fillTitle(room.id, party.id, party.entryId, videoId);
  }

  /** The video ended: plays the next queued one, or pauses the party at the end if there is none. */
  function finishEntry(room: Room, party: WatchParty): void {
    const next = party.queue.shift();
    if (next) {
      play(room, party, next.videoId, next.title);
      changed(room);
      return;
    }
    if (party.playback.state === "paused") return;
    party.playback = { ...projectedPlayback(party, Date.now()), state: "paused" };
    party.updatedAt = Date.now();
    touchRoom(room);
    // Members apply a party state's playback only for a new entry, so they're told directly.
    io.to([...party.members.keys()]).emit("watch-playback", { ...party.playback, entryId: party.entryId });
  }

  onRoomDestroyed((roomId) => {
    clearTimeout(pendingAnnounces.get(roomId));
    pendingAnnounces.delete(roomId);
  });

  io.on("connection", (socket) => {
    onRoom(socket, "watch-start", parseWatchStart, (ctx, { videoId, allowOthersToChange }) => {
      if (!maySendMessages(socket, ctx, "watch-start")) return;
      const { roomId, room, participant } = ctx;
      const alone = partyOf(room, socket.id)?.members.size === 1;
      if (partiesBesidesNew(room.watchParties.size, alone) >= MAX_WATCH_PARTIES) {
        socket.emit("watch-start-refused", { reason: "limit", max: MAX_WATCH_PARTIES });
        return;
      }
      // One party per socket: starting one leaves the last (a watch party's is announced below).
      leaveCurrent(room, socket.id);
      const party: WatchParty = {
        id: nanoid(10),
        hostId: participant.userId,
        allowOthersToChange,
        members: new Map([[socket.id, participant.userId]]),
        queue: [],
        endedBy: new Set(),
        // Set by play().
        videoId,
        entryId: "",
        title: null,
        playback: { state: "playing", position: 0, rate: 1 },
        updatedAt: 0,
      };
      room.watchParties.set(party.id, party);
      play(room, party, videoId);
      const invite = partyInvite(participant, { watchInvite: { partyId: party.id, videoId } }, party.updatedAt);
      addChatMessage(room, invite);
      // The party first, so the invite's card can show it as soon as it arrives.
      changed(room);
      io.to(roomId).emit("chat-message", invite);
    });

    onRoom(socket, "watch-join", parseWatchJoin, ({ room, participant }, { partyId }) => {
      const party = room.watchParties.get(partyId);
      if (!party || party.members.has(socket.id)) return;
      join(room, party, socket.id, participant.userId);
      changed(room);
      // Their copy of the party may be old: playback goes only to members, and a
      // reconnect misses some. The party state above can't be applied by a member
      // (see WatchPartyPanel), so the joiner gets the playback on its own.
      socket.emit("watch-playback", { ...projectedPlayback(party, Date.now()), entryId: party.entryId });
    });

    onRoom(socket, "watch-leave", noPayload, ({ room }) => removeMember(room, socket.id, true));

    /** Runs `action` only for a party member who may control their party. */
    const controlling =
      <T>(action: (ctx: RoomCtx, party: WatchParty, data: T) => void) =>
      (ctx: RoomCtx, data: T) => {
        const party = controlledPartyOf(ctx.room, socket.id, ctx.participant.userId);
        if (party) action(ctx, party, data);
      };

    onRoom(socket, "watch-change-video", parseWatchChangeVideo, controlling(({ room }, party, { videoId }) => {
      play(room, party, videoId);
      changed(room);
    }));

    onRoom(socket, "watch-playback", parseWatchPlayback, controlling(({ room }, party, { entryId, ...playback }) => {
      // A report about the previous play, sent before its sender heard of the change, is
      // dropped. By entry, not video: the next one can be the same video again.
      if (party.entryId !== entryId) return;
      party.playback = playback;
      party.updatedAt = Date.now();
      touchRoom(room);
      const others = [...party.members.keys()].filter((id) => id !== socket.id);
      // Never an empty list: io.to([]) would send to every socket on the server.
      if (others.length) io.to(others).emit("watch-playback", { ...playback, entryId: party.entryId });
    }));

    onRoom(socket, "watch-queue-add", parseWatchQueueAdd, controlling(({ room, participant }, party, { videoId }) => {
      if (party.queue.length >= MAX_WATCH_QUEUE) return;
      const entry = { id: nanoid(10), videoId, title: null, addedBy: participant.userId };
      party.queue.push(entry);
      fillTitle(room.id, party.id, entry.id, videoId);
      changed(room);
    }));

    onRoom(socket, "watch-queue-remove", parseWatchEntry, controlling(({ room }, party, { entryId }) => {
      if (takeQueued(party, entryId)) changed(room);
    }));

    onRoom(socket, "watch-queue-play", parseWatchEntry, controlling(({ room }, party, { entryId }) => {
      const entry = takeQueued(party, entryId);
      if (!entry) return;
      play(room, party, entry.videoId, entry.title);
      changed(room);
    }));

    onRoom(socket, "watch-queue-move", parseWatchQueueMove, controlling(({ room }, party, { entryId, toIndex }) => {
      const entry = takeQueued(party, entryId);
      if (!entry) return;
      party.queue.splice(Math.min(toIndex, party.queue.length), 0, entry);
      changed(room);
    }));

    onRoom(socket, "watch-ended", parseWatchEntry, ({ room, participant }, { entryId }) => {
      const party = partyOf(room, socket.id);
      // Each member's player reports the end: the first that counts moves on,
      // and the rest name a video that is no longer playing.
      if (!party || party.entryId !== entryId) return;
      if (permitted(party, participant.userId)) {
        finishEntry(room, party);
        return;
      }
      // Without control, it takes every such member: so one can't skip videos
      // alone, but a controller whose player is stuck (blocked autoplay, an
      // error) doesn't hold the party on a finished video.
      if (party.playback.state !== "playing") return;
      party.endedBy.add(socket.id);
      const viewers = [...party.members].filter(([, userId]) => !permitted(party, userId));
      if (viewers.every(([socketId]) => party.endedBy.has(socketId))) finishEntry(room, party);
    });

    onRoom(socket, "watch-end", parseWatchEnd, ownerOnly(({ room }, { partyId }) => end(room, partyId)));
  });
}
