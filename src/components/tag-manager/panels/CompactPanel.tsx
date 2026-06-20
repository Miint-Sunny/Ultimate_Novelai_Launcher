// CompactPanel - 参照设计稿小改, 工具栏样式对齐 + 空状态建议 chips
//   pose-composition / lighting-mood / scene-background / 用户自建
//   Step 4 阶段: 数据来自 custom_tag_files store, 目前空状态
//                 提供 SUGGESTIONS 让用户一键创建样例
import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Shuffle } from 'lucide-react';
import type { SubtypeDef, TagFile } from '../types';
import { getLucideIcon } from '../registry';
import { CompactCard } from '../cards/CompactCard';
import { ChipCard } from '../cards/ChipCard';
import { ChipRow } from '../parts/ChipRow';
import { CreateTagModal, type CreateTagPayload, type EditingTarget } from '../parts/CreateTagModal';
import { RecentStrip } from '../parts/RecentStrip';
import { useConfirm } from '../parts/useConfirm';
import { TagPoolSettingsModal } from '../parts/TagPoolSettingsModal';
import { loadCompactTagPool, saveCompactTagPool } from '../parts/compactTagPoolStore';
import { SearchInput, SoftButton, PrimaryButton, EmptyState } from './CharacterPanel';

interface Props {
  subtype: SubtypeDef;
  tags: TagFile[];
  selectedIds: Set<string>;
  onToggleSelection: (id: string) => void;
  currentMainPrompt?: string;
  currentMainNegative?: string;
  imageHistory?: Array<{
    id: string;
    imageUrl: string;
    width: number;
    height: number;
    timestamp: number;
  }>;
  /** 新建自定义 tag 持久化到 customStore */
  onCreateCustomTag?: (subtypeId: string, payload: { name: string; positive: string; negative?: string; preview?: string; tags?: string[] }) => Promise<void>;
  /** 更新自定义 tag(传 id 复用相同记录) */
  onUpdateCustomTag?: (id: string, payload: { name: string; positive: string; negative?: string; preview?: string; tags?: string[] }) => Promise<void>;
  /** 删除自定义 tag */
  onDeleteCustomTag?: (id: string) => Promise<void>;
  showToast?: (message: string, type: 'success' | 'error') => void;
}

