import { ChevronDown, Loader2, Palette, Plus, Power, X } from 'lucide-react';
import type { useMobileVibeLibrary } from './generate/useMobileVibeLibrary';

type MobileVibeLibrary = ReturnType<typeof useMobileVibeLibrary>;

interface MobileVibeReferencesCardProps {
  library: MobileVibeLibrary;
  onOpenManager: () => void;
}

export function MobileVibeReferencesCard({ library, onOpenManager }: MobileVibeReferencesCardProps) {
  const {
    activeVibes,
    isVibeExpanded,
    setIsVibeExpanded,
    loadingVibeIds,
    isVibeCompatibleWithModel,
    removeActiveVibe,
    updateActiveVibe,
  } = library;

  return (
    <div className="bg-nai-input rounded-xl border border-gray-700/50 overflow-hidden shadow-lg">
      <div
        className="flex items-center justify-between p-3 active:bg-gray-800/50 transition-colors cursor-pointer"
        onClick={() => {
          if (activeVibes.length > 0) {
            setIsVibeExpanded(!isVibeExpanded);
          } else {
            onOpenManager();
          }
        }}
      >
        <div className="flex items-center gap-2">
          {activeVibes.length > 0 && (
            <ChevronDown
              className={`w-5 h-5 text-gray-400 transition-transform ${isVibeExpanded ? '' : '-rotate-90'}`}
            />
          )}
          <Palette className="w-5 h-5 text-purple-400" />
          <span className="text-sm font-bold text-gray-200">Vibes</span>
          {activeVibes.length > 0 && (
            <span className="text-xs text-purple-400 bg-purple-500/20 px-1.5 py-0.5 rounded">
              {activeVibes.length}
            </span>
          )}
        </div>
        <button
          onClick={(event) => {
            event.stopPropagation();
            onOpenManager();
          }}
          className="px-3 py-2 bg-purple-500/20 text-purple-400 text-sm font-medium rounded-lg active:scale-95 transition-all flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" />
          添加
        </button>
      </div>

      {activeVibes.length > 0 && isVibeExpanded && (
        <div className="border-t border-gray-700/30">
          {activeVibes.map((vibe, index) => {
            const hasOriginalImage = !!vibe.image;
            const isLoading = loadingVibeIds.has(vibe.id);
            const isCompatible = isVibeCompatibleWithModel(vibe);

            return (
              <div
                key={vibe.id}
                className={`flex items-center gap-3 p-3 ${index > 0 ? 'border-t border-gray-700/30' : ''} ${!isCompatible ? 'bg-red-900/10' : ''}`}
              >
                {isLoading ? (
                  <div className="w-14 h-14 rounded-lg bg-gray-800 flex items-center justify-center flex-shrink-0">
                    <Loader2 className="w-6 h-6 text-purple-400 animate-spin" />
                  </div>
                ) : vibe.preview ? (
                  <img
                    src={vibe.preview}
                    alt={vibe.name}
                    className={`w-14 h-14 rounded-lg object-cover flex-shrink-0 ${!isCompatible ? 'grayscale opacity-60' : !vibe.enabled ? 'opacity-50' : ''}`}
                  />
                ) : (
                  <div className={`w-14 h-14 rounded-lg bg-gray-800 flex items-center justify-center flex-shrink-0 ${!isCompatible ? 'opacity-60' : !vibe.enabled ? 'opacity-50' : ''}`}>
                    <Palette className="w-6 h-6 text-gray-600" />
                  </div>
                )}

                <div className={`flex-1 min-w-0 flex flex-col justify-center ${!isCompatible ? 'opacity-70' : !vibe.enabled ? 'opacity-50' : ''}`}>
                  <div className={`text-sm font-medium truncate ${!isCompatible ? 'text-red-300/80 line-through' : vibe.enabled ? 'text-gray-200' : 'text-gray-500'}`}>
                    {vibe.name}
                  </div>
                  {!isCompatible && (
                    <div className="text-[11px] text-red-400 mt-0.5">不兼容当前模型</div>
                  )}
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-xs text-gray-500 w-6">强度</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={vibe.referenceStrength}
                      onChange={(event) => updateActiveVibe(vibe.id, 'referenceStrength', parseFloat(event.target.value))}
                      className="flex-1 h-1.5 accent-purple-500"
                    />
                    <span className="text-xs text-gray-400 w-8 text-right">{vibe.referenceStrength.toFixed(2)}</span>
                  </div>
                  {(hasOriginalImage || isLoading) && (
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-xs text-gray-500 w-6">提取</span>
                      {isLoading ? (
                        <>
                          <div className="flex-1 h-1.5 bg-gray-700 rounded-full" />
                          <span className="text-xs text-gray-500 w-8 text-right">加载中</span>
                        </>
                      ) : (
                        <>
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.05"
                            value={vibe.informationExtracted}
                            onChange={(event) => updateActiveVibe(vibe.id, 'informationExtracted', parseFloat(event.target.value))}
                            className="flex-1 h-1.5 accent-blue-500"
                          />
                          <span className="text-xs text-gray-400 w-8 text-right">{vibe.informationExtracted.toFixed(2)}</span>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <button
                    onClick={() => {
                      if (!isCompatible) return;
                      updateActiveVibe(vibe.id, 'enabled', !vibe.enabled);
                    }}
                    disabled={!isCompatible}
                    title={!isCompatible ? '不兼容当前模型' : vibe.enabled ? '禁用' : '启用'}
                    className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${!isCompatible
                      ? 'bg-red-900/20 text-red-500/50 cursor-not-allowed'
                      : vibe.enabled ? 'bg-green-500/20 text-green-400' : 'bg-gray-700/50 text-gray-500'
                      }`}
                  >
                    <Power className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => removeActiveVibe(vibe.id)}
                    className="w-9 h-9 rounded-lg flex items-center justify-center bg-gray-700/50 text-gray-500 hover:text-red-400 active:scale-95 transition-all"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
