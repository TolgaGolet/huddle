import { nanoid } from "nanoid";
import { isPollMessage } from "./protocol.js";
import { maySendMessages } from "./chatHandler.js";
import { addChatMessage, findEntry, touchRoom, type PollMessage, type PollOption } from "./roomManager.js";
import { onRoom, type AppServer } from "./socketRoute.js";
import { parsePollCreate, parsePollVote } from "./validation.js";

/** True if the user had voted for this option. */
function removeVote(option: PollOption, userId: string): boolean {
  const idx = option.voters.findIndex((v) => v.userId === userId);
  if (idx < 0) return false;
  option.voters.splice(idx, 1);
  return true;
}

export function setupPolls(io: AppServer): void {
  io.on("connection", (socket) => {
    // The parser has already trimmed the question and options, dropped blank
    // options, and enforced 2..MAX_POLL_OPTIONS of them.
    onRoom(socket, "poll-create", parsePollCreate, (ctx, { question, options, allowMultiple }) => {
      if (!maySendMessages(socket, ctx, "poll-create")) return;
      const { roomId, room, participant } = ctx;
      const pollOptions = options.map((text) => ({
        id: nanoid(6),
        text,
        voters: [],
      }));

      const poll: PollMessage = {
        id: nanoid(10),
        type: "poll",
        senderId: participant.userId,
        senderName: participant.name,
        question,
        options: pollOptions,
        allowMultiple,
        timestamp: Date.now(),
      };

      addChatMessage(room, poll);
      touchRoom(room);
      io.to(roomId).emit("poll-create", poll);
    });

    onRoom(socket, "poll-vote", parsePollVote, ({ roomId, room, participant }, { pollId, optionId }) => {
      const poll = findEntry(room, pollId);
      if (!poll || !isPollMessage(poll)) return;

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
  });
}
