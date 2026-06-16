// ArtistPanel - 参照设计稿重写
//   工具栏: Search + ScopeSegmented [我的 / 公共] + 随机 + 新建
//   RecentStrip (复用 artistUsageOrder)
//   ChipRow (全部 / ⭐收藏 / #tag from artistTagPool)
//   HorizontalCard 2 列 grid
//
// 关键变更:
//   - 删字母索引 rail (ArtistListWithAlphabet)
//   - 删 public/local Tab (改 toolbar 内 segmented)
//   - 删 localArtistSource 四选 dropdown (改单一 ⭐收藏 chip)
//   - 4 图轮播 → 单图 (HorizontalCard 已处理: preview = previews[0])
//   - 创建/编辑/批量/云端 沿用旧入口
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Edit2, Globe, Heart, Plus, Settings, Shuffle, Star,
  Trash2,
} from 'lucide-react';
import type { UseArtistManagerReturn, ArtistFile } from '../../artist/types';
import type { SubtypeDef, TagFile } from '../types';
import { fromArtist } from '../adapters';
import { getLucideIcon } from '../registry';
import { HorizontalCard, type CardMenuItem } from '../parts/HorizontalCard';
import { CreateTagModal, type CreateTagPayload, type EditingTarget } from '../parts/CreateTagModal';
import { PublishGuidelinesDialog } from '../parts/PublishGuidelinesDialog';
import { useConfirm } from '../parts/useConfirm';
import { RecentStrip } from '../parts/RecentStrip';
import { ScopeSegmented, type Scope } from '../parts/ScopeSegmented';
import { ChipRow } from '../parts/ChipRow';
import { TagPoolSettingsModal } from '../parts/TagPoolSettingsModal';
import { AlphabetRail, getLetterForName } from '../parts/AlphabetRail';
import { SearchInput, SoftButton, PrimaryButton, EmptyState } from './CharacterPanel';
import { PublicArtistManagerModal } from '../../artist/PublicArtistManagerModal';
import { getPublicLibraryOwnerId, updatePublicArtist } from '../../../services/publicLibrary';

interface Props {
  subtype: SubtypeDef;
  artistManager: UseArtistManagerReturn;
  selectedIds: Set<string>;
  onToggleSelection: (id: string) => void;
  onClearSelection: () => void;
  showToast: (message: string, type: 'success' | 'error') => void;
  currentMainPrompt?: string;
  currentMainNegative?: string;
  imageHistory?: Array<{
    id: string;
    imageUrl: string;
    width: number;
    height: number;
    timestamp: number;
  }>;
}

