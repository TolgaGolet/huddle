import { useEffect, useRef, useState, useCallback } from "react";
import { X, Maximize, Minimize } from "lucide-react";

interface Props {
  stream: MediaStream;
  sharerName: string;
  onClose?: () => void;
}

export default function ScreenViewer({ stream, sharerName, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  useEffect(() => {
    const handler = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      containerRef.current.requestFullscreen();
    }
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (!document.fullscreenEnabled) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "f" || e.key === "F") {
        toggleFullscreen();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [toggleFullscreen]);

  return (
    <div
      ref={containerRef}
      className={`flex flex-col bg-gray-950 min-w-0 ${isFullscreen ? "h-full" : "h-[35dvh] shrink-0 md:h-auto md:shrink md:flex-1"}`}
    >
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-900/60 shrink-0">
        <span className="text-xs text-gray-400">
          {sharerName}&apos;s screen
        </span>
        <div className="flex items-center gap-1">
          {/* iPhone Safari has no element fullscreen. */}
          {document.fullscreenEnabled && (
            <button
              onClick={toggleFullscreen}
              className="touch-target p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-800 transition-colors cursor-pointer"
              title={isFullscreen ? "Exit fullscreen (F / Esc)" : "Fullscreen (F)"}
              aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              aria-label="Close screen share"
              className="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-800 transition-colors cursor-pointer"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="relative flex-1 min-h-0 w-full">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption, jsx-a11y/control-has-associated-label -- a live screen share has no caption track. */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className="w-full h-full object-contain bg-black"
        />
      </div>
    </div>
  );
}
