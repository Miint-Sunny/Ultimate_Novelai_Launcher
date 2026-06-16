import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Cloud, X, Search, Edit2, Trash2, Loader2, Palette, Undo2 } from 'lucide-react';
import {
  getPublicArtists, deletePublicArtist,
  getPublicLibraryOwnerId, type PublicArtistData,
} from '../../services/publicLibrary';
import { getBackendUrl } from '../../utils/apiConfig';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  showToast: (message: string, type: 'success' | 'error') => void;
  /** 点击编辑时触发 — 由外层用 openArtistDetail 处理 */
  onEdit?: (artist: PublicArtistData) => void;
  /** 公共条目删除成功后回调 - 外层负责清本地相关副本 */
  onAfterDelete?: (artist: PublicArtistData) => void | Promise<void>;
  /** 撤回发布 (删公共,本地副本保留为私人版) - 不传则不显示按钮 */
  onUnpublish?: (artist: PublicArtistData) => Promise<{ success: boolean; message?: string }>;
}

export const PublicArtistManagerModal: React.FC<Props> = ({ isOpen, onClose, showToast, onEdit, onAfterDelete, onUnpublish }) => {
  const [publicArtists, setPublicArtists] = useState<PublicArtistData[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [unpublishingId, setUnpublishingId] = useState<string | null>(null);
  const currentUserId = getPublicLibraryOwnerId();

  const loadData = useCallback(async () => {
    if (!currentUserId) return;
    setLoading(true);
    try {
      const all = await getPublicArtists();
      const mine = all.filter(a => a.added_by === currentUserId);
      setPublicArtists(mine);
    } catch (err) {
      console.error('加载公共画师串失败:', err);
      setPublicArtists([]);
    } finally {
      setLoading(false);
    }
  }, [currentUserId]);

  useEffect(() => { if (isOpen) loadData(); }, [isOpen, loadData]);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return publicArtists;
    const q = searchQuery.toLowerCase();
    return publicArtists.filter(a =>
      a.name.toLowerCase().includes(q) || (a.artist_string || '').toLowerCase().includes(q)
    );
  }, [publicArtists, searchQuery]);

  const handleDelete = async (artist: PublicArtistData) => {
    if (!confirm(`将彻底删除「${artist.name}」(公共 + 你的本地副本)。\n\n此操作不可恢复,确定继续吗?`)) return;
    setDeletingId(artist.id);
    try {
      const result = await deletePublicArtist(artist.id);
      if (result.success) {
        setPublicArtists(prev => prev.filter(a => a.id !== artist.id));
        try { await onAfterDelete?.(artist); } catch (e) { console.error('清本地副本失败:', e); }
        showToast('已彻底删除', 'success');
      } else {
        showToast(`删除失败: ${result.message}`, 'error');
      }
    } catch (err) {
      showToast('删除失败', 'error');
    } finally {
      setDeletingId(null);
    }
  };

  const handleUnpublish = async (artist: PublicArtistData) => {
    if (!onUnpublish) return;
    // eslint-disable-next-line no-restricted-globals, no-alert
    if (!confirm(`将撤回「${artist.name}」的公共发布。\n\n本地会保留一份私人副本(可继续编辑/使用),公共库不再可见。继续吗?`)) return;
    setUnpublishingId(artist.id);
    try {
      const result = await onUnpublish(artist);
      if (result.success) {
        setPublicArtists(prev => prev.filter(a => a.id !== artist.id));
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
            <span className="font-bold text-white text-base">公共画师串管理</span>
          </div>
          <div className="flex-1 relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="搜索..." className="w-full h-8 bg-gray-800/80 text-gray-200 text-sm rounded-lg pl-8 pr-7 border border-gray-700 focus:border-nai-accent focus:outline-none"
            />
            {searchQuery && <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"><X className="w-3 h-3" /></button>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white shrink-0"><X className="w-5 h-5" /></button>
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto p-3">
            {!currentUserId && (
              <div className="flex flex-col items-center justify-center py-10 text-gray-500">
                <Cloud className="w-10 h-10 mb-2 opacity-20" />
                <p className="text-sm">未 Bot 授权</p>
              </div>
            )}
            {currentUserId && loading && publicArtists.length === 0 && (
              <div className="flex items-center justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>
            )}
            {currentUserId && !loading && filtered.length === 0 && (
              <div className="flex flex-col items-center justify-center py-10 text-gray-500">
                <Palette className="w-10 h-10 mb-2 opacity-20" />
                <p className="text-sm">{searchQuery ? '无搜索结果' : '你还没有上传任何公共画师串'}</p>
              </div>
            )}
            <div className="space-y-2">
              {filtered.map(artist => (
                <div key={artist.id} className="flex items-center gap-3 p-3 bg-nai-input border border-gray-800 rounded-lg hover:border-gray-600 transition-colors">
                  {/* 预览图 */}
                  <div className="w-12 h-12 rounded-lg overflow-hidden bg-gray-800 shrink-0 flex items-center justify-center">
                    {artist.preview_url ? (
                      <img src={`${getBackendUrl()}${artist.preview_url}`} alt={artist.name} className="w-full h-full object-cover"
                        onError={e => { e.currentTarget.style.display = 'none'; }} />
                    ) : (
                      <Palette className="w-5 h-5 text-gray-500" />
                    )}
                  </div>
                  {/* 信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm text-white truncate">{artist.name}</div>
                    <div className="text-xs text-gray-500 truncate mt-0.5">{artist.artist_string}</div>
                  </div>
                  {/* 操作 */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => { onEdit?.(artist); onClose(); }}
                      className="p-2 text-gray-400 hover:text-nai-accent rounded hover:bg-white/10 transition-colors"
                      title="编辑"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    {onUnpublish && (
                      <button
                        onClick={() => handleUnpublish(artist)}
                        disabled={unpublishingId === artist.id || deletingId === artist.id}
                        className="p-2 text-gray-400 hover:text-amber-400 rounded hover:bg-amber-500/10 transition-colors disabled:opacity-50"
                        title="撤回发布 (本地副本保留)"
                      >
                        {unpublishingId === artist.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Undo2 className="w-4 h-4" />}
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(artist)}
                      disabled={deletingId === artist.id || unpublishingId === artist.id}
                      className="p-2 text-gray-400 hover:text-red-400 rounded hover:bg-red-500/10 transition-colors disabled:opacity-50"
                      title="彻底删除 (公共+本地)"
                    >
                      {deletingId === artist.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
      </div>
    </div>
  );
};
