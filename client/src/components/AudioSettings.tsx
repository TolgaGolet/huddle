import { Mic, Volume2 } from "lucide-react";

interface Props {
  audioInputs: MediaDeviceInfo[];
  selectedDeviceId: string;
  onDeviceChange: (deviceId: string) => void;
  inputGain: number;
  onInputGainChange: (value: number) => void;
}

export default function AudioSettings({
  audioInputs,
  selectedDeviceId,
  onDeviceChange,
  inputGain,
  onInputGainChange,
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

      <div>
        <label className="flex items-center gap-2 text-sm font-medium text-gray-300 mb-2">
          <Volume2 size={16} />
          Input Volume
        </label>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={300}
            value={Math.round(inputGain * 100)}
            onChange={(e) => onInputGainChange(Number(e.target.value) / 100)}
            className="flex-1 accent-indigo-500 h-1"
          />
          <span className="text-sm text-gray-400 w-12 text-right">
            {Math.round(inputGain * 100)}%
          </span>
        </div>
      </div>
    </div>
  );
}
