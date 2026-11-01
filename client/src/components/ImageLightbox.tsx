import { X } from "lucide-react";
import Dialog from "./Dialog";

interface Props {
  url: string;
  onClose: () => void;
}

export default function ImageLightbox({ url, onClose }: Props) {
  return (
    <Dialog
      onClose={onClose}
      label="Image preview"
      closeOnBackdrop
      overlayClassName="absolute inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
      panelClassName="relative max-h-full max-w-full focus:outline-none"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute -top-2 -right-2 z-10 rounded-full bg-gray-800 border border-gray-600 p-1.5 text-gray-300 hover:text-white hover:bg-gray-700 transition-colors cursor-pointer shadow-lg"
        title="Close"
        aria-label="Close image preview"
      >
        <X size={16} />
      </button>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- click-to-close is a mouse shortcut; the Close button and Escape are the keyboard routes. */}
      <img
        src={url}
        alt="Preview"
        className="max-h-full max-w-full rounded-lg shadow-2xl"
        onClick={onClose}
      />
    </Dialog>
  );
}
