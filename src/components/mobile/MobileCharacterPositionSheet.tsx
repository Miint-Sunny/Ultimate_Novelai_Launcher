import React from 'react';
import { Grid, Sparkles, X } from 'lucide-react';
import type { useMobileCharacterPrompts } from './generate/useMobileCharacterPrompts';

type MobileCharacterPrompts = ReturnType<typeof useMobileCharacterPrompts>;

interface MobileCharacterPositionSheetProps {
  manager: MobileCharacterPrompts;
}

export function MobileCharacterPositionSheet({ manager }: MobileCharacterPositionSheetProps) {
  const {
    characterPrompts,
    editingPositionId,
    setEditingPositionId,
    updateCharacterPrompt,
  } = manager;

  if (!editingPositionId) return null;

  const editingPrompt = characterPrompts.find((prompt) => prompt.id === editingPositionId);
  const editingIndex = characterPrompts.findIndex((prompt) => prompt.id === editingPositionId);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={() => setEditingPositionId(null)}
    >
      <div
        className="bg-nai-panel border border-gray-700 rounded-2xl shadow-2xl p-4 w-full max-w-sm animate-slide-in-from-bottom"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-bold text-white flex items-center gap-2">
            <Grid className="w-4 h-4 text-nai-accent" />
            设置角色位置
          </h3>
          <button
            onClick={() => setEditingPositionId(null)}
            className="p-1 text-gray-400 active:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-6 gap-1 mb-3">
          <div className="col-span-1" />
          {['A', 'B', 'C', 'D', 'E'].map((col) => (
            <div key={col} className="text-center text-xs font-bold text-gray-500">
              {col}
            </div>
          ))}
          {[1, 2, 3, 4, 5].map((row) => (
            <React.Fragment key={row}>
              <div className="flex items-center justify-center text-xs font-bold text-gray-500">
                {row}
              </div>
              {['A', 'B', 'C', 'D', 'E'].map((col) => {
                const cellId = `${col}${row}`;
                const isActive = editingPrompt?.position === cellId;
                const charsInCell = characterPrompts.filter((prompt) => prompt.position === cellId);
                return (
                  <button
                    key={cellId}
                    onClick={() => {
                      updateCharacterPrompt(editingPositionId, 'position', cellId);
                      setEditingPositionId(null);
                    }}
                    className={`aspect-square rounded border flex items-center justify-center relative transition-all duration-200 ${isActive
                      ? 'bg-nai-accent/20 border-nai-accent shadow-[0_0_10px_rgba(235,213,118,0.2)]'
                      : 'bg-black/20 border-gray-700 active:border-gray-500 active:bg-white/5'
                      }`}
                  >
                    {isActive && (
                      <div className="absolute inset-0 bg-nai-accent/10 animate-pulse rounded" />
                    )}
                    <div className="flex flex-wrap items-center justify-center gap-0.5 p-0.5">
                      {charsInCell.map((characterPrompt) => (
                        <div
                          key={characterPrompt.id}
                          className={`w-3 h-3 rounded-full flex items-center justify-center text-[8px] font-bold shadow-sm ${characterPrompt.id === editingPositionId
                            ? 'bg-nai-accent text-black ring-1 ring-white'
                            : 'bg-gray-600 text-white'
                            }`}
                        >
                          {characterPrompts.findIndex((prompt) => prompt.id === characterPrompt.id) + 1}
                        </div>
                      ))}
                    </div>
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </div>

        <button
          onClick={() => {
            updateCharacterPrompt(editingPositionId, 'position', '');
            setEditingPositionId(null);
          }}
          className={`w-full py-2.5 mb-2 rounded-lg text-sm font-bold border transition-all flex items-center justify-center gap-2 ${!editingPrompt?.position
            ? 'bg-nai-accent text-black border-nai-accent'
            : 'bg-black/20 text-gray-400 border-gray-700 active:text-white active:border-gray-500'
            }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          自动 (Auto)
        </button>

        <div className="text-xs text-gray-500 text-center mt-1">
          当前正在设置 Char {editingIndex + 1} 的位置
        </div>
      </div>
    </div>
  );
}
