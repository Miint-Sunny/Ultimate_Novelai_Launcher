import { ChevronDown, Plus, Power, User, X } from 'lucide-react';
import type { PreciseReferenceMode } from './types';
import type { useMobilePreciseReferences } from './generate/useMobilePreciseReferences';
import type { MobileCardDragHandleProps } from './generate/useMobileCardDragSort';

type MobilePreciseReferenceLibrary = ReturnType<typeof useMobilePreciseReferences>;

interface MobilePreciseReferenceCardProps {
  library: MobilePreciseReferenceLibrary;
  onOpenManager: () => void;
  /** 卡头长按拖拽排序手势(P4 注册表);只挂本卡头,不挂输入区 */
  dragHandleProps?: MobileCardDragHandleProps;
}

// P4 起模型能力判定收口到注册表(src/components/generation/genModules.ts):
// 不支持的型号整卡不渲染,不再显示「V4 模型不支持」置灰占位。
export function MobilePreciseReferenceCard({
  library,
  onOpenManager,
  dragHandleProps,
}: MobilePreciseReferenceCardProps) {
  const {
    activePreciseRefs,
    isCRExpanded,
    setIsCRExpanded,
    removePreciseRef,
    updatePreciseRefParam,
  } = library;

  return (
    <div className="bg-nai-input rounded-xl border border-gray-700/50 overflow-hidden shadow-lg">
      <div
        className="flex items-center justify-between p-3 active:bg-gray-800/50 transition-colors cursor-pointer"
        onClick={() => {
          if (activePreciseRefs.length > 0) {
            setIsCRExpanded(!isCRExpanded);
          } else {
            onOpenManager();
          }
        }}
        {...dragHandleProps}
      >
        <div className="flex items-center gap-2">
          {activePreciseRefs.length > 0 && (
            <ChevronDown
              className={`w-5 h-5 text-gray-400 transition-transform ${isCRExpanded ? '' : '-rotate-90'}`}
            />
          )}
          <User className="w-5 h-5 text-cyan-400" />
          <span className="text-sm font-bold text-gray-200">精确参考</span>
          {activePreciseRefs.length > 0 && (
            <span className="text-xs text-cyan-400 bg-cyan-500/20 px-1.5 py-0.5 rounded">
              {activePreciseRefs.filter((ref) => ref.enabled).length}/{activePreciseRefs.length}
            </span>
          )}
        </div>
        <button
          onClick={(event) => {
            event.stopPropagation();
            onOpenManager();
          }}
          className="px-3 py-2 bg-cyan-500/20 text-cyan-400 text-sm font-medium rounded-lg active:scale-95 transition-all flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" />
          {activePreciseRefs.length > 0 ? '管理' : '添加'}
        </button>
      </div>

      {activePreciseRefs.length > 0 && isCRExpanded && (
        <div className="border-t border-gray-700/30">
          {activePreciseRefs.map((preciseRef, index) => (
            <div
              key={preciseRef.id}
              className={`flex items-center gap-3 p-3 ${index > 0 ? 'border-t border-gray-700/30' : ''}`}
            >
              <img
                src={preciseRef.preview}
                alt={preciseRef.name}
                className={`w-14 h-14 rounded-lg object-cover flex-shrink-0 ${!preciseRef.enabled ? 'opacity-50' : ''}`}
              />
              <div className={`flex-1 min-w-0 flex flex-col justify-center ${!preciseRef.enabled ? 'opacity-50' : ''}`}>
                <div className="flex items-center gap-2">
                  <div className="text-sm font-medium text-gray-200 truncate flex-1 min-w-0">{preciseRef.name}</div>
                  <div className="relative w-28 shrink-0">
                    <select
                      value={preciseRef.mode}
                      onChange={(event) => updatePreciseRefParam(preciseRef.id, { mode: event.target.value as PreciseReferenceMode })}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:border-cyan-500 outline-none appearance-none cursor-pointer opacity-0 absolute inset-0 z-10"
                    >
                      <option value="character&style">Character & Style</option>
                      <option value="character">Character</option>
                      <option value="style">Style</option>
                    </select>
                    <div className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 flex items-center justify-between pointer-events-none">
                      <span>{preciseRef.mode === 'character&style' ? 'Char & Style' : preciseRef.mode === 'character' ? 'Character' : 'Style'}</span>
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-500">
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 mt-2">
                  <span className="text-xs text-gray-500 w-6">强度</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={preciseRef.strength}
                    onChange={(event) => updatePreciseRefParam(preciseRef.id, { strength: parseFloat(event.target.value) })}
                    className="flex-1 h-1.5 accent-cyan-500"
                  />
                  <span className="text-xs text-gray-400 w-8 text-right">{preciseRef.strength.toFixed(2)}</span>
                </div>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-xs text-gray-500 w-6">保真</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={preciseRef.informationExtracted}
                    onChange={(event) => updatePreciseRefParam(preciseRef.id, { informationExtracted: parseFloat(event.target.value) })}
                    className="flex-1 h-1.5 accent-blue-500"
                  />
                  <span className="text-xs text-gray-400 w-8 text-right">{preciseRef.informationExtracted.toFixed(2)}</span>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <button
                  onClick={() => updatePreciseRefParam(preciseRef.id, { enabled: !preciseRef.enabled })}
                  className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${preciseRef.enabled ? 'bg-cyan-500/20 text-cyan-400' : 'bg-gray-700/50 text-gray-500'}`}
                >
                  <Power className="w-4 h-4" />
                </button>
                <button
                  onClick={() => removePreciseRef(preciseRef.id)}
                  className="w-9 h-9 rounded-lg flex items-center justify-center bg-gray-700/50 text-gray-500 hover:text-red-400 active:scale-95 transition-all"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
