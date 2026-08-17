import { ImagePlus, Loader2, Send, SlidersHorizontal, Square } from 'lucide-react';
import type { ReactNode } from 'react';
import { calculateCostFromUI } from '../../services/costCalculator';
import type { ActivePreciseRef, ActiveVibe } from './types';

interface MobileGenerateToolbarProps {
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
  /** 步数浮动滑杆开合(状态局部于生图页,见 MobileStepsSliderOverlay) */
  stepsSliderOpen: boolean;
  onToggleStepsSlider: () => void;
}

interface ReadoutChipProps {
  caption?: string;
  value: string;
  icon?: ReactNode;
  active?: boolean;
  title: string;
  onClick: () => void;
}

// 参数读数 chip(对齐 Plana _ReadoutChip):标题弱色 + 当前值等宽字体;
// 边框常在(未激活时 gray-700),激活只换色,避免 2px 边框差引起的抖动。
function ReadoutChip({ caption, value, icon, active = false, title, onClick }: ReadoutChipProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`h-9 flex items-center gap-1.5 px-3 rounded-lg border text-sm transition-all active:scale-[0.98] ${active
        ? 'bg-gray-800 border-nai-accent/50'
        : 'bg-gray-800 border-gray-700'
        }`}
    >
      {icon}
      {caption && <span className="text-[10px] text-gray-500">{caption}</span>}
      <span className={caption ? 'font-mono text-gray-200' : 'text-gray-200'}>{value}</span>
    </button>
  );
}

// P4 吸底操作栏(对齐 Plana bottom_action_bar,两壳共用):
//   第一行 = 读数 chips(尺寸/步数/高级),显示当前值;
//   第二行 = 导入图片方钮 + 胶囊形生成主按钮(成本估算与按钮内嵌进度保留);
//   生成/停止两段式:运行中按钮内右侧长出停止区(竖细线 + 停止图标),
//   点主区 = 再投一条(沿用既有语义:isBusy 时主区禁用,见报告),点停止区 = 取消当前。
export function MobileGenerateToolbar({
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
  stepsSliderOpen,
  onToggleStepsSlider,
}: MobileGenerateToolbarProps) {
  const isBusy = isGenerating || isQueuing || isPreparing;
  const showStopZone = isGenerating || isQueuing;
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

  const busyLabel = isQueuing
    ? `排队中 #${queuePosition}`
    : (isGenerating && currentStep > 0)
      ? `生成中 ${currentStep}/${totalSteps}`
      : '准备中...';

  return (
    <div className="flex-shrink-0 bg-nai-panel border-t border-gray-800 safe-area-bottom">
      <div className="px-3 pt-2 pb-3 space-y-2">
        {/* 第一行:参数读数 chips */}
        <div className="flex items-center gap-2">
          <ReadoutChip
            caption="尺寸"
            value={`${width}×${height}`}
            title="选择尺寸"
            onClick={openResolutionDropdown}
          />
          <ReadoutChip
            caption="步数"
            value={`${steps}`}
            active={stepsSliderOpen}
            title="步数:点开浮动滑杆"
            onClick={onToggleStepsSlider}
          />
          <div className="flex-1" />
          <ReadoutChip
            icon={<SlidersHorizontal className="w-4 h-4 text-gray-400" />}
            value="高级"
            title="高级设置"
            onClick={openAdvancedSettings}
          />
        </div>

        {/* 第二行:导入图片方钮 + 胶囊形生成主按钮(两段式) */}
        <div className="flex items-center gap-2">
          <label
            title="导入图片"
            className="w-12 h-12 flex items-center justify-center rounded-xl bg-gray-800 border border-gray-700 text-gray-400 active:scale-95 transition-all cursor-pointer shrink-0"
          >
            <ImagePlus className="w-5 h-5" />
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

          <div
            className={`flex-1 h-12 flex rounded-full overflow-hidden relative font-bold text-sm transition-colors ${isBusy
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

            <button
              onClick={onGenerate}
              disabled={isBusy}
              title={isBusy ? busyLabel : '生成'}
              className="flex-1 h-full min-w-0 flex items-center justify-center px-4 relative z-10 active:scale-[0.99] transition-transform disabled:cursor-default"
            >
              {isBusy ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  <span className="shrink-0 whitespace-nowrap">{busyLabel}</span>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 w-full">
                  <Send className="w-4 h-4 shrink-0" />
                  <span>生成</span>
                  <div className="flex items-center gap-1 bg-black/15 px-2 py-0.5 rounded-full text-xs font-mono font-bold">
                    <span>{cost.total}</span>
                    <span>💎</span>
                  </div>
                </div>
              )}
            </button>

            {showStopZone && (
              <>
                {/* 竖细线:主区与停止区是两个可点区域,分界不能像猜的 */}
                <div className="w-px self-center h-6 bg-gray-500/50 relative z-10 shrink-0" />
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    void cancelTask();
                  }}
                  title={isQueuing ? '取消排队' : '停止生成'}
                  className="w-14 h-full flex items-center justify-center relative z-10 shrink-0 active:bg-black/20 transition-colors"
                >
                  <Square className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
