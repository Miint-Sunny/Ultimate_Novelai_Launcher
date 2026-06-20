import React from 'react';
import { createPortal } from 'react-dom';
import {
  Check, Image as ImageIcon, User2, Star, Edit2, HardDrive, Globe, Tag,
  Trash2, Upload, Copy as CopyIcon, MoreVertical, X as XIcon, Heart,
} from 'lucide-react';
import type { ArtistFile } from './types';
import { getArtistTokens } from './useArtistManager';

interface ArtistCardProps {
  file: ArtistFile;
  isSelected: boolean;
  /** 'public' = 公共Tab里的卡片, 'mine' = 我的画师串Tab里的卡片 */
  variant: 'public' | 'mine';
  copiedArtistId: string | null;
  savedArtistId: string | null;
  menuOpenId?: string | null;
  onMenuToggle?: (id: string | null) => void;
  onToggleSelection: (id: string) => void;
  onCopy: (id: string, prompt: string) => void;
  onEdit?: (file: ArtistFile) => void;
  // 公共卡片专用
  onSaveToLocal?: (file: ArtistFile) => void;
  // 我的画师串卡片专用
  onDelete?: (id: string) => void;
  onUnfavorite?: (id: string) => void;
  onCreateLocalCopy?: (file: ArtistFile) => void;
  onUploadToPublic?: (file: ArtistFile) => void;
  // 标签点击专用
  onTagClick?: (tag: string) => void;
  // 编辑标签
  onEditTags?: (file: ArtistFile) => void;
  // 是否已收藏到本地（公共tab用）
  isSavedToLocal?: boolean;
}

// 来源标签配置
const ORIGIN_BADGE = {
  local: { icon: HardDrive, label: '来自本地', className: 'border-gray-500/50 bg-gray-500/20 text-gray-300' },
  favorited: { icon: Star, label: '来自公共收藏', className: 'border-yellow-500/50 bg-yellow-500/15 text-yellow-300' },
  created: { icon: Globe, label: '来自公共创建', className: 'border-blue-400/50 bg-blue-500/20 text-blue-300' },
} as const;

