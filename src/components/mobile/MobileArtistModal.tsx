import React, { useEffect, useRef, useState, useMemo } from 'react';
import {
  X, Plus, Edit2, Palette, RefreshCw, Loader2,
  Globe, Bookmark, Search, Copy, Check, Trash2, Save, HardDrive,
  ArrowLeft, Star, Image as ImageIcon, MoreVertical, Upload, Heart
} from 'lucide-react';
import { getArtistTokens } from '../artist/useArtistManager';
import { useArtistManager } from '../artist/useArtistManager';

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
    {/* 创建/编辑时：独立的全屏覆盖层，不依赖底部弹窗布局 */}
    {m.isCreatingArtist && (
      <div className="fixed inset-0 z-[60] bg-nai-panel flex flex-col animate-fade-in safe-area-bottom">
        {/* =========================================
           创建/编辑表单 - 全屏
           ========================================= */}
        {/* Header */}
        <div className="flex-shrink-0 flex items-center justify-between p-4 border-b border-gray-700 bg-nai-panel z-10">
          <div className="flex items-center gap-2">
            <button 
              onClick={() => m.setIsCreatingArtist(false)} 
              className="flex items-center gap-1.5 px-2 py-1.5 -ml-2 text-gray-300 active:text-white rounded-lg active:bg-white/10 transition-colors hit-area"
            >
              <ArrowLeft className="w-5 h-5" />
              <span className="text-sm font-medium">返回</span>
            </button>
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              {m.editingArtistId ? <Edit2 className="w-4 h-4 text-amber-500" /> : <Plus className="w-4 h-4 text-amber-500" />}
              {m.editingArtistId ? '编辑画师串' : '新建画师串'}
            </h3>
          </div>
          {m.editingArtistId && (
            <button
              onClick={() => m.handleDeleteArtist(m.editingArtistId!)}
              className="flex items-center gap-1.5 px-2 py-1.5 -mr-2 text-red-400 rounded-lg active:bg-red-500/15 transition-colors hit-area"
            >
              <Trash2 className="w-4.5 h-4.5" />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 custom-scrollbar">
          
          {/* 表单字段区 */}
          <div className="flex flex-col gap-4">
            <div>
              <label className="text-xs text-gray-400 font-bold block mb-1.5 uppercase tracking-wider">画师串名称</label>
              <input
                type="text"
                value={m.newArtistName}
                onChange={(e) => m.setNewArtistName(e.target.value)}
                className="w-full bg-gray-800/80 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm focus:border-amber-500 outline-none font-bold transition-colors"
                placeholder="输入容易辨识的名称..."
              />
            </div>
            
            <div className="flex flex-col flex-1 min-h-[160px]">
              <div className="flex justify-between items-end mb-1.5">
                <label className="text-xs text-gray-400 font-bold uppercase tracking-wider">提示词内容</label>
                <button
                  onClick={async () => {
                    try {
                      const text = await navigator.clipboard.readText();
                      if (text) m.handleArtistPromptChange(text);
                    } catch (e) {
                      alert('无法读取剪贴板');
                    }
                  }}
                  className="text-[11px] bg-gray-800 hover:bg-gray-700 text-gray-300 px-2.5 py-1 rounded-md flex items-center gap-1 active:scale-95 transition-all outline outline-1 outline-gray-700"
                >
                  <Copy className="w-3 h-3" /> 粘贴
                </button>
              </div>
              <textarea
                value={m.newArtistPrompt}
                onChange={(e) => m.handleArtistPromptChange(e.target.value)}
                className="flex-1 w-full bg-gray-800/80 border border-gray-700 rounded-xl p-3 text-sm text-white focus:border-amber-500 outline-none resize-none font-mono leading-relaxed transition-colors"
                placeholder="在此粘贴画师或风格词串..."
              />
            </div>
          </div>

          <div className="h-px bg-gray-800/80" />

          {/* 封面与预览管理区 */}
          <div>
            <div className="flex justify-between items-end mb-2">
              <label className="text-xs text-gray-400 font-bold uppercase tracking-wider">画师效果图 ({m.newArtistPreviews.length}/4)</label>
            </div>
            
            <input
              type="file"
              multiple
              ref={fileInputRef}
              className="hidden"
              accept="image/*"
              onChange={handleFileUpload}
            />
            
            <div className="grid grid-cols-2 gap-2 aspect-square">
              {[0, 1, 2, 3].map((idx) => {
                const preview = m.newArtistPreviews[idx];
                const isCover = m.selectedArtistCoverIndex === idx;
                const isGeneratingThis = m.isGeneratingArtistPreviews && m.artistPreviewProgress?.current === idx + 1;
                
                return (
                  <div
                    key={idx}
                    className={`relative rounded-xl overflow-hidden bg-gray-800/40 border-2 transition-all ${
                      preview 
                        ? (isCover ? 'border-amber-500' : 'border-gray-700') 
                        : 'border-dashed border-gray-700/50 active:bg-gray-800/80'
                    }`}
                    onClick={() => preview ? m.setSelectedArtistCoverIndex(idx) : (!m.isGeneratingArtistPreviews && fileInputRef.current?.click())}
                  >
                    {isGeneratingThis && (
                      <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center z-20 backdrop-blur-[2px]">
                        <Loader2 className="w-6 h-6 text-amber-500 animate-spin mb-2" />
                        <span className="text-[10px] text-amber-400 font-bold">生成中...</span>
                      </div>
                    )}
                    
                    {preview ? (
                      <>
                        <img src={preview} alt="" className="w-full h-full object-cover" />
                        <div className="absolute top-1.5 left-1.5 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded backdrop-blur-md">
                          #{idx + 1}
                        </div>
                        {isCover && (
                          <div className="absolute top-1.5 right-1.5 bg-amber-500 text-black text-[10px] px-1.5 py-0.5 rounded font-bold shadow-md">
                            封面
                          </div>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            m.setNewArtistPreviews(prev => prev.filter((_, i) => i !== idx));
                          }}
                          className="absolute bottom-1.5 right-1.5 w-9 h-9 bg-red-500/80 backdrop-blur-md text-white rounded-xl flex items-center justify-center active:scale-90"
                        >
                          <X className="w-4 h-4 stroke-2" />
                        </button>
                        {m.newArtistPrompt && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              m.handleRegenerateArtistPreviewAt(idx);
                            }}
                            disabled={m.isGeneratingArtistPreviews}
                            className="absolute bottom-1.5 right-12 w-9 h-9 bg-black/60 backdrop-blur-md text-white rounded-xl flex items-center justify-center active:scale-90 disabled:opacity-50"
                          >
                            <RefreshCw className="w-4 h-4" />
                          </button>
                        )}
                      </>
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center text-gray-500 gap-1 opacity-60">
                        <Plus className="w-6 h-6" />
                        <span className="text-[10px] font-medium tracking-wide">上传或生成</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            
            {m.newArtistPreviews.length < 4 && (
              <button
                onClick={m.handleGenerateSingleArtistPreview}
                disabled={!m.newArtistPrompt || m.isGeneratingArtistPreviews}
                className="w-full mt-3 py-3 bg-gray-800 text-amber-500 font-bold rounded-xl active:scale-[0.98] transition-all disabled:opacity-40 disabled:active:scale-100 flex items-center justify-center gap-2 border border-gray-700/50"
              >
                {m.isGeneratingArtistPreviews ? <Loader2 className="w-4 h-4 animate-spin" /> : <Palette className="w-4 h-4" />}
                使用预设生成一张
              </button>
            )}
          </div>
        </div>

        {/* 底部保存按钮 */}
        <div className="flex-shrink-0 p-4 border-t border-gray-700 bg-nai-panel shadow-[0_-10px_20px_rgba(0,0,0,0.3)]">
          {m.editingArtistId ? (
            <button
              onClick={() => m.handleSaveArtist()}
              disabled={!m.newArtistName || m.newArtistPreviews.length === 0 || m.isSavingArtist}
              className="w-full py-3.5 bg-amber-500 text-black font-bold rounded-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {m.isSavingArtist ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
              保存修改
            </button>
          ) : (
            <div className="flex gap-3">
              <button
                onClick={() => m.handleSaveArtist('public')}
                disabled={!m.newArtistName || m.newArtistPreviews.length === 0 || m.isSavingArtist}
                className="flex-[4] py-3.5 bg-gray-800 text-white border border-gray-700 font-bold rounded-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {m.isSavingArtist ? <Loader2 className="w-5 h-5 animate-spin" /> : <Globe className="w-5 h-5 text-gray-400" />}
                公开
              </button>
              <button
                onClick={() => m.handleSaveArtist('local')}
                disabled={!m.newArtistName || m.newArtistPreviews.length === 0 || m.isSavingArtist}
                className="flex-[6] py-3.5 bg-amber-500 text-black font-bold rounded-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50 shadow-[0_0_15px_rgba(245,158,11,0.2)]"
              >
                {m.isSavingArtist ? <Loader2 className="w-5 h-5 animate-spin" /> : <HardDrive className="w-5 h-5" />}
                保存至本地
              </button>
            </div>
          )}
        </div>
      </div>
    )}

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
                    {(m.artistTab === 'public' ? m.artistPublicFiles.slice(0, m.artistPublicDisplayCount) : m.artistLocalFiles.slice(0, m.artistLocalDisplayCount)).map((artist) => {
                      const isSelected = m.selectedArtistIds.includes(artist.id);
                      const isPublicList = m.artistTab === 'public';
                      const artistTags = getArtistTokens(artist.prompt)
                        .map(t => t.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
                      const displayTags = artistTags.length > 0 
                        ? artistTags 
                        : artist.prompt.split(/[,，]/).map(t => t.trim()).filter(Boolean).slice(0, 3);
                      
                      return (
                        <div
                          key={artist.id}
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
                          {/* 左侧封面 */}
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
                            {/* 选中标记 */}
                            {isSelected && (
                              <div className="absolute top-2 left-2 bg-amber-500 text-black rounded-full p-1 shadow-lg z-10">
                                <Check className="w-3 h-3 stroke-[3]" />
                              </div>
                            )}
                            {/* 右边缘渐变融合 */}
                            <div className="absolute inset-y-0 right-0 w-4 bg-gradient-to-l from-gray-900/30 to-transparent pointer-events-none" />
                          </div>

                          {/* 右侧信息区 */}
                          <div className="flex min-w-0 flex-1 flex-col p-2.5">
                            <div className="flex items-start justify-between gap-2">
                              {/* 名称 */}
                              <div className="min-w-0 flex-1">
                                <div className={`truncate text-[14px] font-extrabold tracking-wide ${
                                  isSelected ? 'text-amber-400' : 'text-gray-100'
                                }`}>
                                  {artist.name}
                                </div>
                                {/* 来源标签 */}
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

                              {/* 右侧操作按钮组 */}
                              <div className="flex shrink-0 gap-1.5">
                                {/* 复制 */}
                                <button
                                  className={`rounded-lg p-2 shadow-sm border backdrop-blur-sm transition-all ${
                                    m.copiedArtistId === artist.id
                                      ? 'bg-green-500/20 text-green-400 border-green-500/40'
                                      : 'bg-gray-700/40 text-gray-300 border-white/5 active:bg-gray-600/80'
                                  }`}
                                  onClick={(e) => handleCopy(e, artist.prompt, artist.id)}
                                >
                                  {m.copiedArtistId === artist.id ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                                </button>
                                {/* 公共 → 收藏到本地 */}
                                {isPublicList && (
                                  <button
                                    className="rounded-lg p-2 shadow-sm border backdrop-blur-sm transition-all bg-gray-700/40 text-gray-300 border-white/5 active:bg-gray-600/80"
                                    onClick={(e) => { e.stopPropagation(); m.savePublicToLocal(artist); }}
                                  >
                                    <Heart className="w-4 h-4" />
                                  </button>
                                )}
                                {/* 我的 → 更多菜单 */}
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

                            {/* 画师标签 */}
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

                          {/* 操作成功提示浮层 */}
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
                    })}
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
