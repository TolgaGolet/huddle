import { errorName } from "./huddleLog";

/** `switch-failed`: a device change failed, but the previous mic is still live. */
export type MicError = "denied" | "not-found" | "busy" | "ended" | "switch-failed";

/** Classifies a getUserMedia rejection. The browser's message isn't used: it can quote details. */
export function classifyMicError(err: unknown): MicError {
  const name = errorName(err);
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "not-found";
  return "busy";
}

/**
 * The error once a live track ended and re-acquiring failed. A specific cause
 * says what to do about it, so it stays; `switch-failed` wrongly assumed the old
 * track was still live.
 */
export function micErrorAfterTrackEnded(current: MicError | null): MicError {
  return current === null || current === "switch-failed" ? "ended" : current;
}

export function micErrorMessage(error: MicError): string {
  switch (error) {
    case "denied":
      return "Microphone access is blocked, so nobody can hear you. Allow it in your browser's site settings, then retry.";
    case "not-found":
      return "No microphone was found, so nobody can hear you. Connect one, then retry.";
    case "busy":
      return "Your microphone couldn't be started, so nobody can hear you. It may be in use by another app.";
    case "ended":
      return "Your microphone was disconnected, so nobody can hear you. Reconnect it, then retry.";
    case "switch-failed":
      return "Couldn't switch to that microphone. You're still using the previous one.";
  }
}