export const ArtistCard: React.FC<ArtistCardProps> = ({
  file, isSelected, variant,
  copiedArtistId, savedArtistId,
  menuOpenId, onMenuToggle,
  onToggleSelection, onCopy, onEdit,
  onSaveToLocal, onDelete, onUnfavorite, onCreateLocalCopy, onUploadToPublic,
  onTagClick, onEditTags, isSavedToLocal,
}) => {
  // 提取画师词根作为标签展示
  const artistTokens = React.useMemo(() => getArtistTokens(file.prompt), [file.prompt]);
  const artistTags = artistTokens.length > 0
    ? artistTokens.map(t => t.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '))
    : file.prompt.split(/[,，]/).map(t => t.trim()).filter(Boolean).slice(0, 3);

  const [currentPreviewIndex, setCurrentPreviewIndex] = React.useState(0);
  const menuBtnRef = React.useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = React.useState<{ top: number; left: number } | null>(null);

  const isMenuOpen = menuOpenId === file.id;
  const origin = file.origin ?? 'local';

  // 打开菜单时计算按钮位置
  React.useEffect(() => {
    if (isMenuOpen && menuBtnRef.current) {
      const rect = menuBtnRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, left: rect.right });
    } else {
      setMenuPos(null);
    }
  }, [isMenuOpen]);

  React.useEffect(() => {
    if (file.previews && file.previews.length > 1) {
      const interval = setInterval(() => {
        setCurrentPreviewIndex((prev) => (prev + 1) % file.previews.length);
      }, 2500);
      return () => clearInterval(interval);
    }
  }, [file.previews]);

  return (
    <div
      className={`group relative flex h-[128px] overflow-hidden rounded-xl border cursor-pointer transition-all duration-300 ease-out hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/60 ${
        isSelected
          ? 'bg-gradient-to-br from-gray-800 to-gray-900 border-nai-accent ring-1 ring-nai-accent/40 shadow-[0_4px_20px_rgba(242,211,107,0.15)]'
          : 'bg-gradient-to-br from-gray-800/60 to-gray-900/80 border-gray-700/50 hover:border-gray-500/70'
      }`}
      onClick={() => onToggleSelection(file.id)}
    >
      {/* 预览图区域 */}
      <div className="relative w-[128px] shrink-0 border-r border-gray-700/40 bg-black/60 overflow-hidden">
        {file.previews.length > 0 ? (
          <div className="relative w-full h-full">
            {file.previews.map((src, index) => (
              <img
                key={src}
                src={src}
                alt={`${file.name} - 预览 ${index + 1}`}
                loading="lazy"
                decoding="async"
                className={`absolute inset-0 h-full w-full object-cover transform transition-all duration-700 ease-out group-hover:scale-110 ${
                  index === currentPreviewIndex ? 'opacity-100 z-10' : 'opacity-0 z-0'
                }`}
              />
            ))}
            {file.previews.length > 1 && (
              <div className="absolute top-1 right-1 flex gap-0.5 z-20 bg-black/40 rounded px-1 py-0.5">
                {file.previews.map((_, index) => (
                  <div
                    key={index}
                    className={`h-1 w-1.5 rounded-full transition-colors ${
                      index === currentPreviewIndex ? 'bg-nai-accent' : 'bg-white/40'
                    }`}
                  />
                ))}
              </div>
            )}
            <div className="absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-gray-900/30 to-transparent z-20 pointer-events-none"></div>
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center text-gray-500">
            <div className="flex flex-col items-center gap-1.5">
              <ImageIcon className="h-6 w-6" />
              <span className="text-[10px]">暂无预览图</span>
            </div>
          </div>
        )}
      </div>

      {/* 右侧信息区域 */}
      <div className="flex min-w-0 flex-1 flex-col p-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <div className={`truncate text-[14px] font-extrabold tracking-wide transition-colors ${isSelected ? 'text-nai-accent drop-shadow-[0_0_8px_rgba(242,211,107,0.3)]' : 'text-gray-100 group-hover:text-white'}`}>
                {file.name}
              </div>
            </div>
            {/* 用户标签 - 过滤掉历史遗留的 '收藏' token */}
            {(() => {
              const visibleTags = (file.tags || []).filter(t => t !== '收藏');
              if (visibleTags.length === 0) return null;
              return (
                <div className="mt-1 flex flex-wrap gap-1">
                  {visibleTags.map(tag => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-0.5 rounded-full py-0.5 px-1.5 text-[9.5px] font-bold bg-nai-accent/10 text-nai-accent/80 border border-nai-accent/20"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* 操作按钮 */}
          <div className="flex shrink-0 gap-1.5 opacity-60 group-hover:opacity-100 transition-opacity">
            {/* 复制按钮 */}
            <button
              className={`${copiedArtistId === file.id ? 'bg-green-500/20 text-green-400 border-green-500/40' : 'bg-gray-700/40 hover:bg-gray-600/80 text-gray-300 hover:text-white border-white/5'} rounded-lg p-2.5 shadow-sm border backdrop-blur-sm transition-all pointer-events-auto`}
              onClick={(e) => { e.stopPropagation(); onCopy(file.id, file.prompt); }}
            >
              {copiedArtistId === file.id ? <Check className="w-[18px] h-[18px]" /> : <CopyIcon className="w-[18px] h-[18px]" />}
            </button>

            {/* 公共Tab：收藏按钮 */}
            {variant === 'public' && onSaveToLocal && (
              <button
                className={`rounded-lg p-2.5 shadow-sm border backdrop-blur-sm transition-all pointer-events-auto ${
                  savedArtistId === file.id
                    ? 'bg-green-500/20 text-green-400 border-green-500/40'
                    : 'bg-gray-700/40 hover:bg-gray-600/80 text-gray-300 hover:text-pink-400 border-white/5'
                }`}
                onClick={(e) => { e.stopPropagation(); onSaveToLocal(file); }}
              >
                {savedArtistId === file.id ? <Check className="w-[18px] h-[18px]" /> : <Heart className="w-[18px] h-[18px]" />}
              </button>
            )}

            {/* 我的Tab：更多按钮 */}
            {variant === 'mine' && onMenuToggle && (
              <>
                <button
                  ref={menuBtnRef}
                  className={`${isMenuOpen ? 'bg-white/15 text-white border-white/20' : 'bg-gray-700/40 hover:bg-gray-600/80 text-gray-300 hover:text-white border-white/5'} rounded-lg p-2.5 shadow-sm border backdrop-blur-sm transition-all pointer-events-auto`}
                  onClick={(e) => { e.stopPropagation(); onMenuToggle(isMenuOpen ? null : file.id); }}
                  title="更多操作"
                >
                  <MoreVertical className="w-[18px] h-[18px]" />
                </button>

                {/* Portal 下拉菜单 */}
                {isMenuOpen && menuPos && createPortal(
                  <>
                    <div className="fixed inset-0 z-[200]" onClick={(e) => { e.stopPropagation(); onMenuToggle(null); }} />
                    <div
                      className="fixed w-36 bg-nai-panel border border-gray-700 rounded-lg shadow-xl z-[201] py-1 text-sm animate-in fade-in zoom-in-95 duration-150 origin-top-right"
                      style={{ top: menuPos.top, left: menuPos.left - 144 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {origin === 'local' && (
                        <>
                          {onEditTags && (
                            <button
                              className="w-full text-left px-3 py-2 hover:bg-white/10 text-gray-200 flex items-center gap-2 transition-colors"
                              onClick={(e) => { e.stopPropagation(); onMenuToggle(null); onEditTags(file); }}
                            >
                              <Tag className="w-3.5 h-3.5 text-gray-400" /> 编辑标签
                            </button>
                          )}
                          {onEdit && (
                            <button
                              className="w-full text-left px-3 py-2 hover:bg-white/10 text-gray-200 flex items-center gap-2 transition-colors"
                              onClick={(e) => { e.stopPropagation(); onMenuToggle(null); onEdit(file); }}
                            >
                              <Edit2 className="w-3.5 h-3.5 text-gray-400" /> 编辑
                            </button>
                          )}
                          {onDelete && (
                            <button
                              className="w-full text-left px-3 py-2 hover:bg-white/10 text-gray-200 flex items-center gap-2 transition-colors"
                              onClick={(e) => { e.stopPropagation(); onMenuToggle(null); onDelete(file.id); }}
                            >
                              <Trash2 className="w-3.5 h-3.5 text-gray-400" /> 删除
                            </button>
                          )}
                          {onUploadToPublic && (
                            <button
                              className="w-full text-left px-3 py-2 hover:bg-white/10 text-gray-200 flex items-center gap-2 transition-colors"
                              onClick={(e) => { e.stopPropagation(); onMenuToggle(null); onUploadToPublic(file); }}
                            >
                              <Upload className="w-3.5 h-3.5 text-gray-400" /> 上传到公共
                            </button>
                          )}
                        </>
                      )}
                      {origin === 'favorited' && (
                        <>
                          {onUnfavorite && (
                            <button
                              className="w-full text-left px-3 py-2 hover:bg-white/10 text-gray-200 flex items-center gap-2 transition-colors"
                              onClick={(e) => { e.stopPropagation(); onMenuToggle(null); onUnfavorite(file.id); }}
                            >
                              <XIcon className="w-3.5 h-3.5 text-gray-400" /> 取消收藏
                            </button>
                          )}
                          {onEditTags && (
                            <button
                              className="w-full text-left px-3 py-2 hover:bg-white/10 text-gray-200 flex items-center gap-2 transition-colors"
                              onClick={(e) => { e.stopPropagation(); onMenuToggle(null); onEditTags(file); }}
                            >
                              <Tag className="w-3.5 h-3.5 text-gray-400" /> 编辑标签
                            </button>
                          )}
                          {onCreateLocalCopy && (
                            <button
                              className="w-full text-left px-3 py-2 hover:bg-white/10 text-gray-200 flex items-center gap-2 transition-colors"
                              onClick={(e) => { e.stopPropagation(); onMenuToggle(null); onCreateLocalCopy(file); }}
                            >
                              <CopyIcon className="w-3.5 h-3.5 text-gray-400" /> 创建本地副本
                            </button>
                          )}
                        </>
                      )}
                      {origin === 'created' && (
                        <>
                          {onEditTags && (
                            <button
                              className="w-full text-left px-3 py-2 hover:bg-white/10 text-gray-200 flex items-center gap-2 transition-colors"
                              onClick={(e) => { e.stopPropagation(); onMenuToggle(null); onEditTags(file); }}
                            >
                              <Tag className="w-3.5 h-3.5 text-gray-400" /> 编辑标签
                            </button>
                          )}
                          {onEdit && (
                            <button
                              className="w-full text-left px-3 py-2 hover:bg-white/10 text-gray-200 flex items-center gap-2 transition-colors"
                              onClick={(e) => { e.stopPropagation(); onMenuToggle(null); onEdit(file); }}
                            >
                              <Edit2 className="w-3.5 h-3.5 text-gray-400" /> 编辑
                            </button>
                          )}
                          {onDelete && (
                            <button
                              className="w-full text-left px-3 py-2 hover:bg-white/10 text-gray-200 flex items-center gap-2 transition-colors"
                              onClick={(e) => { e.stopPropagation(); onMenuToggle(null); onDelete(file.id); }}
                            >
                              <Trash2 className="w-3.5 h-3.5 text-gray-400" /> 删除
                            </button>
                          )}
                          {onCreateLocalCopy && (
                            <button
                              className="w-full text-left px-3 py-2 hover:bg-white/10 text-gray-200 flex items-center gap-2 transition-colors"
                              onClick={(e) => { e.stopPropagation(); onMenuToggle(null); onCreateLocalCopy(file); }}
                            >
                              <CopyIcon className="w-3.5 h-3.5 text-gray-400" /> 创建本地副本
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </>,
                  document.body
                )}
              </>
            )}
          </div>
        </div>

        {/* 标签 */}
        <div
          className="mt-2.5 flex flex-wrap content-start gap-1.5 overflow-hidden flex-1 min-h-0 relative pr-1"
          style={{ maxHeight: '44px' }}
        >
          {artistTags.map((tag, i) => (
            <span
              key={i}
              className="inline-flex items-center px-1.5 py-[3px] border border-gray-700/80 bg-gray-800/50 rounded text-[9.5px] font-medium leading-none whitespace-nowrap transition-all outline outline-1 outline-transparent hover:outline-nai-accent/30 hover:border-nai-accent text-gray-300 hover:text-white hover:bg-gray-800/80 hover:shadow-sm cursor-pointer"
              title={`复制 ${tag}`}
              onClick={(e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(tag).catch(() => {});
                // 在点击位置显示一个小提示
                const tip = document.createElement('div');
                tip.textContent = '已复制';
                tip.className = 'fixed z-[9999] px-2 py-1 bg-gray-800 text-green-400 text-xs rounded shadow-lg pointer-events-none animate-fade-in';
                tip.style.left = `${e.clientX}px`;
                tip.style.top = `${e.clientY - 30}px`;
                document.body.appendChild(tip);
                setTimeout(() => tip.remove(), 800);
              }}
            >
              <span className="text-nai-accent/60 mr-0.5 font-bold">#</span>
              {tag}
            </span>
          ))}
        </div>
      </div>

      {/* 选中标记 */}
      {isSelected && (
        <div className="absolute left-2.5 top-2.5 bg-nai-accent text-black rounded-full p-1 shadow-lg z-10">
          <Check className="w-3 h-3" />
        </div>
      )}
    </div>
  );
};
