import { useContext, useEffect, useState, type ComponentProps } from "react";
import { imageRetryDelay, imageRetrySrc } from "../lib/imageRetry";
import { ImageSessionContext } from "../lib/imageSessionContext";

interface Props extends ComponentProps<"img"> {
  src: string;
  alt: string;
  skeletonClassName: string;
}

/**
 * An uploaded room image: a skeleton until the image session opens, then an
 * <img> that, if it failed to load, tries again after a short backoff (the server
 * may be busy) and whenever the session is reopened, since a request made without
 * a valid session gets a 404.
 */
export default function RoomImage({ src, alt, skeletonClassName, loading, onLoad, onError, ...props }: Props) {
  const session = useContext(ImageSessionContext);
  const [failures, setFailures] = useState(0);
  const [retry, setRetry] = useState(0);
  const [firstFailedSession, setFirstFailedSession] = useState<number | null>(null);
  const [loaded, setLoaded] = useState<{ src: string; url: string } | null>(null);

  useEffect(() => {
    const delay = imageRetryDelay(failures - 1);
    if (delay === null) return;
    const timer = setTimeout(() => setRetry(failures), delay);
    return () => clearTimeout(timer);
  }, [failures]);

  if (session === 0) return <span className={`block bg-gray-800 animate-pulse ${skeletonClassName}`} />;

  const failed = failures > 0;
  const url = imageRetrySrc(src, session, retry, firstFailedSession, loaded);
  return (
    <img
      {...props}
      alt={alt}
      src={url}
      // A lazy image inside a hidden parent would never retry.
      loading={failed ? "eager" : loading}
      onLoad={(e) => {
        if (failed) {
          setFailures(0);
          setLoaded({ src, url });
        }
        onLoad?.(e);
      }}
      onError={(e) => {
        setFailures((n) => n + 1);
        setFirstFailedSession((s) => s ?? session);
        onError?.(e);
      }}
    />
  );
}
