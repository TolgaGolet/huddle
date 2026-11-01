import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ParticipantsList from "./ParticipantsList";

const participant = (id: string, name: string) => ({ id, userId: `user-${id}`, name, isMuted: false });

describe("ParticipantsList", () => {
  // Regression: the local card had a menu button that opened nothing.
  it("offers options for remote participants only", () => {
    const html = renderToStaticMarkup(
      <ParticipantsList
        participants={[participant("me", "Ana"), participant("peer", "Bo")]}
        localId="me"
        speaking={new Set()}
        peerVolumes={new Map()}
        onSetPeerVolume={() => {}}
      />,
    );

    expect(html).toContain("Options for Bo");
    expect(html).not.toContain("Options for Ana");
  });
});
