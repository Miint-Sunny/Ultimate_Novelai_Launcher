import React from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';

interface ExpandPadding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface MobileInpaintExpandOverlayProps {
  isExpandMode: boolean;
  isGenerating: boolean;
  hasExpand: boolean;
  expandPadding: ExpandPadding;
  imageWidth: number;
  imageHeight: number;
  displayWidth: number;
  displayHeight: number;
  baseScale: number;
  zoom: number;
  expandStep: number;
  adjustExpand: (direction: 'top' | 'bottom' | 'left' | 'right', delta: number) => void;
}

const expansionFill = 'repeating-conic-gradient(rgba(252,237,164,0.08) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px';

export const MobileInpaintExpandOverlay: React.FC<MobileInpaintExpandOverlayProps> = ({
  isExpandMode,
  isGenerating,
  hasExpand,
  expandPadding,
  imageWidth,
  imageHeight,
  displayWidth,
  displayHeight,
  baseScale,
  zoom,
  expandStep,
  adjustExpand,
}) => {
  if (!isExpandMode || isGenerating) return null;

  const scale = baseScale * zoom;
  const pTop = expandPadding.top * scale;
  const pBottom = expandPadding.bottom * scale;
  const pLeft = expandPadding.left * scale;
  const pRight = expandPadding.right * scale;
  const totalW = displayWidth + pLeft + pRight;
  const totalH = displayHeight + pTop + pBottom;
  const btnClass = 'w-10 h-10 flex items-center justify-center rounded-full bg-nai-accent text-black shadow-lg shadow-black/30';

  return (
    <>
      {hasExpand && (
        <>
          {expandPadding.top > 0 && (
            <div style={{ position: 'absolute', left: `${-pLeft}px`, top: `${-pTop}px`, width: `${totalW}px`, height: `${pTop}px`, background: expansionFill, pointerEvents: 'none' }} />
          )}
          {expandPadding.bottom > 0 && (
            <div style={{ position: 'absolute', left: `${-pLeft}px`, top: `${displayHeight}px`, width: `${totalW}px`, height: `${pBottom}px`, background: expansionFill, pointerEvents: 'none' }} />
          )}
          {expandPadding.left > 0 && (
            <div style={{ position: 'absolute', left: `${-pLeft}px`, top: '0px', width: `${pLeft}px`, height: `${displayHeight}px`, background: expansionFill, pointerEvents: 'none' }} />
          )}
          {expandPadding.right > 0 && (
            <div style={{ position: 'absolute', left: `${displayWidth}px`, top: '0px', width: `${pRight}px`, height: `${displayHeight}px`, background: expansionFill, pointerEvents: 'none' }} />
          )}
          <div style={{
            position: 'absolute', left: `${-pLeft}px`, top: `${-pTop}px`,
            width: `${totalW}px`, height: `${totalH}px`,
            border: '2px dashed rgba(252,237,164,0.7)',
            boxShadow: '0 0 12px rgba(252,237,164,0.15)',
            borderRadius: '2px',
            pointerEvents: 'none', zIndex: 10,
          }} />
        </>
      )}

      {hasExpand && (
        <div style={{
          position: 'absolute', left: `${-pLeft}px`, top: `${-pTop - 22}px`,
          background: 'rgba(252,237,164,0.9)',
          color: '#1a1a1a', fontSize: '10px', fontWeight: 700,
          padding: '1px 6px', borderRadius: '4px',
          zIndex: 11, pointerEvents: 'none',
          letterSpacing: '0.02em',
        }}>
          {imageWidth + expandPadding.left + expandPadding.right} x {imageHeight + expandPadding.top + expandPadding.bottom}
        </div>
      )}

      <div className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center gap-1" style={{ bottom: `${displayHeight + 8}px` }}>
        <button onClick={() => adjustExpand('top', expandStep)} className={btnClass}><ChevronUp className="w-5 h-5" /></button>
        {expandPadding.top > 0 && <span className="text-[10px] text-nai-accent/80 font-mono">{expandPadding.top}</span>}
      </div>
      <div className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center gap-1" style={{ top: `${displayHeight + 8}px` }}>
        <button onClick={() => adjustExpand('bottom', expandStep)} className={btnClass}><ChevronDown className="w-5 h-5" /></button>
        {expandPadding.bottom > 0 && <span className="text-[10px] text-nai-accent/80 font-mono">{expandPadding.bottom}</span>}
      </div>
      <div className="absolute top-1/2 -translate-y-1/2 flex flex-col items-center gap-1" style={{ right: `${displayWidth + 8}px` }}>
        <button onClick={() => adjustExpand('left', expandStep)} className={btnClass}><ChevronLeft className="w-5 h-5" /></button>
        {expandPadding.left > 0 && <span className="text-[10px] text-nai-accent/80 font-mono">{expandPadding.left}</span>}
      </div>
      <div className="absolute top-1/2 -translate-y-1/2 flex flex-col items-center gap-1" style={{ left: `${displayWidth + 8}px` }}>
        <button onClick={() => adjustExpand('right', expandStep)} className={btnClass}><ChevronRight className="w-5 h-5" /></button>
        {expandPadding.right > 0 && <span className="text-[10px] text-nai-accent/80 font-mono">{expandPadding.right}</span>}
      </div>
    </>
  );
};
