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

/** Chat entries kept per room; older ones are dropped on both sides. */
export const MAX_CHAT_HISTORY = 200;

export const MAX_NAME_LENGTH = 32;
export const MAX_CHAT_TEXT_LENGTH = 4000;
export const MAX_POLL_QUESTION_LENGTH = 200;
export const MAX_POLL_OPTION_LENGTH = 100;
export const MAX_POLL_OPTIONS = 10;
export const MAX_IMAGES_PER_MESSAGE = 10;
export const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif"]);
/**
 * The extension is the authoritative check: some browsers report an empty or
 * non-standard MIME type for HEIC files.
 */
export function isAllowedImage(extension: string, mimeType: string): boolean {
  return IMAGE_EXTENSIONS.has(extension) && (!mimeType || mimeType.startsWith("image/") || mimeType === "application/octet-stream");
}
export const MAX_ROOM_IMAGE_BYTES = 200 * 1024 * 1024;
/** Stored or reserved image bytes across all rooms, so a few busy rooms can't fill the disk. */
export const MAX_TOTAL_IMAGE_BYTES = 2 * 1024 * 1024 * 1024;
/** Live rooms. At about 0.8 MB of chat history each, the worst case still fits the 384 MB heap. */
export const MAX_ROOMS = 200;
/** Live rooms one IP can have created, so it can't hold all of MAX_ROOMS and lock everyone out. */
export const MAX_ROOMS_PER_IP = 10;
/**
 * Image bytes held in memory at once across all rooms: upload bodies, which
 * multer buffers, plus decrypting reads. Must fit one maximum upload.
 */
export const MAX_INFLIGHT_IMAGE_BYTES = 128 * 1024 * 1024;
/** One room's share of that for decrypting reads, so it can't starve other rooms. */
export const MAX_ROOM_INFLIGHT_READ_BYTES = MAX_INFLIGHT_IMAGE_BYTES / 2;
export const MAX_PASSWORD_LENGTH = 128;
/** Format of the secret key a client proves its identity with (see identity.ts). */
export const CLIENT_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
