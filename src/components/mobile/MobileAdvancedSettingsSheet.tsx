import { Check, ChevronDown, Settings, SlidersHorizontal, X } from 'lucide-react';
import type { PromptPresetData } from '../../services/localLibrary';
import { SliderControl, OptionGrid } from './settings/AdvancedSettingControls';

interface MobileAdvancedSettingsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  promptPresets: PromptPresetData[];
  activePresetId: string;
  onApplyPreset: (preset: PromptPresetData) => void;
  isPresetExpanded: boolean;
  setIsPresetExpanded: (expanded: boolean) => void;
  steps: number;
  setSteps: (steps: number) => void;
  scale: number;
  setScale: (scale: number) => void;
  seed: string;
  setSeed: (seed: string) => void;
  sampler: string;
  setSampler: (sampler: string) => void;
  cfgRescale: number;
  setCfgRescale: (cfgRescale: number) => void;
  noiseSchedule: string;
  setNoiseSchedule: (noiseSchedule: string) => void;
  varietyPlus: boolean;
  setVarietyPlus: (enabled: boolean) => void;
}

const SAMPLERS = [
  { id: 'k_euler_ancestral', name: 'Euler Ancestral' },
  { id: 'k_euler', name: 'Euler' },
  { id: 'k_dpmpp_2s_ancestral', name: 'DPM++ 2S Ancestral' },
  { id: 'k_dpmpp_2m_sde', name: 'DPM++ 2M SDE' },
  { id: 'k_dpmpp_2m', name: 'DPM++ 2M' },
  { id: 'k_dpmpp_sde', name: 'DPM++ SDE' },
];

const NOISE_SCHEDULES = [
  { id: 'karras', name: 'Karras' },
  { id: 'exponential', name: 'Exponential' },
  { id: 'polyexponential', name: 'Polyexponential' },
];

export function MobileAdvancedSettingsSheet({
  isOpen,
  onClose,
  promptPresets,
  activePresetId,
  onApplyPreset,
  isPresetExpanded,
  setIsPresetExpanded,
  steps,
  setSteps,
  scale,
  setScale,
  seed,
  setSeed,
  sampler,
  setSampler,
  cfgRescale,
  setCfgRescale,
  noiseSchedule,
  setNoiseSchedule,
  varietyPlus,
  setVarietyPlus,
}: MobileAdvancedSettingsSheetProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end animate-fade-in">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="relative w-full bg-nai-panel rounded-t-2xl max-h-[80vh] flex flex-col animate-slide-in-from-bottom safe-area-bottom">
        <div className="flex-shrink-0 flex items-center justify-between p-4 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-5 h-5 text-nai-accent" />
            <h3 className="text-lg font-bold text-white">生成设置</h3>
          </div>
          <button onClick={onClose} className="p-2 -mr-2 text-gray-400">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="bg-gray-800/50 rounded-xl overflow-hidden">
            <button
              onClick={() => setIsPresetExpanded(!isPresetExpanded)}
              className="w-full p-3 flex items-center justify-between active:bg-gray-700/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <Settings className="w-5 h-5 text-nai-accent" />
                <span className="text-sm font-medium text-gray-300">提示词预设</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-nai-accent">
                  {promptPresets.find((preset) => preset.id === activePresetId)?.name || '未选择'}
                </span>
                <ChevronDown
                  className={`w-4 h-4 text-gray-400 transition-transform ${isPresetExpanded ? 'rotate-180' : ''}`}
                />
              </div>
            </button>
            {isPresetExpanded && (
              <div className="border-t border-gray-700 p-2 space-y-1 max-h-[200px] overflow-y-auto">
                {promptPresets.map((preset) => {
                  const isActive = activePresetId === preset.id;
                  return (
                    <button
                      key={preset.id}
                      onClick={() => {
                        onApplyPreset(preset);
                        setIsPresetExpanded(false);
                      }}
                      className={`w-full p-2.5 rounded-lg text-left transition-colors ${isActive
                        ? 'bg-nai-accent/20 border border-nai-accent/50'
                        : 'bg-gray-800/50 border border-transparent hover:bg-gray-700/50'
                        }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className={`text-sm font-medium ${isActive ? 'text-nai-accent' : 'text-gray-300'}`}>
                          {preset.name}
                        </span>
                        {isActive && <Check className="w-4 h-4 text-nai-accent" />}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <SliderControl
            label="Steps 步数"
            value={steps}
            min={1}
            max={50}
            step={1}
            onChange={(value) => setSteps(Math.round(value))}
          />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-300">Prompt Guidance</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setVarietyPlus(!varietyPlus)}
                  className={`px-2 py-1 text-xs rounded border flex items-center gap-1 transition-colors ${varietyPlus
                    ? 'bg-nai-accent/20 text-nai-accent border-nai-accent'
                    : 'bg-gray-800 text-gray-400 border-gray-700'
                    }`}
                >
                  {varietyPlus ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
                  Variety+
                </button>
                <span className="text-sm font-mono text-nai-accent">{scale}</span>
              </div>
            </div>
            <input
              type="range"
              min="0"
              max="25"
              step="0.1"
              value={scale}
              onChange={(event) => setScale(parseFloat(event.target.value))}
              className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-300">Seed 种子</span>
              <button onClick={() => setSeed('')} className="text-xs text-gray-500 hover:text-white">
                清空
              </button>
            </div>
            <input
              type="text"
              value={seed}
              onChange={(event) => setSeed(event.target.value)}
              placeholder="随机"
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-nai-accent"
            />
          </div>

          <OptionGrid
            label="Sampler 采样器"
            options={SAMPLERS}
            value={sampler}
            onChange={setSampler}
          />

          <SliderControl
            label="Prompt Guidance Rescale"
            value={cfgRescale}
            min={0}
            max={1}
            step={0.01}
            onChange={setCfgRescale}
          />

          <OptionGrid
            label="Noise Schedule 噪声调度"
            options={NOISE_SCHEDULES}
            value={noiseSchedule}
            onChange={setNoiseSchedule}
          />
        </div>

        <div className="flex-shrink-0 p-4 border-t border-gray-700 flex gap-3">
          <button
            onClick={() => {
              setSteps(28);
              setScale(5);
              setSeed('');
              setSampler('k_euler_ancestral');
              setNoiseSchedule('karras');
              setCfgRescale(0);
              setVarietyPlus(false);
            }}
            className="flex-1 py-3 bg-gray-700 text-white font-bold rounded-xl active:scale-[0.98] transition-all"
          >
            重置默认
          </button>
          <button
            onClick={onClose}
            className="flex-1 py-3 bg-nai-accent text-black font-bold rounded-xl active:scale-[0.98] transition-all"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  );
}
