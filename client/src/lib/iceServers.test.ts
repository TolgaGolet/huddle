import { describe, it, expect } from "vitest";
import { parseIceServers } from "./iceServers";

describe("parseIceServers", () => {
  it("accepts urls as a string or a list", () => {
    const servers = [{ urls: "stun:a" }, { urls: ["turn:b", "turn:c"], username: "u", credential: "p" }];
    expect(parseIceServers(JSON.stringify(servers))).toEqual(servers);
  });

  // Regression: a typo silently fell back to STUN, which looks just like a NAT problem.
  it.each([
    ["bad JSON", "[{urls:"],
    ["a non-array", '{"urls":"stun:a"}'],
    ["an empty list", "[]"],
    ["an entry with no urls", '[{"username":"u"}]'],
    ["a null entry", "[null]"],
    ["empty urls", '[{"urls":[]}]'],
    ["non-string urls", '[{"urls":[1]}]'],
  ])("rejects %s", (_label, raw) => {
    expect(parseIceServers(raw)).toBeNull();
  });
});
