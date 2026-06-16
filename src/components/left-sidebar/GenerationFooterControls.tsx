import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ResolutionPreset, ClampedSize } from '../generation/modelResolutionOptions';
import {
  LARGE_RESOLUTIONS,
  RESOLUTIONS,
  WALLPAPER_RESOLUTIONS,
} from '../generation/modelResolutionOptions';
import { GenerationActionGroup } from './GenerationActionGroup';
import { ResolutionSelectorPopup } from './ResolutionSelectorPopup';
import type { ToastType } from './types';

type ResolutionTab = 'small' | 'large' | 'wallpaper';

interface GenerationFooterControlsProps {
  steps: number;
  setSteps: Dispatch<SetStateAction<number>>;
  scale: number;
  setScale: Dispatch<SetStateAction<number>>;
  seed: string;
  setSeed: (seed: string) => void;
  scrollToAISettings: (settingName: string) => void;
  isResSelectorOpen: boolean;
  setIsResSelectorOpen: Dispatch<SetStateAction<boolean>>;
  resolutionTab: ResolutionTab;
  setResolutionTab: Dispatch<SetStateAction<ResolutionTab>>;
  resHighlight: boolean;
  resolution: ResolutionPreset;
  isCustomRes: boolean;
  setIsCustomRes: Dispatch<SetStateAction<boolean>>;
  customWidth: number;
  customHeight: number;
  customWidthInput: string;
  customHeightInput: string;
  setCustomWidth: Dispatch<SetStateAction<number>>;
  setCustomHeight: Dispatch<SetStateAction<number>>;
  setCustomWidthInput: Dispatch<SetStateAction<string>>;
  setCustomHeightInput: Dispatch<SetStateAction<string>>;
  setResolution: Dispatch<SetStateAction<ResolutionPreset>>;
  handleResolutionChange: (resolution: ResolutionPreset) => void;
  resolutionSourceRef: MutableRefObject<string>;
  reportResolutionNormalization: (source: string, result: ClampedSize) => void;
  showToast: (message: string, type: ToastType) => void;
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
  selectedModelId: string;
  sampler: string;
  isOpus: boolean;
  img2imgStrengthForCost?: number;
  preciseRefCount: number;
  vibeRefCount: number;
  onPendingImageImport: (file: File, dataUrl: string, isVibeFile: boolean) => void;
}

