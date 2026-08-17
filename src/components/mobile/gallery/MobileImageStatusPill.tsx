import React from 'react';

interface MobileImageStatusPillProps {
  isGenerating: boolean;
  isQueuing: boolean;
  queuePosition: number;
  currentStep: number;
  totalSteps: number;
  onCancel: () => void;
}

// 统一状态条：排队状态 + 生成进度（与 web 端一致）。
// 两种状态互斥显示，通过 opacity 过渡切换。
export const MobileImageStatusPill: React.FC<MobileImageStatusPillProps> = ({
  isGenerating,
  isQueuing,
  queuePosition,
  currentStep,
  totalSteps,
  onCancel,
}) => (
  <div
    className={`absolute bottom-20 left-1/2 -translate-x-1/2 z-20 transition-all duration-300 ease-out ${isQueuing || isGenerating
      ? 'opacity-100 translate-y-0'
      : 'opacity-0 translate-y-4 pointer-events-none'
      }`}
  >
    <div className="bg-gray-900/90 px-4 py-2 rounded-full shadow-xl border border-gray-600/50 h-9 flex items-center justify-center">
      {/* 排队状态 */}
      <div
        className={`flex items-center gap-3 transition-opacity duration-200 ${isQueuing ? 'opacity-100' : 'opacity-0 invisible absolute'
          }`}
      >
        {/* 脉冲圆环 */}
        <div className="relative w-4 h-4 flex-shrink-0">
          <div className="absolute inset-0 bg-nai-accent/40 rounded-full animate-ping" />
          <div className="absolute inset-0.5 bg-nai-accent rounded-full" />
        </div>
        <span className="text-gray-200 text-sm shrink-0 whitespace-nowrap">排队中</span>
        <span className="text-nai-accent font-bold text-sm shrink-0 whitespace-nowrap">
          #{queuePosition > 0 ? queuePosition : '-'}
        </span>
        <button
          onClick={onCancel}
          className="ml-1 px-2 py-0.5 text-xs text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors shrink-0 whitespace-nowrap"
        >
          取消
        </button>
      </div>

      {/* 生成进度 */}
      <div
        className={`flex items-center gap-3 transition-opacity duration-200 ${isGenerating && !isQueuing ? 'opacity-100' : 'opacity-0 invisible absolute'
          }`}
      >
        <div className="w-28 h-1.5 bg-gray-700 rounded-full overflow-hidden flex-shrink-0">
          <div
            className="h-full bg-nai-accent rounded-full transition-all duration-200 ease-out"
            style={{ width: `${totalSteps > 0 ? (currentStep / totalSteps) * 100 : 0}%` }}
          />
        </div>
        <span className="text-gray-200 text-sm font-mono tabular-nums">
          {currentStep}/{totalSteps}
        </span>
      </div>
    </div>
  </div>
);
