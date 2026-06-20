// 标签池设置弹窗 - 复刻旧 ArtistManagerModal 的"标签管理"面板,通用化
// 适用于 character + artist-style (任何有 tagPool 的 subtype)
//
// 功能:
//   - 顶部"新建标签" 虚线按钮 → 展开为创建表单 (Enter / Esc 快捷键)
//   - 列表: 每个标签 hover 显示删除按钮 (带使用计数提示)
//   - "收藏" 是受保护标签 (来自系统,不可删) - 通过 protectedTags prop 配置
import React, { useState } from 'react';
import { Check, Plus, Settings, Tag, Trash2, X } from 'lucide-react';
import { useConfirm } from './useConfirm';

interface Props {
  isOpen: boolean;
  title?: string;
  tagPool: string[];
  protectedTags?: string[];                       // 不允许删除的标签 (例如 "收藏")
  countUsage?: (tag: string) => number;            // 删除前统计该标签的使用数,用于 confirm 文案
  onClose: () => void;
  onSavePool: (pool: string[]) => void | Promise<void>;
}

export const TagPoolSettingsModal: React.FC<Props> = ({
  isOpen, title = '标签管理', tagPool,
  protectedTags = [], countUsage,
  onClose, onSavePool,
}) => {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const { confirm, confirmDialog } = useConfirm();

  React.useEffect(() => {
    if (!isOpen) {
      setCreating(false);
      setNewName('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const trimmed = newName.trim();
  const dup = trimmed.length > 0 && tagPool.includes(trimmed);
  const canCreate = trimmed.length > 0 && !dup;

  const handleCreate = async () => {
    if (!canCreate) return;
    const merged = [...tagPool, trimmed].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    await onSavePool(merged);
    setNewName('');
    setCreating(false);
  };

  const handleDelete = async (tag: string) => {
    const usage = countUsage ? countUsage(tag) : 0;
    const message = usage > 0
      ? `确定删除标签 "${tag}"?\n\n该标签下的 ${usage} 个项目不会被删除,会回到"全部"中。`
      : `确定删除未使用的标签 "${tag}"?`;
    const ok = await confirm({
      title: '删除标签',
      message,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    const pool = tagPool.filter(t => t !== tag);
    await onSavePool(pool);
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/55 backdrop-blur-md animate-in fade-in duration-150"
      onClick={() => { onClose(); }}
    >
      <div
        className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[480px] max-h-[80vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50 shrink-0">
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-nai-accent" />
            <span className="font-bold text-white text-base">{title}</span>
            <span className="text-xs text-gray-500">{tagPool.length} 个</span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 pt-4 pb-2 shrink-0">
          {!creating ? (
            <button
              onClick={() => { setCreating(true); setNewName(''); }}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border-2 border-dashed border-gray-700 hover:border-nai-accent/60 text-gray-400 hover:text-nai-accent hover:bg-nai-accent/5 text-sm font-bold transition-colors cursor-pointer"
            >
              <Plus className="w-4 h-4" /> 新建标签
            </button>
          ) : (
            <div className="rounded-lg border border-nai-accent/40 bg-nai-dark/60 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Tag className="w-4 h-4 text-nai-accent shrink-0" />
                <input
                  type="text"
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canCreate) handleCreate();
                    if (e.key === 'Escape') { setCreating(false); setNewName(''); }
                  }}
                  placeholder="输入新标签名"
                  className="flex-1 bg-nai-dark text-white text-sm rounded-md px-3 py-2 border border-gray-700 focus:border-nai-accent focus:outline-none"
                />
              </div>
              {dup && <p className="text-[11px] text-red-400 pl-6">标签 "{trimmed}" 已存在</p>}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  onClick={() => { setCreating(false); setNewName(''); }}
                  className="px-3 py-1.5 text-xs font-bold text-gray-400 hover:text-white hover:bg-white/5 rounded-md transition-colors cursor-pointer"
                >
                  取消
                </button>
                <button
                  onClick={handleCreate}
                  disabled={!canCreate}
                  className="px-3 py-1.5 bg-nai-accent hover:bg-nai-accent-hover text-[#1a1410] text-xs font-bold rounded-md disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1 transition-colors cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" /> 创建
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-4 pt-2 custom-scrollbar">
          {tagPool.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500">
              <Tag className="w-10 h-10 mb-3 opacity-30" />
              <p className="text-sm">还没有标签</p>
              <p className="text-xs mt-1 text-gray-600">点击上方按钮创建第一个</p>
            </div>
          ) : tagPool.map(tag => {
            const isProtected = protectedTags.includes(tag);
            const usage = countUsage ? countUsage(tag) : null;
            return (
              <div
                key={tag}
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-md hover:bg-nai-dark/40 transition-colors"
              >
                <Tag className="w-4 h-4 text-gray-500 shrink-0" />
                <span className="flex-1 text-sm text-gray-200 truncate">{tag}</span>
                {usage !== null && (
                  <span
                    title={`${usage} 个项目使用此标签`}
                    className={`text-[11px] tabular-nums px-1.5 py-0.5 rounded ${
                      usage > 0
                        ? 'text-nai-accent/90 bg-nai-accent/10'
                        : 'text-gray-500 bg-gray-700/40'
                    }`}
                  >
                    {usage}
                  </span>
                )}
                {isProtected ? (
                  <span className="text-[10px] text-gray-500 px-1.5 py-0.5 rounded bg-gray-700/50">系统</span>
                ) : (
                  <button
                    onClick={() => handleDelete(tag)}
                    title={`删除 "${tag}"`}
                    className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-400/10 rounded transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {confirmDialog}
    </div>
  );
};
