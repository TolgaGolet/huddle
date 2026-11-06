import { useEffect, useState } from "react";

/** The current time, ticking each second while `until` is ahead, so a countdown stops re-rendering once it ends. */
export function useNow(until: number | undefined): number {
  const [now, setNow] = useState(Date.now);
  const running = until !== undefined && now < until;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}
