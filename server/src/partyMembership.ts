import { nanoid } from "nanoid";
import {
  emptyReactions,
  getRoom,
  onParticipantRemoved,
  onRoomDestroyed,
  type ChatMessage,
  type Participant,
  type Room,
} from "./roomManager.js";
import type { AppServer } from "./socketRoute.js";

export type PartyKind = "watch" | "game";

/** What every kind of party keeps about its members. */
export interface PartyMembers {
  id: string;
  hostId: string;
  /** socket.id -> userId, in the order they joined. A member who reconnects joins again. */
  members: Map<string, string>;
}

/**
 * The host while they're in the party, otherwise the longest-present member. A
 * host who only lost their connection is host again on rejoining; one who
 * leaves on purpose hands it on.
 */
export function hostOf(party: PartyMembers): string {
  const memberIds = [...party.members.values()];
  return memberIds.length && !memberIds.includes(party.hostId) ? memberIds[0] : party.hostId;
}

/** The party among `parties` the socket is in. */
export function partyWith<P extends PartyMembers>(parties: Map<string, P>, socketId: string): P | undefined {
  for (const party of parties.values()) if (party.members.has(socketId)) return party;
  return undefined;
}

/** The chat message announcing a new party, with its kind's invite field. */
export function partyInvite(
  participant: Participant,
  invite: Pick<ChatMessage, "watchInvite"> | Pick<ChatMessage, "gameInvite">,
  timestamp = Date.now(),
): ChatMessage {
  return {
    id: nanoid(10),
    senderId: participant.userId,
    senderName: participant.name,
    text: "",
    timestamp,
    reactions: emptyReactions(),
    ...invite,
  };
}

/**
 * Per server, each kind's way to take a socket out of its party on purpose,
 * announcing the change. Per server so a second one (as in tests) never
 * announces through another's.
 */
const leaversByServer = new WeakMap<AppServer, Map<PartyKind, (room: Room, socketId: string) => void>>();

interface PartyMembershipOptions<P extends PartyMembers> {
  io: AppServer;
  kind: PartyKind;
  partiesOf: (room: Room) => Map<string, P>;
  /** How long a party whose members all lost their connection waits for one to come back. */
  graceMs: number;
  /** Tells the room this kind's parties changed. */
  announce: (room: Room) => void;
}

/**
 * Membership shared by every kind of party: joining and leaving, host hand-off,
 * and ending a party once its last member is gone. A member is in one party at
 * most, of any kind: joining or starting one leaves the last.
 */
export function createPartyMembership<P extends PartyMembers>({
  io,
  kind,
  partiesOf,
  graceMs,
  announce,
}: PartyMembershipOptions<P>) {
  const leavers = leaversByServer.get(io) ?? new Map<PartyKind, (room: Room, socketId: string) => void>();
  leaversByServer.set(io, leavers);

  // Parties whose members all lost their connection, waiting for one to come back.
  const endTimers = new Map<string, { roomId: string; timer: NodeJS.Timeout }>();

  function cancelEnd(partyId: string): void {
    clearTimeout(endTimers.get(partyId)?.timer);
    endTimers.delete(partyId);
  }

  const partyOf = (room: Room, socketId: string): P | undefined => partyWith(partiesOf(room), socketId);

  /** Removes the party without announcing it; true if it existed. */
  function drop(room: Room, partyId: string): boolean {
    cancelEnd(partyId);
    return partiesOf(room).delete(partyId);
  }

  function end(room: Room, partyId: string): void {
    if (drop(room, partyId)) announce(room);
  }

  function endWhenNobodyReturns(room: Room, partyId: string): void {
    cancelEnd(partyId);
    const roomId = room.id;
    const timer = setTimeout(() => {
      endTimers.delete(partyId);
      const current = getRoom(roomId);
      if (current && partiesOf(current).get(partyId)?.members.size === 0) end(current, partyId);
    }, graceMs).unref();
    endTimers.set(partyId, { roomId, timer });
  }

  /**
   * Takes the socket out of its party without announcing it; true if it was in one.
   * `deliberate`: they left the party or the room on purpose (or were kicked), rather than losing their connection.
   */
  function leaveParty(room: Room, socketId: string, deliberate: boolean): boolean {
    const party = partyOf(room, socketId);
    const userId = party?.members.get(socketId);
    if (!party || userId === undefined) return false;
    party.members.delete(socketId);
    if (party.members.size === 0) {
      if (deliberate) drop(room, party.id);
      else endWhenNobodyReturns(room, party.id);
    } else if (deliberate && userId === party.hostId) {
      party.hostId = hostOf(party);
    }
    return true;
  }

  function removeMember(room: Room, socketId: string, deliberate: boolean): void {
    if (leaveParty(room, socketId, deliberate)) announce(room);
  }

  /**
   * Before starting or joining a party of this kind: leaves the socket's party of
   * any kind. Other kinds announce it; this kind's caller announces once after.
   */
  function leaveCurrent(room: Room, socketId: string): void {
    for (const [other, leave] of leavers) if (other !== kind) leave(room, socketId);
    leaveParty(room, socketId, true);
  }

  /** Moves the socket into `party`, without announcing it. */
  function join(room: Room, party: P, socketId: string, userId: string): void {
    leaveCurrent(room, socketId);
    cancelEnd(party.id);
    party.members.set(socketId, userId);
  }

  leavers.set(kind, (room, socketId) => removeMember(room, socketId, true));
  onParticipantRemoved(removeMember);
  onRoomDestroyed((roomId) => {
    for (const [partyId, pending] of endTimers) if (pending.roomId === roomId) cancelEnd(partyId);
  });

  return { partyOf, end, removeMember, leaveCurrent, join };
}
