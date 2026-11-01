export interface RoomInfo {
  exists: boolean;
  hasPassword: boolean;
  participantCount: number;
  maxParticipants: number;
}

/** A missing room is a normal answer; `error` means the lookup itself failed (e.g. a 429). */
export async function lookupRoom(roomId: string): Promise<RoomInfo | { error: string }> {
  const res = await fetch(`/api/rooms/${roomId}`);
  const data = await res.json();
  if (!res.ok) return { error: data.error || "Failed to connect. Please try again." };
  return data as RoomInfo;
}
