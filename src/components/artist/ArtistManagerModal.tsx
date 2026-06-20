// 画师串管理器 - 弹窗组件
import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
  X, Plus, Edit2, Palette, RefreshCw, Loader2,
  Globe, Bookmark, RotateCcw, Wand2, Save, Trash2, HardDrive,
  Image as ImageIcon, Check, Search, Clock, ListFilter, Tag, Settings
} from 'lucide-react';
import { Clipboard as ClipboardIcon } from 'lucide-react';
import type { UseArtistManagerReturn, ArtistFile } from './types';
import { ArtistCard } from './ArtistCard';
import { ArtistCloudManageModal } from './ArtistCloudManageModal';
import { PublicArtistManagerModal } from './PublicArtistManagerModal';
import { getCurrentBotUserId } from '../../services/botService';
import { Cloud } from 'lucide-react';

interface ArtistManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  manager: UseArtistManagerReturn;
  onConfirmSelection: () => void;
  showToast: (message: string, type: 'success' | 'error') => void;
}

export const ArtistManagerModal: React.FC<ArtistManagerModalProps> = ({
  isOpen, onClose, manager: m, onConfirmSelection, showToast,
}) => {
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  // 标签编辑
  const [tagEditorTarget, setTagEditorTarget] = useState<{ artistId: string; current: Set<string> } | null>(null);
  // 标签管理面板
  const [tagSettingsOpen, setTagSettingsOpen] = useState(false);
  const [tagSettingsCreating, setTagSettingsCreating] = useState(false);
  const [tagSettingsNewName, setTagSettingsNewName] = useState('');
  // 批量打标签
  const [batchTagOpen, setBatchTagOpen] = useState(false);
  const [batchTagsToAdd, setBatchTagsToAdd] = useState<Set<string>>(new Set());
  // 批量删除loading
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  // 云端备份弹窗
  const [cloudManageOpen, setCloudManageOpen] = useState(false);
  // 公共画师串管理弹窗
  const [publicManagerOpen, setPublicManagerOpen] = useState(false);

  useEffect(() => {
    if (isOpen) {
      m.loadLocalArtists();
      m.loadPublicArtists(true);
    }
  }, [isOpen]);

  // 模态框重新挂载 / tab 切换后，把上次离开时记录的 scrollTop 还原回新的容器
  useEffect(() => {
    if (!isOpen) return;
    const ref = m.artistTab === 'public' ? m.artistPublicScrollRef : m.artistLocalScrollRef;
    const saved = m.artistTab === 'public' ? m.artistPublicScrollTopRef.current : m.artistLocalScrollTopRef.current;
    if (saved <= 0) return;
    const id = requestAnimationFrame(() => {
      if (ref.current) ref.current.scrollTop = saved;
    });
    return () => cancelAnimationFrame(id);
  }, [isOpen, m.artistTab]);

  if (!isOpen) return null;

  const handleCopy = (id: string, prompt: string) => {
    navigator.clipboard.writeText(prompt);
    m.setCopiedArtistId(id);
    setTimeout(() => m.setCopiedArtistId(null), 1500);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-nai-panel border border-gray-700 rounded-lg shadow-2xl w-[min(800px,90vw)] h-[84vh] max-h-[900px] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200 relative" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="p-4 border-b border-gray-800 flex items-center gap-3 bg-nai-dark/50">
          <div className="flex items-center gap-2 shrink-0">
            <Palette className="w-5 h-5 text-nai-accent" />
            <span className="font-bold text-white text-base">画师串管理器</span>
          </div>

          <div className="flex-1 relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              value={m.searchQuery}
              onChange={(e) => m.setSearchQuery(e.target.value)}
              placeholder="搜索画师串..."
              className="w-full h-8 bg-gray-800/80 text-gray-200 text-sm rounded-lg pl-8 pr-7 border border-gray-700 focus:border-nai-accent focus:outline-none transition-colors"
            />
            {m.searchQuery && (
              <button onClick={() => m.setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setCloudManageOpen(true)}
              className="h-8 w-8 rounded flex items-center justify-center transition-colors border bg-gray-800 border-gray-600 text-gray-400 hover:bg-gray-700 hover:text-nai-accent"
              title="云端数据管理"
            >
              <Cloud className="w-4 h-4" />
            </button>
            <button
              onClick={m.openCreateArtist}
              className="h-8 px-3 bg-nai-accent hover:bg-[#ebd576] text-black text-sm font-bold rounded flex items-center justify-center gap-1.5 transition-colors shadow-sm whitespace-nowrap"
              title="新建配置"
            >
              <Plus className="w-4 h-4" />
              新建
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors ml-1">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Creation/Edit Overlay */}
        <ArtistCreateEditOverlay manager={m} />

        {/* Tab Bar */}
        <div className="flex border-b border-gray-800 shrink-0">
          <button
            className={`flex-1 py-3 text-sm font-bold transition-colors border-b-2 ${m.artistTab === 'public'
              ? 'border-nai-accent text-white bg-white/5'
              : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-white/5'
              }`}
            onClick={() => m.setArtistTab('public')}
          >
            <div className="flex items-center justify-center gap-2">
              <Globe className="w-4 h-4" />
              公共画师串
                {m.isLoadingPublicArtists && <Loader2 className="w-3 h-3 animate-spin" />}
            </div>
          </button>
          <button
            className={`flex-1 py-3 text-sm font-bold transition-colors border-b-2 ${m.artistTab === 'local'
              ? 'border-nai-accent text-white bg-white/5'
              : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-white/5'
              }`}
            onClick={() => m.setArtistTab('local')}
          >
            <div className="flex items-center justify-center gap-2">
              <Bookmark className="w-4 h-4" />
              我的画师串
            </div>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden bg-nai-dark/20 min-h-[300px] relative">
          {/* Public Tab */}
          <ArtistListWithAlphabet
            files={m.artistPublicFiles}
            displayCount={m.artistPublicDisplayCount}
            onExpandDisplay={(n) => m.setArtistPublicDisplayCount(n)}
            scrollRef={m.artistPublicScrollRef}
            isVisible={m.artistTab === 'public'}
            slideDirection="left"
            onScroll={(e) => m.handleArtistScroll(e, true)}
            headerNode={
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs text-gray-400">
                  <Globe className="w-3.5 h-3.5" />
                  <span className="font-bold">公共库</span>
                  <span className="text-gray-500">({m.artistPublicFiles.length})</span>
                </div>
                <button
                  onClick={() => setPublicManagerOpen(true)}
                  disabled={!getCurrentBotUserId()}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] font-bold rounded-md bg-gray-800 border border-gray-700 text-gray-300 hover:text-nai-accent hover:border-nai-accent/50 hover:bg-nai-accent/5 transition-colors disabled:opacity-40"
                  title="管理我上传到公共库的画师串"
                >
                  <Settings className="w-3 h-3" />
                  管理我上传的
                  {getCurrentBotUserId() && (
                    <span className="text-nai-accent">({m.artistPublicFiles.filter(a => a.addedBy === getCurrentBotUserId()).length})</span>
                  )}
                </button>
              </div>
            }
            emptyNode={
              m.isLoadingPublicArtists ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-500 py-10">
                  <Loader2 className="w-8 h-8 animate-spin mb-3 text-nai-accent" />
                  <p className="text-sm">加载公共画师串中...</p>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-gray-500 py-10">
                  <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center mb-3">
                    <Palette className="w-6 h-6 opacity-50" />
                  </div>
                  <p className="text-sm">未找到公共画师串</p>
                </div>
              )
            }
            renderCard={(file) => (
              <ArtistCard
                key={file.id}
                file={file}
                isSelected={m.selectedArtistIds.includes(file.id)}
                variant="public"
                copiedArtistId={m.copiedArtistId}
                savedArtistId={m.savedArtistId}
                isSavedToLocal={m.artistLocalFiles.some(f => f.publicId === file.id || f.name === file.name)}
                onToggleSelection={m.toggleArtistSelection}
                onCopy={handleCopy}
                onEdit={m.openArtistDetail}
                onSaveToLocal={m.savePublicToLocal}
                onTagClick={(tag) => m.setSearchQuery(tag)}
              />
            )}
          />

          {/* Local Tab */}
          <div
            ref={m.artistLocalScrollRef}
            className={`absolute inset-0 overflow-y-scroll p-4 custom-scrollbar transition-all duration-200 ease-out ${m.artistTab === 'local' ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-full pointer-events-none'}`}
            onScroll={(e) => m.handleArtistScroll(e, false)}
          >
            {/* 最近使用区域 */}
            {m.artistUsageOrder.length > 0 && (() => {
              // 只渲染在 localFiles/publicFiles 中真实存在的（防幽灵条目）
              const fileMap = new Map<string, ArtistFile>();
              for (const f of m.artistPublicFiles) fileMap.set(f.id, f);
              for (const f of m.artistLocalFiles) fileMap.set(f.id, f);
              // 只渲染一行能放下的数量（w-20=80px + gap-2.5=10px = 90px/个，容器约768px → 8个）
              const recentArtists = m.artistUsageOrder
                .map(id => fileMap.get(id))
                .filter((f): f is ArtistFile => !!f)
                .slice(0, 8);
              if (recentArtists.length === 0) return null;
              return (
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5 text-xs text-gray-400">
                      <Clock className="w-3.5 h-3.5" />
                      <span className="font-bold">最近使用</span>
                    </div>
                    <button
                      onClick={() => m.updateArtistUsageOrder([])}
                      className="flex items-center gap-1 px-2 py-0.5 rounded-md text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      <Trash2 className="w-3 h-3" />
                      <span className="text-xs">清空</span>
                    </button>
                  </div>
                  <div className="flex gap-2.5">
                    {recentArtists.map(file => {
                      const isSelected = m.selectedArtistIds.includes(file.id);
                      return (
                        <div
                          key={file.id}
                          className="flex-shrink-0 w-20 cursor-pointer group/recent transition-all"
                          onClick={() => m.toggleArtistSelection(file.id)}
                          title={file.name}
                        >
                          <div className={`w-20 h-20 rounded-lg overflow-hidden border-2 transition-colors ${isSelected ? 'border-nai-accent' : 'border-transparent hover:border-gray-600'}`}>
                            {file.previews.length > 0 ? (
                              <img src={file.previews[0]} alt={file.name} className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full bg-gray-800 flex items-center justify-center">
                                <ImageIcon className="w-5 h-5 text-gray-500" />
                              </div>
                            )}
                          </div>
                          <div className={`text-[10px] mt-1 truncate text-center ${isSelected ? 'text-nai-accent font-bold' : 'text-gray-400'}`}>
                            {file.name}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* 列表标题栏 */}
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs text-gray-400">
                <ListFilter className="w-3.5 h-3.5" />
                <span className="font-bold">{m.selectedTagFilter.size > 0 ? '已筛选' : '全部画师串'}</span>
                <span className="text-gray-500">({m.artistLocalFiles.length})</span>
              </div>
              <button onClick={() => setTagSettingsOpen(true)} className="p-1 text-gray-500 hover:text-nai-accent rounded hover:bg-white/5 transition-colors" title="标签管理">
                <Settings className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* 标签筛选 chips */}
            {m.artistTagPool.length > 0 && (
              <div className="mb-3 flex items-center gap-1.5 overflow-x-auto pb-1.5 scrollbar-thin scrollbar-thumb-gray-700">
                <button
                  onClick={() => m.setSelectedTagFilter(new Set())}
                  className={`shrink-0 px-2.5 py-1 text-[11px] font-bold rounded-full transition-colors ${
                    m.selectedTagFilter.size === 0 ? 'bg-nai-accent text-black' : 'bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700'
                  }`}
                >
                  全部
                </button>
                {m.artistTagPool.map(tag => (
                  <button
                    key={tag}
                    onClick={() => m.setSelectedTagFilter(prev => {
                      const next = new Set(prev);
                      if (next.has(tag)) next.delete(tag);
                      else next.add(tag);
                      return next;
                    })}
                    className={`shrink-0 px-2.5 py-1 text-[11px] font-bold rounded-full transition-colors border ${
                      m.selectedTagFilter.has(tag)
                        ? 'bg-nai-accent text-black border-nai-accent'
                        : 'bg-gray-800 text-gray-400 border-gray-700/50 hover:text-gray-200 hover:bg-gray-700'
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 items-start">
              {m.artistLocalFiles.slice(0, m.artistLocalDisplayCount).map((file) => (
                <ArtistCard
                  key={file.id}
                  file={file}
                  isSelected={m.selectedArtistIds.includes(file.id)}
                  variant="mine"
                  copiedArtistId={m.copiedArtistId}
                  savedArtistId={m.savedArtistId}
                  menuOpenId={menuOpenId}
                  onMenuToggle={setMenuOpenId}
                  onToggleSelection={m.toggleArtistSelection}
                  onCopy={handleCopy}
                  onEdit={m.openArtistDetail}
                  onDelete={(id) => m.handleDeleteArtist(id, undefined)}
                  onUnfavorite={m.unfavoriteArtist}
                  onCreateLocalCopy={m.createLocalCopy}
                  onUploadToPublic={m.uploadToPublic}
                  onTagClick={(tag) => m.setSearchQuery(tag)}
                  onEditTags={(file) => setTagEditorTarget({ artistId: file.id, current: new Set(file.tags || []) })}
                />
              ))}
            </div>
            {m.artistLocalFiles.length > 0 && m.artistLocalDisplayCount < m.artistLocalFiles.length && (
              <div className="flex justify-center py-4">
                <div className="flex items-center gap-2 text-gray-400 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>下滑加载更多 ({m.artistLocalDisplayCount}/{m.artistLocalFiles.length})</span>
                </div>
              </div>
            )}
            {m.artistLocalFiles.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 py-10">
                <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center mb-3">
                  <Palette className="w-6 h-6 opacity-50" />
                </div>
                <p className="text-sm">未找到本地画师串</p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-800 bg-nai-dark/50 flex items-center gap-2 shrink-0">
          {/* 左侧：批量操作（本地tab + 有选中时显示） */}
          {m.artistTab === 'local' && m.selectedArtistIds.length > 0 && (
            <>
              <button
                onClick={async () => {
                  const ids = [...m.selectedArtistIds];
                  if (ids.length === 0) return;
                  if (!confirm(`确定要删除选中的 ${ids.length} 个画师串吗？`)) return;
                  setIsBatchDeleting(true);
                  for (const id of ids) {
                    await m.handleDeleteArtist(id, undefined);
                  }
                  m.handleClearArtistSelection();
                  setIsBatchDeleting(false);
                }}
                disabled={isBatchDeleting}
                className="h-8 px-3 rounded border border-red-800/50 text-red-400 hover:bg-red-900/30 text-xs font-bold flex items-center gap-1.5 transition-colors disabled:opacity-50"
                title="批量删除"
              >
                {isBatchDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                删除
              </button>
              <button
                onClick={() => { setBatchTagOpen(true); setBatchTagsToAdd(new Set()); }}
                className="h-8 px-3 rounded border border-gray-700 text-gray-300 hover:bg-white/10 text-xs font-bold flex items-center gap-1.5 transition-colors"
                title="批量添加标签"
              >
                <Tag className="w-3.5 h-3.5" />
                添加标签
              </button>
            </>
          )}
          <div className="flex-1" />
          {/* 右侧：清空 + 取消 + 确认 */}
          <button
            onClick={m.handleClearArtistSelection}
            disabled={m.selectedArtistIds.length === 0}
            className="px-3 py-1.5 text-sm font-bold text-gray-400 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            清空
          </button>
          <button onClick={onClose} className="px-3 py-1.5 text-sm font-bold text-gray-300 hover:text-white transition-colors">
            取消
          </button>
          <button
            onClick={onConfirmSelection}
            className="px-4 py-1.5 text-sm font-bold bg-nai-accent text-black rounded hover:bg-[#ebd576] transition-colors shadow-sm"
          >
            确认选择
          </button>
        </div>
      </div>

      {/* 批量添加标签弹层 */}
      {batchTagOpen && (
        <div className="fixed inset-0 z-[101] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => { setBatchTagOpen(false); setBatchTagsToAdd(new Set()); }}>
          <div className="bg-nai-panel border border-gray-700 rounded-lg shadow-2xl w-80 flex flex-col overflow-hidden animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50">
              <div className="flex items-center gap-2">
                <Tag className="w-5 h-5 text-nai-accent" />
                <span className="font-bold text-white text-base">批量添加标签 ({m.selectedArtistIds.length})</span>
              </div>
              <button onClick={() => { setBatchTagOpen(false); setBatchTagsToAdd(new Set()); }} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-4 space-y-2 max-h-60 overflow-y-auto">
              {m.artistTagPool.map(tag => (
                <label key={tag} className="flex items-center gap-2 cursor-pointer text-sm text-gray-200 hover:text-white">
                  <input type="checkbox" checked={batchTagsToAdd.has(tag)} onChange={() => {
                    setBatchTagsToAdd(prev => { const n = new Set(prev); if (n.has(tag)) n.delete(tag); else n.add(tag); return n; });
                  }} className="accent-nai-accent" />
                  <Tag className="w-3 h-3 text-gray-500" />
                  {tag}
                </label>
              ))}
              {m.artistTagPool.length === 0 && <p className="text-xs text-gray-500 text-center py-4">暂无标签，请在标签管理中新建</p>}
            </div>
            <div className="p-4 border-t border-gray-800 flex gap-3">
              <button onClick={() => { setBatchTagOpen(false); setBatchTagsToAdd(new Set()); }}
                className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg">取消</button>
              <button onClick={async () => {
                const tagsToAdd = Array.from(batchTagsToAdd);
                if (tagsToAdd.length === 0) { setBatchTagOpen(false); return; }
                const allArtists = await import('../../services/localLibrary').then(m => m.getArtists());
                for (const id of m.selectedArtistIds) {
                  const artist = allArtists.find(a => a.id === id);
                  if (!artist) continue;
                  const merged = Array.from(new Set([...(artist.tags || []), ...tagsToAdd]));
                  await m.saveArtistTags(id, merged);
                }
                m.reloadArtistTagPool();
                setBatchTagOpen(false);
                setBatchTagsToAdd(new Set());
              }} className="flex-1 py-2.5 bg-nai-accent hover:bg-nai-accent/90 text-black text-sm font-medium rounded-lg">应用</button>
            </div>
          </div>
        </div>
      )}

      {/* 标签编辑弹层 */}
      {tagEditorTarget && (
        <div className="fixed inset-0 z-[101] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setTagEditorTarget(null)}>
          <div className="bg-nai-panel border border-gray-700 rounded-lg shadow-2xl w-80 flex flex-col overflow-hidden animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50">
              <div className="flex items-center gap-2">
                <Tag className="w-5 h-5 text-nai-accent" />
                <span className="font-bold text-white text-base">编辑标签</span>
              </div>
              <button onClick={() => setTagEditorTarget(null)} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-4 space-y-2 max-h-60 overflow-y-auto">
              {m.artistTagPool.map(tag => {
                const checked = tagEditorTarget.current.has(tag);
                return (
                  <label key={tag} className="flex items-center gap-2 cursor-pointer text-sm text-gray-200 hover:text-white">
                    <input type="checkbox" checked={checked} onChange={() => {
                      setTagEditorTarget(prev => {
                        if (!prev) return prev;
                        const n = new Set(prev.current);
                        if (n.has(tag)) n.delete(tag); else n.add(tag);
                        return { ...prev, current: n };
                      });
                    }} className="accent-nai-accent" />
                    <Tag className="w-3 h-3 text-gray-500" />
                    {tag}
                  </label>
                );
              })}
              {m.artistTagPool.length === 0 && <p className="text-xs text-gray-500 text-center py-4">暂无标签，请在标签管理中新建</p>}
            </div>
            <div className="p-4 border-t border-gray-800 flex gap-3">
              <button onClick={() => setTagEditorTarget(null)} className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg">取消</button>
              <button onClick={async () => {
                if (!tagEditorTarget) return;
                await m.saveArtistTags(tagEditorTarget.artistId, Array.from(tagEditorTarget.current));
                m.reloadArtistTagPool();
                setTagEditorTarget(null);
              }} className="flex-1 py-2.5 bg-nai-accent hover:bg-nai-accent/90 text-black text-sm font-medium rounded-lg">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 标签管理面板 */}
      {tagSettingsOpen && (
        <div className="fixed inset-0 z-[101] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => { setTagSettingsOpen(false); setTagSettingsCreating(false); setTagSettingsNewName(''); }}>
          <div className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[480px] max-h-[80vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50 shrink-0">
              <div className="flex items-center gap-2">
                <Settings className="w-5 h-5 text-nai-accent" />
                <span className="font-bold text-white text-base">标签管理</span>
                <span className="text-xs text-gray-500">{m.artistTagPool.length} 个</span>
              </div>
              <button onClick={() => { setTagSettingsOpen(false); setTagSettingsCreating(false); setTagSettingsNewName(''); }}
                className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <div className="px-5 pt-4 pb-2 shrink-0">
              {!tagSettingsCreating ? (
                <button onClick={() => { setTagSettingsCreating(true); setTagSettingsNewName(''); }}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border-2 border-dashed border-gray-700 hover:border-nai-accent/60 text-gray-400 hover:text-nai-accent hover:bg-nai-accent/5 text-sm font-bold transition-colors">
                  <Plus className="w-4 h-4" /> 新建标签
                </button>
              ) : (() => {
                const trimmed = tagSettingsNewName.trim();
                const dup = trimmed.length > 0 && m.artistTagPool.includes(trimmed);
                const canCreate = trimmed.length > 0 && !dup;
                return (
                  <div className="rounded-lg border border-nai-accent/40 bg-nai-dark/60 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Tag className="w-4 h-4 text-nai-accent shrink-0" />
                      <input type="text" autoFocus value={tagSettingsNewName}
                        onChange={(e) => setTagSettingsNewName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && canCreate) {
                            const merged = [...m.artistTagPool, trimmed].sort((a, b) => a.localeCompare(b, 'zh-CN'));
                            m.saveArtistTagPool(merged);
                            setTagSettingsNewName(''); setTagSettingsCreating(false);
                          }
                          if (e.key === 'Escape') { setTagSettingsCreating(false); setTagSettingsNewName(''); }
                        }}
                        placeholder="输入新标签名"
                        className="flex-1 bg-nai-dark text-white text-sm rounded-md px-3 py-2 border border-gray-700 focus:border-nai-accent focus:outline-none" />
                    </div>
                    {dup && <p className="text-[11px] text-red-400 pl-6">标签 "{trimmed}" 已存在</p>}
                    <div className="flex items-center justify-end gap-2 pt-1">
                      <button onClick={() => { setTagSettingsCreating(false); setTagSettingsNewName(''); }}
                        className="px-3 py-1.5 text-xs font-bold text-gray-400 hover:text-white hover:bg-white/5 rounded-md">取消</button>
                      <button onClick={() => {
                        if (!canCreate) return;
                        const merged = [...m.artistTagPool, trimmed].sort((a, b) => a.localeCompare(b, 'zh-CN'));
                        m.saveArtistTagPool(merged);
                        setTagSettingsNewName(''); setTagSettingsCreating(false);
                      }} disabled={!canCreate}
                        className="px-3 py-1.5 bg-nai-accent hover:bg-[#ebd576] text-black text-xs font-bold rounded-md disabled:opacity-30 flex items-center gap-1">
                        <Check className="w-3.5 h-3.5" /> 创建
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
            <div className="flex-1 overflow-y-auto px-5 pb-4 pt-2">
              {m.artistTagPool.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                  <Tag className="w-10 h-10 mb-3 opacity-30" />
                  <p className="text-sm">还没有标签</p>
                  <p className="text-xs mt-1 text-gray-600">点击上方按钮创建第一个</p>
                </div>
              ) : m.artistTagPool.map(tag => (
                <div key={tag} className="group flex items-center gap-2.5 px-3 py-2.5 rounded-md hover:bg-nai-dark/40">
                  <Tag className="w-4 h-4 text-gray-500 shrink-0" />
                  <span className="flex-1 text-sm text-gray-200 truncate">{tag}</span>
                  <button onClick={async () => {
                    const tagUsage = m.artistLocalFiles.filter(f => f.tags?.includes(tag)).length;
                    const msg = tagUsage > 0
                      ? `确定删除标签 "${tag}"？\n\n该标签下的 ${tagUsage} 个画师串不会被删除，会回到"全部"中。`
                      : `确定删除未使用的标签 "${tag}"？`;
                    if (!confirm(msg)) return;
                    const pool = m.artistTagPool.filter(t => t !== tag);
                    m.saveArtistTagPool(pool);
                  }} className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-400/10 rounded opacity-0 group-hover:opacity-100 transition-all">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {/* 公共画师串管理弹窗 */}
      <PublicArtistManagerModal
        isOpen={publicManagerOpen}
        onClose={() => { setPublicManagerOpen(false); m.loadPublicArtists(true); }}
        showToast={showToast}
        onEdit={(publicArtist) => {
          // 找到对应的本地副本（如果有），用它来初始化
          const localCopy = m.artistLocalFiles.find(f => f.publicId === publicArtist.id);
          const target: ArtistFile = localCopy ?? {
            id: publicArtist.id,
            name: publicArtist.name,
            prompt: publicArtist.artist_string || '',
            previews: publicArtist.preview_url ? [publicArtist.preview_url] : [],
            addedBy: publicArtist.added_by,
            origin: 'created',
            publicId: publicArtist.id,
          };
          m.openArtistDetail(target);
        }}
      />

      {/* 云端备份弹窗 */}
      <ArtistCloudManageModal
        isOpen={cloudManageOpen}
        onClose={() => setCloudManageOpen(false)}
        onDataChanged={async () => {
          await m.loadLocalArtists();
          m.reloadArtistTagPool();
        }}
      />
    </div>
  );
};

// --- 字母索引列表子组件 ---
const ALPHABET = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];

function getLetterForName(name: string): string {
  const first = name.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : '#';
}

interface ArtistListWithAlphabetProps {
  files: ArtistFile[];
  displayCount: number;
  onExpandDisplay: (count: number) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  isVisible: boolean;
  slideDirection: 'left' | 'right';
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  emptyNode: React.ReactNode;
  renderCard: (file: ArtistFile) => React.ReactNode;
  headerNode?: React.ReactNode;
}

const ArtistListWithAlphabet: React.FC<ArtistListWithAlphabetProps> = ({
  files, displayCount, onExpandDisplay, scrollRef, isVisible, slideDirection, onScroll, emptyNode, renderCard, headerNode,
}) => {
  const [activeLetter, setActiveLetter] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragLetter, setDragLetter] = useState<string | null>(null);
  const letterRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const barRef = useRef<HTMLDivElement>(null);

  const availableLetters = useMemo(() => {
    const letters = new Set<string>();
    files.forEach(f => letters.add(getLetterForName(f.name)));
    return letters;
  }, [files]);

  const displayedFiles = files.slice(0, displayCount);

  const letterGroups = useMemo(() => {
    const groups: { letter: string; startIndex: number }[] = [];
    let lastLetter = '';
    displayedFiles.forEach((f, i) => {
      const letter = getLetterForName(f.name);
      if (letter !== lastLetter) {
        groups.push({ letter, startIndex: i });
        lastLetter = letter;
      }
    });
    return groups;
  }, [displayedFiles]);

  // 根据 Y 坐标计算当前指向的字母
  const getLetterFromY = useCallback((clientY: number): string | null => {
    const bar = barRef.current;
    if (!bar) return null;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const idx = Math.min(Math.floor(ratio * ALPHABET.length), ALPHABET.length - 1);
    return ALPHABET[idx];
  }, []);

  // 找到目标字母在 files 中需要的最小 displayCount
  const getRequiredCount = useCallback((target: string) => {
    let lastIdx = -1;
    for (let i = 0; i < files.length; i++) {
      if (getLetterForName(files[i].name) === target) lastIdx = i;
    }
    return lastIdx + 1;
  }, [files]);

  // 跳转到指定字母（找最近的可用字母）
  const jumpToLetter = useCallback((letter: string) => {
    let target = letter;
    if (!availableLetters.has(letter)) {
      const idx = ALPHABET.indexOf(letter);
      let found: string | null = null;
      for (let i = idx + 1; i < ALPHABET.length; i++) {
        if (availableLetters.has(ALPHABET[i])) { found = ALPHABET[i]; break; }
      }
      if (!found) {
        for (let i = idx - 1; i >= 0; i--) {
          if (availableLetters.has(ALPHABET[i])) { found = ALPHABET[i]; break; }
        }
      }
      if (!found) return;
      target = found;
    }
    setActiveLetter(target);
    setDragLetter(target);

    const needed = getRequiredCount(target);
    if (needed > displayCount) {
      onExpandDisplay(needed);
      // 等 React 渲染完再滚动
      requestAnimationFrame(() => {
        const el = letterRefs.current.get(target);
        const container = scrollRef.current;
        if (el && container) {
          container.scrollTo({ top: el.offsetTop - 4, behavior: 'auto' });
        }
      });
    } else {
      const el = letterRefs.current.get(target);
      const container = scrollRef.current;
      if (el && container) {
        container.scrollTo({ top: el.offsetTop - 4, behavior: 'auto' });
      }
    }
  }, [availableLetters, scrollRef, displayCount, onExpandDisplay, getRequiredCount]);

  // --- 拖拽交互 ---
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    const letter = getLetterFromY(e.clientY);
    if (letter) jumpToLetter(letter);
  }, [getLetterFromY, jumpToLetter]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;
    e.preventDefault();
    const letter = getLetterFromY(e.clientY);
    if (letter) jumpToLetter(letter);
  }, [isDragging, getLetterFromY, jumpToLetter]);

  const handlePointerUp = useCallback(() => {
    setIsDragging(false);
    setTimeout(() => setDragLetter(null), 400);
  }, []);

  // 滚动时更新当前字母
  const handleScrollUpdate = useCallback(() => {
    if (isDragging) return; // 拖拽中不跟踪滚动
    const container = scrollRef.current;
    if (!container || letterGroups.length === 0) return;
    const containerTop = container.scrollTop + 8;
    let current = letterGroups[0]?.letter || '#';
    for (const g of letterGroups) {
      const el = letterRefs.current.get(g.letter);
      if (el && el.offsetTop <= containerTop) {
        current = g.letter;
      }
    }
    setActiveLetter(current);
  }, [letterGroups, scrollRef, isDragging]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    onScroll(e);
    handleScrollUpdate();
  }, [onScroll, handleScrollUpdate]);

  const setLetterRef = useCallback((letter: string, el: HTMLDivElement | null) => {
    if (el) letterRefs.current.set(letter, el);
    else letterRefs.current.delete(letter);
  }, []);

  useEffect(() => {
    if (isVisible && files.length > 0) {
      setTimeout(handleScrollUpdate, 50);
    }
  }, [isVisible, files.length, handleScrollUpdate]);

  const slideClass = slideDirection === 'left' ? '-translate-x-full' : 'translate-x-full';

  return (
    <div className={`absolute inset-0 flex transition-all duration-200 ease-out ${isVisible ? 'opacity-100 translate-x-0' : `opacity-0 ${slideClass} pointer-events-none`}`}>
      {/* 左侧字母索引条 - 可拖拽 */}
      {files.length > 0 && (
        <div className="relative shrink-0">
          <div
            ref={barRef}
            className={`w-7 h-full flex flex-col items-center py-1.5 select-none touch-none border-r transition-colors ${isDragging ? 'bg-nai-accent/10 border-nai-accent/30' : 'bg-nai-dark/40 border-gray-800/50'}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            {ALPHABET.map(letter => {
              const isAvailable = availableLetters.has(letter);
              const isActive = activeLetter === letter;
              return (
                <div
                  key={letter}
                  className={`w-full flex items-center justify-center cursor-pointer transition-all duration-100 ${
                    isActive
                      ? 'text-nai-accent font-black text-[12px]'
                      : isAvailable
                        ? 'text-gray-300 font-bold text-[10px]'
                        : 'text-gray-700/40 text-[9px]'
                  }`}
                  style={{ flex: '1 1 0', minHeight: 0 }}
                >
                  {letter}
                </div>
              );
            })}
          </div>

          {/* 拖拽时的浮动气泡指示器 */}
          {isDragging && dragLetter && (
            <div
              className="absolute left-9 pointer-events-none z-30"
              style={{
                top: `${(ALPHABET.indexOf(dragLetter) / (ALPHABET.length - 1)) * 100}%`,
                transform: 'translateY(-50%)',
              }}
            >
              <div className="w-11 h-11 rounded-xl bg-nai-accent text-black font-black text-xl flex items-center justify-center shadow-lg shadow-nai-accent/30">
                {dragLetter}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Scrollable list */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 custom-scrollbar"
        onScroll={handleScroll}
      >
        {headerNode}
        {files.length === 0 ? emptyNode : (
          <>
            {letterGroups.map((g, gi) => {
              const nextStart = gi + 1 < letterGroups.length ? letterGroups[gi + 1].startIndex : displayedFiles.length;
              const groupFiles = displayedFiles.slice(g.startIndex, nextStart);
              return (
                <div key={g.letter} ref={(el) => setLetterRef(g.letter, el)} className={gi > 0 ? 'mt-4' : ''}>
                  <div className="grid grid-cols-2 gap-3 items-start">
                    {groupFiles.map(renderCard)}
                  </div>
                </div>
              );
            })}
            {files.length > 0 && displayCount < files.length && (
              <div className="flex justify-center py-4">
                <div className="flex items-center gap-2 text-gray-400 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>下滑加载更多 ({displayCount}/{files.length})</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

// --- 创建/编辑覆盖层子组件 ---
const ArtistCreateEditOverlay: React.FC<{ manager: UseArtistManagerReturn }> = ({ manager: m }) => {
  const fileInputRef = React.useRef<HTMLInputElement>(null);

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

  if (!m.isCreatingArtist) return null;

  return (
    <div className="absolute inset-0 z-50 bg-black/90 backdrop-blur-sm flex items-center justify-center animate-in fade-in duration-200">
      <div className="bg-nai-panel w-full h-full flex flex-col overflow-hidden">
        <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50 shrink-0">
          <span className="font-bold text-white text-lg flex items-center gap-2">
            {m.editingArtistId ? <Edit2 className="w-5 h-5 text-nai-accent" /> : <Plus className="w-5 h-5 text-nai-accent" />}
            {m.editingArtistId ? '编辑画师串' : '新建画师串'}
          </span>
          <button onClick={() => m.setIsCreatingArtist(false)} className="text-gray-400 hover:text-white transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden p-4">
          <div className="flex gap-4 h-full">
            {/* Left: Preview Grid */}
            <div className="w-[280px] shrink-0 flex flex-col gap-2">
              <div className="aspect-square bg-black/20 rounded-lg border border-gray-700 overflow-hidden relative shadow-lg">
                <input
                  type="file"
                  multiple
                  ref={fileInputRef}
                  className="hidden"
                  accept="image/*"
                  onChange={handleFileUpload}
                />
                <div className="w-full h-full grid grid-cols-2 grid-rows-2 gap-1 p-1">
                  {[0, 1, 2, 3].map((idx) => (
                    <div
                      key={idx}
                      className={`group/preview relative rounded overflow-hidden cursor-pointer transition-all ${m.newArtistPreviews[idx]
                        ? (m.selectedArtistCoverIndex === idx ? 'ring-2 ring-nai-accent' : 'hover:ring-1 hover:ring-gray-500')
                        : 'bg-gray-800/50'
                        }`}
                      onClick={() => m.newArtistPreviews[idx] ? m.setSelectedArtistCoverIndex(idx) : fileInputRef.current?.click()}
                    >
                      {m.isGeneratingArtistPreviews && m.artistPreviewProgress?.current === idx + 1 && (
                        <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center z-10 text-white backdrop-blur-sm">
                          <Loader2 className="w-5 h-5 text-nai-accent animate-spin mb-1" />
                          <span className="text-[10px]">生成中</span>
                        </div>
                      )}
                      {m.newArtistPreviews[idx] ? (
                        <>
                          <img src={m.newArtistPreviews[idx]} alt={`Preview ${idx + 1}`} className="w-full h-full object-cover" />
                          <div className="absolute top-1 left-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded backdrop-blur-sm">#{idx + 1}</div>
                          {m.selectedArtistCoverIndex === idx && (
                            <div className="absolute top-1 right-1 bg-nai-accent text-black text-[10px] px-1.5 py-0.5 rounded font-bold">封面</div>
                          )}
                          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover/preview:opacity-100 transition-opacity flex items-center justify-center gap-3">
                            <button
                              onClick={(e) => { e.stopPropagation(); m.handleRegenerateArtistPreviewAt(idx); }}
                              disabled={m.isGeneratingArtistPreviews || !m.newArtistPrompt}
                              className="p-2.5 bg-white text-black rounded-full hover:scale-110 transition-transform disabled:opacity-50"
                              title="重新生成这张"
                            >
                              <RefreshCw className="w-5 h-5" />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                m.setNewArtistPreviews(prev => prev.filter((_, i) => i !== idx));
                              }}
                              className="p-2.5 bg-red-500 text-white rounded-full hover:scale-110 transition-transform"
                              title="删除"
                            >
                              <X className="w-5 h-5" />
                            </button>
                          </div>
                        </>
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center text-gray-500 hover:bg-gray-700/50 transition-colors">
                          <Plus className="w-6 h-6 mb-1" />
                          <span className="text-[10px]">点击上传</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={m.handleGenerateSingleArtistPreview}
                  disabled={!m.newArtistPrompt || m.isGeneratingArtistPreviews || m.newArtistPreviews.length >= 4}
                  className="flex-1 py-2 bg-nai-accent hover:bg-[#ebd576] disabled:opacity-50 disabled:cursor-not-allowed text-black text-sm font-bold rounded flex items-center justify-center gap-2 transition-colors"
                >
                  <Wand2 className="w-4 h-4" />
                  {m.newArtistPreviews.length >= 4 ? '当前槽位已满' : '使用预设生成一张'}
                </button>
              </div>
              <div className="text-xs text-gray-500 text-center leading-relaxed">
                点击生成将使用4组不同的预设tag测试画师风格
              </div>
            </div>

            {/* Right: Form */}
            <div className="flex-1 flex flex-col gap-3 min-w-0">
              <div className="shrink-0">
                <label className="text-sm text-gray-400 font-bold block mb-1">名称</label>
                <input
                  type="text"
                  value={m.newArtistName}
                  onChange={(e) => m.setNewArtistName(e.target.value)}
                  className="w-full bg-nai-input border border-gray-700 rounded p-2 text-white focus:border-nai-accent outline-none font-bold"
                  placeholder="给画师串起个名字..."
                />
              </div>
              <div className="flex-1 flex flex-col min-h-0">
                <div className="flex justify-between items-center mb-1 shrink-0">
                  <label className="text-sm text-gray-400 font-bold flex items-center gap-2">
                    正向提示词
                  </label>
                  <button
                    onClick={() => navigator.clipboard.readText().then(text => m.handleArtistPromptChange(text))}
                    className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-1 rounded flex items-center gap-1 transition-colors"
                  >
                    <ClipboardIcon className="w-3 h-3" /> 粘贴
                  </button>
                </div>
                <textarea
                  value={m.newArtistPrompt}
                  onChange={(e) => m.handleArtistPromptChange(e.target.value)}
                  className="flex-1 w-full bg-nai-input border rounded p-2 text-sm text-white focus:border-nai-accent outline-none resize-none font-mono leading-relaxed border-gray-700"
                  placeholder="输入画师或风格的提示词..."
                />
              </div>
              {/* 标签 */}
              <div className="shrink-0">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Tag className="w-3.5 h-3.5 text-gray-400" />
                  <label className="text-sm text-gray-400 font-bold">标签</label>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {m.artistTagPool.map(tag => {
                    const active = m.newArtistTags.has(tag);
                    return (
                      <button key={tag} onClick={() => m.setNewArtistTags(prev => {
                        const next = new Set(prev);
                        if (next.has(tag)) next.delete(tag); else next.add(tag);
                        return next;
                      })}
                        className={`px-2.5 py-1 text-[11px] font-bold rounded-full border transition-colors ${active ? 'bg-nai-accent text-black border-nai-accent' : 'bg-gray-800 text-gray-400 border-gray-700/50 hover:text-gray-200 hover:bg-gray-700'}`}
                      >{tag}</button>
                    );
                  })}
                  {m.artistTagPool.length === 0 && <span className="text-xs text-gray-500">暂无标签，可在主界面的"标签管理"中新建</span>}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-gray-800 bg-nai-dark/50 flex justify-between items-center shrink-0">
          {m.editingArtistId ? (
            <button
              onClick={() => m.handleDeleteArtist(m.editingArtistId!)}
              className="px-3 py-1.5 text-sm font-bold text-red-400 hover:text-red-300 hover:bg-red-900/20 border border-transparent hover:border-red-900/50 rounded transition-all flex items-center gap-1.5"
            >
              <Trash2 className="w-4 h-4" />
              删除
            </button>
          ) : <div />}
          <div className="flex gap-2">
            <button onClick={() => m.setIsCreatingArtist(false)} className="px-3 py-1.5 text-sm font-bold text-gray-300 hover:text-white transition-colors">
              取消
            </button>
            {m.editingArtistId ? (
              <button
                onClick={() => m.handleSaveArtist()}
                disabled={!m.newArtistName || m.newArtistPreviews.length === 0 || m.isSavingArtist}
                className="px-4 py-1.5 bg-nai-accent hover:bg-[#ebd576] disabled:opacity-50 disabled:cursor-not-allowed text-black text-sm font-bold rounded flex items-center gap-1.5 shadow-lg hover:shadow-xl transition-all"
                title=""
              >
                {m.isSavingArtist ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {m.isSavingArtist ? '保存中...' : '保存修改'}
              </button>
            ) : (
              <>
                <button
                  onClick={() => m.handleSaveArtist('public')}
                  disabled={!m.newArtistName || m.newArtistPreviews.length === 0 || m.isSavingArtist}
                  className="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold rounded flex items-center gap-1.5 shadow-lg hover:shadow-xl transition-all border border-gray-600"
                  title=""
                >
                  {m.isSavingArtist ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe className="w-4 h-4" />}
                  {m.isSavingArtist ? '保存中...' : '保存到公共'}
                </button>
                <button
                  onClick={() => m.handleSaveArtist('local')}
                  disabled={!m.newArtistName || m.newArtistPreviews.length === 0 || m.isSavingArtist}
                  className="px-4 py-1.5 bg-nai-accent hover:bg-[#ebd576] disabled:opacity-50 disabled:cursor-not-allowed text-black text-sm font-bold rounded flex items-center gap-1.5 shadow-lg hover:shadow-xl transition-all"
                  title=""
                >
                  {m.isSavingArtist ? <Loader2 className="w-4 h-4 animate-spin" /> : <HardDrive className="w-4 h-4" />}
                  {m.isSavingArtist ? '保存中...' : '保存到本地'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
