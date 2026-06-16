// 公共角色 (OC) 管理弹窗 - 复刻 PublicArtistManagerModal 风格
// 列出当前 botUserId 上传到公共库的角色, 支持搜索 / 编辑 / 删除
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Cloud, X, Search, Edit2, Trash2, Loader2, User, Undo2 } from 'lucide-react';
import {
  getPublicOCs, deletePublicOC,
  getOCPreviewUrl, getPublicLibraryOwnerId, type PublicOCData,
} from '../../services/publicLibrary';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  showToast: (message: string, type: 'success' | 'error') => void;
  /** 点击编辑时触发 — 外层用 openOCDetail 进入编辑表单 */
  onEdit?: (oc: PublicOCData) => void;
  /** 公共条目删除成功后回调 - 外层负责清本地相关副本 */
  onAfterDelete?: (oc: PublicOCData) => void | Promise<void>;
  /** 撤回发布 (删公共,本地副本保留为私人版) - 不传则不显示按钮 */
  onUnpublish?: (oc: PublicOCData) => Promise<{ success: boolean; message?: string }>;
}

export const PublicOCManagerModal: React.FC<Props> = ({
  isOpen, onClose, showToast, onEdit, onAfterDelete, onUnpublish,
}) => {
  const [publicOCs, setPublicOCs] = useState<PublicOCData[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [unpublishingId, setUnpublishingId] = useState<string | null>(null);
  const currentUserId = getPublicLibraryOwnerId();

  const loadData = useCallback(async () => {
    if (!currentUserId) return;
    setLoading(true);
    try {
      const all = await getPublicOCs();
      const mine = all.filter(oc => oc.created_by === currentUserId);
      setPublicOCs(mine);
    } catch (err) {
      console.error('加载公共 OC 失败:', err);
      setPublicOCs([]);
    } finally {
      setLoading(false);
    }
  }, [currentUserId]);

  useEffect(() => { if (isOpen) loadData(); }, [isOpen, loadData]);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return publicOCs;
    const q = searchQuery.toLowerCase();
    return publicOCs.filter(oc =>
      (oc.zh_name || '').toLowerCase().includes(q) ||
      oc.en_name.toLowerCase().includes(q) ||
      (oc.tag_group || '').toLowerCase().includes(q) ||
      oc.zh_aliases.some(a => a.toLowerCase().includes(q))
    );
  }, [publicOCs, searchQuery]);

  const handleDelete = async (oc: PublicOCData) => {
    const name = oc.zh_name || oc.en_name;
    // eslint-disable-next-line no-restricted-globals, no-alert
    if (!confirm(`将彻底删除「${name}」(公共 + 你的本地副本)。\n\n此操作不可恢复,确定继续吗?`)) return;
    setDeletingId(oc.id);
    try {
      const result = await deletePublicOC(oc.en_name);
      if (result.success) {
        setPublicOCs(prev => prev.filter(o => o.id !== oc.id));
        try { await onAfterDelete?.(oc); } catch (e) { console.error('清本地副本失败:', e); }
        showToast('已彻底删除', 'success');
      } else {
        showToast(`删除失败: ${result.message}`, 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('删除失败', 'error');
    } finally {
      setDeletingId(null);
    }
  };

  const handleUnpublish = async (oc: PublicOCData) => {
    if (!onUnpublish) return;
    const name = oc.zh_name || oc.en_name;
    // eslint-disable-next-line no-restricted-globals, no-alert
    if (!confirm(`将撤回「${name}」的公共发布。\n\n本地会保留一份私人副本(可继续编辑/使用),公共库不再可见。继续吗?`)) return;
    setUnpublishingId(oc.id);
    try {
      const result = await onUnpublish(oc);
      if (result.success) {
        setPublicOCs(prev => prev.filter(o => o.id !== oc.id));
        showToast('已撤回发布(本地副本已保留)', 'success');
      } else {
        showToast(`撤回失败: ${result.message || '未知'}`, 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('撤回失败', 'error');
    } finally {
      setUnpublishingId(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[101] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[560px] max-h-[80vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="p-4 border-b border-gray-800 flex items-center gap-3 bg-nai-dark/50 shrink-0">
          <div className="flex items-center gap-2 shrink-0">
            <Cloud className="w-5 h-5 text-nai-accent" />
            <span className="font-bold text-white text-base">公共角色管理</span>
          </div>
          <div className="flex-1 relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="搜索..." className="w-full h-8 bg-gray-800/80 text-gray-200 text-sm rounded-lg pl-8 pr-7 border border-gray-700 focus:border-nai-accent focus:outline-none"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto p-3 custom-scrollbar">
          {!currentUserId && (
            <div className="flex flex-col items-center justify-center py-10 text-gray-500">
              <Cloud className="w-10 h-10 mb-2 opacity-20" />
              <p className="text-sm">未 Bot 授权</p>
            </div>
          )}
          {currentUserId && loading && publicOCs.length === 0 && (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          )}
          {currentUserId && !loading && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-gray-500">
              <User className="w-10 h-10 mb-2 opacity-20" />
              <p className="text-sm">{searchQuery ? '无搜索结果' : '你还没有上传任何公共角色'}</p>
            </div>
          )}
          <div className="space-y-2">
            {filtered.map(oc => {
              const displayName = oc.zh_name || oc.en_name;
              return (
                <div key={oc.id} className="flex items-center gap-3 p-3 bg-nai-input border border-gray-800 rounded-lg hover:border-gray-600 transition-colors">
                  {/* 预览图 */}
                  <div className="w-12 h-12 rounded-lg overflow-hidden bg-gray-800 shrink-0 flex items-center justify-center">
                    {oc.preview_url ? (
                      <img
                        src={getOCPreviewUrl(oc.en_name)}
                        alt={displayName}
                        className="w-full h-full object-cover"
                        onError={e => { e.currentTarget.style.display = 'none'; }}
                      />
                    ) : (
                      <User className="w-5 h-5 text-gray-500" />
                    )}
                  </div>
                  {/* 信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm text-white truncate">{displayName}</div>
                    <div className="text-xs text-gray-500 truncate mt-0.5">{oc.tag_group}</div>
                  </div>
                  {/* 操作 */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {onEdit && (
                      <button
                        onClick={() => { onEdit(oc); onClose(); }}
                        className="p-2 text-gray-400 hover:text-nai-accent rounded hover:bg-white/10 transition-colors"
                        title="编辑"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                    )}
                    {onUnpublish && (
                      <button
                        onClick={() => handleUnpublish(oc)}
                        disabled={unpublishingId === oc.id || deletingId === oc.id}
                        className="p-2 text-gray-400 hover:text-amber-400 rounded hover:bg-amber-500/10 transition-colors disabled:opacity-50"
                        title="撤回发布 (本地副本保留)"
                      >
                        {unpublishingId === oc.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Undo2 className="w-4 h-4" />}
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(oc)}
                      disabled={deletingId === oc.id || unpublishingId === oc.id}
                      className="p-2 text-gray-400 hover:text-red-400 rounded hover:bg-red-500/10 transition-colors disabled:opacity-50"
                      title="彻底删除 (公共+本地)"
                    >
                      {deletingId === oc.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
