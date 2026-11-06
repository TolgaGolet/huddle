import { describe, expect, it } from "vitest";
import { parseYouTubeVideoId } from "./youtube.js";

const ID = "dQw4w9WgXcQ";

describe("parseYouTubeVideoId", () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=${ID}&t=42s&list=PL123`,
    `https://youtube.com/watch?feature=share&v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `http://www.youtube.com/watch?v=${ID}`,
    `www.youtube.com/watch?v=${ID}`,
    `youtu.be/${ID}`,
    `  https://youtu.be/${ID}  `,
  ])("finds the id in %s", (url) => {
    expect(parseYouTubeVideoId(url)).toBe(ID);
  });

  it.each([
    "",
    ID,
    "not a link",
    `https://vimeo.com/${ID}`,
    `https://youtube.com.evil.example/watch?v=${ID}`,
    `https://evil.example/?u=youtube.com/watch?v=${ID}`,
    `javascript:alert(1)//youtube.com/watch?v=${ID}`,
    `ftp://www.youtube.com/watch?v=${ID}`,
    `https://user:pw@www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com:8080/watch?v=${ID}`,
    "https://www.youtube.com/watch?v=tooShort",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQQ",
    "https://www.youtube.com/channel/UC1234567890",
    // Live streams can't be kept in sync.
    `https://www.youtube.com/live/${ID}?feature=share`,
    `https://www.youtube.com/watch?v=${ID}`.padEnd(3000, "x"),
  ])("rejects %s", (url) => {
    expect(parseYouTubeVideoId(url)).toBeNull();
  });
});
