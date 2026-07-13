import { Check, Download, Heart, Loader2, MoreVertical, Palette, Tag, Trash2 } from 'lucide-react';
import { getPublicVibeDownloadUrl } from '../../services/publicLibrary';
import type { VibeFile } from './types';

interface MobileVibeListItemProps {
  vibe: VibeFile;
  isAdded: boolean;
  isCompatible: boolean;
  isPublic?: boolean;
  isCollected?: boolean;
  isCollecting?: boolean;
  menuOpen?: boolean;
  onToggle: () => void;
  onCollect?: () => void;
  onOpenMenu?: () => void;
  onCloseMenu?: () => void;
  onEditTags?: () => void;
  onDelete?: () => void;
}

function modelBadgeLabel(model: string) {
  if (model.includes('full')) return 'Full';
  if (model.includes('curated')) return 'Curated';
  return model.split('-').pop();
}

export function MobileVibeListItem({
  vibe,
  isAdded,
  isCompatible,
  isPublic = false,
  isCollected = false,
  isCollecting = false,
  menuOpen = false,
  onToggle,
  onCollect,
  onOpenMenu,
  onCloseMenu,
  onEditTags,
  onDelete,
}: MobileVibeListItemProps) {
  return (
    <div
      className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${!isCompatible ? 'bg-gray-900/50 border-gray-800 opacity-60' : isAdded ? 'bg-nai-accent/10 border-nai-accent/50' : 'bg-gray-800/50 border-gray-700 active:bg-gray-700/50'}`}
      onClick={onToggle}
    >
      <div className={`w-6 h-6 rounded-md border-2 flex items-center justify-center shrink-0 ${isAdded ? 'bg-nai-accent border-nai-accent' : 'border-gray-500'}`}>
        {isAdded && <Check className="w-3 h-3 text-black" />}
      </div>
      {vibe.preview ? (
        <img
          src={vibe.preview}
          alt={vibe.name}
          className="w-12 h-12 rounded-lg object-cover shrink-0"
          onError={(event) => {
            event.currentTarget.style.display = 'none';
            const fallback = event.currentTarget.nextElementSibling;
            if (fallback) (fallback as HTMLElement).style.display = 'flex';
          }}
        />
      ) : null}
      <div className={`w-12 h-12 rounded-lg bg-gray-700 items-center justify-center shrink-0 ${vibe.preview ? 'hidden' : 'flex'}`}>
        <Palette className="w-4 h-4 text-gray-500" />
      </div>
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-medium truncate ${isAdded ? 'text-nai-accent' : 'text-white'}`}>{vibe.name}</div>
        {vibe.supportedModels && vibe.supportedModels.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-0.5">
            {vibe.supportedModels.slice(0, 2).map((model) => (
              <span key={model} className="text-[11px] px-1.5 py-0.5 bg-gray-700 text-gray-400 rounded">
                {modelBadgeLabel(model)}
              </span>
            ))}
          </div>
        )}
        {!isCompatible && <div className="mt-0.5 text-xs text-red-400">不兼容</div>}
      </div>
      {isPublic ? (
        <>
          <button
            onClick={async (event) => {
              event.stopPropagation();
              await onCollect?.();
            }}
            disabled={isCollected || isCollecting}
            className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${isCollected ? 'text-pink-400' : 'text-gray-400'} disabled:opacity-50`}
          >
            {isCollecting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Heart className={`w-5 h-5 ${isCollected ? 'fill-current' : ''}`} />}
          </button>
          <button
            onClick={async (event) => {
              event.stopPropagation();
              if (vibe.fileName) {
                const anchor = document.createElement('a');
                anchor.href = await getPublicVibeDownloadUrl(vibe.fileName);
                anchor.download = vibe.fileName;
                anchor.click();
              }
            }}
            className="w-9 h-9 rounded-full flex items-center justify-center text-gray-400 shrink-0"
          >
            <Download className="w-5 h-5" />
          </button>
        </>
      ) : (
        <div className="relative shrink-0">
          <button
            onClick={(event) => {
              event.stopPropagation();
              onOpenMenu?.();
            }}
            className="w-9 h-9 rounded-full flex items-center justify-center text-gray-400 active:bg-white/10"
          >
            <MoreVertical className="w-5 h-5" />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={(event) => { event.stopPropagation(); onCloseMenu?.(); }} />
              <div className="absolute right-0 top-full mt-1 w-44 bg-nai-panel border border-gray-700 rounded-xl shadow-xl z-50 py-1 text-sm">
                <button
                  onClick={(event) => { event.stopPropagation(); onEditTags?.(); }}
                  className="w-full text-left px-4 py-3 text-gray-300 active:bg-white/10 flex items-center gap-2.5"
                >
                  <Tag className="w-4 h-4" /> 编辑标签
                </button>
                <button
                  onClick={async (event) => { event.stopPropagation(); await onDelete?.(); }}
                  className="w-full text-left px-4 py-3 text-red-400 active:bg-red-900/20 flex items-center gap-2.5"
                >
                  <Trash2 className="w-4 h-4" /> 删除
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
