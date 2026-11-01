import { useEffect, useRef, useState } from "react";
import { MAX_IMAGE_SIZE, MAX_IMAGES_PER_MESSAGE } from "../types";
import { isImageFile } from "../lib/imageUpload";

export interface PendingImage { id: string; file: File; previewUrl: string; }

/** The images waiting to be sent, and their preview URLs' lifetimes. */
export function useImageDraft() {
  const [images, setImages] = useState<PendingImage[]>([]);
  // Read on unmount, when an unsent draft's preview URLs must still be released.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => () => {
    imagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl));
  }, []);

  /** Adds what's acceptable; returns the first problem, if any. */
  function add(fileList: FileList | File[]): string | null {
    const accepted: PendingImage[] = [];
    let problem: string | null = null;
    for (const file of Array.from(fileList)) {
      if (images.length + accepted.length >= MAX_IMAGES_PER_MESSAGE) { problem ??= `You can send up to ${MAX_IMAGES_PER_MESSAGE} images at once.`; break; }
      if (!isImageFile(file)) { problem ??= `${file.name} is not a supported image file.`; continue; }
      if (file.size > MAX_IMAGE_SIZE) { problem ??= `${file.name} is larger than ${MAX_IMAGE_SIZE / (1024 * 1024)} MB.`; continue; }
      accepted.push({ id: `${file.name}-${file.lastModified}-${Math.random()}`, file, previewUrl: URL.createObjectURL(file) });
    }
    if (accepted.length) setImages((current) => [...current, ...accepted]);
    return problem;
  }

  function remove(id: string) {
    setImages((current) => {
      const image = current.find((item) => item.id === id);
      if (image) URL.revokeObjectURL(image.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  }

  function clear() {
    images.forEach((image) => URL.revokeObjectURL(image.previewUrl));
    setImages([]);
  }

  return { images, add, remove, clear };
}
