/**
 * Worker-based timer interval.
 *
 * Browsers aggressively throttle `setInterval` / `setTimeout` down to 1000ms+
 * when a tab or window is in the background or minimized.
 * However, dedicated Web Workers are NOT throttled to 1s in the background,
 * allowing real-time tasks like voice gate checking to maintain their 25ms-50ms
 * cadence seamlessly regardless of tab focus.
 */

const WORKER_CODE = `
let timerId = null;
self.onmessage = function(e) {
  if (e.data.action === "start") {
    if (timerId !== null) clearInterval(timerId);
    timerId = setInterval(() => {
      self.postMessage("tick");
    }, e.data.interval || 25);
  } else if (e.data.action === "stop") {
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
  }
};
`;

export function createWorkerInterval(callback: () => void, intervalMs: number): () => void {
  try {
    const blob = new Blob([WORKER_CODE], { type: "application/javascript" });
    const workerUrl = URL.createObjectURL(blob);
    const worker = new Worker(workerUrl);

    worker.onmessage = () => {
      callback();
    };

    worker.postMessage({ action: "start", interval: intervalMs });

    return () => {
      worker.postMessage({ action: "stop" });
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
    };
  } catch {
    // Fallback to standard setInterval if Web Worker is restricted
    const id = setInterval(callback, intervalMs);
    return () => clearInterval(id);
  }
}
