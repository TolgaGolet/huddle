/** True for a plain F press; Ctrl+F and friends belong to the browser. */
export function isFullscreenShortcut(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return e.key === "f" || e.key === "F";
}
