import React, { useState, useRef, useMemo } from 'react';
import {
  Settings2, Upload, Edit2, Plus, X, RotateCcw, Globe, HardDrive,
  Trash2, Loader2, Search, Cloud, Package, Tag, Check
} from 'lucide-react';
import { VibeBatchTagDialog } from './VibeBatchTagDialog';
import { VibeImportDialog } from './VibeImportDialog';
import { VibeLocalList } from './VibeLocalList';
import { PublicVibeManagerModal } from './PublicVibeManagerModal';
import { type VibeFile } from './types';
import {
  deleteVibe,
  exportVibesToBundle,
  setVibeTags as setVibeTagsStorage,
  removeRecentVibeEntry,
} from '../../services/localLibrary';
import { getPublicLibraryOwnerId } from '../../services/publicLibrary';
import { CloudManageModal } from './CloudManageModal';
import { useConfirm } from '../tag-manager/parts/useConfirm';
import { useVibeCrudActions } from './useVibeCrudActions';
import { useVibeImportFlow } from './useVibeImportFlow';
import { useVibeManagerLists } from './useVibeManagerLists';
import { useVibeTagManagement } from './useVibeTagManagement';
import { VibeTagSettingsDialog } from './VibeTagSettingsDialog';
import { VibePublicList } from './VibePublicList';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface VibeManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedModelId: string;
  /** IDs of currently active vibes (used to initialize selection on open) */
  activeVibeIds: string[];
  /** Called when user confirms selection; parent builds ActiveVibes from this */
  onConfirmSelection: (selectedIds: string[], allFiles: VibeFile[]) => void;
  showToast: (message: string, type: 'success' | 'error') => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const VibeManagerModal: React.FC<VibeManagerModalProps> = ({
  isOpen,
  onClose,
  selectedModelId,
  activeVibeIds,
  onConfirmSelection,
  showToast,
}) => {
  // 二次确认弹窗（用于破坏性操作，如删除 vibe）
  // 注意：故意命名为 confirmAction 以避免与全局 window.confirm 冲突
  const { confirm: confirmAction, confirmDialog } = useConfirm();

  const currentBotUserId = useMemo(() => getPublicLibraryOwnerId(), [isOpen]);
  const {
    vibeTab,
    setVibeTab,
    selectedVibes,
    setSelectedVibes,
    recentEntries,
    setRecentEntries,
    bumpRecentUsage,
    refreshRecentEntries,
    vibeSearchQuery,
    setVibeSearchQuery,
    vibeModelFilter,
    selectedTagFilter,
    setSelectedTagFilter,
    tagPool,
    setTagPool,
    publicFiles,
    setPublicFiles,
    localFiles,
    setLocalFiles,
    isLoadingPublicVibes,
    visiblePublicVibeCount,
    setVisiblePublicVibeCount,
    publicVibeEndRef,
    publicScrollRef,
    localScrollRef,
    filteredPublicFiles,
    filteredLocalFiles,
    tagFilteredLocalFiles,
    myPublicUploadsCount,
    tagUsageCounts,
    loadLocalVibes,
    loadPublicVibes,
    reloadTagPool,
    toggleVibeSelection,
    isVibeInLocal,
    isVibeInPublic,
    handlePublicScroll,
    handleLocalScroll,
  } = useVibeManagerLists({ isOpen, activeVibeIds, currentBotUserId });

  // 公共 Vibe 管理面板（仅管理"我上传的"）
  const [publicVibeManagerOpen, setPublicVibeManagerOpen] = useState(false);

  // 云端管理弹窗
  const [cloudManageOpen, setCloudManageOpen] = useState(false);

  const {
    downloadingVibeIds,
    savingVibeIds,
    uploadingVibeIds,
    vibeMenuOpenId,
    setVibeMenuOpenId,
    editingVibeDefaults,
    setEditingVibeDefaults,
    vibeUploadTarget,
    setVibeUploadTarget,
    vibeUploadName,
    setVibeUploadName,
    vibeUploadStrength,
    setVibeUploadStrength,
    vibeUploadInfoExtracted,
    setVibeUploadInfoExtracted,
    handleSaveVibeToLocal,
    handleDeleteVibeFile,
    handleDownloadVibe,
    handleRemoveFromPublic,
    saveVibeEdit,
    handleUploadVibeToPublic,
    confirmUploadVibeToPublic,
    handlePublicVibeDownload,
  } = useVibeCrudActions({
    currentBotUserId,
    localFiles,
    publicFiles,
    selectedVibes,
    setLocalFiles,
    setPublicFiles,
    setSelectedVibes,
    isVibeInLocal,
    loadLocalVibes,
    loadPublicVibes,
    reloadTagPool,
    refreshRecentEntries,
    confirmAction,
    showToast,
  });

  const {
    tagEditorNewName,
    setTagEditorNewName,
    tagSettingsOpen,
    setTagSettingsOpen,
    tagSettingsEditing,
    setTagSettingsEditing,
    tagSettingsEditDraft,
    setTagSettingsEditDraft,
    tagSettingsNewName,
    setTagSettingsNewName,
    tagSettingsCreating,
    setTagSettingsCreating,
    batchTagEditorOpen,
    setBatchTagEditorOpen,
    batchTagsToAdd,
    setBatchTagsToAdd,
    batchNewTagCreating,
    setBatchNewTagCreating,
    batchNewTagName,
    setBatchNewTagName,
    tagSettingsTrimmedNewName,
    tagSettingsDuplicate,
    canCreateTagSetting,
    batchTrimmedNewTagName,
    batchNewTagDuplicate,
    canCreateBatchNewTag,
    addTagToEditingDefaults,
    closeTagSettings,
    submitNewTagSetting,
    startTagSettingEdit,
    renameTagSetting,
    deleteTagSetting,
    closeBatchTagEditor,
    submitNewBatchTag,
    applyBatchTags,
  } = useVibeTagManagement({
    currentBotUserId,
    tagPool,
    setTagPool,
    selectedVibes,
    localFiles,
    publicFiles,
    setSelectedTagFilter,
    setEditingVibeDefaults,
    loadLocalVibes,
    reloadTagPool,
    showToast,
  });

  const {
    importItems,
    setImportItems,
    importItemNewTagDraft,
    setImportItemNewTagDraft,
    handleFileUpload,
    confirmVibeImport,
    toggleItemTag,
    addNewTagToItem,
    handleModalDrop,
  } = useVibeImportFlow({
    currentBotUserId,
    tagPool,
    setTagPool,
    setLocalFiles,
    setSelectedVibes,
    bumpRecentUsage,
    reloadTagPool,
    showToast,
  });

  const inputRef = useRef<HTMLInputElement>(null);

  // ── Batch operations ──────────────────────────────────────────────────────

  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const handleBatchDelete = async () => {
    const localSelected = selectedVibes.filter(id => localFiles.some(f => f.id === id));
    if (localSelected.length === 0) {
      showToast('没有选中本地 Vibe', 'error');
      return;
    }
    const ok = await confirmAction({
      title: '批量删除',
      message: `确定要删除选中的 ${localSelected.length} 个 Vibe 吗？此操作不可恢复。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    setIsBatchDeleting(true);
    let deleted = 0;
    for (const id of localSelected) {
      try {
        await deleteVibe(id);
        removeRecentVibeEntry(id);
        deleted++;
      } catch (err) {
        console.error(`删除 vibe ${id} 失败:`, err);
      }
    }
    setSelectedVibes(prev => prev.filter(id => !localSelected.includes(id)));
    await loadLocalVibes();
    await reloadTagPool();
    refreshRecentEntries();
    showToast(`已删除 ${deleted} 个 Vibe`, 'success');
    setIsBatchDeleting(false);
  };

  const handleBatchBundleDownload = async () => {
    const localSelected = selectedVibes.filter(id => localFiles.some(f => f.id === id));
    if (localSelected.length === 0) {
      showToast('没有选中本地 Vibe', 'error');
      return;
    }
    try {
      const blob = await exportVibesToBundle(localSelected);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vibes_${localSelected.length}个_${new Date().toISOString().slice(0, 10)}.naiv4vibebundle`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`已打包 ${localSelected.length} 个 Vibe`, 'success');
    } catch (err) {
      console.error('打包下载失败:', err);
      showToast('打包失败: ' + (err as Error).message, 'error');
    }
  };

  // ── Confirm / close ──────────────────────────────────────────────────────

  const handleConfirmSelection = () => {
    const allFiles = [...publicFiles, ...localFiles];
    // Update usage order only on confirm — track all selected vibes (public + local)
    if (selectedVibes.length > 0) {
      const snapshots = selectedVibes
        .map(id => allFiles.find(f => f.id === id))
        .filter(Boolean)
        .map(f => ({ id: f!.id, name: f!.name, preview: f!.preview }));
      bumpRecentUsage(snapshots);
    }
    onConfirmSelection(selectedVibes, allFiles);
  };

  const handleClose = () => {
    onClose();
  };

  // ── Render ───────────────────────────────────────────────────────────────

  if (!isOpen) return null;

  return (
    <>
      {/* Main Modal */}
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={handleClose}>
        <div
          className="relative bg-nai-panel border border-gray-700 rounded-lg shadow-2xl w-[640px] h-[80vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
          onClick={(e) => e.stopPropagation()}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDrop={handleModalDrop}
        >
          {/* Header */}
          <div className="p-4 border-b border-gray-800 flex items-center gap-3 bg-nai-dark/50">
            <div className="flex items-center gap-2 shrink-0">
              <Settings2 className="w-5 h-5 text-nai-accent" />
              <span className="font-bold text-white text-base">Vibe管理器</span>
            </div>
            <div className="flex-1 relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                type="text"
                value={vibeSearchQuery}
                onChange={(e) => { setVibeSearchQuery(e.target.value); setVisiblePublicVibeCount(20); }}
                placeholder="搜索..."
                className="w-full h-8 bg-gray-800/80 text-gray-200 text-sm rounded-lg pl-8 pr-7 border border-gray-700 focus:border-nai-accent focus:outline-none transition-colors"
              />
              {vibeSearchQuery && (
                <button onClick={() => setVibeSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input type="file" ref={inputRef} className="hidden" multiple onChange={handleFileUpload} accept="image/*,.naiv4vibe,.naiv4vibebundle" />
              {/* 云端数据管理 */}
              <button
                onClick={() => setCloudManageOpen(true)}
                className="h-8 w-8 rounded flex items-center justify-center transition-colors border bg-gray-800 border-gray-600 text-gray-400 hover:bg-gray-700 hover:text-nai-accent"
                title="云端数据管理"
              >
                <Cloud className="w-4 h-4" />
              </button>
              <button
                onClick={() => inputRef.current?.click()}
                className="h-8 px-3 bg-nai-accent hover:bg-[#ebd576] text-black text-sm font-bold rounded flex items-center justify-center gap-1.5 transition-colors shadow-sm"
                title="添加文件（支持多选）"
              >
                <Plus className="w-4 h-4" />
                添加文件
              </button>
              <button onClick={handleClose} className="text-gray-400 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-gray-800">
            <button
              className={`flex-1 py-3 text-sm font-bold transition-colors border-b-2 ${vibeTab === 'public'
                ? 'border-nai-accent text-white bg-white/5'
                : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-white/5'
                }`}
              onClick={() => setVibeTab('public')}
            >
              <div className="flex items-center justify-center gap-2">
                <Globe className="w-4 h-4" />
                公共 Vibe
                {isLoadingPublicVibes && <Loader2 className="w-3 h-3 animate-spin" />}
              </div>
            </button>
            <button
              className={`flex-1 py-3 text-sm font-bold transition-colors border-b-2 ${vibeTab === 'local'
                ? 'border-nai-accent text-white bg-white/5'
                : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-white/5'
                }`}
              onClick={() => setVibeTab('local')}
            >
              <div className="flex items-center justify-center gap-2">
                <HardDrive className="w-4 h-4" />
                我的Vibe
              </div>
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-hidden bg-nai-dark/30 min-h-[400px] relative">
            <VibePublicList
              publicScrollRef={publicScrollRef}
              publicVibeEndRef={publicVibeEndRef}
              handlePublicScroll={handlePublicScroll}
              vibeTab={vibeTab}
              publicFiles={publicFiles}
              filteredPublicFiles={filteredPublicFiles}
              visiblePublicVibeCount={visiblePublicVibeCount}
              currentBotUserId={currentBotUserId}
              myPublicUploadsCount={myPublicUploadsCount}
              setPublicVibeManagerOpen={setPublicVibeManagerOpen}
              isLoadingPublicVibes={isLoadingPublicVibes}
              selectedModelId={selectedModelId}
              selectedVibes={selectedVibes}
              toggleVibeSelection={toggleVibeSelection}
              savingVibeIds={savingVibeIds}
              handleSaveVibeToLocal={handleSaveVibeToLocal}
              downloadingVibeIds={downloadingVibeIds}
              handlePublicVibeDownload={handlePublicVibeDownload}
              loadPublicVibes={loadPublicVibes}
              vibeSearchQuery={vibeSearchQuery}
              vibeModelFilter={vibeModelFilter}
            />

            <VibeLocalList
              localScrollRef={localScrollRef}
              handleLocalScroll={handleLocalScroll}
              vibeTab={vibeTab}
              recentEntries={recentEntries}
              setRecentEntries={setRecentEntries}
              localFiles={localFiles}
              publicFiles={publicFiles}
              selectedVibes={selectedVibes}
              toggleVibeSelection={toggleVibeSelection}
              selectedTagFilter={selectedTagFilter}
              setSelectedTagFilter={setSelectedTagFilter}
              tagPool={tagPool}
              setTagSettingsOpen={setTagSettingsOpen}
              tagFilteredLocalFiles={tagFilteredLocalFiles}
              filteredLocalFiles={filteredLocalFiles}
              vibeSearchQuery={vibeSearchQuery}
              vibeModelFilter={vibeModelFilter}
              selectedModelId={selectedModelId}
              isVibeInPublic={isVibeInPublic}
              handleDeleteVibeFile={handleDeleteVibeFile}
              vibeMenuOpenId={vibeMenuOpenId}
              setVibeMenuOpenId={setVibeMenuOpenId}
              setEditingVibeDefaults={setEditingVibeDefaults}
              handleDownloadVibe={handleDownloadVibe}
              handleRemoveFromPublic={handleRemoveFromPublic}
              handleUploadVibeToPublic={handleUploadVibeToPublic}
              uploadingVibeIds={uploadingVibeIds}
            />
          </div>

          {/* Footer */}
          <div className="p-4 border-t border-gray-800 bg-nai-dark/50 flex justify-between items-center shrink-0">
            <div className={`flex items-center gap-1.5 transition-opacity ${vibeTab === 'local' && selectedVibes.length > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
              <button
                onClick={handleBatchDelete}
                disabled={isBatchDeleting}
                className="px-2.5 py-1.5 text-sm font-bold text-red-400 hover:text-red-300 transition-colors flex items-center gap-1 border border-red-400/30 rounded hover:bg-red-400/10 disabled:opacity-50"
                title="批量删除选中的本地 Vibe"
              >
                {isBatchDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                删除
              </button>
              <button
                onClick={handleBatchBundleDownload}
                className="px-2.5 py-1.5 text-sm font-bold text-gray-300 hover:text-white transition-colors flex items-center gap-1 border border-gray-600 rounded hover:bg-white/10"
                title="将选中的 Vibe 打包为 .naiv4vibebundle 文件下载"
              >
                <Package className="w-3.5 h-3.5" />
                打包下载
              </button>
              <button
                onClick={() => {
                  setBatchTagsToAdd(new Set());
                  setBatchTagEditorOpen(true);
                }}
                className="px-2.5 py-1.5 text-sm font-bold text-gray-300 hover:text-white transition-colors flex items-center gap-1 border border-gray-600 rounded hover:bg-white/10"
                title="批量添加标签"
              >
                <Tag className="w-3.5 h-3.5" />
                添加标签
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSelectedVibes([])}
                disabled={selectedVibes.length === 0}
                className="px-2.5 py-1.5 text-sm font-bold text-red-400 hover:text-red-300 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                清空
              </button>
              <button onClick={handleClose} className="px-3 py-1.5 text-sm font-bold text-gray-300 hover:text-white transition-colors">
                取消
              </button>
              <button
                onClick={handleConfirmSelection}
                className="px-4 py-1.5 text-sm font-bold bg-nai-accent text-black rounded hover:bg-[#ebd576] transition-colors"
              >
                确认选择 ({selectedVibes.length})
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Sub-dialogs ─────────────────────────────────────────────────────── */}

      {/* Upload to public dialog */}
      {vibeUploadTarget && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setVibeUploadTarget(null)}>
          <div className="bg-nai-panel border border-gray-700 rounded-lg shadow-2xl w-80 flex flex-col overflow-hidden animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50">
              <div className="flex items-center gap-2">
                <Upload className="w-5 h-5 text-nai-accent" />
                <span className="font-bold text-white text-base">上传到公共Vibe</span>
              </div>
              <button onClick={() => setVibeUploadTarget(null)} className="text-gray-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">主名称</label>
                <input type="text" value={vibeUploadName} onChange={(e) => setVibeUploadName(e.target.value)} placeholder="为这个Vibe起个名字"
                  className="w-full bg-nai-dark text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-nai-accent focus:outline-none transition-colors"
                  autoFocus onKeyDown={(e) => { if (e.key === 'Enter' && vibeUploadName.trim()) confirmUploadVibeToPublic(); }} />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1.5"><label className="text-xs text-gray-400">Strength</label><span className="text-xs text-nai-accent font-mono">{vibeUploadStrength.toFixed(2)}</span></div>
                <input type="range" min="0" max="1" step="0.01" value={vibeUploadStrength} onChange={(e) => setVibeUploadStrength(parseFloat(e.target.value))} className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent" />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1.5"><label className="text-xs text-gray-400">Info Extracted</label><span className="text-xs text-nai-accent font-mono">{vibeUploadInfoExtracted.toFixed(2)}</span></div>
                <input type="range" min="0" max="1" step="0.01" value={vibeUploadInfoExtracted} onChange={(e) => setVibeUploadInfoExtracted(parseFloat(e.target.value))} className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent" />
              </div>
            </div>
            <div className="p-4 border-t border-gray-800 flex gap-3">
              <button onClick={() => setVibeUploadTarget(null)} className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors">取消</button>
              <button onClick={confirmUploadVibeToPublic} disabled={!vibeUploadName.trim()} className="flex-1 py-2.5 bg-nai-accent hover:bg-nai-accent/90 text-black text-sm font-medium rounded-lg transition-colors disabled:opacity-50">确认上传</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit vibe dialog */}
      {editingVibeDefaults && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setEditingVibeDefaults(null)}>
          <div className="bg-nai-panel border border-gray-700 rounded-lg shadow-2xl w-96 max-h-[80vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50">
              <div className="flex items-center gap-2">
                <Edit2 className="w-5 h-5 text-nai-accent" />
                <span className="font-bold text-white text-base">编辑 Vibe</span>
              </div>
              <button onClick={() => setEditingVibeDefaults(null)} className="text-gray-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">名称</label>
                <input
                  type="text"
                  value={editingVibeDefaults.editName}
                  onChange={(e) => setEditingVibeDefaults(prev => prev ? { ...prev, editName: e.target.value } : null)}
                  placeholder="输入名称"
                  className="w-full bg-nai-dark text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-nai-accent focus:outline-none transition-colors"
                  autoFocus
                />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1.5"><label className="text-xs text-gray-400">Strength</label><span className="text-xs text-nai-accent font-mono">{editingVibeDefaults.strength.toFixed(2)}</span></div>
                <input type="range" min="0" max="1" step="0.01" value={editingVibeDefaults.strength} onChange={(e) => setEditingVibeDefaults(prev => prev ? { ...prev, strength: parseFloat(e.target.value) } : null)} className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent" />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1.5"><label className="text-xs text-gray-400">Info Extracted</label><span className="text-xs text-nai-accent font-mono">{editingVibeDefaults.infoExtracted.toFixed(2)}</span></div>
                <input type="range" min="0" max="1" step="0.01" value={editingVibeDefaults.infoExtracted} onChange={(e) => setEditingVibeDefaults(prev => prev ? { ...prev, infoExtracted: parseFloat(e.target.value) } : null)} className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent" />
              </div>
              {/* 标签 */}
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <Tag className="w-3.5 h-3.5 text-gray-400" />
                  <label className="text-xs text-gray-400">标签</label>
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {tagPool.map(tag => {
                    const active = editingVibeDefaults.tags.has(tag);
                    return (
                      <button key={tag} onClick={() => setEditingVibeDefaults(prev => {
                        if (!prev) return prev;
                        const next = new Set(prev.tags);
                        if (next.has(tag)) next.delete(tag); else next.add(tag);
                        return { ...prev, tags: next };
                      })}
                        className={`px-2.5 py-1 text-[11px] font-bold rounded-full border transition-colors ${active ? 'bg-nai-accent text-black border-nai-accent' : 'bg-gray-800 text-gray-400 border-gray-700/50 hover:text-gray-200 hover:bg-gray-700'}`}
                      >{tag}</button>
                    );
                  })}
                  {tagPool.length === 0 && <span className="text-xs text-gray-500">暂无标签</span>}
                </div>
                <div className="flex gap-2">
                  <input type="text" value={tagEditorNewName} onChange={(e) => setTagEditorNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        addTagToEditingDefaults();
                      }
                    }}
                    placeholder="新建标签..."
                    className="flex-1 bg-nai-dark text-white text-xs rounded px-2 py-1.5 border border-gray-700 focus:border-nai-accent focus:outline-none" />
                  <button onClick={() => addTagToEditingDefaults()} disabled={!tagEditorNewName.trim()}
                    className="px-2.5 py-1.5 bg-nai-accent hover:bg-[#ebd576] text-black text-xs font-bold rounded disabled:opacity-30 flex items-center gap-1">
                    <Check className="w-3.5 h-3.5" /> 添加
                  </button>
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-gray-800 flex gap-3">
              <button onClick={() => setEditingVibeDefaults(null)} className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors">取消</button>
              <button onClick={async () => {
                // 保存名称/参数
                await saveVibeEdit(editingVibeDefaults.vibeId, editingVibeDefaults.editName, editingVibeDefaults.strength, editingVibeDefaults.infoExtracted);
                // 保存标签
                await setVibeTagsStorage(editingVibeDefaults.vibeId, Array.from(editingVibeDefaults.tags));
                await loadLocalVibes();
                await reloadTagPool();
                setEditingVibeDefaults(null);
              }} className="flex-1 py-2.5 bg-nai-accent hover:bg-nai-accent/90 text-black text-sm font-medium rounded-lg transition-colors">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 多 Vibe 导入配置面板 */}
      {importItems && importItems.length > 0 && (
        <VibeImportDialog
          importItems={importItems}
          setImportItems={setImportItems}
          tagPool={tagPool}
          importItemNewTagDraft={importItemNewTagDraft}
          setImportItemNewTagDraft={setImportItemNewTagDraft}
          toggleItemTag={toggleItemTag}
          addNewTagToItem={addNewTagToItem}
          confirmVibeImport={confirmVibeImport}
        />
      )}

      {/* 单 Vibe 标签编辑弹层 */}

      {/* 批量添加标签弹层 */}
      {batchTagEditorOpen && (
        <VibeBatchTagDialog
          selectedCount={selectedVibes.length}
          tagPool={tagPool}
          batchTagsToAdd={batchTagsToAdd}
          setBatchTagsToAdd={setBatchTagsToAdd}
          batchNewTagCreating={batchNewTagCreating}
          setBatchNewTagCreating={setBatchNewTagCreating}
          batchNewTagName={batchNewTagName}
          setBatchNewTagName={setBatchNewTagName}
          batchTrimmedNewTagName={batchTrimmedNewTagName}
          batchNewTagDuplicate={batchNewTagDuplicate}
          canCreateBatchNewTag={canCreateBatchNewTag}
          closeBatchTagEditor={closeBatchTagEditor}
          submitNewBatchTag={submitNewBatchTag}
          applyBatchTags={applyBatchTags}
        />
      )}

      {/* 云端数据管理弹窗 */}
      <CloudManageModal
        isOpen={cloudManageOpen}
        onClose={() => setCloudManageOpen(false)}
        onDataChanged={async () => {
          await loadLocalVibes();
          await reloadTagPool();
        }}
      />

      {/* 公共 Vibe 管理面板 — 嵌入在主 Modal 内 */}
      <PublicVibeManagerModal
        isOpen={publicVibeManagerOpen}
        onClose={() => {
          setPublicVibeManagerOpen(false);
          // 关闭时刷新公共列表，反映可能的撤回/编辑变化
          loadPublicVibes(true);
        }}
        selectedModelId={selectedModelId}
        showToast={showToast}
      />


      {/* 标签管理面板 */}
      {tagSettingsOpen && (
        <VibeTagSettingsDialog
          tagPool={tagPool}
          tagUsageCounts={tagUsageCounts}
          tagSettingsEditing={tagSettingsEditing}
          setTagSettingsEditing={setTagSettingsEditing}
          tagSettingsEditDraft={tagSettingsEditDraft}
          setTagSettingsEditDraft={setTagSettingsEditDraft}
          tagSettingsNewName={tagSettingsNewName}
          setTagSettingsNewName={setTagSettingsNewName}
          tagSettingsCreating={tagSettingsCreating}
          setTagSettingsCreating={setTagSettingsCreating}
          tagSettingsTrimmedNewName={tagSettingsTrimmedNewName}
          tagSettingsDuplicate={tagSettingsDuplicate}
          canCreateTagSetting={canCreateTagSetting}
          closeTagSettings={closeTagSettings}
          submitNewTagSetting={submitNewTagSetting}
          startTagSettingEdit={startTagSettingEdit}
          renameTagSetting={renameTagSetting}
          deleteTagSetting={deleteTagSetting}
        />
      )}

      {/* 二次确认弹窗（删除等破坏性操作） */}
      {confirmDialog}
    </>
  );
};
