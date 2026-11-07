import type { GameInfo } from "./protocol.js";

/** Used when RAGAMUFFIN_URL isn't set. */
const DEFAULT_RAGAMUFFIN_URL = "https://ragamuffin.infinityfreeapp.com/";

/** An https URL from the env, or the default; anything else stops startup, since the frame and the CSP depend on it. */
export function gameUrl(envName: string, fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[envName]?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${envName} must be an https URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${envName} must be an https URL`);
  return url.href;
}

/** A true/false flag from the env, or the default; anything else stops startup rather than guessing. */
export function envFlag(envName: string, fallback: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[envName]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${envName} must be true or false`);
}

/**
 * The built-in games a party can be started for. Each is a web page: framed in
 * the party's panel when its host allows that (`embed`), otherwise opened in its
 * own tab from the panel. A new game is one row here; an embedded one's origin
 * reaches the CSP's frame-src through gameOrigins.
 */
export const GAMES: readonly GameInfo[] = [
  {
    id: "ragamuffin",
    name: "RagaMuffin",
    description: "A multiplayer browser game to play with the others in your party.",
    url: gameUrl("RAGAMUFFIN_URL", DEFAULT_RAGAMUFFIN_URL),
    // Off by default: its free host redirects framed visits to an http page,
    // which browsers block inside an https site.
    embed: envFlag("RAGAMUFFIN_EMBED", false),
  },
];

export function gameById(id: string): GameInfo | undefined {
  return GAMES.find((game) => game.id === id);
}

/** The origins of the games shown in a frame, for the CSP's frame-src. Games opened in a tab need none. */
export function gameOrigins(games: readonly GameInfo[] = GAMES): string[] {
  return [...new Set(games.filter((game) => game.embed).map((game) => new URL(game.url).origin))];
}
