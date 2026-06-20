// CharacterPanel - 参照设计稿重写
//   工具栏: Search + ScopeSegmented [我的 / 公共] + 随机 + 新建
//   RecentStrip (来自 oc_usage_order localStorage, 通用)
//   ChipRow (全部 / ⭐收藏 / [未来]#tag)
//   HorizontalCard 2 列 grid (统一卡片, 不再用 OCCard 竖图)
import React, { useEffect, useMemo, useState } from 'react';
import { Globe, Heart, Plus, Settings, Shuffle, User, UserCircle2 } from 'lucide-react';
import type { UseOCManagerReturn, OCFile } from '../../oc/types';
import type { SubtypeDef, TagFile } from '../types';
import { fromOC } from '../adapters';
import { getLucideIcon } from '../registry';
import { getPublicLibraryOwnerId, updatePublicOC } from '../../../services/publicLibrary';
import { getInspirationFavorites } from '../../../services/localLibrary';
import { PublicOCManagerModal } from '../../oc/PublicOCManagerModal';
import { PortraitCard } from '../cards/PortraitCard';
import { RecentStrip } from '../parts/RecentStrip';
import { ScopeSegmented, type Scope } from '../parts/ScopeSegmented';
import { ChipRow } from '../parts/ChipRow';
import {
  loadCharacterTagPool, saveCharacterTagPool,
  loadCharacterTagOverrides, removeTagFromAllOCs, countCharacterTagUsage,
  setCharacterTags,
} from '../parts/characterTagsStore';
import { TagPoolSettingsModal } from '../parts/TagPoolSettingsModal';
import { CreateTagModal, type CreateTagPayload, type EditingTarget } from '../parts/CreateTagModal';
import { PublishGuidelinesDialog } from '../parts/PublishGuidelinesDialog';
import { useConfirm } from '../parts/useConfirm';

const OC_USAGE_ORDER_KEY = 'usage_order:character';
const GROUPS_PER_PAGE = 3; // 每次加载 3 组 (复刻 OCGalleryTab)

interface Props {
  subtype: SubtypeDef;
  ocManager: UseOCManagerReturn;
  selectedIds: Set<string>;
  onToggleSelection: (id: string) => void;
  onOpenInspiration?: () => void;
  showToast?: (message: string, type: 'success' | 'error') => void;
  currentMainPrompt?: string;
  currentMainNegative?: string;
  currentCharacterPrompts?: Array<{
    positive: string;
    negative?: string;
    enabled: boolean;
    name?: string;
  }>;
  imageHistory?: Array<{
    id: string;
    imageUrl: string;
    width: number;
    height: number;
    timestamp: number;
  }>;
}

