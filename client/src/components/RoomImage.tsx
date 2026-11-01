import { useContext, useState, type ComponentProps } from "react";
import { ImageSessionContext } from "../lib/imageSessionContext";

interface Props extends ComponentProps<"img"> {
  src: string;
  alt: string;
  skeletonClassName: string;
}

/**
 * An uploaded room image: a skeleton until the image session opens, then an
 * <img> that tries again whenever the session is reopened if it failed to load,
 * since a request made without a valid session gets a 404.
 */
export default function RoomImage({ src, alt, skeletonClassName, loading, onError, ...props }: Props) {
  const session = useContext(ImageSessionContext);
  const [failed, setFailed] = useState(false);

  if (session === 0) return <span className={`block bg-gray-800 animate-pulse ${skeletonClassName}`} />;

  return (
    <img
      {...props}
      alt={alt}
      // The query only changes the URL, which is what makes the browser try again.
      src={failed ? `${src}?session=${session}` : src}
      // A lazy image inside a hidden parent would never retry.
      loading={failed ? "eager" : loading}
      onError={(e) => {
        setFailed(true);
        onError?.(e);
      }}
    />
  );
}
