import { isAllowedImage } from "../types";
import { errorName, huddleWarn } from "./huddleLog";

/** Well inside the server's 12-hour session, so an open tab never lapses. */
export const IMAGE_SESSION_RENEW_MS = 6 * 60 * 60 * 1000;
export const IMAGE_SESSION_RETRY_MS = 30 * 1000;

export function isImageFile(file: File): boolean {
  return isAllowedImage(file.name.split(".").pop()?.toLowerCase() ?? "", file.type);
}

/** Sets the cookie that authorizes this room's image requests. Call after joining. */
export async function openImageSession(roomId: string, httpToken: string): Promise<void> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/image-session`, {
    method: "POST",
    headers: { "X-Participant-Token": httpToken },
  });
  if (!response.ok) throw new Error("Failed to open image session");
}

/**
 * Opens the image session and keeps it open until the returned function is
 * called, after which `onSettled` never fires. `onSettled` fires on each success
 * and after a failed first attempt, so images show as broken instead of loading.
 */
export function keepImageSessionOpen(roomId: string, httpToken: string, onSettled: () => void): () => void {
  let stopped = false;
  let firstAttempt = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = async () => {
    let opened = true;
    try {
      await openImageSession(roomId, httpToken);
    } catch (err) {
      opened = false;
      huddleWarn("socket", { event: "image-session-failed", error: errorName(err) });
    }
    if (stopped) return;
    timer = setTimeout(() => void open(), opened ? IMAGE_SESSION_RENEW_MS : IMAGE_SESSION_RETRY_MS);
    if (opened || firstAttempt) onSettled();
    firstAttempt = false;
  };
  void open();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

async function compressImage(file: File): Promise<Blob> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "heic" || extension === "heif") {
    try {
      // Lazy-load heic2any (~1.3 MB) only when a HEIC file is actually encountered.
      const { default: heic2any } = await import("heic2any");
      const converted = await heic2any({ blob: file, toType: "image/webp", quality: 0.85 });
      return Array.isArray(converted) ? converted[0] : converted;
    } catch {
      return file;
    }
  }
  if (file.size <= 4 * 1024 * 1024 || file.type === "image/gif") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not compress image"))), "image/webp", 0.92);
    });
  } catch {
    // Browsers commonly cannot decode HEIC/HEIF. Upload the original instead
    // of aborting the complete batch; the server can store it safely.
    return file;
  }
}

export async function uploadImages(roomId: string, httpToken: string, files: File[]): Promise<string[]> {
  const form = new FormData();
  for (const file of files) {
    const compressed = await compressImage(file);
    const extension = compressed === file ? file.name.split(".").pop()?.toLowerCase() : "webp";
    form.append("images", compressed, `${file.name.replace(/\.[^.]+$/, "")}.${extension}`);
  }
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/images`, {
    method: "POST",
    headers: { "X-Participant-Token": httpToken },
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