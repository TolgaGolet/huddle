import { createContext } from "react";

/**
 * Bumped each time the image session is (re)opened; 0 until then, while images
 * would 404. A context, so a renewal only re-renders images, not the message list.
 */
export const ImageSessionContext = createContext(0);
