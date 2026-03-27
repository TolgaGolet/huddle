import type { Server, Socket } from "socket.io";
import { nanoid } from "nanoid";
import { addChatMessage, getRoom, type PollMessage } from "./roomManager.js";
import { socketRoomMap } from "./signaling.js";

interface IncomingPollCreate {
  question: string;
  options: string[];
  allowMultiple: boolean;
}

export function setupPolls(io: Server): void {
  io.on("connection", (socket: Socket) => {
    socket.on("poll-create", ({ question, options, allowMultiple }: IncomingPollCreate) => {
      const roomId = socketRoomMap.get(socket.id);
      if (!roomId) return;

      const room = getRoom(roomId);
      if (!room) return;

      const participant = room.participants.get(socket.id);
      if (!participant) return;

      const trimmedQ = question.trim();
      if (!trimmedQ || !options || options.length < 2) return;

      const pollOptions = options
        .map((o) => o.trim())
        .filter(Boolean)
        .slice(0, 10)
        .map((text) => ({
          id: nanoid(6),
          text,
          voterIds: [] as string[],
          voterNames: [] as string[],
        }));

      if (pollOptions.length < 2) return;

      const poll: PollMessage = {
        id: nanoid(10),
        type: "poll",
        senderId: socket.id,
        senderName: participant.name,
        question: trimmedQ,
        options: pollOptions,
        allowMultiple: !!allowMultiple,
        timestamp: Date.now(),
      };

      addChatMessage(roomId, poll);
      io.to(roomId).emit("poll-create", poll);
    });

    socket.on("poll-vote", ({ pollId, optionId }: { pollId: string; optionId: string }) => {
      const roomId = socketRoomMap.get(socket.id);
      if (!roomId) return;

      const room = getRoom(roomId);
      if (!room) return;

      const participant = room.participants.get(socket.id);
      if (!participant) return;

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
