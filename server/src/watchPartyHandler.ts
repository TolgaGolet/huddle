import { nanoid } from "nanoid";
import { WATCH_PARTY_GRACE_MS } from "./limits.js";
import { mayChangeWatchVideo, projectPosition, type WatchPartyState } from "./protocol.js";
import { maySendMessages } from "./chatHandler.js";
import {
  addChatMessage,
  emptyReactions,
  getRoom,
  onParticipantRemoved,
  onRoomDestroyed,
  touchRoom,
  type ChatMessage,
  type Room,
  type WatchParty,
} from "./roomManager.js";
import { onRoom, type AppServer } from "./socketRoute.js";
import { noPayload, parseWatchChangeVideo, parseWatchJoin, parseWatchPlayback, parseWatchStart } from "./validation.js";

/** The room's watch party as clients see it, with playback projected to `now`. */
export function watchPartyStateOf(room: Room, now = Date.now()): WatchPartyState | null {
  const party = room.watchParty;
  if (!party) return null;
  return {
    id: party.id,
    hostId: controllerOf(party),
    allowOthersToChange: party.allowOthersToChange,
    videoId: party.videoId,
    memberIds: [...new Set(party.members.values())],
    playback: { ...party.playback, position: projectPosition(party.playback, now - party.updatedAt) },
  };
}

/**
 * Who controls the video: the host while they're watching, otherwise the
 * longest-present member, or nobody could change it. A host who only lost
 * their connection gets it back by rejoining; one who leaves hands it on.
 */
function controllerOf(party: WatchParty): string {
  const memberIds = [...party.members.values()];
  return memberIds.length && !memberIds.includes(party.hostId) ? memberIds[0] : party.hostId;
}

/**
 * One watch party per room. The server holds the playback state and projects it
 * when sending, so a late joiner starts at the right second without trusting
 * anyone's clock. Members are sockets: a client that reconnects joins again.
 */
export function setupWatchParty(io: AppServer): void {
  // Parties whose members all lost their connection, waiting for one to come back.
  const endTimers = new Map<string, NodeJS.Timeout>();

  function cancelEnd(roomId: string): void {
    clearTimeout(endTimers.get(roomId));
    endTimers.delete(roomId);
  }

  const announce = (room: Room) => io.to(room.id).emit("watch-party", watchPartyStateOf(room));

  function end(room: Room): void {
    cancelEnd(room.id);
    room.watchParty = null;
    announce(room);
  }

  function endWhenNobodyReturns(room: Room, partyId: string): void {
    cancelEnd(room.id);
    const roomId = room.id;
    const timer = setTimeout(() => {
      endTimers.delete(roomId);
      const current = getRoom(roomId);
      if (current?.watchParty?.id === partyId && current.watchParty.members.size === 0) end(current);
    }, WATCH_PARTY_GRACE_MS).unref();
    endTimers.set(roomId, timer);
  }

  /** `deliberate`: they left the party or the room on purpose (or were kicked), rather than losing their connection. */
  function removeMember(room: Room, socketId: string, deliberate: boolean): void {
    const party = room.watchParty;
    const userId = party?.members.get(socketId);
    if (!party || userId === undefined) return;
    party.members.delete(socketId);
    if (party.members.size === 0) {
      if (deliberate) {
        end(room);
        return;
      }
      endWhenNobodyReturns(room, party.id);
    } else if (deliberate && userId === party.hostId) {
      party.hostId = controllerOf(party);
    }
    announce(room);
  }

  onParticipantRemoved(removeMember);
  onRoomDestroyed(cancelEnd);

  io.on("connection", (socket) => {
    onRoom(socket, "watch-start", parseWatchStart, (ctx, { videoId, allowOthersToChange }) => {
      if (!maySendMessages(socket, ctx, "watch-start")) return;
      const { roomId, room, participant } = ctx;
      if (room.watchParty) {
        socket.emit("watch-start-refused", { reason: "active" });
        return;
      }
      const now = Date.now();
      room.watchParty = {
        id: nanoid(10),
        hostId: participant.userId,
        allowOthersToChange,
        videoId,
        members: new Map([[socket.id, participant.userId]]),
        playback: { state: "playing", position: 0, rate: 1 },
        updatedAt: now,
      };
      const invite: ChatMessage = {
        id: nanoid(10),
        senderId: participant.userId,
        senderName: participant.name,
        text: "",
        timestamp: now,
        reactions: emptyReactions(),
        watchInvite: { partyId: room.watchParty.id, videoId },
      };
      addChatMessage(room, invite);
      touchRoom(room);
      // The party first, so the invite's card can show it as soon as it arrives.
      announce(room);
      io.to(roomId).emit("chat-message", invite);
    });

    onRoom(socket, "watch-join", parseWatchJoin, ({ room, participant }, { partyId }) => {
      const party = room.watchParty;
      if (!party || party.id !== partyId || party.members.has(socket.id)) return;
      cancelEnd(room.id);
      party.members.set(socket.id, participant.userId);
      touchRoom(room);
      announce(room);
      // Their copy of the party may be old: playback goes only to members, and a
      // reconnect misses some. The party state above can't be applied by a member
      // (see WatchPartyPanel), so the joiner gets the playback on its own.
      const { playback } = watchPartyStateOf(room)!;
      socket.emit("watch-playback", playback);
    });

    onRoom(socket, "watch-leave", noPayload, ({ room }) => removeMember(room, socket.id, true));

    onRoom(socket, "watch-change-video", parseWatchChangeVideo, ({ room, participant }, { videoId }) => {
      const party = room.watchParty;
      if (!party?.members.has(socket.id)) return;
      if (!mayChangeWatchVideo({ hostId: controllerOf(party), allowOthersToChange: party.allowOthersToChange }, participant.userId)) return;
      party.videoId = videoId;
      party.playback = { state: "playing", position: 0, rate: 1 };
      party.updatedAt = Date.now();
      touchRoom(room);
      announce(room);
    });

    onRoom(socket, "watch-playback", parseWatchPlayback, ({ room }, { videoId, ...playback }) => {
      const party = room.watchParty;
      // A report about the previous video, sent before its sender heard of the change.
      if (!party?.members.has(socket.id) || party.videoId !== videoId) return;
      party.playback = playback;
      party.updatedAt = Date.now();
      touchRoom(room);
      const others = [...party.members.keys()].filter((id) => id !== socket.id);
      // Never an empty list: io.to([]) would send to every socket on the server.
      if (others.length) io.to(others).emit("watch-playback", playback);
    });
  });
}
