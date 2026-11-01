// Stable codes for join-room failures, shared by both builds like limits.ts
// (client/src/types/index.ts re-exports this file). Clients branch on the code;
// the message beside it is display text and free to change. Keep this file free
// of imports so the client can compile it.

export const JOIN_ERROR = {
  ROOM_NOT_FOUND: "ROOM_NOT_FOUND",
  INCORRECT_PASSWORD: "INCORRECT_PASSWORD",
  NAME_TAKEN: "NAME_TAKEN",
  ROOM_FULL: "ROOM_FULL",
  INVALID_JOIN: "INVALID_JOIN",
} as const;

export type JoinErrorCode = (typeof JOIN_ERROR)[keyof typeof JOIN_ERROR];