export function GenerationFooterControls({
  steps,
  setSteps,
  scale,
  setScale,
  seed,
  setSeed,
  scrollToAISettings,
  isResSelectorOpen,
  setIsResSelectorOpen,
  resolutionTab,
  setResolutionTab,
  resHighlight,
  resolution,
  isCustomRes,
  setIsCustomRes,
  customWidth,
  customHeight,
  customWidthInput,
  customHeightInput,
  setCustomWidth,
  setCustomHeight,
  setCustomWidthInput,
  setCustomHeightInput,
  setResolution,
  handleResolutionChange,
  resolutionSourceRef,
  reportResolutionNormalization,
  showToast,
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
  selectedModelId,
  sampler,
  isOpus,
  img2imgStrengthForCost,
  preciseRefCount,
  vibeRefCount,
  onPendingImageImport,
}: GenerationFooterControlsProps) {
  const currentResolutionLabel = isCustomRes ? '自定义' : getResolutionLabel(resolution);

  return (
    <div className="border-t border-gray-800 bg-nai-panel shrink-0 z-10">
      <div className="p-3 pb-1.5">
        <div className="grid grid-cols-4 gap-2 text-sm bg-nai-dark/30 p-2 rounded border border-gray-800">
          <QuickNumberCell
            label="步数"
            value={steps}
            onClick={() => scrollToAISettings('steps')}
            onWheel={(delta) => setSteps((prev) => Math.min(Math.max(prev + (delta > 0 ? -1 : 1), 1), 50))}
          />
          <QuickNumberCell
            label="引导"
            value={scale}
            onClick={() => scrollToAISettings('scale')}
            onWheel={(delta) => {
              const amount = delta > 0 ? -0.1 : 0.1;
              setScale((prev) => Number(Math.min(Math.max(prev + amount, 0), 25).toFixed(1)));
            }}
          />
          <div
            className="flex flex-col justify-between p-1 cursor-pointer hover:bg-white/5 rounded transition-colors overflow-hidden"
            onClick={() => {
              if (!seed) scrollToAISettings('seed');
              else setSeed('');
            }}
          >
            <div className="text-gray-400 text-xs mb-1">种子</div>
            <div className="font-bold text-white text-xs truncate" title={seed || 'N/A'}>{seed || 'N/A'}</div>
          </div>
          <div className="relative h-full">
            <div
              className="cursor-pointer hover:bg-white/5 rounded p-1 transition-colors h-full flex flex-col justify-between select-none"
              onClick={() => setIsResSelectorOpen(!isResSelectorOpen)}
              onWheel={(event) => {
                const nextResolution = getWheelResolution(event.deltaY, resolution, isCustomRes);
                handleResolutionChange(nextResolution);
              }}
            >
              <div className="text-gray-400 text-xs mb-1">比例</div>
              <div className="font-bold text-white text-xs truncate" title={`${customWidth} x ${customHeight}`}>
                {currentResolutionLabel}
              </div>
            </div>

            {isResSelectorOpen && (
              <ResolutionSelectorPopup
                resHighlight={resHighlight}
                resolutionTab={resolutionTab}
                onResolutionTabChange={setResolutionTab}
                resolution={resolution}
                isCustomRes={isCustomRes}
                customWidth={customWidth}
                customHeight={customHeight}
                customWidthInput={customWidthInput}
                customHeightInput={customHeightInput}
                setCustomWidth={setCustomWidth}
                setCustomHeight={setCustomHeight}
                setCustomWidthInput={setCustomWidthInput}
                setCustomHeightInput={setCustomHeightInput}
                setIsCustomRes={setIsCustomRes}
                setResolution={setResolution}
                onClose={() => setIsResSelectorOpen(false)}
                onResolutionChange={handleResolutionChange}
                resolutionSourceRef={resolutionSourceRef}
                reportResolutionNormalization={reportResolutionNormalization}
                showToast={showToast}
              />
            )}
          </div>
        </div>
      </div>

      <GenerationActionGroup
        isGenerating={isGenerating}
        isPreparing={isPreparing}
        isLoopGenerating={isLoopGenerating}
        setIsLoopGenerating={setIsLoopGenerating}
        loopGeneratingRef={loopGeneratingRef}
        handleGenerate={handleGenerate}
        aprilFoolsEffect={aprilFoolsEffect}
        aprilSpinActive={aprilSpinActive}
        setAprilSpinActive={setAprilSpinActive}
        setAprilCostActive={setAprilCostActive}
        resetAprilFoolsCost={resetAprilFoolsCost}
        aprilFoolsCost={aprilFoolsCost}
        customWidth={customWidth}
        customHeight={customHeight}
        steps={steps}
        selectedModelId={selectedModelId}
        sampler={sampler}
        isOpus={isOpus}
        img2imgStrengthForCost={img2imgStrengthForCost}
        preciseRefCount={preciseRefCount}
        vibeRefCount={vibeRefCount}
        onPendingImageImport={onPendingImageImport}
      />
    </div>
  );
}

function QuickNumberCell({
  label,
  value,
  onClick,
  onWheel,
}: {
  label: string;
  value: number;
  onClick: () => void;
  onWheel: (deltaY: number) => void;
}) {
  return (
    <div
      className="cursor-ns-resize hover:bg-white/5 rounded p-1 transition-colors select-none flex flex-col justify-between"
      onClick={onClick}
      onWheel={(event) => onWheel(event.deltaY)}
    >
      <div className="text-gray-400 text-xs mb-1">{label}</div>
      <div className="font-bold text-white">{value}</div>
    </div>
  );
}

function getResolutionLabel(resolution: ResolutionPreset) {
  const isSmall = RESOLUTIONS.some((preset) => preset.width === resolution.width && preset.height === resolution.height);
  const isLarge = LARGE_RESOLUTIONS.some((preset) => preset.width === resolution.width && preset.height === resolution.height);
  const isWallpaper = WALLPAPER_RESOLUTIONS.some((preset) => preset.width === resolution.width && preset.height === resolution.height);
  const category = isSmall ? '小图' : isLarge ? '大图' : isWallpaper ? '壁纸' : '';
  return category ? `${category} · ${resolution.label}` : resolution.label;
}

function getWheelResolution(deltaY: number, resolution: ResolutionPreset, isCustomRes: boolean) {
  const delta = deltaY > 0 ? 1 : -1;
  const isLarge = LARGE_RESOLUTIONS.some((preset) => preset.width === resolution.width && preset.height === resolution.height);
  const isWallpaper = WALLPAPER_RESOLUTIONS.some((preset) => preset.width === resolution.width && preset.height === resolution.height);
  const currentPresets = isLarge ? LARGE_RESOLUTIONS : isWallpaper ? WALLPAPER_RESOLUTIONS : RESOLUTIONS;
  const currentIndex = currentPresets.findIndex((preset) => preset.width === resolution.width && preset.height === resolution.height);
  const nextIndex = isCustomRes || currentIndex === -1
    ? (delta > 0 ? 0 : currentPresets.length - 1)
    : (currentIndex + delta + currentPresets.length) % currentPresets.length;
  return currentPresets[nextIndex];
}
