import { useState, type RefObject } from "react";
import { X, Volume2 } from "lucide-react";
import AudioSettings from "./AudioSettings";
import Dialog from "./Dialog";
import { useMicTelemetry } from "../hooks/useMicTelemetry";
import type { GateState } from "../lib/audioLevels";
import type { VoiceTransmissionThreshold } from "../types";

const CATEGORIES = [
  { id: "audio", label: "Audio Settings", icon: Volume2 },
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

interface Props {
  readonly onClose: () => void;
  readonly audioInputs: MediaDeviceInfo[];
  readonly selectedDeviceId: string;
  readonly onDeviceChange: (deviceId: string) => void;
  readonly noiseCancellationEnabled: boolean;
  readonly onNoiseCancellationChange: (enabled: boolean) => void;
  readonly isNoiseCancellationSupported: boolean;
  readonly transmissionThreshold: VoiceTransmissionThreshold;
  readonly onTransmissionThresholdChange: (threshold: VoiceTransmissionThreshold) => void;
  readonly manualThresholdDb: number;
  readonly onManualThresholdDbChange: (db: number) => void;
  readonly localAnalyser: AnalyserNode | null;
  readonly isMuted: boolean;
  readonly isTransmitting: boolean;
  readonly gateStateRef: RefObject<GateState>;
}

export default function SettingsPopup({
  onClose,
  audioInputs,
  selectedDeviceId,
  onDeviceChange,
  noiseCancellationEnabled,
  onNoiseCancellationChange,
  isNoiseCancellationSupported,
  transmissionThreshold,
  onTransmissionThresholdChange,
  manualThresholdDb,
  onManualThresholdDbChange,
  localAnalyser,
  isMuted,
  isTransmitting,
  gateStateRef,
}: Props) {
  const [activeCategory, setActiveCategory] = useState<CategoryId>("audio");
  // Lives here, not in RoomPage: it updates every 80ms, which would re-render
  // the whole room (chat included) while this popup is open.
  const telemetry = useMicTelemetry(localAnalyser, isMuted, transmissionThreshold, manualThresholdDb, isTransmitting, gateStateRef);

  return (
    <Dialog
      onClose={onClose}
      labelledBy="settings-dialog-title"
      overlayClassName="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      panelClassName="bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col sm:flex-row overflow-hidden focus:outline-none"
    >
        {/* Left sidebar */}
        <div className="w-full sm:w-48 bg-gray-900 border-b sm:border-b-0 sm:border-r border-gray-800 p-4 flex flex-col">
          <h2 id="settings-dialog-title" className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
            Settings
          </h2>
          <nav className="space-y-1">
            {CATEGORIES.map((cat) => {
              const Icon = cat.icon;
              return (
                <button
                  key={cat.id}
                  type="button"
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
        <div className="flex-1 p-6 overflow-y-auto relative min-h-0">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="absolute top-4 right-4 p-1.5 rounded-lg text-gray-400 hover:text-gray-300 hover:bg-gray-800 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500"
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
                noiseCancellationEnabled={noiseCancellationEnabled}
                onNoiseCancellationChange={onNoiseCancellationChange}
                isNoiseCancellationSupported={isNoiseCancellationSupported}
                transmissionThreshold={transmissionThreshold}
                onTransmissionThresholdChange={onTransmissionThresholdChange}
                manualThresholdDb={manualThresholdDb}
                onManualThresholdDbChange={onManualThresholdDbChange}
                telemetry={telemetry}
              />
            </div>
          )}
        </div>
    </Dialog>
  );
}
