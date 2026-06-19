import React from 'react';
import {
  Check,
  Copy,
  Edit2,
  Globe,
  HardDrive,
  Heart,
  Image as ImageIcon,
  MoreVertical,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { getArtistTokens } from '../../artist/useArtistManager';
import type { ArtistFile, UseArtistManagerReturn } from '../../artist/types';

interface MobileArtistListItemProps {
  artist: ArtistFile;
  manager: UseArtistManagerReturn;
  isSelected: boolean;
  isPublicList: boolean;
  menuOpenId: string | null;
  setMenuOpenId: (id: string | null) => void;
  onCopy: (e: React.MouseEvent, prompt: string, id: string) => void;
}

const getDisplayTags = (prompt: string) => {
  const artistTags = getArtistTokens(prompt)
    .map(t => t.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
  return artistTags.length > 0
    ? artistTags
    : prompt.split(/[,，]/).map(t => t.trim()).filter(Boolean).slice(0, 3);
};

export const MobileArtistListItem: React.FC<MobileArtistListItemProps> = ({
  artist,
  manager: m,
  isSelected,
  isPublicList,
  menuOpenId,
  setMenuOpenId,
  onCopy,
}) => {
  const displayTags = getDisplayTags(artist.prompt);

  return (
    <div
      className={`relative flex h-[120px] overflow-hidden rounded-xl border transition-all select-none active:scale-[0.98] ${
        isSelected
          ? 'bg-gradient-to-br from-gray-800 to-gray-900 border-amber-500 ring-1 ring-amber-500/40 shadow-[0_4px_16px_rgba(245,158,11,0.15)]'
          : 'bg-gradient-to-br from-gray-800/60 to-gray-900/80 border-gray-700/50'
      }`}
      onClick={() => {
        if (isSelected) m.handleClearArtistSelection();
        else m.toggleArtistSelection(artist.id);
      }}
    >
      <div className="relative w-[120px] shrink-0 border-r border-gray-700/40 bg-black/60 overflow-hidden">
        {artist.previews && artist.previews.length > 0 ? (
          <img
            src={artist.previews[0]}
            alt={artist.name}
            loading="lazy"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ImageIcon className="w-6 h-6 text-gray-600" />
          </div>
        )}
        {isSelected && (
          <div className="absolute top-2 left-2 bg-amber-500 text-black rounded-full p-1 shadow-lg z-10">
            <Check className="w-3 h-3 stroke-[3]" />
          </div>
        )}
        <div className="absolute inset-y-0 right-0 w-4 bg-gradient-to-l from-gray-900/30 to-transparent pointer-events-none" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col p-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className={`truncate text-[14px] font-extrabold tracking-wide ${
              isSelected ? 'text-amber-400' : 'text-gray-100'
            }`}>
              {artist.name}
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {isPublicList ? (
                <span className="inline-flex items-center gap-0.5 rounded-md border border-white/5 bg-white/5 py-0.5 px-1.5 text-[9px] text-gray-400">
                  <Globe className="h-[10px] w-[10px] opacity-70" />
                  公共
                </span>
              ) : (() => {
                const origin = artist.origin ?? 'local';
                const badgeConfig = {
                  local: { icon: HardDrive, label: '来自本地', cls: 'border-gray-500/50 bg-gray-500/20 text-gray-300' },
                  favorited: { icon: Star, label: '来自公共收藏', cls: 'border-yellow-500/50 bg-yellow-500/15 text-yellow-300' },
                  created: { icon: Globe, label: '来自公共创建', cls: 'border-blue-400/50 bg-blue-500/20 text-blue-300' },
                }[origin] || { icon: HardDrive, label: '来自本地', cls: 'border-gray-500/50 bg-gray-500/20 text-gray-300' };
                const BadgeIcon = badgeConfig.icon;
                return (
                  <span className={`inline-flex items-center gap-0.5 rounded-md border py-0.5 px-1.5 text-[9px] ${badgeConfig.cls}`}>
                    <BadgeIcon className="h-[10px] w-[10px] opacity-80" />
                    {badgeConfig.label}
                  </span>
                );
              })()}
            </div>
          </div>

          <div className="flex shrink-0 gap-1.5">
            <button
              className={`rounded-lg p-2 shadow-sm border backdrop-blur-sm transition-all ${
                m.copiedArtistId === artist.id
                  ? 'bg-green-500/20 text-green-400 border-green-500/40'
                  : 'bg-gray-700/40 text-gray-300 border-white/5 active:bg-gray-600/80'
              }`}
              onClick={(e) => onCopy(e, artist.prompt, artist.id)}
            >
              {m.copiedArtistId === artist.id ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>
            {isPublicList && (
              <button
                className="rounded-lg p-2 shadow-sm border backdrop-blur-sm transition-all bg-gray-700/40 text-gray-300 border-white/5 active:bg-gray-600/80"
                onClick={(e) => { e.stopPropagation(); m.savePublicToLocal(artist); }}
              >
                <Heart className="w-4 h-4" />
              </button>
            )}
            {!isPublicList && (
              <div className="relative">
                <button
                  className={`rounded-lg p-2 shadow-sm border backdrop-blur-sm transition-all ${
                    menuOpenId === artist.id
                      ? 'bg-white/15 text-white border-white/20'
                      : 'bg-gray-700/40 text-gray-300 border-white/5 active:bg-gray-600/80'
                  }`}
                  onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === artist.id ? null : artist.id); }}
                >
                  <MoreVertical className="w-4 h-4" />
                </button>
                {menuOpenId === artist.id && (() => {
                  const origin = artist.origin ?? 'local';
                  return (
                    <>
                      <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setMenuOpenId(null); }} />
                      <div className="absolute right-0 top-full mt-1 w-36 bg-nai-panel border border-gray-700 rounded-lg shadow-xl z-50 py-1 text-sm animate-in fade-in zoom-in-95 duration-150 origin-top-right">
                        {origin === 'local' && (
                          <>
                            <button className="w-full text-left px-3 py-2.5 active:bg-white/10 text-gray-200 flex items-center gap-2" onClick={(e) => { e.stopPropagation(); setMenuOpenId(null); m.openArtistDetail(artist); }}>
                              <Edit2 className="w-3.5 h-3.5 text-gray-400" /> 编辑
                            </button>
                            <button className="w-full text-left px-3 py-2.5 active:bg-white/10 text-gray-200 flex items-center gap-2" onClick={(e) => { e.stopPropagation(); setMenuOpenId(null); m.handleDeleteArtist(artist.id, e as any); }}>
                              <Trash2 className="w-3.5 h-3.5 text-gray-400" /> 删除
                            </button>
                            <button className="w-full text-left px-3 py-2.5 active:bg-white/10 text-gray-200 flex items-center gap-2" onClick={(e) => { e.stopPropagation(); setMenuOpenId(null); m.uploadToPublic(artist); }}>
                              <Upload className="w-3.5 h-3.5 text-gray-400" /> 上传到公共
                            </button>
                          </>
                        )}
                        {origin === 'favorited' && (
                          <>
                            <button className="w-full text-left px-3 py-2.5 active:bg-white/10 text-gray-200 flex items-center gap-2" onClick={(e) => { e.stopPropagation(); setMenuOpenId(null); m.unfavoriteArtist(artist.id); }}>
                              <X className="w-3.5 h-3.5 text-gray-400" /> 取消收藏
                            </button>
                            <button className="w-full text-left px-3 py-2.5 active:bg-white/10 text-gray-200 flex items-center gap-2" onClick={(e) => { e.stopPropagation(); setMenuOpenId(null); m.createLocalCopy(artist); }}>
                              <Copy className="w-3.5 h-3.5 text-gray-400" /> 创建本地副本
                            </button>
                          </>
                        )}
                        {origin === 'created' && (
                          <>
                            <button className="w-full text-left px-3 py-2.5 active:bg-white/10 text-gray-200 flex items-center gap-2" onClick={(e) => { e.stopPropagation(); setMenuOpenId(null); m.openArtistDetail(artist); }}>
                              <Edit2 className="w-3.5 h-3.5 text-gray-400" /> 编辑
                            </button>
                            <button className="w-full text-left px-3 py-2.5 active:bg-white/10 text-gray-200 flex items-center gap-2" onClick={(e) => { e.stopPropagation(); setMenuOpenId(null); m.handleDeleteArtist(artist.id, e as any); }}>
                              <Trash2 className="w-3.5 h-3.5 text-gray-400" /> 删除
                            </button>
                            <button className="w-full text-left px-3 py-2.5 active:bg-white/10 text-gray-200 flex items-center gap-2" onClick={(e) => { e.stopPropagation(); setMenuOpenId(null); m.createLocalCopy(artist); }}>
                              <Copy className="w-3.5 h-3.5 text-gray-400" /> 创建本地副本
                            </button>
                          </>
                        )}
                      </div>
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        </div>

        <div className="mt-auto flex flex-wrap content-start gap-1 overflow-hidden" style={{ maxHeight: '38px' }}>
          {displayTags.slice(0, 4).map((tag, i) => (
            <span
              key={i}
              className="inline-flex items-center px-1.5 py-[3px] border border-gray-700/80 bg-gray-800/50 rounded text-[9.5px] font-medium leading-none whitespace-nowrap text-gray-300"
              onClick={(e) => { e.stopPropagation(); m.setSearchQuery(tag); }}
            >
              <span className="text-amber-500/60 mr-0.5 font-bold">#</span>
              {tag}
            </span>
          ))}
        </div>
      </div>

      {m.copiedArtistId === artist.id && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-black/80 text-white text-xs px-3 py-1.5 rounded-full backdrop-blur-sm z-20">
          已复制
        </div>
      )}
      {isPublicList && m.savedArtistId === artist.id && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-black/80 text-white text-xs px-3 py-1.5 rounded-full backdrop-blur-sm z-20">
          已收藏
        </div>
      )}
    </div>
  );
};
