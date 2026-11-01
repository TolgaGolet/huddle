import { describe, it, expect } from "vitest";
import { rekeyStream, withoutStream } from "./screenStreams";

const stream = {} as MediaStream;

describe("withoutStream", () => {
  it("removes only the given id, without changing the original map", () => {
    const streams = new Map([["a", stream], ["b", stream]]);
    expect([...withoutStream(streams, "a").keys()]).toEqual(["b"]);
    expect(streams.size).toBe(2);
  });
});

describe("rekeyStream", () => {
  it("moves the stream, so the old socket id no longer holds it after a reconnect", () => {
    const next = rekeyStream(new Map([["old", stream]]), "old", "new");
    expect(next.get("new")).toBe(stream);
    expect(next.has("old")).toBe(false);
  });

  it("returns the same map when there is nothing to move", () => {
    const streams = new Map([["a", stream]]);
    expect(rekeyStream(streams, "old", "new")).toBe(streams);
  });
});
