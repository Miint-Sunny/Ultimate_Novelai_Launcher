import { Fragment } from 'react';
import type React from 'react';
import { MapPin, Sparkles, X } from 'lucide-react';
import type { CharacterPrompt } from './types';

interface CharacterPositionModalProps {
  editingPositionId: string;
  characterPrompts: CharacterPrompt[];
  onClose: () => void;
  onUpdatePosition: (id: string, position: string) => void;
}

const COLUMNS = ['A', 'B', 'C', 'D', 'E'];
const ROWS = [1, 2, 3, 4, 5];

export const CharacterPositionModal: React.FC<CharacterPositionModalProps> = ({
  editingPositionId,
  characterPrompts,
  onClose,
  onUpdatePosition,
}) => {
  const activeCharacter = characterPrompts.find(p => p.id === editingPositionId);
  const activeCharacterIndex = characterPrompts.findIndex(p => p.id === editingPositionId);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl p-4 w-[320px] animate-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-bold text-white flex items-center gap-2">
            <MapPin className="w-4 h-4 text-nai-accent" />
            设置角色位置
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-6 gap-1 mb-2">
          <div className="col-span-1"></div>
          {COLUMNS.map(col => (
            <div key={col} className="text-center text-xs font-bold text-gray-500">{col}</div>
          ))}

          {ROWS.map(row => (
            <Fragment key={row}>
              <div className="flex items-center justify-center text-xs font-bold text-gray-500">{row}</div>

              {COLUMNS.map(col => {
                const cellId = `${col}${row}`;
                const isActive = activeCharacter?.position === cellId;
                const charsInCell = characterPrompts.filter(p => p.position === cellId);

                return (
                  <button
                    key={cellId}
                    onClick={() => onUpdatePosition(editingPositionId, cellId)}
                    className={`aspect-square rounded border flex items-center justify-center relative group transition-all duration-200 ${isActive
                      ? 'bg-nai-accent/20 border-nai-accent shadow-[0_0_10px_rgba(235,213,118,0.2)]'
                      : 'bg-black/20 border-gray-700 hover:border-gray-500 hover:bg-white/5'
                    }`}
                  >
                    {isActive && (
                      <div className="absolute inset-0 bg-nai-accent/10 animate-pulse rounded" />
                    )}

                    <div className="flex flex-wrap items-center justify-center gap-0.5 p-0.5">
                      {charsInCell.map(char => {
                        const charIndex = characterPrompts.findIndex(p => p.id === char.id);
                        return (
                          <div
                            key={char.id}
                            className={`w-3 h-3 rounded-full flex items-center justify-center text-[8px] font-bold shadow-sm ${char.id === editingPositionId
                              ? 'bg-nai-accent text-black ring-1 ring-white'
                              : 'bg-gray-600 text-white'
                            }`}
                            title={`Char ${charIndex + 1}`}
                          >
                            {charIndex + 1}
                          </div>
                        );
                      })}
                    </div>
                  </button>
                );
              })}
            </Fragment>
          ))}
        </div>

        <button
          onClick={() => onUpdatePosition(editingPositionId, '')}
          className={`w-full py-2 mb-2 rounded text-xs font-bold border transition-all flex items-center justify-center gap-2 ${!activeCharacter?.position
            ? 'bg-nai-accent text-black border-nai-accent'
            : 'bg-black/20 text-gray-400 border-gray-700 hover:text-white hover:border-gray-500'
          }`}
        >
          <Sparkles className="w-3 h-3" />
          自动 (Auto)
        </button>

        <div className="text-xs text-gray-500 text-center mt-2">
          当前正在设置 Char {activeCharacterIndex + 1} 的位置
        </div>
      </div>
    </div>
  );
};
