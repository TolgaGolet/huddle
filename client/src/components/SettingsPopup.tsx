import { useState } from "react";
import { X, Volume2 } from "lucide-react";
import AudioSettings from "./AudioSettings";

const CATEGORIES = [
  { id: "audio", label: "Audio Settings", icon: Volume2 },
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

interface Props {
  onClose: () => void;
  audioInputs: MediaDeviceInfo[];
  selectedDeviceId: string;
  onDeviceChange: (deviceId: string) => void;
  inputGain: number;
  onInputGainChange: (value: number) => void;
}

export default function SettingsPopup({
  onClose,
  audioInputs,
  selectedDeviceId,
  onDeviceChange,
  inputGain,
  onInputGainChange,
}: Props) {
  const [activeCategory, setActiveCategory] = useState<CategoryId>("audio");

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl w-full max-w-xl h-[400px] flex overflow-hidden">
        {/* Left sidebar */}
        <div className="w-48 bg-gray-900 border-r border-gray-800 p-4 flex flex-col">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
            Settings
          </h2>
          <nav className="space-y-1">
            {CATEGORIES.map((cat) => {
              const Icon = cat.icon;
              return (
                <button
                  key={cat.id}
                  onClick={() => setActiveCategory(cat.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer ${
                    activeCategory === cat.id
                      ? "bg-gray-800 text-white"
                      : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50"
                  }`}
                >
                  <Icon size={16} />
                  {cat.label}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Right content */}
        <div className="flex-1 p-6 overflow-y-auto relative">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-1 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors cursor-pointer"
          >
            <X size={18} />
          </button>

          {activeCategory === "audio" && (
            <div>
              <h3 className="text-lg font-semibold text-white mb-6">Audio Settings</h3>
              <AudioSettings
                audioInputs={audioInputs}
                selectedDeviceId={selectedDeviceId}
                onDeviceChange={onDeviceChange}
                inputGain={inputGain}
                onInputGainChange={onInputGainChange}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
