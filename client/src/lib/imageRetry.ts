// The server answers 503 while its image memory is full. That can last as long as
// a slow client's downloads of a room full of large images, so this spans a minute.
const IMAGE_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

/** Backoff before retry number `attempt` (from 0), or null once retries are exhausted. */
export function imageRetryDelay(attempt: number): number | null {
  return IMAGE_RETRY_DELAYS_MS[attempt] ?? null;
}

/**
 * The URL to load. It stays `src` until a backoff has elapsed or the session has
 * reopened since the first failure: the query only changes the URL, which is what
 * makes the browser try again, so adding it sooner would retry with no delay.
 * Once a retry has loaded (`loaded`), the URL stays put, or later session renewals
 * would download the image again.
 */
export function imageRetrySrc(
  src: string,
  session: number,
  retry: number,
  firstFailedSession: number | null,
  loaded: { src: string; url: string } | null = null,
): string {
  if (loaded?.src === src) return loaded.url;
  const retrying = retry > 0 || (firstFailedSession !== null && session !== firstFailedSession);
  return retrying ? `${src}?session=${session}&retry=${retry}` : src;
}
