import { CLIENT_KEY_PATTERN } from "../types";

const STORAGE_KEY = "huddle.clientKey";
const CLAIM_WINDOW_MS = 100;

// Also the fallback when storage is blocked: identity then lasts until reload.
let memoryKey: string | null = null;

function generateKey(): string {
  // getRandomValues, as randomUUID only exists in secure contexts.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * This tab's secret identity key, sent only in join-room. The server derives
 * the public userId from it, so never log it or send it anywhere else.
 */
export function getClientKey(): string {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored && CLIENT_KEY_PATTERN.test(stored)) return stored;
  } catch {
    // Storage blocked: use the in-memory key below.
  }
  memoryKey ??= generateKey();
  try {
    sessionStorage.setItem(STORAGE_KEY, memoryKey);
  } catch {
    // Storage blocked: the in-memory key still covers reconnects.
  }
  return memoryKey;
}

function rotateKey(): string {
  memoryKey = generateKey();
  try {
    sessionStorage.setItem(STORAGE_KEY, memoryKey);
  } catch {
    // Storage blocked: the in-memory key still covers reconnects.
  }
  return memoryKey;
}

async function runClaim(): Promise<string> {
  const key = getClientKey();
  if (typeof BroadcastChannel === "undefined") return key;
  // The key only names a same-origin channel; it's never in a message.
  const open = (k: string) => new BroadcastChannel(`${STORAGE_KEY}.${k}`);
  const answerClaims = (channel: BroadcastChannel, onTaken?: () => void) => {
    channel.onmessage = (e: MessageEvent) => {
      if (e.data === "claim") channel.postMessage("taken");
      else if (e.data === "taken") onTaken?.();
    };
  };

  const channel = open(key);
  const taken = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), CLAIM_WINDOW_MS);
    answerClaims(channel, () => {
      clearTimeout(timer);
      resolve(true);
    });
    channel.postMessage("claim");
  });
  if (!taken) return key;

  channel.close();
  const fresh = rotateKey();
  answerClaims(open(fresh));
  return fresh;
}

let claim: Promise<string> | null = null;

/**
 * This tab's key, once no other live tab holds it. Duplicate Tab copies
 * sessionStorage, and two tabs sharing a key would share an identity and evict
 * each other, so the copy takes a new key. A reload keeps its key, since the
 * page that held it is gone and can't answer. Never rejects.
 */
export function claimClientKey(): Promise<string> {
  claim ??= runClaim().catch(() => getClientKey());
  return claim;
}
