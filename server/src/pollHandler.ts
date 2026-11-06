import { nanoid } from "nanoid";
import { hasVotedInPoll, isPollMessage, isPollOpen } from "./protocol.js";
import { maySendMessages } from "./chatHandler.js";
import { addChatMessage, findEntry, getRoom, onMessageRemoved, onRoomDestroyed, touchRoom, type PollMessage, type PollOption, type Room } from "./roomManager.js";
import { onRoom, type AppServer } from "./socketRoute.js";
import { parsePollCreate, parsePollSubmit, parsePollVote } from "./validation.js";

/** True if the user had voted for this option. */
function removeVote(option: PollOption, userId: string): boolean {
  const idx = option.voters.findIndex((v) => v.userId === userId);
  if (idx < 0) return false;
  option.voters.splice(idx, 1);
  return true;
}

/** A poll that still exists and takes votes now. */
function openPoll(room: Room, pollId: string): PollMessage | null {
  const poll = findEntry(room, pollId);
  return poll && isPollMessage(poll) && isPollOpen(poll, Date.now()) ? poll : null;
}

export function setupPolls(io: AppServer): void {
  // Pending close timers by room, then poll, so a poll that's deleted, falls
  // out of the history or loses its room doesn't keep a timer for hours.
  const closeTimers = new Map<string, Map<string, NodeJS.Timeout>>();

  function forgetTimer(roomId: string, pollId: string): void {
    const timers = closeTimers.get(roomId);
    clearTimeout(timers?.get(pollId));
    timers?.delete(pollId);
    if (timers?.size === 0) closeTimers.delete(roomId);
  }

  onMessageRemoved((room, entry) => forgetTimer(room.id, entry.id));
  onRoomDestroyed((roomId) => {
    for (const timer of closeTimers.get(roomId)?.values() ?? []) clearTimeout(timer);
    closeTimers.delete(roomId);
  });

  /**
   * Tells the room a poll has ended. Votes are already refused by `endsAt`
   * (isPollOpen); this tells clients when to stop offering them, so they
   * needn't trust their own clocks.
   */
  function closeWhenDue(roomId: string, pollId: string, durationMs: number): void {
    const timer = setTimeout(() => {
      forgetTimer(roomId, pollId);
      const room = getRoom(roomId);
      const poll = room && findEntry(room, pollId);
      if (!poll || !isPollMessage(poll) || poll.closed) return;
      poll.closed = true;
      io.to(roomId).emit("poll-update", poll);
    }, durationMs).unref();
    const timers = closeTimers.get(roomId) ?? new Map<string, NodeJS.Timeout>();
    timers.set(pollId, timer);
    closeTimers.set(roomId, timers);
  }

  io.on("connection", (socket) => {
    // The parser has already trimmed the question and options, dropped blank
    // options, enforced 2..MAX_POLL_OPTIONS of them and checked durationMs.
    onRoom(socket, "poll-create", parsePollCreate, (ctx, { question, options, allowMultiple, lockVotes, durationMs }) => {
      if (!maySendMessages(socket, ctx, "poll-create")) return;
      const { roomId, room, participant } = ctx;
      const pollOptions = options.map((text) => ({
        id: nanoid(6),
        text,
        voters: [],
      }));

      const timestamp = Date.now();
      const poll: PollMessage = {
        id: nanoid(10),
        type: "poll",
        senderId: participant.userId,
        senderName: participant.name,
        question,
        options: pollOptions,
        allowMultiple,
        lockVotes,
        timestamp,
      };
      if (durationMs !== undefined) {
        poll.endsAt = timestamp + durationMs;
        closeWhenDue(roomId, poll.id, durationMs);
      }

      addChatMessage(room, poll);
      touchRoom(room);
      io.to(roomId).emit("poll-create", poll);
    });

    onRoom(socket, "poll-vote", parsePollVote, ({ roomId, room, participant }, { pollId, optionId }) => {
      const poll = openPoll(room, pollId);
      // A locked poll takes votes only all at once, through poll-submit.
      if (!poll || poll.lockVotes) return;

      const option = poll.options.find((o) => o.id === optionId);
      if (!option) return;

      touchRoom(room);
      const { userId, name } = participant;
      if (!removeVote(option, userId)) {
        if (!poll.allowMultiple) poll.options.forEach((o) => removeVote(o, userId));
        option.voters.push({ userId, name });
      }

      io.to(roomId).emit("poll-update", poll);
    });

    onRoom(socket, "poll-submit", parsePollSubmit, ({ roomId, room, participant }, { pollId, optionIds }) => {
      const poll = openPoll(room, pollId);
      if (!poll || !poll.lockVotes || hasVotedInPoll(poll, participant.userId)) return;
      if (!poll.allowMultiple && optionIds.length !== 1) return;
      // The parser made the ids distinct, so a count mismatch means an unknown one.
      const chosen = poll.options.filter((o) => optionIds.includes(o.id));
      if (chosen.length !== optionIds.length) return;

      touchRoom(room);
      const { userId, name } = participant;
      for (const option of chosen) option.voters.push({ userId, name });

      io.to(roomId).emit("poll-update", poll);
    });
  });
}
