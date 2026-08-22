import { Mic, Volume2 } from "lucide-react";

interface Props {
  audioInputs: MediaDeviceInfo[];
  selectedDeviceId: string;
  onDeviceChange: (deviceId: string) => void;
}

export default function AudioSettings({
  audioInputs,
  selectedDeviceId,
  onDeviceChange,
}: Props) {
  return (
    <div className="space-y-6">
      <div>
        <label className="flex items-center gap-2 text-sm font-medium text-gray-300 mb-2">
          <Mic size={16} />
          Input Device
        </label>
        <select
          value={selectedDeviceId}
          onChange={(e) => onDeviceChange(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-gray-700 border border-gray-600 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
        >
          {audioInputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Microphone (${d.deviceId.slice(0, 8)}...)`}
            </option>
          ))}
          {audioInputs.length === 0 && <option value="">No devices found</option>}
        </select>
      </div>

      <div className="rounded-lg bg-gray-800/60 border border-gray-700 p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-300 mb-1">
          <Volume2 size={16} />
          Noise & Echo Suppression
        </div>
        <p className="text-xs text-gray-400 leading-relaxed">
          Huddle uses your browser's built-in echo cancellation, noise
          suppression, and automatic gain control. For the clearest voice, use a headset with a
          boom microphone. On Safari, app-controlled noise suppression is
          limited by the browser; a USB/headset mic with hardware processing
          gives the best results.
        </p>
      </div>
    </div>
  );
}
