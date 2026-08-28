import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { ImagePlus, Loader2, RefreshCw, X } from 'lucide-react';
import { calculateCostFromUI } from '../../services/costCalculator';
import { getCachedOpusUsage, isOpusUsageExhausted } from '../../services/novelai';
import { OpusUsageBar, shouldShowOpusUsage } from '../generation/OpusUsageBar';
import { modelCapabilities } from '../generation/modelResolutionOptions';

interface GenerationActionGroupProps {
  isGenerating: boolean;
  isPreparing: boolean;
  isLoopGenerating: boolean;
  setIsLoopGenerating: Dispatch<SetStateAction<boolean>>;
  loopGeneratingRef: MutableRefObject<boolean>;
  handleGenerate: () => void;
  aprilFoolsEffect: number | null;
  aprilSpinActive: boolean;
  setAprilSpinActive: (active: boolean) => void;
  setAprilCostActive: (active: boolean) => void;
  resetAprilFoolsCost: () => void;
  aprilFoolsCost: number;
  customWidth: number;
  customHeight: number;
  steps: number;
  selectedModelId: string;
  sampler: string;
  isOpus: boolean;
  img2imgStrengthForCost?: number;
  preciseRefCount: number;
  vibeRefCount: number;
  onPendingImageImport: (file: File, dataUrl: string, isVibeFile: boolean) => void;
}

export function GenerationActionGroup({
  isGenerating,
  isPreparing,
  isLoopGenerating,
  setIsLoopGenerating,
  loopGeneratingRef,
  handleGenerate,
  aprilFoolsEffect,
  aprilSpinActive,
  setAprilSpinActive,
  setAprilCostActive,
  resetAprilFoolsCost,
  aprilFoolsCost,
  customWidth,
  customHeight,
  steps,
  selectedModelId,
  sampler,
  isOpus,
  img2imgStrengthForCost,
  preciseRefCount,
  vibeRefCount,
  onPendingImageImport,
}: GenerationActionGroupProps) {
  const isBusy = isGenerating || isLoopGenerating || isPreparing;
  const cost = calculateCostFromUI({
    // V5 体力条耗尽后 NAI 静默改扣 Anlas；不带上这个标志，界面会一直显示「免费」
    opusUsageExhausted: isOpusUsageExhausted(),
    width: customWidth,
    height: customHeight,
    steps,
    modelId: selectedModelId,
    sampler,
    isOpus,
    img2imgStrength: img2imgStrengthForCost,
    preciseRefCount,
    vibeRefCount,
  });
  const displayedCost = aprilFoolsEffect === 1 ? cost.total + aprilFoolsCost : cost.total;
  const opusUsage = getCachedOpusUsage();
  const showUsageBar = shouldShowOpusUsage(
    opusUsage,
    isOpus,
    modelCapabilities(selectedModelId).opusUsageLimit,
  );

  return (
    <>
    {showUsageBar && (
      <div className="px-3">
        <OpusUsageBar usage={opusUsage} />
      </div>
    )}
    <div className="p-3 pt-1.5 flex gap-2">
      <div
        className={`flex-1 font-bold rounded-md flex items-stretch overflow-hidden transition-all ${isBusy ? 'bg-gray-600' : 'bg-nai-accent'}`}
        style={aprilFoolsEffect === 0 && aprilSpinActive ? { animation: 'spin 1s linear infinite' } : undefined}
      >
        <button
          className={`flex-1 py-2.5 flex items-center justify-between px-4 transition-all ${isBusy ? 'text-gray-300 cursor-not-allowed' : 'hover:bg-black/5 text-black'}`}
          onClick={() => {
            setAprilSpinActive(false);
            setAprilCostActive(false);
            resetAprilFoolsCost();
            handleGenerate();
          }}
          disabled={isBusy}
        >
          {isBusy ? (
            <span className="flex items-center gap-2">
              {isLoopGenerating ? (
                <RefreshCw className="w-4 h-4 animate-spin" style={{ animationDuration: '1.5s' }} />
              ) : (
                <Loader2 className="w-4 h-4 animate-spin" />
              )}
              {isLoopGenerating ? '循环生成中...' : isPreparing ? '准备中...' : '生成中...'}
            </span>
          ) : (
            <>
              <span>生成 1 张图像</span>
              <div className="flex items-center gap-1 bg-black/10 px-2 py-0.5 rounded text-sm font-mono font-bold">
                <span>{displayedCost}</span>
                <span>💎</span>
              </div>
            </>
          )}
        </button>
        <button
          className={`px-3 flex items-center justify-center border-l transition-all ${isLoopGenerating
            ? 'border-gray-500/40 text-gray-200 hover:bg-white/10 hover:text-white'
            : isGenerating || isPreparing
              ? 'border-gray-500/30 text-gray-400'
              : 'border-black/10 text-black/60 hover:text-black hover:bg-black/5'
          }`}
          onClick={() => {
            if (isLoopGenerating) {
              setIsLoopGenerating(false);
              loopGeneratingRef.current = false;
            } else {
              setIsLoopGenerating(true);
              loopGeneratingRef.current = true;
              if (!isGenerating && !isPreparing) {
                handleGenerate();
              }
            }
          }}
          title={isLoopGenerating ? '停止循环生成' : '开始循环生成'}
        >
          {isLoopGenerating ? <X className="w-4 h-4" /> : <RefreshCw className="w-4 h-4" />}
        </button>
      </div>

      <label
        className="aspect-square py-2.5 px-2.5 rounded-md font-bold transition-all border flex items-center justify-center bg-nai-accent/10 hover:bg-nai-accent/20 text-nai-accent border-nai-accent/30 cursor-pointer"
        title="导入图片"
      >
        <ImagePlus className="w-5 h-5" />
        <input
          type="file"
          accept="image/*,.vibe"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onloadend = () => {
              const dataUrl = reader.result as string;
              const isVibeFile = file.name.toLowerCase().endsWith('.vibe') || file.name.toLowerCase().endsWith('.naiv4vibe');
              onPendingImageImport(file, dataUrl, isVibeFile);
            };
            reader.readAsDataURL(file);
            event.target.value = '';
          }}
        />
      </label>
    </div>
    </>
  );
}
