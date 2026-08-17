import React from 'react';

interface MobileInpaintProgressPillProps {
  isGenerating: boolean;
  currentStep: number;
  totalSteps: number;
}

export const MobileInpaintProgressPill: React.FC<MobileInpaintProgressPillProps> = ({
  isGenerating,
  currentStep,
  totalSteps,
}) => {
  if (!isGenerating || totalSteps <= 0) return null;

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
      <div className="bg-gray-900/90 px-4 py-2 rounded-full shadow-xl border border-gray-600/50 flex items-center gap-3">
        <div className="w-24 h-1.5 bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-nai-accent rounded-full transition-all"
            style={{ width: `${(currentStep / totalSteps) * 100}%` }}
          />
        </div>
        <span className="text-gray-200 text-xs font-mono">{currentStep}/{totalSteps}</span>
      </div>
    </div>
  );
};
