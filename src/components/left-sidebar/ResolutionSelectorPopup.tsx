import type { MutableRefObject } from 'react';
import { ArrowLeftRight, Check, X } from 'lucide-react';
import {
  LARGE_RESOLUTIONS,
  MAX_TOTAL_PIXELS,
  RESOLUTIONS,
  WALLPAPER_RESOLUTIONS,
  clampToMaxPixels,
  getPixelCount,
  type ClampedSize,
  type ResolutionPreset,
} from '../generation/modelResolutionOptions';
import type { ToastType } from './types';

type ResolutionTab = 'small' | 'large' | 'wallpaper';

interface ResolutionSelectorPopupProps {
  resHighlight: boolean;
  resolutionTab: ResolutionTab;
  onResolutionTabChange: (tab: ResolutionTab) => void;
  resolution: ResolutionPreset;
  isCustomRes: boolean;
  customWidth: number;
  customHeight: number;
  customWidthInput: string;
  customHeightInput: string;
  setCustomWidth: (width: number) => void;
  setCustomHeight: (height: number) => void;
  setCustomWidthInput: (width: string) => void;
  setCustomHeightInput: (height: string) => void;
  setIsCustomRes: (isCustom: boolean) => void;
  setResolution: (resolution: ResolutionPreset) => void;
  onClose: () => void;
  onResolutionChange: (resolution: ResolutionPreset) => void;
  resolutionSourceRef: MutableRefObject<string>;
  reportResolutionNormalization: (source: string, result: ClampedSize) => void;
  showToast: (message: string, type: ToastType) => void;
}

