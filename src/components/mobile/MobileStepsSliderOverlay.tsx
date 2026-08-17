import { useEffect, useState } from 'react';
import { stepsRangeForModel } from '../generation/modelResolutionOptions';

interface MobileStepsSliderOverlayProps {
  open: boolean;
  steps: number;
  model: string;
  onCommit: (steps: number) => void;
}

// 步数浮动滑杆(P4,对齐 Plana StepsSliderOverlay):浮在内容区上方、吸底栏之上
// (absolute 定位,不占布局,开合不推动任何东西);拖动只写本地草稿,松手才提交
// 全局参数 —— 逐帧改全局会连着整页与成本估算重建,肉眼就是抖。范围读取当前模型
// 的合法 steps 区间(stepsRangeForModel,与两端高级设置同源),不做吸附刻度。
export function MobileStepsSliderOverlay({
  open,
  steps,
  model,
  onCommit,
}: MobileStepsSliderOverlayProps) {
  const [draft, setDraft] = useState<number | null>(null);

  // 收起时清掉未提交的草稿,重开不回闪旧值
  useEffect(() => {
    if (!open) setDraft(null);
  }, [open]);

  if (!open) return null;

  const range = stepsRangeForModel(model);
  const clamp = (value: number) => Math.min(range.max, Math.max(range.min, value));
  const shown = clamp(draft ?? steps);

  const commit = () => {
    if (draft === null) return;
    if (draft !== steps) onCommit(draft);
    setDraft(null);
  };

  return (
    <div className="absolute left-3 right-3 bottom-3 z-20 animate-fade-in">
      <div className="glass rounded-full border border-white/10 shadow-xl h-12 px-4 flex items-center gap-3">
        <span className="text-xs text-gray-400 shrink-0">步数</span>
        <input
          type="range"
          min={range.min}
          max={range.max}
          step={1}
          value={shown}
          onChange={(event) => setDraft(clamp(Math.round(parseFloat(event.target.value))))}
          onPointerUp={commit}
          onTouchEnd={commit}
          onKeyUp={commit}
          onBlur={commit}
          title="步数"
          className="flex-1 h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent"
        />
        <span className="text-sm font-mono text-nai-accent w-6 text-right shrink-0">{shown}</span>
      </div>
    </div>
  );
}
