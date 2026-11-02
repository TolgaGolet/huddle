import sharp from "sharp";

// Decoding takes far more memory than the file does, so limit what's accepted and
// handle one image at a time. These are also what stop decompression bombs.
const MAX_IMAGE_PIXELS = 32_000_000;
const MAX_FRAMES = 500;
/** All frames together, which is what sharp's limit counts. Encoding holds them, at about 2.8 bytes per pixel. */
const MAX_ANIMATED_PIXELS = 64_000_000;
const TIMEOUT_SECONDS = 20;
const WEBP_QUALITY = 90;
const READABLE_FORMATS: ReadonlySet<string> = new Set(["jpeg", "png", "webp", "gif", "heif"]);

sharp.cache(false);
sharp.concurrency(1);

/** The upload isn't an image this server can read, whatever its name or type claimed. */
export class UnreadableImageError extends Error {
  override name = "UnreadableImageError";
}

async function encode(input: Buffer): Promise<Buffer> {
  // Not sharp's default of failing on warnings: browsers show images with minor
  // flaws, such as a wrong checksum, and people's real files do have them.
  const options = { animated: true, limitInputPixels: MAX_ANIMATED_PIXELS, failOn: "error" } as const;
  try {
    const { format, pages = 1, width, height, pageHeight = height } = await sharp(input, options).metadata();
    if (!READABLE_FORMATS.has(format) || pages > MAX_FRAMES || width * pageHeight > MAX_IMAGE_PIXELS) throw new UnreadableImageError();
    // Sharp leaves out metadata unless asked, so this also removes GPS location,
    // and rotation has to be applied now as the orientation tag goes too.
    return await sharp(input, options).rotate().timeout({ seconds: TIMEOUT_SECONDS }).webp({ quality: WEBP_QUALITY }).toBuffer();
  } catch {
    // Its message can quote the input, and every failure means the same to the sender.
    throw new UnreadableImageError();
  }
}

let queue: Promise<void> = Promise.resolve();

/** A clean WebP copy of an upload, holding pixels only. Rejects with UnreadableImageError. */
export function processImage(input: Buffer): Promise<Buffer> {
  const run = queue.then(() => encode(input));
  // Holds no result, or the last image would stay in memory until the next upload.
  queue = run.then(() => {}, () => {});
  return run;
}