export const CompactPanel: React.FC<Props> = ({
  subtype, tags, selectedIds, onToggleSelection, currentMainPrompt, currentMainNegative, imageHistory,
  onCreateCustomTag, onUpdateCustomTag, onDeleteCustomTag, showToast,
}) => {
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editingTarget, setEditingTarget] = useState<EditingTarget | null>(null);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [persistedPool, setPersistedPool] = useState<string[]>(() => loadCompactTagPool(subtype.id));
  const [tagSettingsOpen, setTagSettingsOpen] = useState(false);
  const Icon = getLucideIcon(subtype.iconName);
  const { confirm, confirmDialog } = useConfirm();

  // 切换 subtype 时重新加载对应的池
  useEffect(() => {
    setPersistedPool(loadCompactTagPool(subtype.id));
    setActiveTags(new Set());
  }, [subtype.id]);

  const askDelete = async (id: string, name: string) => {
    if (!onDeleteCustomTag) return;
    const ok = await confirm({
      title: `删除${subtype.label}`,
      message: `确定删除「${name}」?数据无法恢复`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    onDeleteCustomTag(id)
      .then(() => showToast?.('已删除', 'success'))
      .catch(() => showToast?.('删除失败', 'error'));
  };

  // 标签池: 持久化 (persistedPool) ∪ items 自身 tags 聚合
  const tagPool = useMemo(() => {
    const s = new Set<string>();
    for (const x of persistedPool) if (x) s.add(x);
    for (const t of tags) {
      for (const x of t.tags || []) if (x) s.add(x);
    }
    return Array.from(s).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [tags, persistedPool]);

  // 统计某个标签当前在多少 items 上 (供删除前 confirm 文案)
  const countUsage = (tag: string) => tags.filter(t => t.tags?.includes(tag)).length;

  // 保存新池: 删除被移除的标签时,同步从所有 items 移除该标签
  const handleSavePool = async (newPool: string[]) => {
    const newSet = new Set(newPool);
    const removed = tagPool.filter(t => !newSet.has(t));
    if (removed.length > 0 && onUpdateCustomTag) {
      for (const item of tags) {
        if (!item.tags?.some(t => removed.includes(t))) continue;
        const nextTags = (item.tags || []).filter(t => !removed.includes(t));
        await onUpdateCustomTag(item.id, {
          name: item.name,
          positive: item.positive,
          negative: item.negative,
          preview: item.preview,
          tags: nextTags,
        });
      }
    }
    // activeTags 中被删的也清掉
    if (removed.length > 0) {
      setActiveTags(prev => {
        const n = new Set(prev);
        for (const t of removed) n.delete(t);
        return n;
      });
    }
    saveCompactTagPool(subtype.id, newPool);
    setPersistedPool(newPool);
  };

  const openEditTag = (tag: TagFile) => {
    setEditingTarget({
      id: tag.id,
      origin: 'local',  // 自定义 tag 永远是 local
      initialPayload: {
        name: tag.name,
        positive: tag.positive,
        negative: tag.negative,
        previews: tag.preview ? [tag.preview] : [],
        tags: tag.tags || [],
      },
    });
    setCreateOpen(true);
  };

  const usageKey = `usage_order:${subtype.id}`;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(usageKey);
      if (raw) setRecentIds(JSON.parse(raw));
      else setRecentIds([]);
    } catch {
      setRecentIds([]);
    }
  }, [usageKey]);

  const handleClearRecent = () => {
    setRecentIds([]);
    try { localStorage.removeItem(usageKey); } catch { /* ignore */ }
  };

  const filtered = tags.filter(t => {
    if (activeTags.size > 0) {
      if (!t.tags?.some(tag => activeTags.has(tag))) return false;
    }
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      t.name.toLowerCase().includes(q) ||
      t.positive.toLowerCase().includes(q) ||
      t.tags?.some(tag => tag.toLowerCase().includes(q))
    );
  });

  const handleRandom = () => {
    if (selectedIds.size >= subtype.maxSelectable) return;
    const pool = filtered.filter(t => !selectedIds.has(t.id));
    if (pool.length === 0) return;
    onToggleSelection(pool[Math.floor(Math.random() * pool.length)].id);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/[0.06] bg-nai-dark/30 shrink-0">
        <SearchInput value={query} onChange={setQuery} placeholder={`搜索${subtype.label}…`} />
        <SoftButton onClick={handleRandom} disabled={filtered.length === 0 || selectedIds.size >= subtype.maxSelectable}>
          <Shuffle className="w-3.5 h-3.5" />
          随机
        </SoftButton>
        <PrimaryButton onClick={() => setCreateOpen(true)} title={`新建${subtype.label}`}>
          <Plus className="w-3.5 h-3.5" />
          新建
        </PrimaryButton>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 custom-scrollbar flex flex-col">
        <RecentStrip
          ids={recentIds}
          pools={[tags]}
          selectedSet={selectedIds}
          onToggle={onToggleSelection}
          onClear={recentIds.length > 0 ? handleClearRecent : undefined}
        />

        {/* 标签分类筛选: 即使无标签也保留 全部 chip + 设置入口 */}
        <ChipRow
          allActive={activeTags.size === 0}
          onAllClick={() => setActiveTags(new Set())}
          tagPool={tagPool}
          activeTags={activeTags}
          onTagToggle={(t) => setActiveTags(prev => {
            const n = new Set(prev);
            if (n.has(t)) n.delete(t); else n.add(t);
            return n;
          })}
          onSettingsClick={() => setTagSettingsOpen(true)}
        />

        {filtered.length === 0 ? (
          <EmptyState
            iconBg="bg-nai-accent/10"
            iconColor="text-nai-accent"
            icon={Icon ? <Icon className="w-6 h-6" strokeWidth={1.4} /> : null}
            title={`还没有${subtype.label}`}
            sub="点击右上「新建」开始添加"
          />
        ) : subtype.cardLayout === 'chip' ? (
          <div className="flex flex-wrap gap-2">
            {filtered.map(tag => (
              <ChipCard
                key={tag.id}
                tag={tag}
                isSelected={selectedIds.has(tag.id)}
                onToggleSelection={onToggleSelection}
                onEdit={() => openEditTag(tag)}
                onDelete={onDeleteCustomTag ? (id) => { askDelete(id, tag.name); } : undefined}
              />
            ))}
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
            {filtered.map(tag => (
              <CompactCard
                key={tag.id}
                tag={tag}
                subtype={subtype}
                isSelected={selectedIds.has(tag.id)}
                onToggleSelection={onToggleSelection}
                onEdit={() => openEditTag(tag)}
                onDelete={onDeleteCustomTag ? (id) => { askDelete(id, tag.name); } : undefined}
              />
            ))}
          </div>
        )}
      </div>

      <CreateTagModal
        isOpen={createOpen}
        subtype={subtype}
        editing={editingTarget || undefined}
        onClose={() => { setCreateOpen(false); setEditingTarget(null); }}
        currentMainPrompt={currentMainPrompt}
        currentMainNegative={currentMainNegative}
        imageHistory={imageHistory}
        onSave={async (payload: CreateTagPayload) => {
          try {
            if (editingTarget) {
              if (!onUpdateCustomTag) { showToast?.('更新失败:未配置', 'error'); return; }
              await onUpdateCustomTag(editingTarget.id, {
                name: payload.name,
                positive: payload.positive,
                negative: payload.negative,
                preview: payload.previews[0],
                tags: payload.tags,
              });
              showToast?.(`已更新「${payload.name}」`, 'success');
              return;
            }
            if (!onCreateCustomTag) { showToast?.('保存失败:未配置', 'error'); return; }
            await onCreateCustomTag(subtype.id, {
              name: payload.name,
              positive: payload.positive,
              negative: payload.negative,
              preview: payload.previews[0],
              tags: payload.tags,
            });
            showToast?.(`已创建「${payload.name}」`, 'success');
          } catch (err) {
            console.error('[CompactPanel] save failed', err);
            showToast?.('保存失败', 'error');
          }
        }}
      />

      <TagPoolSettingsModal
        isOpen={tagSettingsOpen}
        title={`${subtype.label}标签管理`}
        tagPool={tagPool}
        countUsage={countUsage}
        onClose={() => setTagSettingsOpen(false)}
        onSavePool={handleSavePool}
      />

      {confirmDialog}
    </div>
  );
};
