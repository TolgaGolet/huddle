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
/** The only lengths a poll can run for; a poll without one stays open. Well inside MAX_ROOM_LIFETIME_MS. */
export const POLL_DURATIONS_MS: readonly number[] = [1, 5, 15, 30, 60, 180].map((minutes) => minutes * 60_000);
/** Furthest a watch party's playback position can be, in seconds; well past any real video. */
export const MAX_WATCH_POSITION_S = 24 * 60 * 60;
/** The playback speeds YouTube offers, the only ones a watch party accepts. */
export const WATCH_RATES: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
/** How long a watch party whose members all lost their connection waits for one to come back. */
export const WATCH_PARTY_GRACE_MS = 60_000;
/** Watch parties running in one room at once. Each member is in one party at most. */
export const MAX_WATCH_PARTIES = 2;
/** Videos waiting in one watch party's queue, which is sent with every party state. */
export const MAX_WATCH_QUEUE = 50;
/** Game parties running in one room at once. Each member is in one party at most, of either kind. */
export const MAX_GAME_PARTIES = 2;
/** How long a game party whose members all lost their connection waits for one to come back. */
export const GAME_PARTY_GRACE_MS = 60_000;
export const MAX_YOUTUBE_QUERY_LENGTH = 100;
export const MAX_IMAGES_PER_MESSAGE = 10;
export const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"]);
/**
 * A first filter only, as the name and type are the sender's claim. The server
 * decodes every image, which is the real check (imageProcessing.ts).
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
/** One client's share of that. Must fit one maximum upload. */
export const MAX_CLIENT_INFLIGHT_IMAGE_BYTES = 84 * 1024 * 1024;
/** However active it is, a room closes this long after it was created. */
export const MAX_ROOM_LIFETIME_MS = 10 * 60 * 60 * 1000;
/** A room closes this long after anyone last spoke, wrote or shared their screen. */
export const ROOM_INACTIVE_MS = 31 * 60 * 1000;
/** How long before each kind of closing its members are warned. */
export const INACTIVE_WARNING_MS = 10 * 60 * 1000;
export const LIFETIME_WARNING_MS = 30 * 60 * 1000;
/** People in one room's waiting room at once. */
export const MAX_WAITING_PER_ROOM = 10;
/** Identities a room remembers as having got in, so that they can return without the password. */
export const MAX_REMEMBERED_MEMBERS = 200;
export const MAX_PASSWORD_LENGTH = 128;
export const MIN_PASSWORD_LENGTH = 8;
/**
 * For a new room: empty means no password, while only spaces is refused, as its
 * creator clearly wanted a password and would otherwise get an open room.
 */
export function isValidNewPassword(password: string): boolean {
  const { length } = password.trim();
  return password === "" || (length >= MIN_PASSWORD_LENGTH && length <= MAX_PASSWORD_LENGTH);
}
/** Open connections per IP. Above what a shared network needs, as a socket costs about 36 KB even idle. */
export const MAX_CONNECTIONS_PER_IP = 30;
/** Open connections in total, so that idle ones can't exhaust the 512 MB instance. */
export const MAX_CONNECTIONS_TOTAL = 3000;
/** Format of the secret key a client proves its identity with (see identity.ts). */
export const CLIENT_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
