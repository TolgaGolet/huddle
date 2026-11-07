import { ExternalLink } from "lucide-react";

export const YOUTUBE_HOME_URL = "https://www.youtube.com/";

/** YouTube's red play button, inline so it needs no image host in the CSP. */
export function YouTubeLogo({ className = "h-4 w-auto" }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 28 20" className={className} aria-hidden focusable="false">
      <path
        fill="#FF0000"
        d="M27.4 3.1A3.5 3.5 0 0 0 24.9.6C22.7 0 14 0 14 0S5.3 0 3.1.6A3.5 3.5 0 0 0 .6 3.1C0 5.3 0 10 0 10s0 4.7.6 6.9a3.5 3.5 0 0 0 2.5 2.5C5.3 20 14 20 14 20s8.7 0 10.9-.6a3.5 3.5 0 0 0 2.5-2.5c.6-2.2.6-6.9.6-6.9s0-4.7-.6-6.9Z"
      />
      <path fill="#FFFFFF" d="m11.2 14.3 7.3-4.3-7.3-4.3v8.6Z" />
    </svg>
  );
}

interface Props {
  /** `icon`: the logo alone, for tight spots like the start of an input. */
  readonly variant?: "icon" | "button";
  readonly label?: string;
  readonly className?: string;
}

/**
 * Opens YouTube's home page in a new tab, to find a video and copy its link:
 * the way in when search isn't available.
 */
export default function YouTubeLink({ variant = "button", label = "Open YouTube", className = "" }: Props) {
  if (variant === "icon") {
    return (
      <a
        href={YOUTUBE_HOME_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open YouTube in a new tab"
        title="Open YouTube in a new tab"
        className={`touch-target shrink-0 inline-flex items-center justify-center rounded-lg px-1.5 hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-indigo-500 transition-colors ${className}`}
      >
        <YouTubeLogo className="h-3.5 w-auto" />
      </a>
    );
  }
  return (
    <a
      href={YOUTUBE_HOME_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`touch-target inline-flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-900/60 px-2.5 py-1 text-xs font-medium text-gray-100 hover:bg-gray-800 hover:border-gray-600 focus-visible:outline-2 focus-visible:outline-indigo-500 transition-colors ${className}`}
    >
      <YouTubeLogo />
      {label}
      <ExternalLink size={11} className="text-gray-400" aria-hidden />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}
