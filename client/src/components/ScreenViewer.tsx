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

  return (
    <div
      ref={containerRef}
      className={`flex flex-col bg-gray-950 ${isFullscreen ? "h-full" : "border-b border-gray-800"}`}
    >
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-900/60 shrink-0">
        <span className="text-xs text-gray-400">
          {sharerName}&apos;s screen
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={toggleFullscreen}
            className="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-800 transition-colors cursor-pointer"
            title={isFullscreen ? "Exit fullscreen (Esc)" : "Watch fullscreen"}
          >
            {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-800 transition-colors cursor-pointer"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      <div
        className="relative w-full min-h-0"
        style={isFullscreen ? { flex: 1 } : { maxHeight: "45vh" }}
      >
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
