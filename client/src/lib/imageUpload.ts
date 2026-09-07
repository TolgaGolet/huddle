import heic2any from "heic2any";

export const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
export const MAX_IMAGES_PER_SEND = 10;
const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif"]);

export function isImageFile(file: File): boolean {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  // Some browsers report an empty or non-standard MIME type for HEIC files.
  // The extension is the authoritative check; the server applies the same
  // allowlist before storing the file.
  return ALLOWED_EXTENSIONS.has(extension) && (!file.type || file.type.startsWith("image/") || file.type === "application/octet-stream");
}

async function compressImage(file: File): Promise<Blob> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "heic" || extension === "heif") {
    try {
      const converted = await heic2any({ blob: file, toType: "image/webp", quality: 0.85 });
      return Array.isArray(converted) ? converted[0] : converted;
    } catch {
      return file;
    }
  }
  if (file.size <= 2 * 1024 * 1024 || file.type === "image/gif") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not compress image"))), "image/webp", 0.85);
    });
  } catch {
    // Browsers commonly cannot decode HEIC/HEIF. Upload the original instead
    // of aborting the complete batch; the server can store it safely.
    return file;
  }
}

export async function uploadImages(roomId: string, socketId: string, files: File[]): Promise<string[]> {
  const form = new FormData();
  for (const file of files) {
    const compressed = await compressImage(file);
    const extension = compressed === file ? file.name.split(".").pop()?.toLowerCase() : "webp";
    form.append("images", compressed, `${file.name.replace(/\.[^.]+$/, "")}.${extension}`);
  }
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/images`, {
    method: "POST",
    headers: { "X-Socket-Id": socketId },
    body: form,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || "Failed to upload images");
  }
  const data = await response.json() as { urls?: unknown };
  if (!Array.isArray(data.urls) || !data.urls.every((url) => typeof url === "string")) {
    throw new Error("Invalid image upload response");
  }
  return data.urls as string[];
}