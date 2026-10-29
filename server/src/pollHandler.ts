import type { Server, Socket } from "socket.io";
import { nanoid } from "nanoid";
import { addChatMessage, type PollMessage } from "./roomManager.js";
import { onRoom } from "./socketRoute.js";
import { parsePollCreate, parsePollVote } from "./validation.js";

export function setupPolls(io: Server): void {
  io.on("connection", (socket: Socket) => {
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
        senderId: socket.id,
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
      const entry = room.chatHistory.find((m) => m.id === pollId);
      if (!entry || !("type" in entry) || entry.type !== "poll") return;

      const poll = entry as PollMessage;
      const option = poll.options.find((o) => o.id === optionId);
      if (!option) return;

      const alreadyVoted = option.voterIds.includes(socket.id);

      if (alreadyVoted) {
        const idx = option.voterIds.indexOf(socket.id);
        option.voterIds.splice(idx, 1);
        option.voterNames.splice(idx, 1);
      } else {
        if (!poll.allowMultiple) {
          for (const opt of poll.options) {
            const existIdx = opt.voterIds.indexOf(socket.id);
            if (existIdx >= 0) {
              opt.voterIds.splice(existIdx, 1);
              opt.voterNames.splice(existIdx, 1);
            }
          }
        }
        option.voterIds.push(socket.id);
        option.voterNames.push(participant.name);
      }

      io.to(roomId).emit("poll-update", poll);
    });
  });
}
