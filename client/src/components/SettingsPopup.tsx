import type { RefObject } from "react";
import { X } from "lucide-react";
import AudioSettings from "./AudioSettings";
import Dialog from "./Dialog";
import { useMicTelemetry } from "../hooks/useMicTelemetry";
import type { GateState } from "../lib/audioLevels";
import type { VoiceTransmissionThreshold } from "../types";

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
  // Lives here, not in RoomPage: it updates every 80ms, which would re-render
  // the whole room (chat included) while this popup is open.
  const telemetry = useMicTelemetry(localAnalyser, isMuted, transmissionThreshold, manualThresholdDb, isTransmitting, gateStateRef);

  return (
    <Dialog
      onClose={onClose}
      labelledBy="settings-dialog-title"
      overlayClassName="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      panelClassName="bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto relative p-6 focus:outline-none"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close settings"
        className="absolute top-4 right-4 p-1.5 rounded-lg text-gray-400 hover:text-gray-300 hover:bg-gray-800 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        <X size={18} />
      </button>
      <h2 id="settings-dialog-title" className="text-lg font-semibold text-white mb-6">Audio Settings</h2>
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
    </Dialog>
  );
}
