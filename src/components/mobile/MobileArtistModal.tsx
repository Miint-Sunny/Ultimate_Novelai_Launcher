import React, { useEffect, useRef, useState } from 'react';
import {
  X, Plus, Palette, Loader2,
  Globe, Bookmark, Search, Check
} from 'lucide-react';
import { useArtistManager } from '../artist/useArtistManager';
import { MobileArtistEditorSheet } from './artist/MobileArtistEditorSheet';
import { MobileArtistListItem } from './artist/MobileArtistListItem';

interface MobileArtistModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirmSelection: (artist: { name: string; prompt: string } | null) => void;
}

export const MobileArtistModal: React.FC<MobileArtistModalProps> = ({
  isOpen,
  onClose,
  onConfirmSelection,
}) => {
  const m = useArtistManager();
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      m.loadLocalArtists();
      m.loadPublicArtists();
    }
  }, [isOpen]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    Promise.all(files.slice(0, 4 - m.newArtistPreviews.length).map(f => {
      return new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(f);
      });
    })).then(base64s => {
      m.setNewArtistPreviews(prev => [...prev, ...base64s].slice(0, 4));
    });

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleCopy = (e: React.MouseEvent, prompt: string, id: string) => {
    e.stopPropagation();
    navigator.clipboard.writeText(prompt);
    m.setCopiedArtistId(id);
    setTimeout(() => m.setCopiedArtistId(null), 1500);
  };

  const hasSelection = m.selectedArtistIds.length > 0;
  const selectedArtist = hasSelection 
    ? [...m.artistPublicFiles, ...m.artistLocalFiles].find(a => a.id === m.selectedArtistIds[0])
    : null;

  return (
    <>
    <MobileArtistEditorSheet
      manager={m}
      fileInputRef={fileInputRef}
      onFileUpload={handleFileUpload}
    />


    {/* 列表页：底部弹窗 */}
    <div className={`fixed inset-0 z-50 bg-black/70 flex items-end animate-fade-in ${m.isCreatingArtist ? 'pointer-events-none opacity-0' : ''}`}>
      <div className="absolute inset-0" onClick={onClose} />
      
      <div className="relative w-full bg-nai-panel rounded-t-2xl flex flex-col animate-slide-in-from-bottom safe-area-bottom h-[85vh]">
        
        {/* 主要列表视口 */}
        {!m.isCreatingArtist && (
          <>
            {/* 改进 1：统合搜索栏、分类 Tab 与添加操作至 Sticky Header */}
            <div className="flex-shrink-0 flex flex-col border-b border-gray-700 bg-nai-panel z-10 rounded-t-2xl overflow-hidden">
              {/* Top Header */}
              <div className="flex items-center justify-between p-4 pb-2">
                <div className="flex items-center gap-2 text-amber-500">
                  <Palette className="w-5 h-5" />
                  <h3 className="text-lg font-bold text-white">画师串管理器</h3>
                </div>
                <button onClick={onClose} className="p-2 -mr-2 text-gray-400 hit-area">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Search & Actions Bar */}
              <div className="flex items-center gap-2 px-4 pb-3">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
                  <input
                    type="text"
                    value={m.searchQuery}
                    onChange={(e) => m.setSearchQuery(e.target.value)}
                    placeholder="搜索画师串..."
                    className="w-full h-10 bg-gray-800/80 text-gray-200 text-sm rounded-xl pl-9 pr-8 border border-gray-700 focus:border-amber-500 focus:outline-none transition-colors"
                  />
                  {m.searchQuery && (
                    <button onClick={() => m.setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white hit-area">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                {/* 改进 1/2：独立的新建按钮 */}
                <button
                  onClick={m.openCreateArtist}
                  className="h-10 px-4 bg-amber-500 text-black text-sm font-bold rounded-xl flex items-center justify-center gap-1.5 active:scale-95 transition-all shadow-sm shrink-0"
                >
                  <Plus className="w-4 h-4" />
                  新建
                </button>
              </div>

              {/* Tabs */}
              <div className="flex">
                <button
                  className={`flex-1 py-3 text-sm font-bold transition-colors border-b-2 flex items-center justify-center gap-2 ${m.artistTab === 'public'
                    ? 'border-amber-500 text-white bg-white/5'
                    : 'border-transparent text-gray-400 active:bg-white/5'
                    }`}
                  onClick={() => m.setArtistTab('public')}
                >
                  <Globe className="w-4 h-4" />
                  公共 ({m.artistPublicFiles.length})
                </button>
                <button
                  className={`flex-1 py-3 text-sm font-bold transition-colors border-b-2 flex items-center justify-center gap-2 ${m.artistTab === 'local'
                    ? 'border-amber-500 text-white bg-white/5'
                    : 'border-transparent text-gray-400 active:bg-white/5'
                    }`}
                  onClick={() => m.setArtistTab('local')}
                >
                  <Bookmark className="w-4 h-4" />
                  我的 ({m.artistLocalFiles.length})
                </button>
              </div>
            </div>

            {/* 可滑动内容区域 */}
            <div
              className="flex-1 overflow-y-auto custom-scrollbar relative"
              onScroll={(e) => m.handleArtistScroll(e as any, m.artistTab === 'public')}
              onTouchStart={(e) => {
                const touch = e.touches[0];
                (e.currentTarget as any)._touchStartX = touch.clientX;
                (e.currentTarget as any)._touchStartY = touch.clientY;
              }}
              onTouchEnd={(e) => {
                const startX = (e.currentTarget as any)._touchStartX;
                const startY = (e.currentTarget as any)._touchStartY;
                if (startX === undefined) return;
                const touch = e.changedTouches[0];
                const deltaX = touch.clientX - startX;
                const deltaY = touch.clientY - startY;
                if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 60) {
                  if (deltaX > 0 && m.artistTab === 'local') {
                    m.setArtistTab('public');
                  } else if (deltaX < 0 && m.artistTab === 'public') {
                    m.setArtistTab('local');
                  }
                }
              }}
            >
              <div className="p-3">
                {m.isLoadingPublicArtists && m.artistPublicFiles.length === 0 ? (
                  <div className="flex items-center justify-center py-16">
                    <Loader2 className="w-8 h-8 animate-spin text-amber-500/50" />
                  </div>
                ) : (m.artistTab === 'public' ? m.artistPublicFiles : m.artistLocalFiles).length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-gray-500">
                    <Palette className="w-12 h-12 mb-3 opacity-30" />
                    <p>{m.artistTab === 'public' ? '暂无匹配的公共画师串' : '暂无匹配的画师串'}</p>
                    <p className="text-xs mt-4 text-gray-600">← 左右滑动切换目录 →</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2.5 pb-4">
                    {(m.artistTab === 'public' ? m.artistPublicFiles.slice(0, m.artistPublicDisplayCount) : m.artistLocalFiles.slice(0, m.artistLocalDisplayCount)).map((artist) => (
                      <MobileArtistListItem
                        key={artist.id}
                        artist={artist}
                        manager={m}
                        isSelected={m.selectedArtistIds.includes(artist.id)}
                        isPublicList={m.artistTab === 'public'}
                        menuOpenId={menuOpenId}
                        setMenuOpenId={setMenuOpenId}
                        onCopy={handleCopy}
                      />
                    ))}
                  </div>
                )}
                
                {/* 底部加载更多提示 */}
                {m.isLoadingMoreArtists && (
                  <div className="flex justify-center py-4">
                    <Loader2 className="w-5 h-5 text-gray-500 animate-spin" />
                  </div>
                )}
              </div>
            </div>

            {/* 底部动作栏 */}
            <div className="flex-shrink-0 p-4 border-t border-gray-700 bg-nai-panel">
              <div className="flex gap-3">
                <button
                  onClick={m.handleClearArtistSelection}
                  disabled={!hasSelection}
                  className="flex-1 py-3 bg-gray-800 text-gray-300 font-bold rounded-xl active:scale-[0.98] transition-all disabled:opacity-30 disabled:active:scale-100"
                >
                  取消选择
                </button>
                <button
                  onClick={() => {
                    if (selectedArtist) {
                      onConfirmSelection({
                        name: selectedArtist.name,
                        prompt: selectedArtist.prompt,
                      });
                    } else {
                      onConfirmSelection(null);
                    }
                  }}
                  className="flex-[2] py-3 bg-amber-500 text-black font-bold rounded-xl active:scale-[0.98] transition-all flex justify-center items-center gap-2"
                >
                  <Check className="w-5 h-5" />
                  应用 {hasSelection && '(1)'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
    </>
  );
};
