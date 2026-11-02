import { describe, expect, it } from "vitest";
import { AVATAR_COLORS, avatarBgColor, avatarTextColor } from "./avatarColor";

describe("avatar colors", () => {
  it("gives a name the same color every time", () => {
    expect(avatarBgColor("Ana")).toBe(avatarBgColor("Ana"));
  });

  it("pairs the background and text of one palette entry", () => {
    for (const name of ["Ana", "Bo", "Cem", "Dara", "Ece"]) {
      expect(AVATAR_COLORS).toContainEqual({ bg: avatarBgColor(name), text: avatarTextColor(name) });
    }
  });

  it.each(["", "ğüşİÖç", "😀😀", "x".repeat(10_000)])("always lands inside the palette for %j", (name) => {
    expect(AVATAR_COLORS.map((c) => c.bg)).toContain(avatarBgColor(name));
  });

  it("spreads names across the palette", () => {
    const used = new Set(Array.from({ length: 200 }, (_, i) => avatarBgColor(`user-${i}`)));

    expect(used.size).toBe(AVATAR_COLORS.length);
  });
});
