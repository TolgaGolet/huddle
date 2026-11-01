import { describe, it, expect, vi, afterEach } from "vitest";
import { CLIENT_KEY_PATTERN } from "../types";
import { getClientKey } from "./clientKey";

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
  });
  return data;
}

afterEach(() => vi.unstubAllGlobals());

describe("getClientKey", () => {
  it("creates a key the server accepts and stores it", () => {
    const data = stubStorage();
    const key = getClientKey();

    expect(key).toMatch(CLIENT_KEY_PATTERN);
    expect(data.get("huddle.clientKey")).toBe(key);
  });

  it("reuses the stored key, so a reload keeps the identity", () => {
    const stored = "stored-key-0123456789";
    stubStorage({ "huddle.clientKey": stored });

    expect(getClientKey()).toBe(stored);
  });

  it("replaces a stored value the server would reject", () => {
    stubStorage({ "huddle.clientKey": "bad key" });

    expect(getClientKey()).toMatch(CLIENT_KEY_PATTERN);
  });

  it("stays stable when storage is blocked", () => {
    const blocked = () => {
      throw new DOMException("denied", "SecurityError");
    };
    vi.stubGlobal("sessionStorage", { getItem: blocked, setItem: blocked });

    const key = getClientKey();
    expect(key).toMatch(CLIENT_KEY_PATTERN);
    expect(getClientKey()).toBe(key);
  });
});

describe("claimClientKey", () => {
  const stored = "stored-key-0123456789";

  /** The claim is cached per page, so each test loads a fresh module. */
  async function claim() {
    vi.resetModules();
    const { claimClientKey } = await import("./clientKey");
    return claimClientKey();
  }

  /** A channel where another live tab answers every claim, if `holder` is set. */
  function stubChannel(holder: boolean) {
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        onmessage: ((e: { data: string }) => void) | null = null;
        postMessage(data: string) {
          if (holder && data === "claim") this.onmessage?.({ data: "taken" });
        }
        close() {}
      },
    );
  }

  it("keeps the key when no other tab holds it, so a reload keeps the identity", async () => {
    stubStorage({ "huddle.clientKey": stored });
    stubChannel(false);

    expect(await claim()).toBe(stored);
  });

  it("takes a new key when another tab holds it, as after Duplicate Tab", async () => {
    const data = stubStorage({ "huddle.clientKey": stored });
    stubChannel(true);

    const key = await claim();
    expect(key).not.toBe(stored);
    expect(key).toMatch(CLIENT_KEY_PATTERN);
    expect(data.get("huddle.clientKey")).toBe(key);
  });

  it("keeps the key when BroadcastChannel is unavailable", async () => {
    stubStorage({ "huddle.clientKey": stored });
    vi.stubGlobal("BroadcastChannel", undefined);

    expect(await claim()).toBe(stored);
  });
});