export const CharacterPanel: React.FC<Props> = ({
  subtype, ocManager: m, selectedIds, onToggleSelection, showToast,
  currentMainPrompt, currentMainNegative, currentCharacterPrompts, imageHistory,
}) => {
  const currentUserId = getPublicLibraryOwnerId();
  const Icon = getLucideIcon(subtype.iconName);

  const [favoriteOCIds, setFavoriteOCIds] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('mine');
  const [favOnly, setFavOnly] = useState(false);
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [ocTagPool, setOcTagPool] = useState<string[]>(() => loadCharacterTagPool());
  const [ocTagsMap, setOcTagsMap] = useState<Record<string, string[]>>(() => loadCharacterTagOverrides());
  const [tagSettingsOpen, setTagSettingsOpen] = useState(false);
  const [publicManagerOpen, setPublicManagerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingTarget, setEditingTarget] = useState<EditingTarget | null>(null);
  // 公共发布规范弹窗 - Promise resolver 模式 (异步等待用户确认)
  const [pubDialog, setPubDialog] = useState<{ itemName: string; resolve: (ok: boolean) => void } | null>(null);
  const askPublishConfirm = (itemName: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => setPubDialog({ itemName, resolve }));
  const { confirm, confirmDialog } = useConfirm();
  const [displayedGroupCount, setDisplayedGroupCount] = useState(GROUPS_PER_PAGE);

  useEffect(() => {
    setFavoriteOCIds(getInspirationFavorites().ocIds || []);
    m.refreshPublicOCs();
    try {
      const raw = localStorage.getItem(OC_USAGE_ORDER_KEY);
      if (raw) setRecentIds(JSON.parse(raw));
    } catch { /* ignore */ }
    // 监听其它代码 (例如批量加标签弹窗) 写入 storage 后的更新
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'tag_pool:character') setOcTagPool(loadCharacterTagPool());
      if (e.key === 'oc_tag_overrides:v1') setOcTagsMap(loadCharacterTagOverrides());
    };
    window.addEventListener('storage', onStorage);
    // 本窗口内也需要重新同步 - 使用自定义事件
    const onLocalRefresh = () => {
      setOcTagPool(loadCharacterTagPool());
      setOcTagsMap(loadCharacterTagOverrides());
    };
    window.addEventListener('character-tags-changed', onLocalRefresh);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('character-tags-changed', onLocalRefresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 数据源
  const myOCs = useMemo<OCFile[]>(() => {
    if (!currentUserId) return [];
    return m.ocPublicFiles.filter(oc => oc.created_by === currentUserId);
  }, [m.ocPublicFiles, currentUserId]);
  const favSet = useMemo(() => new Set(favoriteOCIds), [favoriteOCIds]);
  const mineAll = useMemo<OCFile[]>(() => {
    // 我的 = 本地副本 (含点 ❤️ 保存的公共) + 我创建的公共 + 我灵感收藏的公共,按 name 去重
    // 顺序决定优先级:后加入的覆盖,公共数据更完整,优先于本地简化副本
    const map = new Map<string, OCFile>();
    for (const f of m.ocLocalFiles) map.set(f.name, f);
    for (const f of myOCs) map.set(f.name, f);
    for (const f of m.ocPublicFiles.filter(oc => favSet.has(oc.id))) map.set(f.name, f);
    return Array.from(map.values());
  }, [m.ocLocalFiles, myOCs, m.ocPublicFiles, favSet]);
  const pubAll = m.ocPublicFiles;

  // OC 标签池 - 走 localStorage 旁路 (loadCharacterTagPool / overrides)
  const tagPool = ocTagPool;

  // "已收藏" = 本地有对应副本(按 name 匹配) - 跟 PortraitCard ❤️ 状态判断一致
  const localNames = useMemo(() => new Set(m.ocLocalFiles.map(f => f.name)), [m.ocLocalFiles]);

  const applyFilters = (arr: OCFile[], applyFavOnly: boolean): OCFile[] => {
    let out = arr;
    if (applyFavOnly) out = out.filter(f => localNames.has(f.name));
    const q = query.trim().toLowerCase();
    if (q) {
      out = out.filter(f =>
        f.name.toLowerCase().includes(q) ||
        f.positive.toLowerCase().includes(q) ||
        f.aliases?.some(a => a.toLowerCase().includes(q)) ||
        (ocTagsMap[f.id] || []).some(t => t.toLowerCase().includes(q))
      );
    }
    if (activeTags.size > 0) {
      out = out.filter(f => {
        const tags = ocTagsMap[f.id] || [];
        return tags.some(t => activeTags.has(t));
      });
    }
    return out;
  };

  const visible = scope === 'mine' ? applyFilters(mineAll, favOnly) : applyFilters(pubAll, false);
  const mineCount = applyFilters(mineAll, false).length;
  const pubCount = applyFilters(pubAll, false).length;
  const favCount = mineAll.filter(o => localNames.has(o.name)).length;

  // 分组规则:
  //   - 「我的」视图: 自己上传的 (created_by===me) + 本地保存的 (ocLocalFiles 中有对应条目)
  //     一起归到「我的角色」组,置顶;剩下的 (灵感收藏来的别人的) 仍按作者分组
  //   - 「公共」视图: 按作者分组,无「我的角色」组
  const allGroups = useMemo(() => {
    const groups: Record<string, OCFile[]> = {};
    const mine: OCFile[] = [];
    const unclaimed: OCFile[] = [];

    // 「我的」判定:
    //   1. 自己上传的公共 (created_by===me) → 我的
    //   2. origin='favorited' (点 ❤️ 卡片保存到本地的别人的副本) → 别人的,按 created_by 归原作者
    //   3. origin='created' 或 'local' → 我的 (自己上传同步的 / 纯本地 / fork detached)
    //   4. origin/publicId 都无 (老数据兜底): 公共库有同名 → 收藏的别人的;无同名 → 纯本地我的
    const isMyFile = (oc: OCFile): boolean => {
      if (scope !== 'mine') return false;
      if (!!currentUserId && oc.created_by === currentUserId) return true;
      if (oc.origin === 'favorited') return false;
      if (oc.origin === 'created' || oc.origin === 'local') return true;
      // 老数据 (origin/publicId 都未标记) 兜底
      if (!oc.publicId) {
        const hasPublicSameName = m.ocPublicFiles.some(p => p.name === oc.name);
        return !hasPublicSameName;
      }
      return false;
    };

    for (const oc of visible) {
      if (isMyFile(oc)) {
        mine.push(oc);
      } else if (oc.created_by) {
        if (!groups[oc.created_by]) groups[oc.created_by] = [];
        groups[oc.created_by].push(oc);
      } else {
        unclaimed.push(oc);
      }
    }

    const result: { key: string; label: string; files: OCFile[] }[] = [];
    if (mine.length > 0) {
      result.push({ key: '__mine__', label: '我的角色', files: mine });
    }
    const otherGroups = Object.keys(groups)
      .map(creator => ({ key: creator, label: creator, files: groups[creator] }))
      .sort((a, b) => b.files.length - a.files.length);
    result.push(...otherGroups);
    if (unclaimed.length > 0) {
      result.push({ key: '__unclaimed__', label: '未认领角色', files: unclaimed });
    }
    return result;
  }, [visible, scope, currentUserId, m.ocLocalFiles]);

  const displayedGroups = useMemo(
    () => allGroups.slice(0, displayedGroupCount),
    [allGroups, displayedGroupCount]
  );

  // scope / search / fav 等变化时重置分页
  useEffect(() => {
    setDisplayedGroupCount(GROUPS_PER_PAGE);
  }, [scope, query, favOnly, activeTags]);

  const handleRandom = () => {
    if (selectedIds.size >= subtype.maxSelectable) return;
    const pool = (scope === 'mine' ? myOCs : pubAll).filter(f => !selectedIds.has(f.id));
    if (pool.length === 0) return;
    onToggleSelection(pool[Math.floor(Math.random() * pool.length)].id);
  };

  const handleClearRecent = () => {
    setRecentIds([]);
    localStorage.removeItem(OC_USAGE_ORDER_KEY);
  };

  // 转 TagFile 给 HorizontalCard 用 - 注入 localStorage 旁路的用户标签
  const toTag = (f: OCFile): TagFile => ({
    ...fromOC(f, false),
    tags: ocTagsMap[f.id] || [],
  });

  // 渲染一张角色竖卡 (helper, 避免分组渲染时重复代码)
  const renderPortraitCard = (file: OCFile) => (
    <PortraitCard
      key={file.id}
      item={toTag(file)}
      isSelected={selectedIds.has(file.id)}
      onToggle={onToggleSelection}
      isPublic={scope === 'pub'}
      isSavedToLocal={m.ocLocalFiles.some(f => f.id === file.id || f.name === file.name)}
      onCopy={() => {
        m.setCopiedOCId(file.id);
        setTimeout(() => m.setCopiedOCId(null), 1200);
      }}
      onEdit={() => {
        const isCreated = !!currentUserId && file.created_by === currentUserId;
        // 精确链接:优先 publicId,fallback 到 id/name (兼容老数据)
        const localOC = m.ocLocalFiles.find(
          f => (file.publicId && f.publicId === file.publicId)
            || f.publicId === file.id
            || f.id === file.id
            || f.name === file.name
        );
        const publicMatch = m.ocPublicFiles.find(p => p.id === file.id || p.id === file.publicId || p.id === localOC?.publicId || p.name === file.name);
        // 'favorited' = 来自公共且不是我创建的 (用 publicMatch 判定,比 isFromPublic 严格)
        const origin = isCreated ? 'created' : (publicMatch ? 'favorited' : 'local');
        const ocIdForTags = localOC?.id || file.id;
        const sourcePublicId = origin === 'favorited' ? (publicMatch?.id || localOC?.publicId || file.publicId || file.id) : undefined;
        // 本地副本可能因历史原因没存 aliases / negative,回退到公共数据
        const effectiveAliases = (file.aliases && file.aliases.length > 0)
          ? file.aliases
          : (publicMatch?.aliases || []);
        const effectiveNegative = file.negative || publicMatch?.negative || undefined;
        setEditingTarget({
          id: localOC?.id || file.id,
          origin,
          sourcePublicId,
          initialPayload: {
            name: file.name,
            positive: file.positive,
            negative: effectiveNegative,
            aliases: effectiveAliases,
            previews: file.preview ? [file.preview] : [],
            tags: ocTagsMap[ocIdForTags] || [],
          },
        });
        setCreateOpen(true);
      }}
      onSaveToLocal={async () => {
        try {
          const already = m.ocLocalFiles.some(f => f.id === file.id || f.name === file.name);
          await m.handleSaveOCToLocal(file, { stopPropagation: () => {} } as React.MouseEvent);
          showToast?.(already ? '已经收藏过了' : `已收藏「${file.name}」`, 'success');
        } catch (err) {
          console.error('[CharacterPanel] saveToLocal failed', err);
          showToast?.('收藏失败', 'error');
        }
      }}
      onDelete={async (id) => {
        const isCreated = !!currentUserId && file.created_by === currentUserId;
        if (isCreated) {
          const ok = await confirm({
            title: '彻底删除角色',
            message: `将彻底删除「${file.name}」(公共 + 本地副本)。\n\n此操作不可恢复,确定继续吗?`,
            confirmLabel: '彻底删除',
            danger: true,
          });
          if (!ok) return;
          const r = await m.deletePublicOCTotally(file.id);
          if (r.success) showToast?.('已彻底删除', 'success');
          else showToast?.(`删除失败: ${r.message || '未知'}`, 'error');
          return;
        }
        // 非 created (纯本地 / favorited 副本) 直接删本地
        const localOC = m.ocLocalFiles.find(f => f.id === id || f.name === file.name);
        const targetId = localOC?.id || id;
        const ok = await confirm({
          title: '删除角色',
          message: `确定删除「${file.name}」?数据无法恢复`,
          confirmLabel: '删除',
          danger: true,
        });
        if (!ok) return;
        try {
          await m.handleDeleteOC(targetId, { stopPropagation: () => {} } as React.MouseEvent);
          showToast?.('已删除', 'success');
        } catch {
          showToast?.('删除失败', 'error');
        }
      }}
    />
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/[0.06] bg-nai-dark/30 shrink-0">
        <SearchInput value={query} onChange={setQuery} placeholder="搜索角色名 / 别名 / 提示词…" />
        <ScopeSegmented
          scope={scope}
          onChange={setScope}
          mineCount={mineCount}
          pubCount={pubCount}
        />
        <SoftButton onClick={handleRandom} disabled={selectedIds.size >= subtype.maxSelectable}>
          <Shuffle className="w-3.5 h-3.5" />
          随机
        </SoftButton>
        <PrimaryButton onClick={() => setCreateOpen(true)}>
          <Plus className="w-3.5 h-3.5" />
          新建
        </PrimaryButton>
      </div>

      {/* Content */}
      <div
        className="flex-1 min-h-0 overflow-y-auto p-3 custom-scrollbar flex flex-col"
        onScroll={(e) => {
          const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
          if (scrollHeight - scrollTop - clientHeight < 200 && displayedGroupCount < allGroups.length) {
            setDisplayedGroupCount(prev => Math.min(prev + GROUPS_PER_PAGE, allGroups.length));
          }
        }}
      >
        <RecentStrip
          ids={recentIds}
          pools={[mineAll.map(toTag), pubAll.map(toTag)]}
          selectedSet={selectedIds}
          onToggle={onToggleSelection}
          onClear={recentIds.length > 0 ? handleClearRecent : undefined}
        />

        {scope === 'mine' && (
          <ChipRow
            allActive={activeTags.size === 0 && !favOnly}
            onAllClick={() => { setActiveTags(new Set()); setFavOnly(false); }}
            showFavChip
            favOn={favOnly}
            onFavToggle={() => setFavOnly(v => !v)}
            tagPool={tagPool}
            activeTags={activeTags}
            onTagToggle={(t) => {
              setActiveTags(prev => {
                const n = new Set(prev);
                if (n.has(t)) n.delete(t);
                else n.add(t);
                return n;
              });
            }}
            onSettingsClick={() => setTagSettingsOpen(true)}
          />
        )}

        {visible.length === 0 ? (
          <EmptyState
            iconBg="bg-nai-accent/10"
            iconColor="text-nai-accent"
            icon={Icon ? <Icon className="w-6 h-6" strokeWidth={1.4} /> : <User className="w-6 h-6" />}
            title={
              scope === 'mine'
                ? (favOnly ? '没有匹配的收藏' : currentUserId ? '您还没有创建任何 OC' : '请先登录以查看 OC')
                : '没有匹配的公共角色'
            }
            sub={
              scope === 'mine'
                ? (favOnly ? '取消「收藏」筛选查看全部本地角色' : '点击右上角「新建」开始创建')
                : '试试清空搜索或筛选'
            }
          />
        ) : (
          <>
            {/* 公共库 section header + 管理上传按钮 */}
            {scope === 'pub' && (
              <div className="flex items-center gap-2.5 mb-3 pl-0.5">
                <Globe className="w-5 h-5 text-nai-text-dim shrink-0" />
                <span className="text-[15px] font-bold text-white truncate">公共角色</span>
                <span className="text-[13px] font-bold text-nai-text-dim tabular-nums shrink-0">{visible.length}</span>
                <span className="flex-1 h-px bg-white/[0.06] mx-1" />
                <button
                  onClick={() => setPublicManagerOpen(true)}
                  disabled={!currentUserId}
                  title="管理我上传到公共库的角色"
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 h-8 rounded-md border border-gray-700 bg-gray-800/60 text-[12.5px] font-bold text-gray-300 hover:text-nai-accent hover:border-nai-accent/50 hover:bg-nai-accent/[0.05] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-gray-800/60 disabled:hover:text-gray-300 disabled:hover:border-gray-700"
                >
                  <Settings className="w-3.5 h-3.5" />
                  管理上传
                  {currentUserId && (
                    <span className="text-nai-accent ml-0.5 tabular-nums">
                      ({m.ocPublicFiles.filter(f => f.created_by === currentUserId).length})
                    </span>
                  )}
                </button>
              </div>
            )}

            {/* 按作者分组 + 每组独立卡片 + 内部 grid + 分页加载 (复刻 OCGalleryTab) */}
            <div className="flex flex-col gap-3">
              {displayedGroups.map(group => (
                <AuthorGroupCard
                  key={group.key}
                  label={group.label}
                  files={group.files}
                  variant={group.key === '__mine__' ? 'mine' : group.key === '__unclaimed__' ? 'unclaimed' : 'author'}
                  renderCard={renderPortraitCard}
                />
              ))}
              {displayedGroupCount < allGroups.length && (
                <div className="flex justify-center py-2 text-[12px] text-nai-text-dim">
                  显示 {displayedGroupCount} / {allGroups.length} 组,下滑加载更多
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* 管理我上传到公共库的角色 */}
      <PublicOCManagerModal
        isOpen={publicManagerOpen}
        onClose={() => { setPublicManagerOpen(false); m.refreshPublicOCs(); }}
        showToast={showToast ?? (() => {})}
        onEdit={(publicOC) => {
          // 走 tag-manager 内置 CreateTagModal — 跟卡片菜单「编辑」入口一致
          const displayName = publicOC.zh_name || publicOC.en_name;
          const isCreated = !!currentUserId && publicOC.created_by === currentUserId;
          const origin = isCreated ? 'created' : 'favorited'; // 该 modal 只列「我上传的」,正常都是 created;非 created 走 fork 流程
          const localOC = m.ocLocalFiles.find(f => (f.publicId && f.publicId === publicOC.id) || f.id === publicOC.id || f.name === displayName);
          const ocIdForTags = localOC?.id || publicOC.id;
          const sourcePublicId = origin === 'favorited' ? publicOC.id : undefined;
          setEditingTarget({
            id: localOC?.id || publicOC.id,
            origin,
            sourcePublicId,
            initialPayload: {
              name: displayName,
              positive: publicOC.tag_group,
              negative: publicOC.negative_prompt || undefined,
              aliases: publicOC.zh_aliases,
              previews: publicOC.preview_url ? [publicOC.preview_url] : [],
              tags: ocTagsMap[ocIdForTags] || [],
            },
          });
          setCreateOpen(true);
          setPublicManagerOpen(false);
        }}
        onAfterDelete={async (publicOC) => {
          // 仅清"我发布时自动落的 created 本地副本"(id === public id 且未被改为其它 origin)
          // fork 出来的独立副本 (origin='local' 或 'favorited') 不动 - 主从独立
          const toDelete = m.ocLocalFiles.filter(f =>
            f.id === publicOC.id && (f.origin === 'created' || f.origin === undefined),
          );
          for (const local of toDelete) {
            try { await m.deleteOCLocalCopy(local.id); } catch (e) { console.error('删本地副本失败:', e); }
          }
        }}
        onUnpublish={async (publicOC) => m.unpublishOC(publicOC.id)}
      />

      {/* 标签池设置 */}
      <TagPoolSettingsModal
        isOpen={tagSettingsOpen}
        title="角色标签管理"
        tagPool={ocTagPool}
        countUsage={(t) => countCharacterTagUsage(t, ocTagsMap)}
        onClose={() => setTagSettingsOpen(false)}
        onSavePool={(pool) => {
          // 检测被删除的标签 → 同步从所有 OC overrides 移除
          const removed = ocTagPool.filter(t => !pool.includes(t));
          let nextMap = ocTagsMap;
          for (const tag of removed) {
            nextMap = removeTagFromAllOCs(tag);
          }
          saveCharacterTagPool(pool);
          setOcTagPool(pool);
          if (removed.length > 0) setOcTagsMap(nextMap);
          // 清掉已激活但被删除的筛选
          if (removed.length > 0) {
            setActiveTags(prev => {
              const n = new Set(prev);
              for (const t of removed) n.delete(t);
              return n;
            });
          }
          window.dispatchEvent(new Event('character-tags-changed'));
        }}
      />

      {/* 新建/编辑角色 - 统一面板 */}
      <CreateTagModal
        isOpen={createOpen}
        subtype={subtype}
        editing={editingTarget || undefined}
        onClose={() => { setCreateOpen(false); setEditingTarget(null); }}
        tagPool={ocTagPool}
        currentMainPrompt={currentMainPrompt}
        currentMainNegative={currentMainNegative}
        currentCharacterPrompts={currentCharacterPrompts}
        imageHistory={imageHistory}
        onTransferOwner={async (newOwnerId) => {
          if (!editingTarget) return { success: false, message: '未指定条目' };
          const local = m.ocLocalFiles.find(f => f.id === editingTarget.id);
          const publicName = local?.publicId || local?.name;
          if (!publicName) return { success: false, message: '未发布到公共,无法转让' };
          const result = await updatePublicOC(publicName, { created_by: newOwnerId });
          if (result.success) {
            showToast?.(`已转让「${local!.name}」给 ${newOwnerId}`, 'success');
            await m.refreshPublicOCs();
            return { success: true };
          }
          showToast?.(`转让失败: ${result.message}`, 'error');
          return { success: false, message: result.message };
        }}
        onGeneratePreview={(prompt, _index, onProgress) => m.generatePreviewBase64(prompt, onProgress)}
        onSave={async (payload: CreateTagPayload) => {
          if (editingTarget) {
            // 收藏的别人的角色: 弹 confirm 走 fork 流程,创建/更新本地副本 (不影响原作)
            if (editingTarget.origin === 'favorited' && editingTarget.sourcePublicId) {
              const ok = await confirm({
                title: '保存为本地副本',
                message: `「${payload.name}」是别人创作的角色,保存将创建一份本地副本 (不影响原作)。\n\n确定保存吗?`,
                confirmLabel: '保存副本',
              });
              if (!ok) return false; // 阻止 modal 关闭,保留用户已填字段
              const result = await m.forkOCToLocal(editingTarget.sourcePublicId, {
                name: payload.name,
                positive: payload.positive,
                negative: payload.negative,
                aliases: payload.aliases,
                previews: payload.previews,
              });
              if (result.success && result.localId) {
                const nextMap = setCharacterTags(result.localId, payload.tags || []);
                setOcTagsMap(nextMap);
                window.dispatchEvent(new Event('character-tags-changed'));
                const renamed = result.finalName && result.finalName !== payload.name;
                showToast?.(
                  renamed
                    ? `已创建本地副本「${result.finalName}」(原名重复,自动加后缀)`
                    : `已创建本地副本「${result.finalName || payload.name}」`,
                  'success',
                );
                return;
              }
              showToast?.(`保存失败: ${result.message || '未知'}`, 'error');
              return false;
            }
            // 编辑模式: local 直接更新本地 / created 同步公共+本地
            const result = await m.updateOCFromPayload(editingTarget.id, {
              name: payload.name,
              positive: payload.positive,
              negative: payload.negative,
              aliases: payload.aliases,
              previews: payload.previews,
            }, editingTarget.origin);
            // 私有 tags 同步到 characterTagsStore
            const localOC = m.ocLocalFiles.find(f => f.id === editingTarget.id || f.name === payload.name);
            const tagOwnerId = localOC?.id || editingTarget.id;
            const nextMap = setCharacterTags(tagOwnerId, payload.tags || []);
            setOcTagsMap(nextMap);
            window.dispatchEvent(new Event('character-tags-changed'));
            if (result.success) showToast?.(`已更新「${payload.name}」`, 'success');
            else showToast?.(`更新失败: ${result.message || '未知'}`, 'error');
            return;
          }
          // 创建模式
          const result = await m.saveOCFromPayload({
            name: payload.name,
            positive: payload.positive,
            negative: payload.negative,
            aliases: payload.aliases,
            previews: payload.previews,
          }, 'local');
          if (result.success) showToast?.(`已保存「${payload.name}」`, 'success');
          else showToast?.(`保存失败: ${result.message || '未知'}`, 'error');
        }}
        onUploadPublic={async (payload: CreateTagPayload) => {
          // 公共发布/同步必须有预览图 (提高公共库质量,bot 端展示也需要)
          if (!payload.previews?.[0]) {
            showToast?.('发布到公共必须有预览图,请先生成或上传一张', 'error');
            return false;
          }
          if (editingTarget && editingTarget.origin === 'created') {
            // 编辑 created: 同步公共 + 本地
            const result = await m.updateOCFromPayload(editingTarget.id, {
              name: payload.name,
              positive: payload.positive,
              negative: payload.negative,
              aliases: payload.aliases,
              previews: payload.previews,
            }, 'created');
            const localOC = m.ocLocalFiles.find(f => f.id === editingTarget.id || f.name === payload.name);
            if (localOC) {
              const nextMap = setCharacterTags(localOC.id, payload.tags || []);
              setOcTagsMap(nextMap);
              window.dispatchEvent(new Event('character-tags-changed'));
            }
            if (result.success) showToast?.(`已同步「${payload.name}」到公共库`, 'success');
            else showToast?.(`同步失败: ${result.message || '未知'}`, 'error');
            return;
          }
          // 创建 + 发布: 独立弹窗二次确认公共发布规范
          const ok = await askPublishConfirm(payload.name);
          if (!ok) return false;
          const result = await m.saveOCFromPayload({
            name: payload.name,
            positive: payload.positive,
            negative: payload.negative,
            aliases: payload.aliases,
            previews: payload.previews,
          }, 'public');
          if (!result.success) {
            showToast?.(`发布失败: ${result.message || '未知'}`, 'error');
            return;
          }
          // 若是从本地条目升级发布: 把私有 tags 迁移到新公共 id, 然后删除原本地条目, 避免出现两份
          if (editingTarget && editingTarget.origin === 'local' && result.id) {
            const oldTags = ocTagsMap[editingTarget.id] || [];
            if (oldTags.length > 0) {
              setCharacterTags(result.id, oldTags);
            }
            const cleared = setCharacterTags(editingTarget.id, []);
            setOcTagsMap(cleared);
            window.dispatchEvent(new Event('character-tags-changed'));
            try {
              await m.handleDeleteOC(editingTarget.id, { stopPropagation: () => {} } as React.MouseEvent);
            } catch (err) {
              console.error('[CharacterPanel] cleanup local after publish failed', err);
            }
            showToast?.(`已发布「${payload.name}」并合并本地条目`, 'success');
          } else {
            showToast?.(`已发布「${payload.name}」到公共库`, 'success');
          }
        }}
        onUnpublish={async () => {
          if (!editingTarget || editingTarget.origin !== 'created') return { success: false, message: '非可撤回状态' };
          const r = await m.unpublishOC(editingTarget.id);
          if (r.success) showToast?.('已撤回发布(本地副本已保留)', 'success');
          else showToast?.(`撤回失败: ${r.message || '未知'}`, 'error');
          return r;
        }}
        onSaveAsCopy={async (payload: CreateTagPayload) => {
          // 仅在 created 编辑模式下触发: 从自己发布的公共版本 fork 一份脱钩本地副本
          if (!editingTarget || editingTarget.origin !== 'created') return false;
          const ok = await confirm({
            title: '另存为本地副本',
            message: `将基于当前编辑内容创建一份本地副本 (不修改你发布的公共数据,副本与公共版独立)。\n\n确定保存吗?`,
            confirmLabel: '保存副本',
          });
          if (!ok) return false;
          // editingTarget.id 在 created 模式下 = public id (本地 created 副本 id 跟 public id 一致)
          const result = await m.forkOCToLocal(editingTarget.id, {
            name: payload.name,
            positive: payload.positive,
            negative: payload.negative,
            aliases: payload.aliases,
            previews: payload.previews,
          }, 'detached');
          if (result.success && result.localId) {
            const nextMap = setCharacterTags(result.localId, payload.tags || []);
            setOcTagsMap(nextMap);
            window.dispatchEvent(new Event('character-tags-changed'));
            const renamed = result.finalName && result.finalName !== payload.name;
            showToast?.(
              renamed
                ? `已创建本地副本「${result.finalName}」(原名重复,自动加后缀)`
                : `已创建本地副本「${result.finalName || payload.name}」`,
              'success',
            );
            return;
          }
          showToast?.(`保存失败: ${result.message || '未知'}`, 'error');
          return false;
        }}
      />

      {/* 公共发布规范二次确认 */}
      <PublishGuidelinesDialog
        isOpen={!!pubDialog}
        title="发布到公共角色库"
        subtitle="发布前请阅读以下规范"
        bullets={[
          '必须是原创角色 (OC),请勿上传二创 / 同人角色',
          '仅保留与角色外貌相关的提示词 (服装 / 发型 / 瞳色等),\n请去除场景 / 背景 / 动作等无关内容',
          '尽量避免明显 R18 / 裸露描写,保持适度',
        ]}
        itemName={pubDialog?.itemName ?? ''}
        confirmLabel="我已确认,发布"
        onConfirm={() => { pubDialog?.resolve(true); setPubDialog(null); }}
        onCancel={() => { pubDialog?.resolve(false); setPubDialog(null); }}
      />

      {confirmDialog}
    </div>
  );
};

// === 按作者分组 - 轻量 section header (无独立 bordered 容器) ===
// 用户偏好: 不要外层卡片包裹, 用标题行 + 横线 + grid 的简洁风格
const AuthorGroupCard: React.FC<{
  label: string;
  files: OCFile[];
  variant?: 'mine' | 'author' | 'unclaimed';
  renderCard: (oc: OCFile) => React.ReactNode;
}> = ({ label, files, variant = 'author', renderCard }) => {
  const previewNames = files.slice(0, 4).map(o => o.name).join('、');
  const hasMore = files.length > 4;
  const namesDisplay = hasMore ? `${previewNames} 等` : previewNames;
  const isMine = variant === 'mine';

  return (
    <div>
      <div className="flex items-center gap-2.5 mb-3 pl-0.5">
        {isMine ? (
          <Heart className="w-5 h-5 text-nai-accent shrink-0 fill-nai-accent/30" strokeWidth={1.75} />
        ) : (
          <UserCircle2 className="w-5 h-5 text-nai-text-dim shrink-0" strokeWidth={1.75} />
        )}
        {isMine ? (
          <>
            <span className="text-[15px] font-bold text-nai-accent shrink-0">{label}</span>
            <span className="text-[12.5px] text-nai-text-dim truncate" title={namesDisplay}>
              · {namesDisplay}
            </span>
          </>
        ) : (
          <span className="text-[15px] font-bold text-white truncate" title={`作者: ${label}`}>
            {namesDisplay}
          </span>
        )}
        <span className={`text-[13px] font-bold tabular-nums shrink-0 ${isMine ? 'text-nai-accent' : 'text-nai-text-dim'}`}>{files.length}</span>
        <span className="flex-1 h-px bg-white/[0.06] ml-1" />
      </div>
      <div
        className="grid gap-2.5"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}
      >
        {files.map(renderCard)}
      </div>
    </div>
  );
};

// === 共享小组件 (本文件 + ArtistPanel + CompactPanel 都用) ===

import { Search, X } from 'lucide-react';

export const SearchInput: React.FC<{
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}> = ({ value, onChange, placeholder }) => (
  <label className="relative flex items-center flex-1 min-w-0 h-9 pl-9 pr-2.5 rounded-md bg-gray-800/50 border border-gray-700 focus-within:border-nai-accent transition-colors">
    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-nai-text-dim" />
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="flex-1 min-w-0 h-full bg-transparent border-0 text-[13px] text-white placeholder:text-nai-text-dim outline-none"
    />
    {value && (
      <button
        onClick={() => onChange('')}
        className="w-5 h-5 grid place-items-center rounded-full text-nai-text-dim hover:bg-white/[0.08] hover:text-white transition-colors cursor-pointer"
      >
        <X className="w-3 h-3" />
      </button>
    )}
  </label>
);

export const SoftButton: React.FC<{
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}> = ({ onClick, disabled, title, children }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className="h-9 px-3.5 inline-flex items-center gap-1.5 rounded-md text-[13px] font-bold bg-gray-700/70 text-white hover:bg-gray-600/85 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-gray-700/70 whitespace-nowrap"
  >
    {children}
  </button>
);

export const PrimaryButton: React.FC<{
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}> = ({ onClick, disabled, title, children }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className="h-9 px-3.5 inline-flex items-center gap-1.5 rounded-md text-[13px] font-bold bg-nai-accent text-[#1a1410] shadow-[0_4px_12px_-4px_rgba(252,237,164,0.4)] hover:bg-nai-accent-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-nai-accent whitespace-nowrap"
  >
    {children}
  </button>
);

export const EmptyState: React.FC<{
  iconBg: string;
  iconColor: string;
  icon: React.ReactNode;
  title: string;
  sub: string;
}> = ({ iconBg, iconColor, icon, title, sub }) => (
  // flex-1: 父若是 flex column 则撑剩余高度居中,否则退化为自然高度不会溢出
  // 之前用 min-h-full + py-10 会让 box 高度超过父容器 80px,叠加上面的 RecentStrip/ChipRow 就出滚动条
  <div className="flex-1 min-h-[240px] flex flex-col items-center justify-center text-center px-6 py-10 max-w-[460px] mx-auto">
    <div className={`w-[60px] h-[60px] mb-3.5 rounded-2xl grid place-items-center ${iconBg} ${iconColor}`}>
      {icon}
    </div>
    <div className="text-[14px] font-bold text-white mb-1">{title}</div>
    <div className="text-[12px] text-nai-text-dim">{sub}</div>
  </div>
);
