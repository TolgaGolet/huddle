import { useCallback, useEffect, useRef, useState } from "react";

/** Full screen for one element: attach `ref` to it. `isFullscreen` is true only while that element is the one shown. */
export function useElementFullscreen<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handler = () => setIsFullscreen(document.fullscreenElement === ref.current);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  const toggle = useCallback(() => {
    if (!ref.current) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    // Refused without a user gesture, or by a browser policy: nothing to do but stay as we are.
    else void ref.current.requestFullscreen().catch(() => {});
  }, []);

  return { ref, isFullscreen, toggle };
}
