import { Mic, ShieldCheck, Sparkles, Sliders } from "lucide-react";
import type { MicTelemetry, VoiceTransmissionThreshold } from "../types";
import { MicLevelPreview } from "./MicLevelPreview";

interface Props {
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
  readonly telemetry: MicTelemetry;
}

export default function AudioSettings({
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
  telemetry,
}: Props) {
  return (
    <div className="space-y-6">
      {/* Input Device Selection */}
      <div>
        <label htmlFor="mic-device-select" className="flex items-center gap-2 text-sm font-medium text-gray-300 mb-2">
          <Mic size={16} />
          Input Device
        </label>
        <select
          id="mic-device-select"
          value={selectedDeviceId}
          onChange={(e) => onDeviceChange(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-gray-700 border border-gray-600 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
        >
          {audioInputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Microphone (${d.deviceId.slice(0, 8)}...)`}
            </option>
          ))}
          {audioInputs.length === 0 && <option value="">No devices found</option>}
        </select>
      </div>

      {/* Voice Transmission Threshold Combobox (Steam Chat style) */}
      <div className="rounded-lg bg-gray-800/60 border border-gray-700 p-4">
        <div className="flex items-start gap-3 mb-3">
          <div className="mt-0.5 text-indigo-400">
            <Sliders size={18} />
          </div>
          <div className="flex-1">
            <label
              htmlFor="transmission-threshold-select"
              className="text-sm font-medium text-white block"
            >
              Voice Transmission Threshold
            </label>
            <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">
              Prevents transmitting sounds below this threshold when you are not speaking (slight mouse clicks, fan hum, breathing).
            </p>
          </div>
        </div>

        <select
          id="transmission-threshold-select"
          value={transmissionThreshold}
          onChange={(e) =>
            onTransmissionThresholdChange(e.target.value as VoiceTransmissionThreshold)
          }
          className="w-full px-3 py-2 rounded-lg bg-gray-700 border border-gray-600 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors cursor-pointer"
        >
          <option value="off">Off (Continuous Transmission)</option>
          <option value="low">Low (-42 dB)</option>
          <option value="medium">Medium (-36 dB, Recommended)</option>
          <option value="high">High (-30 dB)</option>
          <option value="very-high">Very High (-24 dB)</option>
          <option value="manual">Manual (Custom dB Level)</option>
        </select>

        {/* Manual Threshold dB Slider */}
        {transmissionThreshold === "manual" && (
          <div className="mt-4 pt-3 border-t border-gray-700/60 flex flex-col gap-2">
            <div className="flex justify-between items-center text-xs">
              <span className="text-gray-300 font-medium">Custom Threshold:</span>
              <span className="text-indigo-400 font-semibold">{manualThresholdDb} dB</span>
            </div>
            <input
              type="range"
              min={-60}
              max={-10}
              step={1}
              value={manualThresholdDb}
              onChange={(e) => onManualThresholdDbChange(Number(e.target.value))}
              className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
            />
            <div className="flex justify-between text-[10px] text-gray-500">
              <span>More sensitive (-60 dB)</span>
              <span>Stricter rejection (-10 dB)</span>
            </div>
          </div>
        )}
      </div>

      {/* Live Mic Activity & Noise Meter */}
      <div>
        <MicLevelPreview telemetry={telemetry} />
      </div>

      {/* Noise Cancellation Toggle */}
      <div className="rounded-lg bg-gray-800/60 border border-gray-700 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 text-indigo-400">
              <Sparkles size={18} />
            </div>
            <div>
              <label
                htmlFor="noise-cancellation-toggle"
                className="text-sm font-medium text-white cursor-pointer select-none"
              >
                Noise Cancellation
              </label>
              <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">
                Applies browser-level noise suppression to cancel constant background noises.
              </p>
            </div>
          </div>

          <label className="relative inline-flex items-center cursor-pointer shrink-0" aria-label="Toggle noise cancellation">
            <input
              id="noise-cancellation-toggle"
              type="checkbox"
              aria-label="Toggle noise cancellation"
              disabled={!isNoiseCancellationSupported}
              checked={noiseCancellationEnabled}
              onChange={(e) => onNoiseCancellationChange(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-zinc-700 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-indigo-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600 peer-disabled:opacity-40 peer-disabled:cursor-not-allowed" />
          </label>
        </div>

        {!isNoiseCancellationSupported ? (
          <p className="text-[11px] text-amber-400/90 mt-3 pt-2 border-t border-gray-700/60">
            Noise suppression is not programmatically controllable on this browser or platform. Your browser or hardware may apply native filtering automatically.
          </p>
        ) : (
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 mt-3 pt-2 border-t border-gray-700/60">
            <ShieldCheck size={13} className="text-emerald-400" />
            <span>Browser-native audio isolation active</span>
          </div>
        )}
      </div>
    </div>
  );
}
