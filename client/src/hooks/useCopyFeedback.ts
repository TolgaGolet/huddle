import { useCallback, useEffect, useRef, useState } from "react";
import { errorName, huddleWarn } from "../lib/huddleLog";

const FEEDBACK_MS = 2000;

type CopyStatus = "idle" | "copied" | "failed";

/** Copies text to the clipboard and reports the result for a couple of seconds. */
export function useCopyFeedback() {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const copy = useCallback(async (text: string) => {
    let result: CopyStatus = "copied";
    try {
      // `navigator.clipboard` is undefined on insecure origins, and writing can
      // be denied; both land here.
      await navigator.clipboard.writeText(text);
    } catch (err) {
      huddleWarn("clipboard", { event: "copy-failed", error: errorName(err) });
      result = "failed";
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    setStatus(result);
    timerRef.current = setTimeout(() => setStatus("idle"), FEEDBACK_MS);
  }, []);

  return { status, copy };
}
