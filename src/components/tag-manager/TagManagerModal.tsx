// 统一 Tag 管理器主模态 - 参照设计稿 .modal + .m-head + .m-body + .m-foot
// 主壳只负责 Header / Sidebar / 内容路由 / Footer chip rail + 动态按钮
// Panel 自决工具栏 + recent + chips + grid
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Cloud, LibraryBig, Loader2, RotateCcw, Sparkles, Tag, Trash2, User, X } from 'lucide-react';
import type { UseOCManagerReturn } from '../oc/types';
import type { UseArtistManagerReturn } from '../artist/types';
import { botService } from '../../services/botService';
import { useTagManager, type SelectionConfirm } from './useTagManager';
import { findSubtype } from './registry';
import { SubtypeSidebar } from './SubtypeSidebar';
import { CharacterPanel } from './panels/CharacterPanel';
import { ArtistPanel } from './panels/ArtistPanel';
import { CompactPanel } from './panels/CompactPanel';
import { BatchTagModal } from './parts/BatchTagModal';
import { TagManagerBackupModal } from './parts/TagManagerBackupModal';
import { useConfirm } from './parts/useConfirm';
import {
  loadCharacterTagPool, saveCharacterTagPool,
  mergeCharacterTags,
} from './parts/characterTagsStore';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  ocManager: UseOCManagerReturn;
  artistManager: UseArtistManagerReturn;
  characterPromptsCount: number;
  showToast: (message: string, type: 'success' | 'error') => void;
  onConfirm: (selections: SelectionConfirm[]) => void;
  onOpenInspiration?: () => void;
  /** 主面板当前正向提示词,会透传给 CreateTagModal 用于"导入主提示词"快捷键 */
  currentMainPrompt?: string;
  /** 主面板当前负面提示词,导入主提示词时一并同步 */
  currentMainNegative?: string;
  /** 主面板当前的角色提示词数组,character subtype 下优先 */
  currentCharacterPrompts?: Array<{
    positive: string;
    negative?: string;
    enabled: boolean;
    name?: string;
  }>;
  /** 主面板生成历史,用于"从历史选取"按钮 */
  imageHistory?: Array<{
    id: string;
    imageUrl: string;
    width: number;
    height: number;
    timestamp: number;
  }>;
}