export const ArtistPanel: React.FC<Props> = ({
  subtype, artistManager: m, selectedIds, onToggleSelection, showToast,
  currentMainPrompt, currentMainNegative, imageHistory,
}) => {
  const Icon = getLucideIcon(subtype.iconName);

  const [scope, setScope] = useState<Scope>('mine');
  const [favOnly, setFavOnly] = useState(false);
  const [tagSettingsOpen, setTagSettingsOpen] = useState(false);
  const [publicManagerOpen, setPublicManagerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingTarget, setEditingTarget] = useState<EditingTarget | null>(null);
  const [pubDialog, setPubDialog] = useState<{ itemName: string; resolve: (ok: boolean) => void } | null>(null);
  const askPublishConfirm = (itemName: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => setPubDialog({ itemName, resolve }));
  const { confirm, confirmDialog } = useConfirm();
  const [activeLetter, setActiveLetter] = useState<string | null>(null);

  const openEditArtist = useCallback((a: ArtistFile) => {
    const origin = (a.origin || 'local') as 'local' | 'favorited' | 'created';
    setEditingTarget({
      id: a.id,
      origin,
      sourcePublicId: origin === 'favorited' ? (a.publicId || a.id) : undefined,
      initialPayload: {
        name: a.name,
        positive: a.prompt,
        negative: a.negative,
        previews: a.previews || [],
        tags: a.tags || [],
      },
    });
    setCreateOpen(true);
  }, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const setCardRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  }, []);

  useEffect(() => {
    m.loadLocalArtists();
    m.loadPublicArtists(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 数据源 - 对齐 CharacterPanel:公共库按 addedBy 筛"我的",叠加本地副本
  const currentUserId = getPublicLibraryOwnerId();
  const myArtists = useMemo<ArtistFile[]>(() => {
    if (!currentUserId) return [];
    return m.artistPublicFiles.filter(a => a.addedBy === currentUserId);
  }, [m.artistPublicFiles, currentUserId]);
  // 我的 = 本地副本 (fork / ❤️ 收藏 / 纯本地) + 我发布到公共的 (按 addedBy 筛)
  // 去重 key: publicId(本地副本) 或 id(公共条目),避免同名覆盖;本地副本承载 tags/origin,优先保留
  // 公共条目无本地副本时补 origin='created' + publicId,跟 PublicArtistManagerModal.onEdit 对齐,
  // 否则点编辑会因 origin 缺失 fallback 成 'local',误进本地编辑面板
  const mineAll = useMemo<ArtistFile[]>(() => {
    const map = new Map<string, ArtistFile>();
    const keyOf = (a: ArtistFile) => a.publicId || a.id;
    for (const f of m.artistLocalFiles) map.set(keyOf(f), f);
    for (const f of myArtists) {
      if (!map.has(f.id)) map.set(f.id, { ...f, origin: 'created', publicId: f.publicId || f.id });
    }
    return Array.from(map.values());
  }, [m.artistLocalFiles, myArtists]);
  const favSet = useMemo(
    () => new Set(mineAll.filter(a => a.origin === 'favorited').map(a => a.id)),
    [mineAll]
  );
  const pubAll = m.artistPublicFiles;

  const tagPool = m.artistTagPool;
  const activeTags = m.selectedTagFilter;

  const applyFilters = (arr: ArtistFile[], applyFavOnly: boolean): ArtistFile[] => {
    let out = arr;
    if (applyFavOnly) out = out.filter(a => favSet.has(a.id));
    const q = m.searchQuery.trim().toLowerCase();
    if (q) {
      out = out.filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.prompt.toLowerCase().includes(q) ||
        a.tags?.some(t => t.toLowerCase().includes(q))
      );
    }
    if (activeTags.size > 0) {
      out = out.filter(a => a.tags?.some(t => activeTags.has(t)));
    }
    return out;
  };

  const visible = scope === 'mine' ? applyFilters(mineAll, favOnly) : applyFilters(pubAll, false);
  const mineCount = applyFilters(mineAll, false).length;
  const pubCount = applyFilters(pubAll, false).length;
  const favCount = mineAll.filter(a => favSet.has(a.id)).length;

  const availableLetters = useMemo(() => {
    const s = new Set<string>();
    for (const a of visible) s.add(getLetterForName(a.name));
    return s;
  }, [visible]);

  const handleRandom = () => {
    if (selectedIds.size >= subtype.maxSelectable) return;
    const pool = (scope === 'mine' ? mineAll : pubAll).filter(a => !selectedIds.has(a.id));
    if (pool.length === 0) return;
    onToggleSelection(pool[Math.floor(Math.random() * pool.length)].id);
  };

  const handleClearRecent = () => m.updateArtistUsageOrder([]);

  const toTag = (a: ArtistFile): TagFile => fromArtist(a, !a.publicId);

  // 自动编号: 与 bot 端 utils/artist_manager.py:get_next_available_name 对齐
  //   A-Z 每段 1-99, 取第一个未占用的位置 (gap-filling, 不是 max+1)
  //   A99 后跳 B1, Z99 满则没空位
  // 已占用集合 = 本地副本 ∪ 公共库全部 (对应 bot 端的 artist_data.keys() 全集)
  //   不能只看 mineAll, 因为旧数据 added_by=null 导致很多自己上传的不在 mineAll 里
  const suggestNextArtistCode = (): string => {
    const used = new Set<string>();
    for (const a of mineAll) used.add(a.name);
    for (const a of pubAll) used.add(a.name);
    for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
      const letter = String.fromCharCode(c);
      for (let n = 1; n < 100; n++) {
        const name = `${letter}${n}`;
        if (!used.has(name)) return name;
      }
    }
    return 'Z99'; // 兜底: 全部占满 (理论 2574 个), 返回末位让保存校验报错
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/[0.06] bg-nai-dark/30 shrink-0">
        <SearchInput
          value={m.searchQuery}
          onChange={m.setSearchQuery}
          placeholder="搜索画师串名 / 提示词 / 标签…"
        />
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

      {/* Content + 字母滚动条 */}
      <div className="flex-1 min-h-0 flex min-w-0">
        <div
          ref={scrollRef}
          className="flex-1 min-w-0 overflow-y-auto p-3 custom-scrollbar flex flex-col"
          onScroll={() => {
            const el = scrollRef.current;
            if (!el) return;
            const top = el.scrollTop + 4;
            let current: string | null = null;
            for (const a of visible) {
              const ce = cardRefs.current.get(a.id);
              if (!ce) continue;
              if (ce.offsetTop <= top) current = getLetterForName(a.name);
              else break;
            }
            setActiveLetter(current);
          }}
        >
        <RecentStrip
          ids={m.artistUsageOrder}
          pools={[mineAll.map(toTag), pubAll.map(toTag)]}
          selectedSet={selectedIds}
          onToggle={onToggleSelection}
          onClear={m.artistUsageOrder.length > 0 ? handleClearRecent : undefined}
        />

        {scope === 'pub' && visible.length > 0 && (
          <div className="flex items-center gap-2.5 mb-3 pl-0.5">
            <Globe className="w-5 h-5 text-nai-text-dim shrink-0" />
            <span className="text-[15px] font-bold text-white truncate">公共库</span>
            <span className="text-[13px] font-bold text-nai-text-dim tabular-nums shrink-0">{pubAll.length}</span>
            <span className="flex-1 h-px bg-white/[0.06] mx-1" />
            <button
              onClick={() => setPublicManagerOpen(true)}
              disabled={!currentUserId}
              title="管理我上传到公共库的画师串"
              className="shrink-0 inline-flex items-center gap-1.5 px-3 h-8 rounded-md border border-gray-700 bg-gray-800/60 text-[12.5px] font-bold text-gray-300 hover:text-nai-accent hover:border-nai-accent/50 hover:bg-nai-accent/[0.05] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-gray-800/60 disabled:hover:text-gray-300 disabled:hover:border-gray-700"
            >
              <Settings className="w-3.5 h-3.5" />
              管理上传
              {currentUserId && (
                <span className="text-nai-accent ml-0.5 tabular-nums">
                  ({pubAll.filter(a => a.addedBy === currentUserId).length})
                </span>
              )}
            </button>
          </div>
        )}

        {scope === 'mine' && (
          <ChipRow
            allActive={activeTags.size === 0 && !favOnly}
            onAllClick={() => {
              m.setSelectedTagFilter(new Set());
              setFavOnly(false);
            }}
            showFavChip
            favOn={favOnly}
            onFavToggle={() => setFavOnly(v => !v)}
            tagPool={tagPool}
            activeTags={activeTags}
            onTagToggle={(t) => {
              m.setSelectedTagFilter(prev => {
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
            icon={Icon ? <Icon className="w-6 h-6" strokeWidth={1.4} /> : null}
            title={
              scope === 'mine'
                ? (favOnly ? '没有匹配的收藏' : '还没有创建本地画风')
                : '没有匹配的公共画风'
            }
            sub={
              scope === 'mine'
                ? (favOnly ? '取消「收藏」筛选查看全部本地画风' : '点击右上角「新建」开始建立你的画师串')
                : '试试清空搜索或筛选'
            }
          />
        ) : (() => {
          // 渲染一张画师卡 (helper, 避免分组渲染时重复 menuItems 构造)
          const renderArtistCard = (a: ArtistFile) => {
            const origin = a.origin ?? 'local';
            const menuItems: CardMenuItem[] = scope === 'mine'
              ? (origin === 'favorited'
                  ? [
                      { label: '编辑私有标签', icon: Edit2, onClick: () => openEditArtist(a) },
                      { label: '删除', icon: Trash2, danger: true, onClick: async () => {
                          const ok = await confirm({
                            title: '删除收藏',
                            message: `将从本地移除「${a.name}」(原作不受影响)。\n\n确定继续吗?`,
                            confirmLabel: '删除',
                            danger: true,
                          });
                          if (ok) m.unfavoriteArtist(a.id);
                        } },
                    ]
                  : origin === 'created'
                  ? [
                      { label: '编辑', icon: Edit2, onClick: () => openEditArtist(a) },
                      { label: '删除', icon: Trash2, danger: true, onClick: async () => {
                          const ok = await confirm({
                            title: '删除画师串',
                            message: `将彻底删除「${a.name}」(公共 + 本地副本)。\n\n此操作不可恢复,确定继续吗?`,
                            confirmLabel: '删除',
                            danger: true,
                          });
                          if (!ok) return;
                          const pubId = a.publicId || a.id;
                          const r = await m.deletePublicArtistTotally(pubId);
                          if (r.success) showToast('已彻底删除', 'success');
                          else showToast(`删除失败: ${r.message || '未知'}`, 'error');
                        } },
                    ]
                  : [
                      { label: '编辑', icon: Edit2, onClick: () => openEditArtist(a) },
                      { label: '删除', icon: Trash2, danger: true, onClick: async () => {
                          const ok = await confirm({
                            title: '删除画师串',
                            message: `删除「${a.name}」?数据无法恢复`,
                            confirmLabel: '删除',
                            danger: true,
                          });
                          if (ok) m.handleDeleteArtist(a.id, undefined);
                        } },
                    ])
              : [];
            return (
              <div key={a.id} ref={(el) => setCardRef(a.id, el)}>
                <HorizontalCard
                  item={toTag(a)}
                  isSelected={selectedIds.has(a.id)}
                  onToggle={onToggleSelection}
                  isPublic={scope === 'pub'}
                  isSavedToLocal={m.artistLocalFiles.some(f => f.publicId === a.id || f.name === a.name)}
                  onCopy={() => showToast('已复制提示词', 'success')}
                  onSaveToLocal={() => m.savePublicToLocal(a)}
                  menuItems={menuItems}
                />
              </div>
            );
          };

          // mine scope: 分组 - 我的画风 (own) 置顶, 收藏的画风 (favorited) 在下方
          if (scope === 'mine') {
            const ownArtists = visible.filter(a => (a.origin ?? 'local') !== 'favorited');
            const favArtists = visible.filter(a => (a.origin ?? 'local') === 'favorited');
            const sectionHeader = (
              icon: React.ReactNode,
              label: string,
              count: number,
              accent: boolean,
            ) => (
              <div className="flex items-center gap-2.5 mb-3 pl-0.5">
                {icon}
                <span className={`text-[15px] font-bold shrink-0 ${accent ? 'text-nai-accent' : 'text-white'}`}>{label}</span>
                <span className={`text-[13px] font-bold tabular-nums shrink-0 ${accent ? 'text-nai-accent' : 'text-nai-text-dim'}`}>{count}</span>
                <span className="flex-1 h-px bg-white/[0.06] ml-1" />
              </div>
            );
            return (
              <div className="flex flex-col gap-5">
                {ownArtists.length > 0 && (
                  <div>
                    {sectionHeader(
                      <Heart className="w-5 h-5 text-nai-accent shrink-0 fill-nai-accent/30" strokeWidth={1.75} />,
                      '我的画风',
                      ownArtists.length,
                      true,
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
                      {ownArtists.map(renderArtistCard)}
                    </div>
                  </div>
                )}
                {favArtists.length > 0 && (
                  <div>
                    {sectionHeader(
                      <Star className="w-5 h-5 text-nai-text-dim shrink-0" strokeWidth={1.75} />,
                      '收藏的画风',
                      favArtists.length,
                      false,
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
                      {favArtists.map(renderArtistCard)}
                    </div>
                  </div>
                )}
              </div>
            );
          }

          // pub scope: 不分组,扁平网格
          return (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
              {visible.map(renderArtistCard)}
            </div>
          );
        })()}
        </div>
        {/* 右侧字母索引条 - 仅有数据时显示 */}
        {visible.length > 0 && (
          <AlphabetRail
            letters={availableLetters}
            activeLetter={activeLetter}
            onJump={(letter) => {
              for (const a of visible) {
                if (getLetterForName(a.name) === letter) {
                  const ce = cardRefs.current.get(a.id);
                  if (ce && scrollRef.current) {
                    scrollRef.current.scrollTo({ top: ce.offsetTop - 4, behavior: 'smooth' });
                  }
                  return;
                }
              }
            }}
            side="right"
          />
        )}
      </div>

      {/* 管理我上传到公共库的画师串 */}
      <PublicArtistManagerModal
        isOpen={publicManagerOpen}
        onClose={() => { setPublicManagerOpen(false); m.loadPublicArtists(true); }}
        showToast={showToast}
        onAfterDelete={async (publicArtist) => {
          // 仅清"我发布时自动落的 created 本地副本"(publicId 链接且 origin='created')
          // fork 出来的独立副本 (origin='local' 无 publicId) 不动 - 主从独立
          const toDelete = m.artistLocalFiles.filter(f =>
            f.publicId === publicArtist.id && f.origin === 'created',
          );
          for (const local of toDelete) {
            try { await m.handleDeleteArtist(local.id); } catch (e) { console.error('删本地副本失败:', e); }
          }
        }}
        onUnpublish={async (publicArtist) => m.unpublishArtist(publicArtist.id)}
        onEdit={(publicArtist) => {
          const localCopy = m.artistLocalFiles.find(f => f.publicId === publicArtist.id || f.name === publicArtist.name);
          const target: ArtistFile = localCopy ?? {
            id: publicArtist.id,
            name: publicArtist.name,
            prompt: publicArtist.artist_string || '',
            previews: publicArtist.preview_url ? [publicArtist.preview_url] : [],
            addedBy: publicArtist.added_by,
            origin: 'created',
            publicId: publicArtist.id,
          };
          openEditArtist(target);
          setPublicManagerOpen(false);
        }}
      />

      {/* 标签池设置 */}
      <TagPoolSettingsModal
        isOpen={tagSettingsOpen}
        title="画师串标签管理"
        tagPool={tagPool}
        countUsage={(t) => mineAll.filter(a => a.tags?.includes(t)).length}
        onClose={() => setTagSettingsOpen(false)}
        onSavePool={(pool) => {
          m.saveArtistTagPool(pool);
          const removed = tagPool.filter(t => !pool.includes(t));
          if (removed.length > 0) {
            m.setSelectedTagFilter(prev => {
              const n = new Set(prev);
              for (const t of removed) n.delete(t);
              return n;
            });
          }
        }}
      />

      {/* 新建/编辑画师串 - 统一面板 */}
      <CreateTagModal
        isOpen={createOpen}
        subtype={subtype}
        editing={editingTarget || undefined}
        onClose={() => { setCreateOpen(false); setEditingTarget(null); }}
        tagPool={tagPool}
        currentMainPrompt={currentMainPrompt}
        currentMainNegative={currentMainNegative}
        imageHistory={imageHistory}
        onSuggestName={suggestNextArtistCode}
        onTransferOwner={async (newOwnerId) => {
          if (!editingTarget) return { success: false, message: '未指定条目' };
          const local = m.artistLocalFiles.find(f => f.id === editingTarget.id);
          const publicId = local?.publicId;
          if (!publicId) return { success: false, message: '未发布到公共,无法转让' };
          const result = await updatePublicArtist(publicId, { added_by: newOwnerId });
          if (result.success) {
            showToast(`已转让「${local!.name}」给 ${newOwnerId}`, 'success');
            await m.loadPublicArtists(true);
            return { success: true };
          }
          showToast(`转让失败: ${result.message}`, 'error');
          return { success: false, message: result.message };
        }}
        onGeneratePreview={(prompt, index, onProgress) => m.generatePreviewBase64(prompt, index, onProgress)}
        onSave={async (payload: CreateTagPayload) => {
          if (editingTarget) {
            // 收藏的别人的画师串: 弹 confirm 走 fork 流程,创建本地副本 (不影响原作)
            if (editingTarget.origin === 'favorited' && editingTarget.sourcePublicId) {
              const ok = await confirm({
                title: '保存为本地副本',
                message: `「${payload.name}」是别人创作的画师串,保存将创建一份本地副本 (不影响原作)。\n\n确定保存吗?`,
                confirmLabel: '保存副本',
              });
              if (!ok) return false;
              const result = await m.forkArtistToLocal(editingTarget.sourcePublicId, {
                name: payload.name,
                positive: payload.positive,
                negative: payload.negative,
                previews: payload.previews,
                tags: payload.tags,
              });
              if (result.success) {
                const renamed = result.finalName && result.finalName !== payload.name;
                showToast(
                  renamed
                    ? `已创建本地副本「${result.finalName}」(原名重复,自动加后缀)`
                    : `已创建本地副本「${result.finalName || payload.name}」`,
                  'success',
                );
                return;
              }
              showToast(`保存失败: ${result.message || '未知'}`, 'error');
              return false;
            }
            const result = await m.updateArtistFromPayload(editingTarget.id, {
              name: payload.name,
              positive: payload.positive,
              negative: payload.negative,
              previews: payload.previews,
              tags: payload.tags,
            }, editingTarget.origin);
            if (result.success) showToast(`已更新「${payload.name}」`, 'success');
            else showToast(`更新失败: ${result.message || '未知'}`, 'error');
            return;
          }
          const result = await m.saveArtistFromPayload({
            name: payload.name,
            positive: payload.positive,
            negative: payload.negative,
            previews: payload.previews,
            tags: payload.tags,
          }, 'local');
          if (result.success) showToast(`已保存「${payload.name}」`, 'success');
          else showToast(`保存失败: ${result.message || '未知'}`, 'error');
        }}
        onUploadPublic={async (payload: CreateTagPayload) => {
          // 公共发布/同步必须有预览图 (提高公共库质量,bot 端展示也需要)
          if (!payload.previews?.[0]) {
            showToast('发布到公共必须有预览图,请先生成或上传一张', 'error');
            return false;
          }
          // 重名校验: 与公共库现有条目 (排除自己当前正在编辑的同 publicId 条目) 比对
          // 优先查本地副本拿 publicId; 拿不到时 editingTarget.id 本身就是公共条目 id
          // (mineAll 合并时对无本地副本的"我的公共"用了公共 id 作为 key)
          const currentPublicId = editingTarget?.origin === 'created'
            ? (m.artistLocalFiles.find(f => f.id === editingTarget.id)?.publicId ?? editingTarget.id)
            : undefined;
          const nameClash = pubAll.some(p => p.name === payload.name && p.id !== currentPublicId);
          if (nameClash) {
            showToast(`「${payload.name}」已在公共库存在,请换一个名字或用「获取编号」自动取下一个`, 'error');
            return false;
          }
          if (editingTarget && editingTarget.origin === 'created') {
            const result = await m.updateArtistFromPayload(editingTarget.id, {
              name: payload.name,
              positive: payload.positive,
              negative: payload.negative,
              previews: payload.previews,
              tags: payload.tags,
            }, 'created');
            if (result.success) showToast(`已同步「${payload.name}」到公共库`, 'success');
            else showToast(`同步失败: ${result.message || '未知'}`, 'error');
            return;
          }
          // 创建 + 发布: 独立弹窗二次确认公共发布规范
          const ok = await askPublishConfirm(payload.name);
          if (!ok) return false;
          const result = await m.saveArtistFromPayload({
            name: payload.name,
            positive: payload.positive,
            negative: payload.negative,
            previews: payload.previews,
            tags: payload.tags,
          }, 'public');
          if (!result.success) {
            showToast(`发布失败: ${result.message || '未知'}`, 'error');
            return;
          }
          // 若是从本地条目升级发布: 删除原本地条目, 避免出现两份 (新 created 副本由 saveArtistFromPayload 已建好)
          if (editingTarget && editingTarget.origin === 'local' && result.id && editingTarget.id !== result.id) {
            try {
              await m.handleDeleteArtist(editingTarget.id);
            } catch (err) {
              console.error('[ArtistPanel] cleanup local after publish failed', err);
            }
            showToast(`已发布「${payload.name}」并合并本地条目`, 'success');
          } else {
            showToast(`已发布「${payload.name}」到公共库`, 'success');
          }
        }}
        onUnpublish={async () => {
          if (!editingTarget || editingTarget.origin !== 'created') return { success: false, message: '非可撤回状态' };
          const r = await m.unpublishArtist(editingTarget.id);
          if (r.success) showToast('已撤回发布(本地副本已保留)', 'success');
          else showToast(`撤回失败: ${r.message || '未知'}`, 'error');
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
          const result = await m.forkArtistToLocal(editingTarget.id, {
            name: payload.name,
            positive: payload.positive,
            negative: payload.negative,
            previews: payload.previews,
            tags: payload.tags,
          });
          if (result.success) {
            const renamed = result.finalName && result.finalName !== payload.name;
            showToast(
              renamed
                ? `已创建本地副本「${result.finalName}」(原名重复,自动加后缀)`
                : `已创建本地副本「${result.finalName || payload.name}」`,
              'success',
            );
            return;
          }
          showToast(`保存失败: ${result.message || '未知'}`, 'error');
          return false;
        }}
      />

      {/* 公共发布规范二次确认 */}
      <PublishGuidelinesDialog
        isOpen={!!pubDialog}
        title="发布到公共画师串库"
        subtitle="发布前请阅读以下规范"
        bullets={[
          '请先自行测试过画师串效果,确认品质后再发布',
          '未经原作者授权请勿搬运他人发布的画师串',
          '剔除与画风无关的 tag (角色 / 动作 / 构图等),\n保持画师串纯净 - 仅描述画风',
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
