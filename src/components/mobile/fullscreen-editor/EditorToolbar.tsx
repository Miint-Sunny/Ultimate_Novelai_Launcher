import { AlignLeft, ArrowLeft, Grid, Undo2 } from 'lucide-react';
import type React from 'react';

interface EditorToolbarProps {
  totalTokens: number;
  undoDepth: number;
  rawMode: boolean;
  inputText: string;
  value: string;
  onBack: () => void;
  onUndo: () => void;
  onSaveValue: (value: string) => void;
  onInputTextChange: (value: string) => void;
  onClearSelection: () => void;
  onRawModeChange: (updater: (prev: boolean) => boolean) => void;
}

export const EditorToolbar: React.FC<EditorToolbarProps> = ({
  totalTokens,
  undoDepth,
  rawMode,
  inputText,
  value,
  onBack,
  onUndo,
  onSaveValue,
  onInputTextChange,
  onClearSelection,
  onRawModeChange,
}) => (
  <div className="flex-shrink-0 bg-nai-panel border-t border-white/[0.06] px-4 py-2.5 flex items-center gap-3">
    <button onClick={onBack} className="w-9 h-9 flex items-center justify-center rounded-full bg-white/[0.08] text-gray-300 active:text-white active:bg-white/15 transition-colors">
      <ArrowLeft className="w-4 h-4" />
    </button>
    <div className="flex-1 flex items-center justify-center gap-2.5">
      <div className="flex-1 h-2 bg-white/10 rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${totalTokens > 512 ? 'bg-red-500' : 'bg-nai-accent'}`}
          style={{ width: `${Math.min((totalTokens / 512) * 100, 100)}%` }}
        />
      </div>
      <span className={`text-xs font-mono ${totalTokens > 512 ? 'text-red-400' : 'text-nai-accent/80'}`}>
        {totalTokens}/512
      </span>
    </div>
    <button
      onClick={onUndo}
      disabled={undoDepth === 0}
      className="w-9 h-9 flex items-center justify-center rounded-full bg-white/[0.08] text-gray-300 active:text-white active:bg-white/15 transition-colors disabled:opacity-30"
    >
      <Undo2 className="w-4 h-4" />
    </button>
    <button
      onClick={() => {
        if (!rawMode && inputText.trim()) {
          const newValue = value ? `${value}, ${inputText.trim()}` : inputText.trim();
          onSaveValue(newValue);
          onInputTextChange('');
        }
        onClearSelection();
        onRawModeChange(prev => !prev);
      }}
      className="w-9 h-9 flex items-center justify-center rounded-full bg-white/[0.08] text-gray-300 active:text-white active:bg-white/15 transition-colors"
    >
      {rawMode ? <Grid className="w-4 h-4" /> : <AlignLeft className="w-4 h-4" />}
    </button>
  </div>
);