export const TagManagerModal: React.FC<Props> = ({
  isOpen, onClose, ocManager, artistManager,
  characterPromptsCount, showToast,
  onConfirm, onOpenInspiration,
  currentMainPrompt, currentMainNegative, currentCharacterPrompts, imageHistory,
}) => {
  const mgr = useTagManager({ oc: ocManager, artist: artistManager });
  const activeSubtype = findSubtype(mgr.subtypes, mgr.activeSubtypeId);
  const { confirm, confirmDialog } = useConfirm();

  // 批量操作状态
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const [batchTagOpen, setBatchTagOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  // character 自己的 tagPool snapshot (BatchTagModal 用)
  const [characterTagPool, setCharacterTagPool] = useState<string[]>(() => loadCharacterTagPool());

  // ESC 关闭
  useEffect(() => {
    if (!isOpen) return;
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [isOpen, onClose]);

  const countMap = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of mgr.subtypes) {
      const size = mgr.selectionMap[s.id]?.size || 0;
      if (size > 0) m[s.id] = size;
    }
    return m;
  }, [mgr.selectionMap, mgr.subtypes]);

  const totalSelected = useMemo(
    () => Object.values(mgr.selectionMap).reduce((a, s) => a + (s?.size || 0), 0),
    [mgr.selectionMap]
  );

  const artistSelectedIds = useMemo(
    () => Array.from(mgr.selectionMap['artist-style'] || []),
    [mgr.selectionMap]
  );
  const characterSelectedIds = useMemo(
    () => Array.from(mgr.selectionMap['character'] || []),
    [mgr.selectionMap]
  );

  // 批量按钮: artist-style / character 都支持 删除 + 添加标签
  const batchTargetSubtype = activeSubtype?.id === 'artist-style'
    ? 'artist-style'
    : activeSubtype?.id === 'character' ? 'character' : null;
  const batchTargetIds = batchTargetSubtype === 'artist-style'
    ? artistSelectedIds
    : batchTargetSubtype === 'character'
      ? characterSelectedIds
      : [];
  const showBatchActions = batchTargetIds.length > 0;
  const showBatchDelete = batchTargetSubtype === 'artist-style' || batchTargetSubtype === 'character';

  const handleBatchDelete = async () => {
    if (batchTargetSubtype === 'artist-style') {
      if (artistSelectedIds.length === 0) return;
      const ok = await confirm({
        title: '批量删除画师串',
        message: `确定要删除选中的 ${artistSelectedIds.length} 个画师串吗?`,
        confirmLabel: '删除',
        danger: true,
      });
      if (!ok) return;
      setIsBatchDeleting(true);
      for (const id of artistSelectedIds) {
        await artistManager.handleDeleteArtist(id, undefined);
      }
      mgr.clearSelection('artist-style');
      setIsBatchDeleting(false);
      return;
    }
    if (batchTargetSubtype === 'character') {
      if (characterSelectedIds.length === 0) return;
      // 区分 created (彻底删公共+本地) vs 其它 (仅删本地副本) - 复刻 CharacterPanel 单卡删除语义
      const currentUserId = botService.getAuthState().botUserId;
      const items = characterSelectedIds.map(id => {
        const pub = ocManager.ocPublicFiles.find(o => o.id === id);
        const isMine = !!currentUserId && pub?.created_by === currentUserId;
        return { id, pub, isMine };
      });
      const mineCount = items.filter(i => i.isMine).length;
      const otherCount = items.length - mineCount;
      const message =
        mineCount > 0 && otherCount > 0
          ? `选中 ${items.length} 个角色:\n  · 你创建的 ${mineCount} 个 → 彻底删除(公共 + 本地副本)\n  · 其它 ${otherCount} 个 → 仅删本地副本\n\n此操作不可恢复,确定继续吗?`
          : mineCount > 0
            ? `将彻底删除 ${mineCount} 个由你创建的公共角色(含本地副本)。\n\n此操作不可恢复,确定继续吗?`
            : `确定从本地删除选中的 ${items.length} 个角色?数据无法恢复`;
      const ok = await confirm({
        title: '批量删除角色',
        message,
        confirmLabel: '删除',
        danger: true,
      });
      if (!ok) return;
      setIsBatchDeleting(true);
      for (const it of items) {
        if (it.isMine) {
          await ocManager.deletePublicOCTotally(it.id);
        } else {
          const localOC = ocManager.ocLocalFiles.find(
            f => (it.pub?.id && f.publicId === it.pub.id)
              || f.publicId === it.id
              || f.id === it.id
              || (it.pub?.name && f.name === it.pub.name),
          );
          if (localOC) {
            await ocManager.handleDeleteOC(localOC.id, { stopPropagation: () => {} } as React.MouseEvent);
          }
        }
      }
      mgr.clearSelection('character');
      setIsBatchDeleting(false);
      return;
    }
  };

  // 通用批量加标签 - 按当前 subtype 路由
  const handleBatchTagApply = async (selectedTags: Set<string>) => {
    const tagsToAdd = Array.from(selectedTags);
    if (tagsToAdd.length === 0) return;
    if (batchTargetSubtype === 'artist-style') {
      const { getArtists } = await import('../../services/localLibrary');
      const allArtists = await getArtists();
      for (const id of artistSelectedIds) {
        const artist = allArtists.find(a => a.id === id);
        if (!artist) continue;
        const merged = Array.from(new Set([...(artist.tags || []), ...tagsToAdd]));
        await artistManager.saveArtistTags(id, merged);
      }
      artistManager.reloadArtistTagPool();
    } else if (batchTargetSubtype === 'character') {
      mergeCharacterTags(characterSelectedIds, tagsToAdd);
      window.dispatchEvent(new Event('character-tags-changed'));
    }
  };

  const handleCreatePoolTag = async (newTag: string) => {
    if (batchTargetSubtype === 'artist-style') {
      const merged = Array.from(new Set([...(artistManager.artistTagPool || []), newTag]))
        .sort((a, b) => a.localeCompare(b, 'zh-CN'));
      artistManager.saveArtistTagPool(merged);
    } else if (batchTargetSubtype === 'character') {
      const merged = Array.from(new Set([...characterTagPool, newTag]))
        .sort((a, b) => a.localeCompare(b, 'zh-CN'));
      saveCharacterTagPool(merged);
      setCharacterTagPool(merged);
      window.dispatchEvent(new Event('character-tags-changed'));
    }
  };

  // 弹窗打开时同步最新的 character pool
  useEffect(() => {
    if (batchTagOpen && batchTargetSubtype === 'character') {
      setCharacterTagPool(loadCharacterTagPool());
    }
  }, [batchTagOpen, batchTargetSubtype]);

  const activeTagPool = batchTargetSubtype === 'artist-style'
    ? (artistManager.artistTagPool || [])
    : batchTargetSubtype === 'character' ? characterTagPool : [];

  const handleConfirm = (mode?: 'character' | 'main') => {
    const out: SelectionConfirm[] = [];
    for (const [subtypeId, idSet] of Object.entries(mgr.selectionMap)) {
      if (idSet && idSet.size > 0) {
        const tagIds = Array.from(idSet);
        const item: SelectionConfirm = { subtypeId, tagIds };
        if (subtypeId === 'character' && mode) item.mode = mode;
        // 自定义 subtype(非 character/artist-style)附上 customStore 数据
        if (subtypeId !== 'character' && subtypeId !== 'artist-style') {
          const pool = mgr.customStore.getBySubtype(subtypeId);
          item.customTagFiles = tagIds
            .map(id => pool.find(t => t.id === id))
            .filter((t): t is NonNullable<typeof t> => !!t)
            .map(t => ({ id: t.id, name: t.name, positive: t.positive, negative: t.negative }));
        }
        out.push(item);
      }
    }
    if (out.length === 0) return;
    onConfirm(out);
    mgr.clearSelection();
    onClose();
  };

  if (!isOpen) return null;

  return createPortal(
    <>
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/55 backdrop-blur-md animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-nai-panel border border-gray-700 rounded-xl shadow-[0_30px_80px_-20px_rgba(0,0,0,0.7)] w-[min(1100px,96vw)] h-[min(780px,92vh)] grid grid-rows-[auto_1fr] overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.06] bg-nai-dark/50 shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-nai-accent inline-flex w-9 h-9 rounded-lg bg-nai-accent/10 items-center justify-center">
              <LibraryBig className="w-[22px] h-[22px]" strokeWidth={1.75} />
            </span>
            <div className="flex flex-col leading-tight">
              <span className="text-[16px] font-bold text-white whitespace-nowrap tracking-wide">Tag 管理器</span>
            </div>
          </div>
          <div className="flex-1" />
          <button
            onClick={() => setBackupOpen(true)}
            title="数据备份 (4 分类导出/导入 + 4 分类云端)"
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-nai-accent/30 bg-nai-accent/10 text-nai-accent hover:bg-nai-accent/20 hover:border-nai-accent/50 transition-colors cursor-pointer shadow-sm"
          >
            <Cloud className="w-[18px] h-[18px]" strokeWidth={2} />
            <span className="text-[13px] font-bold">数据备份</span>
          </button>
          <button
            onClick={onClose}
            title="关闭 (Esc)"
            className="w-9 h-9 grid place-items-center rounded-lg text-nai-text-dim hover:bg-white/[0.06] hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-[18px] h-[18px]" />
          </button>
        </header>

        {/* Body: Sidebar + Main */}
        <div className="grid grid-cols-[176px_1fr] min-h-0">
          <SubtypeSidebar
            subtypes={mgr.subtypes}
            activeId={mgr.activeSubtypeId}
            onSelect={mgr.setActiveSubtypeId}
            countMap={countMap}
          />

          <div className="flex flex-col min-h-0 min-w-0">
            {activeSubtype?.id === 'character' && (
              <CharacterPanel
                subtype={activeSubtype}
                ocManager={ocManager}
                selectedIds={mgr.selectionMap['character'] || new Set()}
                onToggleSelection={(id) => mgr.toggleSelection('character', id, activeSubtype.maxSelectable)}
                onOpenInspiration={onOpenInspiration}
                showToast={showToast}
                currentMainPrompt={currentMainPrompt}
                currentMainNegative={currentMainNegative}
                currentCharacterPrompts={currentCharacterPrompts}
                imageHistory={imageHistory}
              />
            )}
            {activeSubtype?.id === 'artist-style' && (
              <ArtistPanel
                subtype={activeSubtype}
                artistManager={artistManager}
                selectedIds={mgr.selectionMap['artist-style'] || new Set()}
                onToggleSelection={(id) => mgr.toggleSelection('artist-style', id, activeSubtype.maxSelectable)}
                onClearSelection={() => mgr.clearSelection('artist-style')}
                showToast={showToast}
                currentMainPrompt={currentMainPrompt}
                currentMainNegative={currentMainNegative}
                imageHistory={imageHistory}
              />
            )}
            {activeSubtype && !['character', 'artist-style'].includes(activeSubtype.id) && (
              <CompactPanel
                subtype={activeSubtype}
                tags={mgr.getFiles(activeSubtype.id, 'local')}
                selectedIds={mgr.selectionMap[activeSubtype.id] || new Set()}
                onToggleSelection={(id) => mgr.toggleSelection(activeSubtype.id, id, activeSubtype.maxSelectable)}
                currentMainPrompt={currentMainPrompt}
                currentMainNegative={currentMainNegative}
                imageHistory={imageHistory}
                showToast={showToast}
                onCreateCustomTag={async (subtypeId, payload) => {
                  await mgr.customStore.create({
                    id: `${subtypeId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
                    subtypeId,
                    name: payload.name,
                    positive: payload.positive,
                    negative: payload.negative,
                    preview: payload.preview,
                    tags: payload.tags,
                  });
                }}
                onUpdateCustomTag={async (id, payload) => {
                  // saveCustomTag upsert by id — 传 id 复用现有记录
                  const existing = mgr.customStore.tags.find(t => t.id === id);
                  await mgr.customStore.create({
                    id,
                    subtypeId: existing?.subtypeId || activeSubtype!.id,
                    name: payload.name,
                    positive: payload.positive,
                    negative: payload.negative,
                    preview: payload.preview,
                    tags: payload.tags,
                    createdAt: existing?.createdAt,
                  });
                }}
                onDeleteCustomTag={async (id) => {
                  await mgr.customStore.remove(id);
                }}
              />
            )}

            {/* Footer - 旧版风格 (批量操作菜单 + 红色清空) */}
            <footer className="flex items-center gap-2 px-4 py-3 border-t border-gray-800 bg-nai-dark/50 shrink-0">
              {/* 左侧批量操作 - artist-style 删除 + 添加; character 仅添加 */}
              {showBatchActions && (
                <>
                  {showBatchDelete && (
                    <button
                      onClick={handleBatchDelete}
                      disabled={isBatchDeleting}
                      title="批量删除"
                      className="h-9 px-3 rounded-md border border-red-800/50 text-red-400 hover:bg-red-900/30 text-[13px] font-bold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isBatchDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      删除 ({batchTargetIds.length})
                    </button>
                  )}
                  <button
                    onClick={() => setBatchTagOpen(true)}
                    title="批量添加标签"
                    className="h-9 px-3 rounded-md border border-gray-700 text-gray-300 hover:bg-white/10 hover:text-white text-[13px] font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <Tag className="w-3.5 h-3.5" />
                    添加标签 ({batchTargetIds.length})
                  </button>
                </>
              )}
              <div className="flex-1" />

              {/* 右侧: 清空(red) + 取消 + 确认 - 旧 ArtistManagerModal/OCManagerModal 风格 */}
              <button
                onClick={() => mgr.clearSelection()}
                disabled={totalSelected === 0}
                title="清空所有 subtype 已选"
                className="px-3 py-1.5 text-[13px] font-bold text-red-400 hover:text-red-300 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1.5 cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" />
                清空选择
              </button>
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-[13px] font-bold text-gray-300 hover:text-white transition-colors cursor-pointer"
              >
                取消
              </button>

              {activeSubtype?.id === 'character' ? (
                <>
                  <button
                    onClick={() => handleConfirm('main')}
                    disabled={(mgr.selectionMap['character']?.size || 0) === 0}
                    title="拼接到主提示词"
                    className="px-4 py-2 text-[13px] font-bold bg-gray-700 text-white rounded-md hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <Sparkles className="w-4 h-4" />
                    加入主提示词
                  </button>
                  <button
                    onClick={() => handleConfirm('character')}
                    disabled={(mgr.selectionMap['character']?.size || 0) === 0 || characterPromptsCount >= 6}
                    title={characterPromptsCount >= 6 ? '角色提示词已满 (6/6)' : '加入角色提示词'}
                    className="px-4 py-2 text-[13px] font-bold bg-nai-accent text-[#1a1410] rounded-md hover:bg-nai-accent-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 shadow-sm transition-colors cursor-pointer"
                  >
                    <User className="w-4 h-4" />
                    加入角色提示词
                  </button>
                </>
              ) : (
                <button
                  onClick={() => handleConfirm()}
                  disabled={totalSelected === 0}
                  className="px-4 py-2 text-[13px] font-bold bg-nai-accent text-[#1a1410] rounded-md hover:bg-nai-accent-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 shadow-sm transition-colors cursor-pointer"
                >
                  <Sparkles className="w-4 h-4" />
                  添加到提示词 ({totalSelected})
                </button>
              )}
            </footer>
          </div>
        </div>
      </div>
    </div>

    {/* 数据备份 - 4 分类统一面板 */}
    <TagManagerBackupModal
      isOpen={backupOpen}
      onClose={() => setBackupOpen(false)}
      onDataChanged={() => {
        // 触发各 hook 重新拉数据 (恢复/导入后视图刷新)
        ocManager.refreshPublicOCs();
        artistManager.loadLocalArtists();
        mgr.customStore.reload();
      }}
    />

    {/* 批量添加标签 - 通用 BatchTagModal (character + artist-style 共用) */}
    <BatchTagModal
      isOpen={batchTagOpen}
      title={batchTargetSubtype === 'character' ? '为角色添加标签' : '为画师串添加标签'}
      selectedCount={batchTargetIds.length}
      tagPool={activeTagPool}
      onClose={() => setBatchTagOpen(false)}
      onApply={handleBatchTagApply}
      onCreatePoolTag={handleCreatePoolTag}
    />

    {confirmDialog}
    </>,
    document.body
  );
};
