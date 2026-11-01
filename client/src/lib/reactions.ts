import type { ReactionUser } from "../types";

/** Whether the local user is among a reaction's users. */
export function hasReacted(users: ReactionUser[], localUserId: string): boolean {
  return users.some((u) => u.userId === localUserId);
}
