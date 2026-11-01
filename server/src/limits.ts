// User-facing input limits, shared by both builds: the server's parsers
// (validation.ts) enforce them and the client imports this file directly
// (client/src/types/index.ts re-exports it), so the two sides cannot drift.
// Input over a limit is rejected rather than truncated. Keep this file free of
// imports so the client can compile it.

/**
 * Maximum participants per room. Huddle uses a peer-to-peer mesh topology, so
 * this cap keeps calls reliable on typical consumer hardware/connections.
 */
export const MAX_PARTICIPANTS = 6;

export const MAX_NAME_LENGTH = 32;
export const MAX_CHAT_TEXT_LENGTH = 4000;
export const MAX_POLL_QUESTION_LENGTH = 200;
export const MAX_POLL_OPTION_LENGTH = 100;
export const MAX_POLL_OPTIONS = 10;
export const MAX_IMAGES_PER_MESSAGE = 10;
export const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
export const MAX_ROOM_IMAGE_BYTES = 200 * 1024 * 1024;
/** Upload bodies held in memory at once across all rooms; multer buffers them. */
export const MAX_INFLIGHT_UPLOAD_BYTES = 512 * 1024 * 1024;
export const MAX_PASSWORD_LENGTH = 128;
/** Format of the secret key a client proves its identity with (see identity.ts). */
export const CLIENT_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
