import React, { type Dispatch, type SetStateAction } from 'react';
import { Brush, Circle, Crop, Eraser, Expand, Eye, RotateCcw, Square, Undo2 } from 'lucide-react';

type BrushShape = 'square' | 'circle';

interface MobileInpaintBottomToolbarProps {
  isEraser: boolean;
  setIsEraser: Dispatch<SetStateAction<boolean>>;
  brushShape: BrushShape;
  setBrushShape: Dispatch<SetStateAction<BrushShape>>;
  historyLength: number;
  onUndo: () => void;
  onClear: () => void;
  isCropMode: boolean;
  isExpandMode: boolean;
  onToggleCrop: () => void;
  onToggleExpand: () => void;
  hasSnapshot: boolean;
  isGenerating: boolean;
  showOriginal: boolean;
  setShowOriginal: Dispatch<SetStateAction<boolean>>;
  brushSize: number;
  setBrushSize: Dispatch<SetStateAction<number>>;
  strength: number;
  onStrengthChange: (strength: number) => void;
}

export const MobileInpaintBottomToolbar: React.FC<MobileInpaintBottomToolbarProps> = ({
  isEraser,
  setIsEraser,
  brushShape,
  setBrushShape,
  historyLength,
  onUndo,
  onClear,
  isCropMode,
  isExpandMode,
  onToggleCrop,
  onToggleExpand,
  hasSnapshot,
  isGenerating,
  showOriginal,
  setShowOriginal,
  brushSize,
  setBrushSize,
  strength,
  onStrengthChange,
}) => {
  if (isGenerating) return null;

  return (
    <div className="flex-shrink-0 bg-gray-900/95 border-t border-white/10 px-3 pt-2.5 pb-2.5">
      <div className="flex items-center justify-center gap-1.5 mb-2.5">
        <div className="flex items-center bg-gray-800 rounded-xl p-0.5">
          <button
            className={`p-2.5 rounded-lg transition-all ${!isEraser ? 'bg-nai-accent text-black' : 'text-gray-400'}`}
            onClick={() => setIsEraser(false)}
          >
            <Brush className="w-[18px] h-[18px]" />
          </button>
          <button
            className={`p-2.5 rounded-lg transition-all ${isEraser ? 'bg-nai-accent text-black' : 'text-gray-400'}`}
            onClick={() => setIsEraser(true)}
          >
            <Eraser className="w-[18px] h-[18px]" />
          </button>
        </div>

        <div className="flex items-center bg-gray-800 rounded-xl p-0.5">
          <button
            className={`p-2.5 rounded-lg transition-all ${brushShape === 'square' ? 'bg-white/20 text-white' : 'text-gray-400'}`}
            onClick={() => setBrushShape('square')}
          >
            <Square className="w-[18px] h-[18px]" />
          </button>
          <button
            className={`p-2.5 rounded-lg transition-all ${brushShape === 'circle' ? 'bg-white/20 text-white' : 'text-gray-400'}`}
            onClick={() => setBrushShape('circle')}
          >
            <Circle className="w-[18px] h-[18px]" />
          </button>
        </div>

        <div className="flex items-center bg-gray-800 rounded-xl p-0.5">
          <button
            onClick={onUndo}
            disabled={historyLength === 0}
            className="p-2.5 rounded-lg text-red-400 disabled:opacity-30"
          >
            <Undo2 className="w-[18px] h-[18px]" />
          </button>
          <button onClick={onClear} className="p-2.5 rounded-lg text-red-400">
            <RotateCcw className="w-[18px] h-[18px]" />
          </button>
        </div>

        <button
          onClick={onToggleCrop}
          disabled={isExpandMode}
          className={`p-2.5 rounded-lg transition-all ${isCropMode
            ? 'bg-teal-400 text-black'
            : isExpandMode
              ? 'text-gray-600'
              : 'text-gray-400'
            }`}
        >
          <Crop className="w-[18px] h-[18px]" />
        </button>

        <div className="flex items-center bg-gray-800 rounded-xl p-0.5">
          <button
            onClick={onToggleExpand}
            className={`p-2.5 rounded-lg transition-all ${isExpandMode
              ? 'bg-nai-accent text-black'
              : 'text-gray-400'
              }`}
          >
            <Expand className="w-[18px] h-[18px]" />
          </button>
        </div>

        {hasSnapshot && !isGenerating && (
          <button
            onTouchStart={() => setShowOriginal(true)}
            onTouchEnd={() => setShowOriginal(false)}
            onTouchCancel={() => setShowOriginal(false)}
            onMouseDown={() => setShowOriginal(true)}
            onMouseUp={() => setShowOriginal(false)}
            onMouseLeave={() => setShowOriginal(false)}
            className={`p-2.5 rounded-lg ${showOriginal ? 'bg-nai-accent text-black' : 'text-gray-400'}`}
          >
            <Eye className="w-[18px] h-[18px]" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 overflow-hidden">
        <div className="flex items-center gap-2 bg-gray-800 rounded-xl px-3 py-2 flex-1 min-w-0 overflow-hidden">
          <span className="text-xs text-gray-400 flex-shrink-0">大小</span>
          <input
            type="range"
            min="20"
            max="200"
            value={brushSize}
            onChange={(event) => setBrushSize(Number(event.target.value))}
            className="flex-1 accent-nai-accent h-1.5 bg-gray-700 rounded-full appearance-none min-w-0"
          />
          <span className="text-xs text-white font-mono w-6 text-right flex-shrink-0">{brushSize}</span>
        </div>

        <div className="flex items-center gap-2 bg-gray-800 rounded-xl px-3 py-2 flex-1 min-w-0 overflow-hidden">
          <span className="text-xs text-gray-400 flex-shrink-0">强度</span>
          <input
            type="range"
            min="0.1"
            max="1"
            step="0.05"
            value={strength}
            onChange={(event) => onStrengthChange(Number(event.target.value))}
            className="flex-1 accent-nai-accent h-1.5 bg-gray-700 rounded-full appearance-none min-w-0"
          />
          <span className="text-xs text-white font-mono w-9 text-right flex-shrink-0">{strength.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
};
