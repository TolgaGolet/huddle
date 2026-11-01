import { nanoid } from "nanoid";
import { isPollMessage } from "./protocol.js";
import { addChatMessage, type PollMessage } from "./roomManager.js";
import { onRoom, type AppServer } from "./socketRoute.js";
import { parsePollCreate, parsePollVote } from "./validation.js";

export function setupPolls(io: AppServer): void {
  io.on("connection", (socket) => {
    // The parser has already trimmed the question and options, dropped blank
    // options, and enforced 2..MAX_POLL_OPTIONS of them.
    onRoom(socket, "poll-create", parsePollCreate, ({ roomId, participant }, { question, options, allowMultiple }) => {
      const pollOptions = options.map((text) => ({
        id: nanoid(6),
        text,
        voterIds: [] as string[],
        voterNames: [] as string[],
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

      addChatMessage(roomId, poll);
      io.to(roomId).emit("poll-create", poll);
    });

    onRoom(socket, "poll-vote", parsePollVote, ({ roomId, room, participant }, { pollId, optionId }) => {
      const poll = room.chatHistory.find((m) => m.id === pollId);
      if (!poll || !isPollMessage(poll)) return;

      const option = poll.options.find((o) => o.id === optionId);
      if (!option) return;

      const { userId } = participant;
      const idx = option.voterIds.indexOf(userId);

      if (idx >= 0) {
        option.voterIds.splice(idx, 1);
        option.voterNames.splice(idx, 1);
      } else {
        if (!poll.allowMultiple) {
          for (const opt of poll.options) {
            const existIdx = opt.voterIds.indexOf(userId);
            if (existIdx >= 0) {
              opt.voterIds.splice(existIdx, 1);
              opt.voterNames.splice(existIdx, 1);
            }
          }
        }
        option.voterIds.push(userId);
        option.voterNames.push(participant.name);
      }

      io.to(roomId).emit("poll-update", poll);
    });
  });
}
