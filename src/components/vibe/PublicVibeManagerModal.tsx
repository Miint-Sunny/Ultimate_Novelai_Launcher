import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Cloud, X, Search, Edit2, Trash2, Loader2, RefreshCw, File } from 'lucide-react';
import { VibeCard } from './VibeCard';
import { type VibeFile } from './types';
import {
  getPublicVibes, deletePublicVibe, updatePublicVibeMeta,
  getPublicLibraryOwnerId, type PublicVibeData,
} from '../../services/publicLibrary';

interface PublicVibeManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedModelId: string;
  showToast: (message: string, type: 'success' | 'error') => void;
}

/**
 * 独立的"公共 Vibe 管理器"
 * 仅展示当前 Bot 用户上传的公共 vibe，支持编辑元数据 / 撤回
 */
export const PublicVibeManagerModal: React.FC<PublicVibeManagerModalProps> = ({
  isOpen,
  onClose,
  selectedModelId,
  showToast,
}) => {
  const [publicFiles, setPublicFiles] = useState<PublicVibeData[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const [editingTarget, setEditingTarget] = useState<{
    file: PublicVibeData;
    name: string;
    strength: number;
    infoExtracted: number;
  } | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const currentUserId = useMemo(() => getPublicLibraryOwnerId(), [isOpen]);

  const loadList = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    try {
      const all = await getPublicVibes(forceRefresh);
      // 仅保留当前用户上传的
      const mine = currentUserId ? all.filter(v => v.uploaderId === currentUserId) : [];
      setPublicFiles(mine);
    } catch (err) {
      console.error('加载公共 Vibe 失败:', err);
      setPublicFiles([]);
    } finally {
      setLoading(false);
    }
  }, [currentUserId]);

  useEffect(() => {
    if (isOpen) {
      loadList(true);
    }
  }, [isOpen, loadList]);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return publicFiles;
    const q = searchQuery.trim().toLowerCase();
    return publicFiles.filter(f => f.name.toLowerCase().includes(q));
  }, [publicFiles, searchQuery]);

  const handleDelete = async (file: PublicVibeData) => {
    if (!confirm(`确定要从公共库撤回 "${file.name}" 吗？此操作不可恢复。`)) return;
    setDeletingId(file.id);
    try {
      const result = await deletePublicVibe(file.filename);
      if (result.success) {
        setPublicFiles(prev => prev.filter(f => f.id !== file.id));
        showToast('已撤回', 'success');
      } else {
        showToast(result.message || '撤回失败', 'error');
      }
    } finally {
      setDeletingId(null);
    }
  };

  const handleSaveEdit = async () => {
    if (!editingTarget) return;
    setSavingId(editingTarget.file.id);
    try {
      const result = await updatePublicVibeMeta(editingTarget.file.filename, {
        name: editingTarget.name.trim() || undefined,
        defaultStrength: editingTarget.strength,
        defaultInfoExtracted: editingTarget.infoExtracted,
      });
      if (result.success) {
        showToast('已保存', 'success');
        setEditingTarget(null);
        await loadList(true);
      } else {
        showToast(result.message || '保存失败', 'error');
      }
    } finally {
      setSavingId(null);
    }
  };

  // 把 PublicVibeData 转换为 VibeFile 以便复用 VibeCard
  const toVibeFile = (v: PublicVibeData): VibeFile => {
    return {
      id: v.id,
      name: v.name,
      size: '',
      preview: v.thumbnail || '',
      supportedModels: v.supportedModels,
      defaultStrength: v.defaultStrength,
      defaultInfoExtracted: v.defaultInfoExtracted,
      fileName: v.filename,
      hasImage: v.hasImage,
      uploaderId: v.uploaderId,
    };
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
        <div
          className="bg-nai-panel border border-gray-700 rounded-lg shadow-2xl w-[640px] h-[80vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="p-4 border-b border-gray-800 flex items-center gap-3 bg-nai-dark/50">
            <div className="flex items-center gap-2 shrink-0">
              <Cloud className="w-5 h-5 text-nai-accent" />
              <span className="font-bold text-white text-base">公共 Vibe 管理</span>
            </div>
            <div className="flex-1 relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索..."
                className="w-full h-8 bg-gray-800/80 text-gray-200 text-sm rounded-lg pl-8 pr-7 border border-gray-700 focus:border-nai-accent focus:outline-none transition-colors"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => loadList(true)}
                disabled={loading}
                className="h-8 px-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm font-bold rounded flex items-center justify-center transition-colors border border-gray-600 disabled:opacity-50"
                title="刷新"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-2 bg-nai-dark/30">
            {!currentUserId && (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 py-10">
                <Cloud className="w-10 h-10 mb-2 opacity-20" />
                <p className="text-sm">未 Bot 授权</p>
                <p className="text-xs mt-1">请先完成 Bot 授权才能管理公共 Vibe</p>
              </div>
            )}
            {currentUserId && loading && publicFiles.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 py-10">
                <Loader2 className="w-8 h-8 animate-spin opacity-50" />
              </div>
            )}
            {currentUserId && !loading && filtered.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 py-10">
                <File className="w-10 h-10 mb-2 opacity-20" />
                <p className="text-sm">{searchQuery ? '无搜索结果' : '你还没有上传任何公共 Vibe'}</p>
                {!searchQuery && (
                  <p className="text-xs mt-1">在 Vibe 管理器中选择一个本地 Vibe 后，使用"上传到公共"按钮</p>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              {filtered.map((file) => {
                const vibeFile = toVibeFile(file);
                return (
                  <VibeCard
                    key={file.id}
                    file={vibeFile}
                    isSelected={false}
                    selectedModelId={selectedModelId}
                    onClick={() => {
                      setEditingTarget({
                        file,
                        name: file.name,
                        strength: file.defaultStrength ?? 0.5,
                        infoExtracted: file.defaultInfoExtracted ?? 1,
                      });
                    }}
                    actions={
                      <>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingTarget({
                              file,
                              name: file.name,
                              strength: file.defaultStrength ?? 0.5,
                              infoExtracted: file.defaultInfoExtracted ?? 1,
                            });
                          }}
                          className="p-2 text-gray-400 hover:text-nai-accent rounded hover:bg-white/10 transition-colors"
                          title="编辑"
                        >
                          <Edit2 className="w-5 h-5" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(file); }}
                          disabled={deletingId === file.id}
                          className="p-2 text-gray-400 hover:text-red-400 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
                          title="撤回"
                        >
                          {deletingId === file.id ? <Loader2 className="w-5 h-5 animate-spin" /> : <Trash2 className="w-5 h-5" />}
                        </button>
                      </>
                    }
                  />
                );
              })}
            </div>
          </div>

          {/* Footer */}
          <div className="p-3 border-t border-gray-800 bg-nai-dark/50 flex justify-between items-center text-xs text-gray-500">
            <div>共 {publicFiles.length} 个</div>
            <div>右键卡片或点击编辑按钮修改元数据</div>
          </div>
        </div>
      </div>

      {/* 编辑弹层 */}
      {editingTarget && (
        <div className="fixed inset-0 z-[101] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setEditingTarget(null)}>
          <div className="bg-nai-panel border border-gray-700 rounded-lg shadow-2xl w-80 flex flex-col overflow-hidden animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50">
              <div className="flex items-center gap-2">
                <Edit2 className="w-5 h-5 text-nai-accent" />
                <span className="font-bold text-white text-base">编辑公共 Vibe</span>
              </div>
              <button onClick={() => setEditingTarget(null)} className="text-gray-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">名称</label>
                <input
                  type="text"
                  value={editingTarget.name}
                  onChange={(e) => setEditingTarget(prev => prev ? { ...prev, name: e.target.value } : null)}
                  className="w-full bg-nai-dark text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-nai-accent focus:outline-none transition-colors"
                  autoFocus
                />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-xs text-gray-400">Strength</label>
                  <span className="text-xs text-nai-accent font-mono">{editingTarget.strength.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={editingTarget.strength}
                  onChange={(e) => setEditingTarget(prev => prev ? { ...prev, strength: parseFloat(e.target.value) } : null)}
                  className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent"
                />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-xs text-gray-400">Info Extracted</label>
                  <span className="text-xs text-nai-accent font-mono">{editingTarget.infoExtracted.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={editingTarget.infoExtracted}
                  onChange={(e) => setEditingTarget(prev => prev ? { ...prev, infoExtracted: parseFloat(e.target.value) } : null)}
                  className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent"
                />
              </div>
            </div>
            <div className="p-4 border-t border-gray-800 flex gap-3">
              <button
                onClick={() => setEditingTarget(null)}
                className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={savingId === editingTarget.file.id}
                className="flex-1 py-2.5 bg-nai-accent hover:bg-nai-accent/90 text-black text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {savingId === editingTarget.file.id ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
