interface RoomEntry {
  roomId: string;
  password?: string;
  ownerToken?: string;
}

let entry: RoomEntry | null = null;

/**
 * What the next join into a room needs, held in memory and only until that join.
 * Never in router state, which browsers keep in history and can write to disk.
 * After joining, a reload or reconnect is proven by the client key instead.
 */
export function setRoomEntry(next: RoomEntry): void {
  entry = next;
}

export function roomEntryFor(roomId: string): Pick<RoomEntry, "password" | "ownerToken"> {
  if (entry?.roomId !== roomId) return {};
  return { password: entry.password, ownerToken: entry.ownerToken };
}

export function clearRoomEntry(): void {
  entry = null;
}
