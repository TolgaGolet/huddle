import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageSessionContext } from "../lib/imageSessionContext";
import ImageLightbox from "./ImageLightbox";

function render(session: number) {
  return renderToStaticMarkup(
    <ImageSessionContext value={session}>
      <ImageLightbox url="/api/rooms/r/images/a.png" senderName="Bo" onClose={() => {}} />
    </ImageSessionContext>,
  );
}

describe("ImageLightbox", () => {
  // Regression: a bare <img> loaded without a session and never retried.
  it("waits for the image session instead of requesting the image", () => {
    const html = render(0);
    expect(html).not.toContain("<img");
    expect(html).toContain("animate-pulse");
  });

  it("names the sender once the session is open", () => {
    const html = render(1);
    expect(html).toContain('alt="Sent by Bo"');
    expect(html).toContain("/api/rooms/r/images/a.png");
  });
});
