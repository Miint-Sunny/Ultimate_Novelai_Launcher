import React from 'react';

interface NaturalLanguageLoadingPillProps {
  isVisible: boolean;
}

export const NaturalLanguageLoadingPill: React.FC<NaturalLanguageLoadingPillProps> = ({
  isVisible,
}) => {
  if (!isVisible) return null;

  return (
    <div className="flex-shrink-0 bg-nai-panel border-t border-white/[0.06] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="inline-block w-3.5 h-3.5 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
        <span className="text-xs text-cyan-200/80">翻译中...</span>
      </div>
    </div>
  );
};
