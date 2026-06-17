import { Grid, ImagePlus, Loader2, Send, SlidersHorizontal } from 'lucide-react';
import { calculateCostFromUI } from '../../services/costCalculator';
import type { ActivePreciseRef, ActiveVibe } from './types';

interface MobileGenerateToolbarProps {
  currentResLabel: string;
  openAdvancedSettings: () => void;
  openResolutionDropdown: () => void;
  openImageFile: (file: File) => void;
  onGenerate: () => void;
  cancelTask: () => Promise<boolean>;
  isGenerating: boolean;
  isQueuing: boolean;
  isPreparing: boolean;
  queuePosition: number;
  currentStep: number;
  totalSteps: number;
  width: number;
  height: number;
  steps: number;
  model: string;
  sampler: string;
  isOpus: boolean;
  img2imgImage: string | null;
  img2imgStrength: number;
  activePreciseRefs: ActivePreciseRef[];
  activeVibes: ActiveVibe[];
}

export function MobileGenerateToolbar({
  currentResLabel,
  openAdvancedSettings,
  openResolutionDropdown,
  openImageFile,
  onGenerate,
  cancelTask,
  isGenerating,
  isQueuing,
  isPreparing,
  queuePosition,
  currentStep,
  totalSteps,
  width,
  height,
  steps,
  model,
  sampler,
  isOpus,
  img2imgImage,
  img2imgStrength,
  activePreciseRefs,
  activeVibes,
}: MobileGenerateToolbarProps) {
  const isBusy = isGenerating || isQueuing || isPreparing;
  const cost = calculateCostFromUI({
    width,
    height,
    steps,
    modelId: model,
    sampler,
    isOpus,
    img2imgStrength: img2imgImage ? img2imgStrength : undefined,
    preciseRefCount: activePreciseRefs.filter((ref) => ref.enabled).length,
    vibeRefCount: activeVibes.filter((vibe) => vibe.enabled).length,
  });

  return (
    <div className="flex-shrink-0 bg-nai-panel border-t border-gray-800 safe-area-bottom">
      <div className="flex items-center gap-2 p-3">
        <button
          onClick={openAdvancedSettings}
          className="w-10 h-10 flex items-center justify-center rounded-lg bg-gray-800 border border-gray-700 text-gray-400 active:scale-95 transition-all"
        >
          <SlidersHorizontal className="w-4 h-4" />
        </button>

        <button
          onClick={openResolutionDropdown}
          className="h-10 flex items-center gap-1.5 px-3 bg-gray-800 border border-gray-700 rounded-lg text-sm active:scale-[0.98] transition-all"
        >
          <Grid className="w-4 h-4 text-gray-400" />
          <span className="text-gray-200">{currentResLabel}</span>
        </button>

        <label className="h-10 flex items-center justify-center px-3 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 active:scale-[0.98] transition-all cursor-pointer">
          <ImagePlus className="w-4 h-4" />
          <input
            type="file"
            accept="image/*,.vibe"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                openImageFile(file);
              }
              event.target.value = '';
            }}
          />
        </label>

        <button
          onClick={onGenerate}
          disabled={isBusy}
          className={`flex-1 h-10 flex items-center justify-center px-4 rounded-lg font-bold text-sm transition-all active:scale-[0.98] relative overflow-hidden ${isBusy
            ? 'bg-gray-700 text-gray-300'
            : 'bg-nai-accent text-black'
            }`}
        >
          {isGenerating && totalSteps > 0 && (
            <div
              className="absolute inset-0 bg-nai-accent/30 transition-all duration-200"
              style={{ width: `${(currentStep / totalSteps) * 100}%` }}
            />
          )}
          {isBusy ? (
            <div className="flex items-center gap-2 relative z-10">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="shrink-0 whitespace-nowrap">
                {isQueuing ? `排队中 #${queuePosition}` : (isGenerating && currentStep > 0) ? `生成中 ${currentStep}/${totalSteps}` : '准备中...'}
              </span>
              {isQueuing && (
                <button
                  onClick={(event) => { event.stopPropagation(); cancelTask(); }}
                  className="ml-2 px-2 py-0.5 text-xs bg-black/20 hover:bg-black/40 rounded transition-colors shrink-0 whitespace-nowrap"
                >
                  取消
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center gap-1.5">
                <Send className="w-4 h-4" />
                <span>生成</span>
              </div>
              <div className="flex items-center gap-1 bg-black/15 px-2 py-0.5 rounded text-xs font-mono font-bold">
                <span>{cost.total}</span>
                <span>💎</span>
              </div>
            </div>
          )}
        </button>
      </div>
    </div>
  );
}
