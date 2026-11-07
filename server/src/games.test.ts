import { describe, it, expect } from "vitest";
import { envFlag, gameOrigins, gameUrl } from "./games.js";

describe("gameUrl", () => {
  it("takes an https URL from the env, falls back when unset, and refuses anything else", () => {
    const fallback = "https://game.example/";
    expect(gameUrl("GAME_URL", fallback, {})).toBe(fallback);
    expect(gameUrl("GAME_URL", fallback, { GAME_URL: " https://other.example/play " })).toBe("https://other.example/play");
    expect(() => gameUrl("GAME_URL", fallback, { GAME_URL: "http://other.example/" })).toThrow("GAME_URL must be an https URL");
    expect(() => gameUrl("GAME_URL", fallback, { GAME_URL: "not a url" })).toThrow("GAME_URL must be an https URL");
  });
});

describe("envFlag", () => {
  it("reads true or false, falls back when unset, and refuses anything else", () => {
    expect(envFlag("GAME_EMBED", false, {})).toBe(false);
    expect(envFlag("GAME_EMBED", false, { GAME_EMBED: " TRUE " })).toBe(true);
    expect(envFlag("GAME_EMBED", true, { GAME_EMBED: "false" })).toBe(false);
    expect(() => envFlag("GAME_EMBED", false, { GAME_EMBED: "yes" })).toThrow("GAME_EMBED must be true or false");
  });
});

describe("gameOrigins", () => {
  it("lists only the origins of games shown in a frame", () => {
    const game = { id: "a", name: "A", description: "", url: "https://a.example/play", embed: true };
    expect(gameOrigins([game, { ...game, id: "b", url: "https://b.example/", embed: false }, { ...game, id: "c" }])).toEqual(["https://a.example"]);
  });
});

// Regression: an unset NODE_ENV dropped the image cookie's Secure flag.
