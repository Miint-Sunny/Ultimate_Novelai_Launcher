// 我的OC管理器 - 弹窗组件
import React, { useMemo, useRef, useState, useEffect } from 'react';
import {
  X, Plus, Edit2, Users, User, Loader2,
  RotateCcw, Save, Trash2, Sparkles, Dices, Heart,
  ChevronLeft, ChevronRight, ArrowLeft,
} from 'lucide-react';
import { Clipboard as ClipboardIcon } from 'lucide-react';
import type { OCFile } from './types';
import type { UseOCManagerReturn } from './types';
import { OCCard } from './OCCard';
import { botService } from '../../services/botService';
import { getInspirationFavorites } from '../../services/localLibrary';

interface OCManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  manager: UseOCManagerReturn;
  onConfirmSelection: (mode: 'character' | 'main') => void;
  characterPromptsCount: number;
  onOpenInspiration?: () => void;
}

export const OCManagerModal: React.FC<OCManagerModalProps> = ({
  isOpen, onClose, manager: m, onConfirmSelection, characterPromptsCount, onOpenInspiration,
}) => {
  const currentUserId = botService.getAuthState().botUserId;
  const [favoriteOCIds, setFavoriteOCIds] = useState<string[]>([]);
  
  useEffect(() => {
    if (isOpen) {
      const favorites = getInspirationFavorites();
      setFavoriteOCIds(favorites.ocIds || []);
      m.refreshPublicOCs();
    }
  }, [isOpen]);

  const myOCs = useMemo(() => {
    if (!currentUserId) return [];
    return m.ocPublicFiles.filter(oc => oc.created_by === currentUserId);
  }, [m.ocPublicFiles, currentUserId]);

  const favoriteOCs = useMemo(() => {
    return m.ocPublicFiles.filter(oc => favoriteOCIds.includes(oc.id));
  }, [m.ocPublicFiles, favoriteOCIds]);

  if (!isOpen) return null;

  const handleCopy = (id: string, prompt: string) => {
    navigator.clipboard.writeText(prompt);
    m.setCopiedOCId(id);
    setTimeout(() => m.setCopiedOCId(null), 1500);
  };

  const handleRandomMyOC = () => {
    const availableFiles = myOCs.filter(f => !m.selectedOCs.includes(f.id));
    if (availableFiles.length === 0 || m.selectedOCs.length >= 6) return;
    const randomFile = availableFiles[Math.floor(Math.random() * availableFiles.length)];
    m.setSelectedOCs(prev => [...prev, randomFile.id]);
    setTimeout(() => {
      const element = document.getElementById(`oc-card-${randomFile.id}`);
      if (!element) return;
      const scrollContainer = element.closest('.overflow-x-auto');
      if (scrollContainer) {
        const containerRect = scrollContainer.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        const scrollLeft = scrollContainer.scrollLeft + elementRect.left - containerRect.left - containerRect.width / 2 + elementRect.width / 2;
        scrollContainer.scrollTo({ left: scrollLeft, behavior: 'smooth' });
      }
      setTimeout(() => {
        m.setJustSelectedOCId(randomFile.id);
        setTimeout(() => m.setJustSelectedOCId(null), 2000);
      }, 300);
    }, 50);
  };

  // 编辑模式
  if (m.isCreatingOC) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
        <div className="bg-nai-panel border border-gray-700 rounded-lg shadow-2xl w-[600px] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50">
            <div className="flex items-center gap-2">
              <button onClick={() => m.setIsCreatingOC(false)} className="text-gray-400 hover:text-white">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <span className="font-bold text-white text-base">{m.editingOCId ? '编辑OC' : '新建OC'}</span>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-white">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Edit Form */}
          <div className="p-4 flex flex-col gap-4">
            {/* Preview + Info */}
            <div className="flex gap-4">
              <div className="w-[200px] shrink-0">
                <div className="aspect-[832/1216] bg-black/20 rounded-lg border border-gray-700 flex items-center justify-center overflow-hidden relative group">
                  {m.newOCPreview ? (
                    <img src={m.newOCPreview} alt="Preview" className="w-full h-full object-cover" />
                  ) : (
                    <User className="w-12 h-12 text-gray-600" />
                  )}
                  {m.isGeneratingOCPreview && (
                    <div className="absolute inset-0 bg-black/70 flex items-center justify-center">
                      <Loader2 className="w-6 h-6 text-nai-accent animate-spin" />
                    </div>
                  )}
                  {!m.isGeneratingOCPreview && (
                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <button onClick={m.handleGenerateOCPreview} disabled={!m.newOCPositive}
                        className="px-3 py-1.5 bg-white text-black text-sm font-bold rounded-full flex items-center gap-1.5 disabled:opacity-50">
                        <Sparkles className="w-4 h-4" /> {m.newOCPreview ? '重新生成' : '生成预览'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex-1 flex flex-col gap-3">
                <div>
                  <label className="text-xs text-gray-400 block mb-1">名称</label>
                  <input type="text" value={m.newOCName} onChange={(e) => m.setNewOCName(e.target.value)}
                    className="w-full bg-nai-input border border-gray-700 rounded px-3 py-2 text-white focus:border-nai-accent outline-none text-sm font-bold"
                    placeholder="OC名称..." />
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">别名 (逗号分隔)</label>
                  <input type="text" value={m.newOCAliases} onChange={(e) => m.setNewOCAliases(e.target.value)}
                    className="w-full bg-nai-input border border-gray-700 rounded px-3 py-2 text-white focus:border-nai-accent outline-none text-sm"
                    placeholder="小名, 昵称, ..." />
                </div>
                <div className="flex-1 flex flex-col">
                  <div className="flex justify-between items-center mb-1">
                    <label className="text-xs text-gray-400">提示词</label>
                    <button onClick={() => navigator.clipboard.readText().then(text => m.setNewOCPositive(text))}
                      className="text-xs text-gray-400 hover:text-gray-300 flex items-center gap-1">
                      <ClipboardIcon className="w-3 h-3" /> 粘贴
                    </button>
                  </div>
                  <textarea value={m.newOCPositive} onChange={(e) => m.setNewOCPositive(e.target.value)}
                    className="flex-1 min-h-[120px] w-full bg-nai-input border border-gray-700 rounded p-3 text-sm text-white focus:border-nai-accent outline-none resize-none font-mono"
                    placeholder="1girl, ..." />
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="px-4 py-3 border-t border-gray-800 bg-nai-dark/50 flex justify-between items-center">
            {m.editingOCId ? (
              <button onClick={(e) => { m.handleDeleteOC(m.editingOCId!, e); m.setIsCreatingOC(false); }}
                className="text-sm text-red-400 hover:text-red-300 flex items-center gap-1">
                <Trash2 className="w-4 h-4" /> 删除
              </button>
            ) : <div />}
            <div className="flex gap-2">
              <button onClick={() => m.setIsCreatingOC(false)}
                className="px-3 py-1.5 text-sm text-gray-300 hover:text-white">
                取消
              </button>
              <button onClick={() => m.handleSaveOC('public')} disabled={!m.newOCName || !m.newOCPositive || m.isSavingOC}
                className="px-4 py-1.5 bg-nai-accent hover:bg-[#ebd576] disabled:opacity-50 text-black text-sm font-bold rounded flex items-center gap-1">
                {m.isSavingOC ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                保存
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 列表模式
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-nai-panel border border-gray-700 rounded-lg shadow-2xl w-[700px] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50">
          <div className="flex items-center gap-2">
            <Users className="w-5 h-5 text-nai-accent" />
            <span className="font-bold text-white text-base">我的OC</span>
            {m.isLoadingPublicOCs && <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleRandomMyOC} disabled={m.selectedOCs.length >= 6 || myOCs.length === 0}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-bold rounded flex items-center gap-1.5 disabled:opacity-50">
              <Dices className="w-4 h-4" /> 随机
            </button>
            <button onClick={m.openCreateOC}
              className="px-3 py-1.5 bg-nai-accent hover:bg-[#ebd576] text-black text-sm font-bold rounded flex items-center gap-1.5">
              <Plus className="w-4 h-4" /> 新建OC
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-white">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="bg-nai-dark/30 flex flex-col">
          {!currentUserId ? (
            <div className="flex flex-col items-center justify-center text-gray-500 h-[400px]">
              <User className="w-12 h-12 opacity-50 mb-3" />
              <p className="text-sm">请先登录以查看您的OC</p>
            </div>
          ) : m.isLoadingPublicOCs ? (
            <div className="flex flex-col items-center justify-center text-gray-500 h-[400px]">
              <Loader2 className="w-8 h-8 animate-spin mb-3 text-nai-accent" />
              <p className="text-sm">正在加载...</p>
            </div>
          ) : (
            <>
              <HorizontalOCRow
                title="我的角色"
                icon={<User className="w-4 h-4 text-nai-accent" />}
                files={myOCs}
                selectedOCs={m.selectedOCs}
                justSelectedOCId={m.justSelectedOCId}
                copiedOCId={m.copiedOCId}
                savedToLocalOCId={m.savedToLocalOCId}
                onToggleSelection={m.toggleOCSelection}
                onCopy={handleCopy}
                onEdit={m.openOCDetail}
                onDelete={m.handleDeleteOC}
                emptyMessage="您还没有创建任何OC"
                onCreateClick={m.openCreateOC}
              />
              <HorizontalOCRow
                title="收藏角色"
                icon={<Heart className="w-4 h-4 text-red-500" />}
                files={favoriteOCs}
                selectedOCs={m.selectedOCs}
                justSelectedOCId={m.justSelectedOCId}
                copiedOCId={m.copiedOCId}
                savedToLocalOCId={m.savedToLocalOCId}
                onToggleSelection={m.toggleOCSelection}
                onCopy={handleCopy}
                emptyMessage="还没有收藏任何角色，去灵感空间收藏吧"
              />
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-800 bg-nai-dark/50 flex flex-col gap-2 shrink-0">
          <div className="flex items-center justify-center text-xs text-gray-500">
            <span>寻找公共OC库？现已迁移至</span>
            {onOpenInspiration ? (
              <button onClick={() => { onClose(); onOpenInspiration(); }}
                className="ml-1 text-indigo-400 hover:text-indigo-300 underline">
                灵感空间
              </button>
            ) : (
              <span className="ml-1 text-indigo-400">灵感空间</span>
            )}
          </div>
          <div className="flex justify-between items-center">
            <button onClick={() => m.setSelectedOCs([])} disabled={m.selectedOCs.length === 0}
              className="px-3 py-1.5 text-sm font-bold text-red-400 hover:text-red-300 disabled:opacity-30 flex items-center gap-1.5">
              <RotateCcw className="w-4 h-4" /> 清空选择
            </button>
            <div className="flex gap-2">
              <button onClick={onClose} className="px-3 py-1.5 text-sm font-bold text-gray-300 hover:text-white">
                取消
              </button>
              <button onClick={() => onConfirmSelection('character')}
                disabled={m.selectedOCs.length === 0 || characterPromptsCount >= 6}
                className="px-4 py-1.5 text-sm font-bold bg-nai-accent text-black rounded hover:bg-[#ebd576] disabled:opacity-50 flex items-center gap-1.5">
                <User className="w-4 h-4" /> 添加到角色提示词
              </button>
              <button onClick={() => onConfirmSelection('main')} disabled={m.selectedOCs.length === 0}
                className="px-4 py-1.5 text-sm font-bold bg-gray-700 text-white rounded hover:bg-gray-600 disabled:opacity-50 flex items-center gap-1.5">
                <Sparkles className="w-4 h-4" /> 添加到主提示词
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};


// --- 横向滚动OC行组件 ---
interface HorizontalOCRowProps {
  title: string;
  icon: React.ReactNode;
  files: OCFile[];
  selectedOCs: string[];
  justSelectedOCId: string | null;
  copiedOCId: string | null;
  savedToLocalOCId: string | null;
  onToggleSelection: (id: string) => void;
  onCopy: (id: string, prompt: string) => void;
  onEdit?: (oc: OCFile) => void;
  onDelete?: (id: string, e: React.MouseEvent) => void;
  emptyMessage: string;
  onCreateClick?: () => void;
}

const HorizontalOCRow: React.FC<HorizontalOCRowProps> = ({
  title, icon, files, selectedOCs, justSelectedOCId, copiedOCId, savedToLocalOCId,
  onToggleSelection, onCopy, onEdit, onDelete, emptyMessage, onCreateClick,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkScroll = () => {
    if (scrollRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current;
      setCanScrollLeft(scrollLeft > 0);
      setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (scrollRef.current && e.deltaY !== 0) {
      e.preventDefault();
      scrollRef.current.scrollLeft += e.deltaY * 2;
      checkScroll();
    }
  };

  useEffect(() => {
    checkScroll();
    const el = scrollRef.current;
    if (el) {
      el.addEventListener('scroll', checkScroll);
      window.addEventListener('resize', checkScroll);
      return () => {
        el.removeEventListener('scroll', checkScroll);
        window.removeEventListener('resize', checkScroll);
      };
    }
  }, [files]);

  const scroll = (direction: 'left' | 'right') => {
    if (scrollRef.current) {
      scrollRef.current.scrollBy({ left: direction === 'left' ? -300 : 300, behavior: 'smooth' });
    }
  };

  return (
    <div className="py-2 border-b border-gray-800 last:border-b-0 flex h-[200px]">
      <div className="w-10 shrink-0 flex flex-col items-center justify-center border-r border-gray-800">
        <div className="flex flex-col items-center gap-1">
          {icon}
          <span className="text-sm font-bold text-white" style={{ writingMode: 'vertical-rl' }}>{title}</span>
        </div>
      </div>
      <div className="flex-1 min-w-0">
        {files.length === 0 ? (
          <div className="flex items-center justify-center text-gray-500 h-full px-4">
            <p className="text-sm">{emptyMessage}</p>
            {onCreateClick && (
              <button onClick={onCreateClick}
                className="ml-3 px-3 py-1.5 bg-nai-accent hover:bg-[#ebd576] text-black text-sm font-bold rounded flex items-center gap-1.5">
                <Plus className="w-4 h-4" /> 创建
              </button>
            )}
          </div>
        ) : (
          <div className="relative group h-full">
            {canScrollLeft && (
              <button onClick={() => scroll('left')}
                className="absolute left-1 top-1/2 -translate-y-1/2 z-10 w-8 h-8 bg-black/70 hover:bg-black/90 rounded-full flex items-center justify-center text-white opacity-0 group-hover:opacity-100">
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}
            {canScrollRight && (
              <button onClick={() => scroll('right')}
                className="absolute right-1 top-1/2 -translate-y-1/2 z-10 w-8 h-8 bg-black/70 hover:bg-black/90 rounded-full flex items-center justify-center text-white opacity-0 group-hover:opacity-100">
                <ChevronRight className="w-5 h-5" />
              </button>
            )}
            <div ref={scrollRef} onWheel={handleWheel}
              className="flex gap-2 overflow-x-auto overflow-y-hidden px-3 py-2 scrollbar-hide h-full items-center"
              style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
              {files.map(file => (
                <div key={file.id} className="shrink-0 w-[120px]">
                  <OCCard
                    file={file}
                    isSelected={selectedOCs.includes(file.id)}
                    isJustSelected={justSelectedOCId === file.id}
                    isPublic={true}
                    copiedOCId={copiedOCId}
                    savedToLocalOCId={savedToLocalOCId}
                    onToggleSelection={onToggleSelection}
                    onCopy={onCopy}
                    onEdit={onEdit}
                    onDelete={onDelete}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
