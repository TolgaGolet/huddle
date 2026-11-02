import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { processImage, UnreadableImageError } from "./imageProcessing.js";

const pixels = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } });

describe("processImage", () => {
  // Regression: photos were shared with their GPS location and device details.
  it("removes location and other metadata", async () => {
    const photo = await pixels(40, 20)
      .withExif({ IFD0: { Make: "SecretCamera" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } })
      .jpeg()
      .toBuffer();
    expect((await sharp(photo).metadata()).exif).toBeDefined();

    const clean = await processImage(photo);

    const { format, exif, icc, xmp } = await sharp(clean).metadata();
    expect(format).toBe("webp");
    expect(exif).toBeUndefined();
    expect(xmp).toBeUndefined();
    expect(icc).toBeUndefined();
    expect(clean.includes("SecretCamera")).toBe(false);
  });

  it("applies the rotation before the orientation tag goes", async () => {
    const sideways = await pixels(40, 20).withMetadata({ orientation: 6 }).jpeg().toBuffer();

    const { width, height } = await sharp(await processImage(sideways)).metadata();

    expect({ width, height }).toEqual({ width: 20, height: 40 });
  });

  it("keeps an animated GIF animated", async () => {
    const frame = await pixels(10, 10).raw().toBuffer();
    const gif = await sharp(Buffer.concat([frame, Buffer.alloc(frame.length, 90)]), {
      raw: { width: 10, height: 20, channels: 3, pageHeight: 10 },
    }).gif({ delay: 100 }).toBuffer();
    expect((await sharp(gif, { animated: true }).metadata()).pages).toBe(2);

    const { pages, format } = await sharp(await processImage(gif), { animated: true }).metadata();

    expect(format).toBe("webp");
    expect(pages).toBe(2);
  });

  // Each frame differs, or the GIF encoder merges them into one.
  const animation = (width: number, frameHeight: number, frames: number) =>
    sharp(Buffer.concat(Array.from({ length: frames }, (_, i) => Buffer.alloc(width * frameHeight).fill(255, 0, width * (i + 1)))), {
      raw: { width, height: frameHeight * frames, channels: 1, pageHeight: frameHeight },
      limitInputPixels: false,
    }).gif({ delay: 50 }).toBuffer();

  // Regression: the pixel limit counted all frames, refusing ordinary GIFs.
  it("accepts an animated GIF whose frames only exceed the limit for one image together", async () => {
    const gif = await animation(500, 280, 240);

    const { pages, format } = await sharp(await processImage(gif), { animated: true, limitInputPixels: false }).metadata();

    expect(format).toBe("webp");
    expect(pages).toBe(240);
  }, 30_000);

  it("refuses an animation too large to encode in memory", async () => {
    await expect(processImage(await animation(500, 400, 400))).rejects.toBeInstanceOf(UnreadableImageError);
  }, 30_000);

  // Regression: anything named .png was stored and served as an image.
  it.each([
    ["HTML", Buffer.from("<html><script>alert(1)</script></html>")],
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')],
    ["nothing", Buffer.alloc(0)],
  ])("refuses %s", async (_name, input) => {
    await expect(processImage(input)).rejects.toBeInstanceOf(UnreadableImageError);
  });

  it("refuses a decompression bomb", async () => {
    const bomb = await pixels(6000, 6000).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(1024 * 1024);

    await expect(processImage(bomb)).rejects.toBeInstanceOf(UnreadableImageError);
  });

  // Regression: sharp's default refused files that browsers display without complaint.
  it("accepts an image with a minor flaw, such as a wrong checksum", async () => {
    const png = await pixels(5, 5).png().toBuffer();
    const flawed = Buffer.from(png);
    flawed[png.indexOf("IEND") + 4] ^= 0xff; // The final chunk's checksum.

    const { format } = await sharp(await processImage(flawed)).metadata();

    expect(format).toBe("webp");
  });

  it("keeps working after refusing something", async () => {
    await processImage(Buffer.from("not an image")).catch(() => {});

    const { format } = await sharp(await processImage(await pixels(5, 5).png().toBuffer())).metadata();

    expect(format).toBe("webp");
  });
});