export function ResolutionSelectorPopup({
  resHighlight,
  resolutionTab,
  onResolutionTabChange,
  resolution,
  isCustomRes,
  customWidth,
  customHeight,
  customWidthInput,
  customHeightInput,
  setCustomWidth,
  setCustomHeight,
  setCustomWidthInput,
  setCustomHeightInput,
  setIsCustomRes,
  setResolution,
  onClose,
  onResolutionChange,
  resolutionSourceRef,
  reportResolutionNormalization,
  showToast,
}: ResolutionSelectorPopupProps) {
  const currentPresets = resolutionTab === 'small'
    ? RESOLUTIONS
    : resolutionTab === 'large'
      ? LARGE_RESOLUTIONS
      : WALLPAPER_RESOLUTIONS;

  const applyCustomResolution = (width: number, height: number, source: string) => {
    resolutionSourceRef.current = source;
    setCustomWidth(width);
    setCustomHeight(height);
    setCustomWidthInput(String(width));
    setCustomHeightInput(String(height));
    setIsCustomRes(true);
    setResolution({ label: '自定义', width, height });
  };

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className={`absolute bottom-full right-0 mb-2 w-52 bg-nai-panel border rounded-lg shadow-xl p-2 z-50 ${resHighlight ? 'border-nai-accent ring-2 ring-nai-accent/40' : 'border-gray-700'}`}>
        <div className="flex items-center justify-between mb-2 pb-2 border-b border-gray-700">
          <span className="text-sm font-bold text-white">选择比例</span>
          <X className="w-4 h-4 text-gray-400 cursor-pointer hover:text-white" onClick={onClose} />
        </div>

        <div className="relative flex gap-1 mb-2 bg-black/20 rounded p-0.5">
          <div
            className="absolute top-0.5 bottom-0.5 rounded bg-nai-accent transition-all duration-200 ease-out"
            style={{
              width: 'calc((100% - 0.75rem) / 3)',
              left: resolutionTab === 'small' ? '0.125rem' : resolutionTab === 'large' ? 'calc((100% - 0.75rem) / 3 + 0.375rem)' : 'calc((100% - 0.75rem) / 3 * 2 + 0.625rem)',
            }}
          />
          <ResolutionTabButton active={resolutionTab === 'small'} onClick={() => onResolutionTabChange('small')} label="小图" />
          <ResolutionTabButton active={resolutionTab === 'large'} onClick={() => onResolutionTabChange('large')} label="大图" />
          <ResolutionTabButton active={resolutionTab === 'wallpaper'} onClick={() => onResolutionTabChange('wallpaper')} label="壁纸" />
        </div>

        <div className="space-y-1 mb-2">
          {currentPresets.map((preset) => {
            const isActive = !isCustomRes && resolution.width === preset.width && resolution.height === preset.height;
            return (
              <button
                key={`${resolutionTab}-${preset.label}`}
                className={`w-full flex items-baseline justify-between px-2 py-1.5 rounded text-sm transition-colors ${isActive ? 'bg-nai-accent text-black font-bold' : 'text-gray-300 hover:bg-gray-700'}`}
                onClick={() => onResolutionChange(preset)}
              >
                <span>{preset.label}</span>
                <span className={`text-xs font-mono tabular-nums tracking-tight ${isActive ? 'text-black/60' : 'text-gray-500'}`}>
                  {preset.width}×{preset.height}
                </span>
              </button>
            );
          })}
        </div>

        <div className="border-t border-gray-700 pt-2">
          <div className="flex items-center justify-between mb-2 min-h-[16px]">
            <div className="text-xs text-gray-400">自定义尺寸</div>
            <span
              className={`text-[10px] text-gray-500 hover:text-gray-300 underline cursor-pointer transition-opacity duration-150 ${customWidth * customHeight > 1048576 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
              onClick={() => {
                const ratio = customWidth / customHeight;
                const maxPixels = 1048576;
                let bestW = 64;
                let bestH = 64;
                for (let width = 64; width <= 2048; width += 64) {
                  const idealH = width / ratio;
                  const height = Math.max(64, Math.round(idealH / 64) * 64);
                  if (width * height > maxPixels) continue;
                  if (width * height > bestW * bestH) {
                    bestW = width;
                    bestH = height;
                  }
                }
                applyCustomResolution(bestW, bestH, `用户点击缩放到免费尺寸 ${bestW}×${bestH}`);
                showToast(`已调整到免费尺寸：${bestW}×${bestH}`, 'success');
              }}
              title="调整为像素总数不超过免费阈值(1024×1024)的最接近比例"
            >
              缩放到免费尺寸
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              step={64}
              min={64}
              className="w-16 bg-black/20 border border-gray-700 rounded px-2 py-1 text-xs text-white outline-none focus:border-nai-accent text-center"
              value={customWidthInput}
              onChange={(event) => setCustomWidthInput(event.target.value)}
              onWheel={(event) => {
                event.preventDefault();
                const delta = event.deltaY < 0 ? 64 : -64;
                const nextWidth = Math.max(64, customWidth + delta);
                if (getPixelCount(nextWidth, customHeight) <= MAX_TOTAL_PIXELS) {
                  applyCustomResolution(nextWidth, customHeight, `用户滚轮调整 ${nextWidth}×${customHeight}`);
                }
              }}
              onBlur={(event) => {
                const value = Math.round(Number(event.target.value) / 64) * 64;
                const clamped = clampToMaxPixels(Math.max(64, value), customHeight);
                resolutionSourceRef.current = `用户自定义 ${clamped.width}×${clamped.height}`;
                reportResolutionNormalization('用户自定义宽度', clamped);
                applyCustomResolution(clamped.width, clamped.height, `用户自定义 ${clamped.width}×${clamped.height}`);
              }}
            />
            <button
              className="text-gray-500 hover:text-nai-accent transition-colors p-0.5 rounded hover:bg-white/5"
              onClick={() => {
                const nextWidth = customHeight;
                const nextHeight = customWidth;
                applyCustomResolution(nextWidth, nextHeight, `用户交换宽高 ${nextWidth}×${nextHeight}`);
              }}
              title="交换宽高"
            >
              <ArrowLeftRight className="w-3 h-3" />
            </button>
            <input
              type="number"
              step={64}
              min={64}
              className="w-16 bg-black/20 border border-gray-700 rounded px-2 py-1 text-xs text-white outline-none focus:border-nai-accent text-center"
              value={customHeightInput}
              onChange={(event) => setCustomHeightInput(event.target.value)}
              onWheel={(event) => {
                event.preventDefault();
                const delta = event.deltaY < 0 ? 64 : -64;
                const nextHeight = Math.max(64, customHeight + delta);
                if (getPixelCount(customWidth, nextHeight) <= MAX_TOTAL_PIXELS) {
                  applyCustomResolution(customWidth, nextHeight, `用户滚轮调整 ${customWidth}×${nextHeight}`);
                }
              }}
              onBlur={(event) => {
                const value = Math.round(Number(event.target.value) / 64) * 64;
                const clamped = clampToMaxPixels(customWidth, Math.max(64, value));
                resolutionSourceRef.current = `用户自定义 ${clamped.width}×${clamped.height}`;
                reportResolutionNormalization('用户自定义高度', clamped);
                applyCustomResolution(clamped.width, clamped.height, `用户自定义 ${clamped.width}×${clamped.height}`);
              }}
            />

            <button
              className="ml-auto bg-nai-accent hover:bg-[#ebd576] text-black p-1 rounded transition-colors"
              onClick={() => {
                const matchedPreset = [...RESOLUTIONS, ...LARGE_RESOLUTIONS, ...WALLPAPER_RESOLUTIONS]
                  .find((preset) => preset.width === customWidth && preset.height === customHeight);
                if (matchedPreset) {
                  onResolutionChange(matchedPreset);
                } else {
                  onClose();
                }
              }}
              title="确认"
            >
              <Check className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function ResolutionTabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      className={`relative flex-1 px-2 py-1 rounded text-xs transition-colors z-10 ${active ? 'text-black font-bold' : 'text-gray-400 hover:text-white'}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
