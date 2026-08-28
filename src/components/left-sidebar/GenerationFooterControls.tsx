import { useRef } from 'react';
import type { Dispatch, MutableRefObject, PointerEvent, SetStateAction } from 'react';
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
  opusUsage?: import('../../api/localSidecarApi').OpusUsage;
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
  opusUsage,
  img2imgStrengthForCost,
  preciseRefCount,
  vibeRefCount,
  onPendingImageImport,
}: GenerationFooterControlsProps) {
  const currentResolutionLabel = isCustomRes ? '自定义' : getResolutionLabel(resolution);

  return (
    <div className="border-t border-gray-800 bg-nai-panel shrink-0 z-10">
      <div className="px-3 pt-2 pb-1">
        <div className="grid grid-cols-4 gap-1 text-sm bg-nai-dark/30 px-1.5 py-1 rounded border border-gray-800">
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
            className="flex flex-col justify-center px-1 py-0.5 cursor-pointer hover:bg-white/5 rounded transition-colors overflow-hidden"
            onClick={() => {
              if (!seed) scrollToAISettings('seed');
              else setSeed('');
            }}
          >
            <div className="text-gray-500 text-[10px] leading-none">种子</div>
            <div className="font-bold text-white text-sm leading-tight truncate tabular-nums" title={seed || 'N/A'}>{seed || 'N/A'}</div>
          </div>
          <div className="relative h-full">
            <div
              className="cursor-pointer hover:bg-white/5 rounded px-1 py-0.5 transition-colors h-full flex flex-col justify-center select-none"
              onClick={() => setIsResSelectorOpen(!isResSelectorOpen)}
              onWheel={(event) => {
                const nextResolution = getWheelResolution(event.deltaY, resolution, isCustomRes);
                handleResolutionChange(nextResolution);
              }}
            >
              <div className="text-gray-500 text-[10px] leading-none">比例</div>
              <div className="font-bold text-white text-sm leading-tight truncate" title={`${customWidth} x ${customHeight}`}>
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
        opusUsage={opusUsage}
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

// 拖动灵敏度:每移动这么多像素记一档。太小会让轻微手抖也改数值,
// 太大又拖不动;6px 是在触控板与鼠标上都跟手的值。
const DRAG_STEP_PX = 6;

function QuickNumberCell({
  label,
  value,
  onClick,
  onWheel,
}: {
  label: string;
  value: number;
  onClick: () => void;
  /** 传入方向:正=增,负=减(滚轮与拖动共用同一步进逻辑)。 */
  onWheel: (deltaY: number) => void;
}) {
  const dragState = useRef<{ x: number; y: number; accum: number; moved: boolean } | null>(null);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // 只接管主键拖动,右键/中键留给系统
    if (event.button !== 0) return;
    dragState.current = { x: event.clientX, y: event.clientY, accum: 0, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = dragState.current;
    if (!state) return;
    // 上=增、右=增:两个方向都支持,取位移较大的那个轴,
    // 这样斜着拖也不会两个轴互相抵消。
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    state.x = event.clientX;
    state.y = event.clientY;
    state.accum += Math.abs(dx) > Math.abs(dy) ? dx : -dy;
    while (Math.abs(state.accum) >= DRAG_STEP_PX) {
      const direction = state.accum > 0 ? 1 : -1;
      state.accum -= direction * DRAG_STEP_PX;
      state.moved = true;
      // onWheel 的约定与滚轮一致:deltaY 为负表示「增」
      onWheel(-direction);
    }
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const state = dragState.current;
    dragState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // 拖过就不再当作点击,否则松手会顺带跳去 AI 设置面板
    if (state && !state.moved) onClick();
  };

  return (
    <div
      className="cursor-ns-resize hover:bg-white/5 rounded px-1 py-0.5 transition-colors select-none touch-none flex flex-col justify-center"
      title={`${label}:滚轮或上下/左右拖动调整,点击跳到设置`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={(event) => onWheel(event.deltaY)}
    >
      <div className="text-gray-500 text-[10px] leading-none">{label}</div>
      <div className="font-bold text-white text-sm leading-tight tabular-nums">{value}</div>
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
