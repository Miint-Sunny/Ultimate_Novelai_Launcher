import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Search, X, Sparkles, Filter, Dice5, MessageSquare, Image as ImageIcon, Book, Copy, Download, Heart, Share2, Send, User, LayoutGrid, List as ListIcon, Check, ChevronDown, Info, Plus, Trash2, Loader2, Users, RefreshCw, Clock, AlertTriangle, Tag } from 'lucide-react';
import { getInspirationFavorites, saveInspirationFavorites, type R18FilterType, type CodexFilterSettings } from '../services/localLibrary';
import { loadCodexData, getCodexStats } from '../services/codexData';
import type { CodexItem } from '../services/codexData';
import { OCGalleryTab } from './inspiration/OCGalleryTab';
import { getPublicOCs, getOCPreviewUrl } from '../services/publicLibrary';
import { countTokens } from '../services/tokenizer';
import { getKktList, getKktRecord, resolveKktImageUrl, type KktRecord, type KktListParams } from '../services/kktService';
import { appBackendApi } from '../api/appBackendApi';
import { API_PATHS } from '../utils/apiConfig';

// 模型名称映射
const MODEL_NAME_MAP: Record<string, string> = {
  // V4.5 Full 系列
  'NovelAI Diffusion V4.5 4BDE2A90': 'NovelAI V4.5 Full',
  'NovelAI Diffusion V4.5 1229B44F': 'NovelAI V4.5 Full Inpaint',
  'NovelAI Diffusion V4.5 B9F340FD': 'NovelAI V4.5 Full',
  'NovelAI Diffusion V4.5 F3D95188': 'NovelAI V4.5 Full',
  // V4.5 Curated 系列
  'NovelAI Diffusion V4.5 C02D4F98': 'NovelAI V4.5 Curated',
  'NovelAI Diffusion V4.5 5BB76870': 'NovelAI V4.5 Curated Inpaint',
  'NovelAI Diffusion V4.5 5AB81C7C': 'NovelAI V4.5 Curated',
  'NovelAI Diffusion V4.5 B5A2A797': 'NovelAI V4.5 Curated',
  // V4 Full
  'NovelAI Diffusion V4 44FD40FE': 'NovelAI V4 Full',
  'NovelAI Diffusion V4 37442FCA': 'NovelAI V4 Full',
  'NovelAI Diffusion V4 4F49EC75': 'NovelAI V4 Full',
  'NovelAI Diffusion V4 CA4B7203': 'NovelAI V4 Full',
  'NovelAI Diffusion V4 79F47848': 'NovelAI V4 Full',
  'NovelAI Diffusion V4 F6302A9D': 'NovelAI V4 Full',
  // V4 Curated
  'NovelAI Diffusion V4 C5E578FD': 'NovelAI V4 Curated',
  'NovelAI Diffusion V4 7ABFFA2A': 'NovelAI V4 Curated',
  'NovelAI Diffusion V4 C1CCBA86': 'NovelAI V4 Curated',
  'NovelAI Diffusion V4 770A9E12': 'NovelAI V4 Curated',
  // V4 → V4.5 Curated (官方归类)
  'NovelAI Diffusion V4 5AB81C7C': 'NovelAI V4.5 Curated',
  'NovelAI Diffusion V4 B5A2A797': 'NovelAI V4.5 Curated',
  // V3
  'NovelAI Diffusion V3 F4D50568': 'NovelAI V3',
};
function resolveModelName(raw?: string | null): string | null {
  if (!raw) return null;
  return MODEL_NAME_MAP[raw] ?? raw.replace('NovelAI Diffusion ', 'NovelAI ').replace('.safetensors', '').substring(0, 20);
}

// 可折叠标签信息
export interface CollapsibleTagInfo {
  type: 'artist' | 'codex' | 'oc';
  label: string;
  content: string;
}

interface InspirationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectPrompt: (prompt: string) => void;
  // 添加可折叠标签的回调
  onAddCollapsibleTag?: (tag: CollapsibleTagInfo) => void;
  // 添加到角色提示词的回调
  onAddToCharacter?: (tag: CollapsibleTagInfo) => void;
  // 外部传入的法典筛选设置（用于随机灵感功能）
  externalCodexFilter?: CodexFilterSettings;
  // 当筛选设置变化时的回调（用于同步到外部）
  onCodexFilterChange?: (settings: CodexFilterSettings) => void;
  // 导入图片回调（触发DropZoneModal）
  onImportImage?: (file: File, dataUrl: string) => void;
}

type TabType = 'codex' | 'kkt' | 'oc' | 'favorites';
type R18Filter = 'all' | 'safe' | 'r18';

// 获取法典的Tag序号（去掉前缀）
const getCodexTagId = (id: string): string => {
  return id.replace(/^(nsfw_|common_)/, '');
};

// ============ KKT 智能瀑布流组件 ============

interface KktMasonryGridProps {
  items: KktRecord[];
  resetKey: number;
  onItemClick: (item: KktRecord) => void;
  onSelectPrompt: (prompt: string) => void;
  favoriteIds: string[];
  onToggleFavorite: (id: string, e?: React.MouseEvent) => void;
  onImportImage?: (item: KktRecord) => void;
  downloadingId?: string | null;
}

// 标准比例（NAI常见尺寸）
const ASPECT_P = 832 / 1216;   // 0.684 竖图
const ASPECT_L = 1216 / 832;   // 1.462 横图  
const ASPECT_S = 1.0;          // 方图

type ImgType = 'P' | 'L' | 'S';

// 判断是否为异形比例
const isOddAspect = (aspect: number): boolean => {
  // 超窄(<0.5)或超宽(>1.8)都算异形
  return aspect < 0.5 || aspect > 1.8;
};

// 将图片归类到标准类型
const getType = (aspect: number): ImgType => {
  if (aspect < 0.85) return 'P';
  if (aspect > 1.2) return 'L';
  return 'S';
};

// 获取用于布局计算的标准化宽高比
const getLayoutAspect = (item: KktRecord): number => {
  const raw = item.width && item.height ? item.width / item.height : ASPECT_P;
  // 异形图片强制使用标准比例参与布局
  if (raw < 0.5) return ASPECT_P;      // 超窄 -> 竖图
  if (raw > 1.8) return ASPECT_L;      // 超宽 -> 横图
  // 正常范围内的图片使用实际比例，但限制范围
  return Math.max(0.55, Math.min(1.7, raw));
};

// 获取实际宽高比（用于判断是否需要裁剪）
const getActualAspect = (item: KktRecord): number => {
  const raw = item.width && item.height ? item.width / item.height : ASPECT_P;
  return raw;
};

// 获取显示用的宽高比（限制范围）
const getDisplayAspect = (item: KktRecord): number => {
  const raw = item.width && item.height ? item.width / item.height : ASPECT_P;
  return Math.max(0.5, Math.min(2.0, raw));
};

// 预计算的行组合模式（按总宽高比排序）
// 每个模式: [类型数组, 总宽高比]
const PATTERNS: [ImgType[], number][] = [
  [['L', 'L'], ASPECT_L * 2],                           // 2.92
  [['L', 'S'], ASPECT_L + ASPECT_S],                    // 2.46
  [['S', 'S'], ASPECT_S * 2],                           // 2.0
  [['L', 'P'], ASPECT_L + ASPECT_P],                    // 2.15
  [['S', 'S', 'S'], ASPECT_S * 3],                      // 3.0
  [['L', 'P', 'P'], ASPECT_L + ASPECT_P * 2],           // 2.83
  [['S', 'S', 'P'], ASPECT_S * 2 + ASPECT_P],           // 2.68
  [['L', 'S', 'P'], ASPECT_L + ASPECT_S + ASPECT_P],    // 3.15
  [['P', 'P', 'P'], ASPECT_P * 3],                      // 2.05
  [['L', 'L', 'P'], ASPECT_L * 2 + ASPECT_P],           // 3.61
  [['L', 'S', 'S'], ASPECT_L + ASPECT_S * 2],           // 3.46
  [['S', 'P', 'P'], ASPECT_S + ASPECT_P * 2],           // 2.37
  [['P', 'P', 'P', 'P'], ASPECT_P * 4],                 // 2.74
  [['S', 'S', 'P', 'P'], ASPECT_S * 2 + ASPECT_P * 2],  // 3.37
  [['L', 'P', 'P', 'P'], ASPECT_L + ASPECT_P * 3],      // 3.51
  [['S', 'S', 'S', 'S'], ASPECT_S * 4],                 // 4.0
  [['L', 'L', 'S'], ASPECT_L * 2 + ASPECT_S],           // 3.92
  [['L', 'S', 'P', 'P'], ASPECT_L + ASPECT_S + ASPECT_P * 2], // 3.83
];

// 智能布局：精确匹配组合模式
const layoutRows = (items: KktRecord[], containerWidth: number, baseHeight: number, gap: number): KktRecord[][] => {
  if (items.length === 0) return [];

  // 目标宽高比 = 可用宽度 / 行高
  const targetAspect = containerWidth / baseHeight;

  // 按类型分组（异形图片也会被归类）
  const pools: Record<ImgType, KktRecord[]> = { P: [], L: [], S: [] };
  items.forEach(item => {
    pools[getType(getDisplayAspect(item))].push(item);
  });

  const rows: KktRecord[][] = [];
  const tolerance = 0.25; // 允许25%的偏差

  // 按接近程度排序模式
  const sortedPatterns = PATTERNS
    .map(([types, aspect]) => ({ types, aspect, diff: Math.abs(aspect - targetAspect) / targetAspect }))
    .filter(p => p.diff <= tolerance)
    .sort((a, b) => a.diff - b.diff);

  let iterations = 0;
  const maxIter = items.length * 3;

  while (iterations++ < maxIter) {
    const total = pools.P.length + pools.L.length + pools.S.length;
    if (total === 0) break;

    let matched = false;

    // 尝试匹配模式
    for (const { types } of sortedPatterns) {
      const need: Record<ImgType, number> = { P: 0, L: 0, S: 0 };
      types.forEach(t => need[t]++);

      // 检查是否有足够图片
      if (pools.P.length >= need.P && pools.L.length >= need.L && pools.S.length >= need.S) {
        const row: KktRecord[] = [];
        types.forEach(t => row.push(pools[t].shift()!));
        rows.push(row);
        matched = true;
        break;
      }
    }

    // 没有匹配到模式，取剩余图片
    if (!matched) {
      const remaining = [...pools.L, ...pools.S, ...pools.P];
      pools.P = []; pools.L = []; pools.S = [];

      // 简单分行：每行最多3-4张
      while (remaining.length > 0) {
        let rowAspect = 0;
        const row: KktRecord[] = [];

        while (remaining.length > 0 && row.length < 4) {
          const item = remaining[0];
          const aspect = getLayoutAspect(item);

          if (row.length > 0 && rowAspect + aspect > targetAspect * 1.1) break;

          row.push(remaining.shift()!);
          rowAspect += aspect;

          if (rowAspect >= targetAspect * 0.85) break;
        }

        if (row.length > 0) rows.push(row);
      }
      break;
    }
  }

  return rows;
};

const KktMasonryGrid: React.FC<KktMasonryGridProps> = ({
  items,
  resetKey,
  onItemClick,
  onSelectPrompt,
  favoriteIds,
  onToggleFavorite,
  onImportImage,
  downloadingId,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1000);

  const cachedRowsRef = useRef<KktRecord[][]>([]);
  const processedCountRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(entries => {
      setContainerWidth(entries[0].contentRect.width);
    });
    observer.observe(container);
    setContainerWidth(container.clientWidth);

    return () => observer.disconnect();
  }, []);

  const baseHeight = 300;
  const gap = 8;

  // 记录上次的容器宽度，宽度变化时需要重新布局
  const lastWidthRef = useRef(containerWidth);

  // 跟踪 resetKey 用于检测筛选切换
  const lastResetKeyRef = useRef(resetKey);

  const rows = useMemo(() => {
    const currentCount = items.length;
    const widthChanged = Math.abs(lastWidthRef.current - containerWidth) > 50;

    // resetKey 变化 = 筛选切换，必须重置
    const resetKeyChanged = resetKey !== lastResetKeyRef.current;
    lastResetKeyRef.current = resetKey;

    // 重置条件：图片减少、清空、容器宽度显著变化、或内容变化（如标签筛选）
    if (currentCount < processedCountRef.current || currentCount === 0 || widthChanged || resetKeyChanged) {
      cachedRowsRef.current = [];
      processedCountRef.current = 0;
      lastWidthRef.current = containerWidth;
      if (currentCount === 0) return [];
    }

    // 增量布局
    if (currentCount > processedCountRef.current) {
      const cached = cachedRowsRef.current;
      const targetAspect = containerWidth / baseHeight;
      const newItems = [...items.slice(processedCountRef.current)];

      // 如果最后一行不完整，优先从新图片中选择合适的补全
      if (cached.length > 0) {
        const lastRow = cached[cached.length - 1];
        let lastRowAspect = lastRow.reduce((s, i) => s + getLayoutAspect(i), 0);

        // 尝试补全最后一行（不超过目标的110%）
        while (newItems.length > 0 && lastRowAspect < targetAspect * 0.95) {
          // 找最合适的图片来补全
          let bestIdx = -1;
          let bestDiff = Infinity;

          for (let i = 0; i < Math.min(newItems.length, 10); i++) {
            const aspect = getLayoutAspect(newItems[i]);
            const newTotal = lastRowAspect + aspect;

            // 不能超过目标太多
            if (newTotal > targetAspect * 1.15) continue;

            const diff = Math.abs(newTotal - targetAspect);
            if (diff < bestDiff) {
              bestDiff = diff;
              bestIdx = i;
            }
          }

          if (bestIdx === -1) break;

          // 添加到最后一行
          const selected = newItems.splice(bestIdx, 1)[0];
          lastRow.push(selected);
          lastRowAspect += getLayoutAspect(selected);
        }
      }

      // 剩余的新图片进行新行布局
      if (newItems.length > 0) {
        const newRows = layoutRows(newItems, containerWidth, baseHeight, gap);
        cachedRowsRef.current = [...cached, ...newRows];
      }

      processedCountRef.current = currentCount;
    }

    return cachedRowsRef.current;
  }, [items, containerWidth]);

  return (
    <div ref={containerRef} className="space-y-2">
      {rows.map((row, rowIdx) => {
        // 使用布局宽高比计算行高
        const rowAspect = row.reduce((s, i) => s + getLayoutAspect(i), 0);
        const availableWidth = containerWidth - gap * (row.length - 1);
        const rowHeight = Math.max(220, Math.min(360, availableWidth / rowAspect));

        return (
          <div key={`row-${rowIdx}-${row[0]?.name}`} className="flex gap-2">
            {row.map((item) => {
              const layoutAspect = getLayoutAspect(item);
              const actualAspect = getActualAspect(item);
              const width = layoutAspect * rowHeight;
              const imageUrl = resolveKktImageUrl(item.image_url, true);
              const isOdd = isOddAspect(actualAspect);

              return (
                <div
                  key={item.name}
                  style={{ width, height: rowHeight, flexShrink: 0 }}
                  className="group relative rounded-xl overflow-hidden bg-gray-800 cursor-pointer border border-gray-800 hover:border-indigo-500 transition-all hover:shadow-[0_0_20px_rgba(99,102,241,0.3)]"
                  onClick={() => onItemClick(item)}
                >
                  {imageUrl ? (
                    <div className="relative w-full h-full bg-gray-800/50 animate-pulse">
                      <img
                        src={imageUrl}
                        alt={item.name}
                        loading="lazy"
                        decoding="async"
                        className="w-full h-full object-cover opacity-0 transition-opacity duration-500 relative z-10"
                        onLoad={e => {
                          e.currentTarget.classList.remove('opacity-0');
                          e.currentTarget.parentElement?.classList.remove('animate-pulse');
                        }}
                      />
                      {/* 异形图片裁剪标记 */}
                      {isOdd && (
                        <div className="absolute top-2 right-2 z-20 px-1.5 py-0.5 bg-amber-500/80 text-white text-[9px] font-bold rounded">
                          裁剪
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="w-full h-full bg-gradient-to-br from-indigo-500/20 to-purple-500/20 flex items-center justify-center">
                      <ImageIcon className="w-12 h-12 text-gray-600" />
                    </div>
                  )}

                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent p-3 flex flex-col justify-end translate-y-4 group-hover:translate-y-0 opacity-0 group-hover:opacity-100 transition-all duration-300 pt-10 z-20">
                    <p className="font-bold text-white text-xs mb-0.5 truncate">{item.name}</p>
                    <div className="flex justify-between items-center mb-2">
                      <p className="text-[10px] text-gray-400">{item.user_name}</p>
                      {item.model_name && (
                        <span className="text-[9px] bg-white/10 text-gray-300 px-1.5 py-0.5 rounded">
                          {resolveModelName(item.model_name)}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-1.5">
                      <button
                        className={`flex-1 py-1.5 text-white text-[10px] font-bold rounded flex items-center justify-center gap-1 ${downloadingId === item.name
                          ? 'bg-indigo-700 cursor-wait'
                          : 'bg-indigo-600 hover:bg-indigo-500'
                          }`}
                        onClick={e => { e.stopPropagation(); if (downloadingId !== item.name) { onImportImage ? onImportImage(item) : onSelectPrompt(item.content); } }}
                        disabled={downloadingId === item.name}
                      >
                        {downloadingId === item.name ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin" />
                            下载中
                          </>
                        ) : (
                          <>
                            <Download className="w-3 h-3" />
                            导入图片
                          </>
                        )}
                      </button>
                      <button
                        className={`p-1.5 rounded backdrop-blur-md transition-colors ${favoriteIds.includes(item.name)
                          ? 'bg-red-500/80 text-white hover:bg-red-500'
                          : 'bg-white/10 hover:bg-white/20 text-white'
                          }`}
                        onClick={e => onToggleFavorite(item.name, e)}
                      >
                        <Heart className={`w-3 h-3 ${favoriteIds.includes(item.name) ? 'fill-current' : ''}`} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};

// 获取带序号的标题显示
// 获取带序号的标题显示
const getCodexDisplayTitle = (item: CodexItem): string => {
  return item.title;
};

export const InspirationModal: React.FC<InspirationModalProps> = ({ isOpen, onClose, onSelectPrompt, onAddCollapsibleTag, onAddToCharacter, externalCodexFilter, onCodexFilterChange, onImportImage }) => {
  const [activeTab, setActiveTab] = useState<TabType>('codex');

  // Codex 数据状态
  const [codexData, setCodexData] = useState<CodexItem[]>([]);
  const [isCodexLoading, setIsCodexLoading] = useState(true);
  const [codexStats, setCodexStats] = useState<{ total: number; nsfwCount: number; commonCount: number } | null>(null);

  // OC 数据状态（用于收藏页显示）
  const [ocData, setOcData] = useState<{ id: string; name: string; en_name: string; aliases: string[]; preview: string; positive: string; created_by: string }[]>([]);
  const [isOcLoading, setIsOcLoading] = useState(false);

  // 添加成功反馈状态
  const [addedItemId, setAddedItemId] = useState<string | null>(null);

  // 复制成功反馈状态
  const [copiedItemId, setCopiedItemId] = useState<string | null>(null);
  const [randomCopied, setRandomCopied] = useState(false);

  // 处理复制并显示反馈
  const handleCopyContent = (id: string, content: string) => {
    navigator.clipboard.writeText(content);
    setCopiedItemId(id);
    setTimeout(() => setCopiedItemId(null), 1500);
  };

  // 处理随机灵感预览的复制
  const handleCopyRandomContent = (content: string) => {
    navigator.clipboard.writeText(content);
    setRandomCopied(true);
    setTimeout(() => setRandomCopied(false), 1500);
  };

  // 处理添加并显示反馈
  const handleAddPrompt = (id: string, content: string) => {
    onSelectPrompt(content);
    onClose();
  };

  // 处理添加法典内容为可折叠标签
  const handleAddCodexTag = (id: string, name: string, content: string) => {
    if (onAddCollapsibleTag) {
      // 使用 Tag 序号作为标签名
      const tagId = getCodexTagId(id);
      onAddCollapsibleTag({
        type: 'codex',
        label: tagId,
        content: content,
      });
      // 显示添加成功反馈
      setAddedItemId(id);
      setTimeout(() => setAddedItemId(null), 1500);
    } else {
      // 回退到普通添加
      onSelectPrompt(content);
      onClose();
    }
  };

  // 加载法典数据
  useEffect(() => {
    if (isOpen && codexData.length === 0) {
      setIsCodexLoading(true);
      loadCodexData().then(data => {
        setCodexData(data);
        setCodexStats(getCodexStats(data));
        setIsCodexLoading(false);
      });
    }
  }, [isOpen]);

  // Favorites State - 从持久化存储加载
  const [favoriteCodexIds, setFavoriteCodexIds] = useState<string[]>([]);
  const [favoriteKktIds, setFavoriteKktIds] = useState<string[]>([]);
  const [favoriteOCIds, setFavoriteOCIds] = useState<string[]>([]);
  const [favoritesSubTab, setFavoritesSubTab] = useState<'codex' | 'kkt' | 'oc'>('codex');

  // 加载收藏数据
  useEffect(() => {
    const favorites = getInspirationFavorites();
    setFavoriteCodexIds(favorites.codexIds);
    setFavoriteKktIds(favorites.kktIds);
    setFavoriteOCIds(favorites.ocIds || []);
  }, []);

  // 加载OC数据（用于收藏页显示）
  useEffect(() => {
    // 当切换到收藏页的OC子标签时，或者有收藏的OC时加载数据
    const shouldLoadOC = isOpen && ocData.length === 0 && (
      favoriteOCIds.length > 0 || (activeTab === 'favorites' && favoritesSubTab === 'oc')
    );
    if (shouldLoadOC) {
      setIsOcLoading(true);
      getPublicOCs().then(data => {
        const ocs = data.map(oc => ({
          id: oc.id,
          name: oc.zh_name || oc.en_name,
          en_name: oc.en_name,
          aliases: oc.zh_aliases || [],
          preview: oc.preview_url ? getOCPreviewUrl(oc.en_name) : '',
          positive: oc.tag_group,
          created_by: oc.created_by || '',
        }));
        setOcData(ocs);
        setIsOcLoading(false);
      }).catch(() => setIsOcLoading(false));
    }
    // 角色数据独立加载（不依赖OC条件）
    if (isOpen && characterData.length === 0) {
      appBackendApi.request(API_PATHS.DATA_ROLE_TAG_MAPPING)
        .then(res => res.ok ? res.json() : {})
        .then(data => {
          const chars: { en: string, zh: string }[] = [];
          for (const [en, info] of Object.entries(data || {})) {
            const zhArr = (info as any)?.role_zh || [];
            chars.push({ en, zh: zhArr[0] || '' });
          }
          setCharacterData(chars);
        })
        .catch(() => { });
    }
  }, [isOpen, favoriteOCIds.length, activeTab, favoritesSubTab]);

  const toggleCodexFavorite = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setFavoriteCodexIds(prev => {
      const newIds = prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id];
      // 保存到持久化存储
      saveInspirationFavorites({ codexIds: newIds, kktIds: favoriteKktIds, ocIds: favoriteOCIds });
      return newIds;
    });
  };

  const toggleKktFavorite = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setFavoriteKktIds(prev => {
      const newIds = prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id];
      // 保存到持久化存储
      saveInspirationFavorites({ codexIds: favoriteCodexIds, kktIds: newIds, ocIds: favoriteOCIds });
      return newIds;
    });
  };

  const toggleOCFavorite = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setFavoriteOCIds(prev => {
      const newIds = prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id];
      // 保存到持久化存储
      saveInspirationFavorites({ codexIds: favoriteCodexIds, kktIds: favoriteKktIds, ocIds: newIds });
      return newIds;
    });
  };

  // Codex State
  const [searchQuery, setSearchQuery] = useState('');
  const [r18Filter, setR18Filter] = useState<R18Filter>(() =>
    externalCodexFilter?.r18Filter || 'all'
  );
  const [selectedCategories, setSelectedCategories] = useState<string[]>(() =>
    externalCodexFilter?.selectedCategories || []
  );
  const [isCategoryDropdownOpen, setIsCategoryDropdownOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list'); // Default to list for efficiency
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [displayCount, setDisplayCount] = useState(50); // 分页显示数量

  // 当筛选设置变化时同步到外部
  useEffect(() => {
    if (onCodexFilterChange) {
      onCodexFilterChange({
        r18Filter,
        selectedCategories,
      });
    }
  }, [r18Filter, selectedCategories, onCodexFilterChange]);

  // KKT State
  const [kktSearchQuery, setKktSearchQuery] = useState('');
  const [isKktAboutOpen, setIsKktAboutOpen] = useState(false);
  const [isKktFilterOpen, setIsKktFilterOpen] = useState(false);
  const [kktDetailItem, setKktDetailItem] = useState<KktRecord | null>(null);
  const [kktNsfwEnabled, setKktNsfwEnabled] = useState(false);
  const [kktSelectedTags, setKktSelectedTags] = useState<string[]>([]);
  const [kktTagInput, setKktTagInput] = useState('');
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [kktAvailableTags, setKktAvailableTags] = useState<string[]>(["sex", "nsfw", "loli", "chibi"]);

  // KKT 真实数据状态
  const [kktItems, setKktItems] = useState<KktRecord[]>([]);
  const [kktResetKey, setKktResetKey] = useState(0);
  const [kktTotal, setKktTotal] = useState(0);
  const [kktPage, setKktPage] = useState(1);
  const [kktTotalPages, setKktTotalPages] = useState(1);
  const [isKktLoading, setIsKktLoading] = useState(false);
  const [kktError, setKktError] = useState<string | null>(null);
  const kktSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // KKT 高级筛选
  const [kktFilterAuthor, setKktFilterAuthor] = useState('');
  const [kktFilterDateStart, setKktFilterDateStart] = useState('');
  const [kktFilterDateEnd, setKktFilterDateEnd] = useState('');
  const [kktTimeRange, setKktTimeRange] = useState('');
  const [kktFilterOcName, setKktFilterOcName] = useState('');
  const [kktFilterCharacter, setKktFilterCharacter] = useState('');
  const [characterData, setCharacterData] = useState<{ en: string, zh: string }[]>([]);

  // 缓存角色过滤结果避免渲染卡顿
  const filteredCharacters = useMemo(() => {
    if (!kktFilterCharacter || kktFilterCharacter.length < 2) return [];
    const q = kktFilterCharacter.toLowerCase();
    const result: { en: string, zh: string }[] = [];
    for (const c of characterData) {
      if (c.en === kktFilterCharacter || c.zh === kktFilterCharacter) continue;
      if (c.en.toLowerCase().includes(q) || c.zh.toLowerCase().includes(q)) {
        result.push(c);
        if (result.length >= 10) break;
      }
    }
    return result;
  }, [kktFilterCharacter, characterData]);

  // 下载图片中的状态
  const [downloadingKktId, setDownloadingKktId] = useState<string | null>(null);

  // 下载KKT图片并触发导入
  const handleKktImportImage = useCallback(async (item: KktRecord, onDone?: () => void) => {
    if (!item.image_url || !onImportImage) return;

    setDownloadingKktId(item.name);
    try {
      const imageUrl = resolveKktImageUrl(item.image_url, false); // 获取原图URL
      if (!imageUrl) return;

      const response = await fetch(imageUrl);
      if (!response.ok) throw new Error('下载图片失败');

      const blob = await response.blob();
      const fileName = item.name + '.png';
      const file = new File([blob], fileName, { type: blob.type || 'image/png' });

      // 转换为 dataUrl
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        onImportImage(file, dataUrl);
        onDone?.();   // 关闭详情弹窗（如果有的话）
        onClose();    // 关闭灵感空间窗口
      };
      reader.readAsDataURL(blob);
    } catch (error) {
      console.error('导入图片失败:', error);
      alert('导入图片失败，请重试');
    } finally {
      setDownloadingKktId(null);
    }
  }, [onImportImage, onClose]);

  // -- Codex Logic --
  // 分类按 NSFW/Common 分组
  const categoriesByType = useMemo(() => {
    const nsfwCategories = new Set<string>();
    const commonCategories = new Set<string>();

    codexData.forEach(item => {
      if (item.isR18) {
        nsfwCategories.add(item.category);
      } else {
        commonCategories.add(item.category);
      }
    });

    return {
      nsfw: Array.from(nsfwCategories).sort(),
      common: Array.from(commonCategories).sort()
    };
  }, [codexData]);

  // 所有分类（用于向后兼容）
  const allCategories = useMemo(() =>
    [...categoriesByType.nsfw, ...categoriesByType.common].filter((v, i, a) => a.indexOf(v) === i),
    [categoriesByType]
  );

  const filteredCodex = useMemo(() => {
    return codexData.filter(item => {
      // Search - 支持搜索标题、内容和Tag序号，支持多关键词拆分匹配
      if (searchQuery) {
        const terms = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
        const titleLower = item.title.toLowerCase();
        const contentLower = item.content.toLowerCase();
        // 提取原始ID进行匹配（去掉 nsfw_ 或 common_ 前缀，保留 Tag1、Tag2 等）
        const originalId = item.id.replace(/^(nsfw_|common_)/, '').toLowerCase();

        const match = terms.every(term => 
          titleLower.includes(term) || 
          contentLower.includes(term) || 
          originalId.includes(term)
        );

        if (!match) {
          return false;
        }
      }
      // R18 Filter
      if (r18Filter === 'safe' && item.isR18) return false;
      if (r18Filter === 'r18' && !item.isR18) return false;

      // Category Filter - 需要同时匹配分类名和类型
      if (selectedCategories.length > 0) {
        // selectedCategories 格式: "nsfw:姿势类" 或 "common:风格类"
        const itemKey = `${item.isR18 ? 'nsfw' : 'common'}:${item.category}`;
        if (!selectedCategories.includes(itemKey)) return false;
      }

      return true;
    });
  }, [codexData, searchQuery, r18Filter, selectedCategories]);

  // 分页显示的数据
  const displayedCodex = useMemo(() => {
    return filteredCodex.slice(0, displayCount);
  }, [filteredCodex, displayCount]);

  // 重置分页当筛选条件变化时
  useEffect(() => {
    setDisplayCount(50);
  }, [searchQuery, r18Filter, selectedCategories]);

  // 加载更多
  const loadMoreCodex = () => {
    setDisplayCount(prev => Math.min(prev + 50, filteredCodex.length));
  };

  // 滚动加载更多
  const handleCodexScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 200 && displayCount < filteredCodex.length) {
      loadMoreCodex();
    }
  };

  // -- KKT Logic (真实 API) --
  // 用 ref 同步筛选值，避免 useCallback 闭包过期
  const kktSearchRef = useRef(kktSearchQuery);
  const kktTagsRef = useRef(kktSelectedTags);
  const kktAuthorRef = useRef(kktFilterAuthor);
  const kktNsfwRef = useRef(kktNsfwEnabled);
  const kktTimeRangeRef = useRef(kktTimeRange);
  const kktOcNameRef = useRef(kktFilterOcName);
  const kktDateStartRef = useRef(kktFilterDateStart);
  const kktDateEndRef = useRef(kktFilterDateEnd);
  const ocDataRef = useRef(ocData);
  kktSearchRef.current = kktSearchQuery;
  kktTagsRef.current = kktSelectedTags;
  kktAuthorRef.current = kktFilterAuthor;
  kktNsfwRef.current = kktNsfwEnabled;
  kktTimeRangeRef.current = kktTimeRange;
  kktOcNameRef.current = kktFilterOcName;
  kktDateStartRef.current = kktFilterDateStart;
  kktDateEndRef.current = kktFilterDateEnd;
  ocDataRef.current = ocData;
  const kktCharacterRef = useRef(kktFilterCharacter);
  kktCharacterRef.current = kktFilterCharacter;

  const loadKktData = useCallback(async (page = 1, resetList = true) => {
    setIsKktLoading(true);
    setKktError(null);
    try {
      const params: KktListParams = {
        page,
        page_size: 50,
        sort: 'newest',
      };
      if (kktSearchRef.current || kktCharacterRef.current) {
        const parts = [kktSearchRef.current, kktCharacterRef.current].filter(Boolean);
        params.search = parts.join(' ');
      }
      if (kktTagsRef.current.length > 0) params.tags = kktTagsRef.current.join(',');
      if (kktAuthorRef.current) params.user_id = kktAuthorRef.current;
      // NSFW 过滤与标签筛选叠加
      if (!kktNsfwRef.current) params.nsfw = false;
      if (kktTimeRangeRef.current) params.time_range = kktTimeRangeRef.current;
      if (kktOcNameRef.current) {
        const selectedOc = ocDataRef.current.find(oc => oc.name === kktOcNameRef.current);
        if (selectedOc && selectedOc.positive) {
          params.oc_tags = selectedOc.positive;
        }
      }
      if (kktDateStartRef.current) params.date_start = kktDateStartRef.current;
      if (kktDateEndRef.current) params.date_end = kktDateEndRef.current;
      params.has_image = true;

      console.log('[KKT] loadKktData → params:', JSON.stringify(params));
      const res = await getKktList(params);
      console.log('[KKT] loadKktData → response:', res.total, 'total,', res.items.length, 'items, page', res.page);
      setKktItems(prev => {
        const newItems = resetList ? res.items : [...prev, ...res.items];
        console.log('[KKT] setKktItems:', prev.length, '→', newItems.length);
        if (resetList) setKktResetKey(k => k + 1);
        return newItems;
      });
      setKktTotal(res.total);
      setKktPage(res.page);
      setKktTotalPages(res.total_pages);
    } catch (e) {
      setKktError('加载失败，请检查 KKT 服务器连接');
    } finally {
      setIsKktLoading(false);
    }
  }, []); // 无依赖 —— 永远从 ref 读最新值

  // 切换到 KKT tab 时加载数据
  useEffect(() => {
    if (isOpen && activeTab === 'kkt' && kktItems.length === 0 && !isKktLoading) {
      loadKktData(1, true);
    }
  }, [isOpen, activeTab]);

  // 搜索输入防抖（仅文字输入 400ms）
  useEffect(() => {
    if (activeTab !== 'kkt') return;
    if (kktSearchTimer.current) clearTimeout(kktSearchTimer.current);
    kktSearchTimer.current = setTimeout(() => {
      loadKktData(1, true);
    }, 400);
    return () => { if (kktSearchTimer.current) clearTimeout(kktSearchTimer.current); };
  }, [kktSearchQuery]);

  const handleKktScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 300 && !isKktLoading && kktPage < kktTotalPages) {
      loadKktData(kktPage + 1, false);
    }
  };

  const toggleKktTag = (tag: string) => {
    const newTags = kktSelectedTags.includes(tag)
      ? kktSelectedTags.filter(t => t !== tag)
      : [...kktSelectedTags, tag];
    kktTagsRef.current = newTags;
    setKktSelectedTags(newTags);
    console.log('[KKT] toggleKktTag → newTags:', newTags, '→ calling loadKktData');
    loadKktData(1, true);  // ref 已更新，直接调用
  };

  const handleAddKktTag = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && kktTagInput.trim()) {
      const newTag = kktTagInput.trim();
      if (!kktAvailableTags.includes(newTag)) {
        setKktAvailableTags(prev => [...prev, newTag]);
      }
      const newTags = kktSelectedTags.includes(newTag)
        ? kktSelectedTags
        : [...kktSelectedTags, newTag];
      kktTagsRef.current = newTags;
      setKktSelectedTags(newTags);
      setKktTagInput('');
      setIsAddingTag(false);
      loadKktData(1, true);
    }
  };

  const handleDeleteKktTag = (tagToDelete: string, e: React.MouseEvent) => {
    e.stopPropagation();
    console.log('[KKT] deleteTag:', tagToDelete, 'wasSelected:', kktSelectedTags.includes(tagToDelete));
    setKktAvailableTags(prev => prev.filter(tag => tag !== tagToDelete));
    const newTags = kktSelectedTags.filter(tag => tag !== tagToDelete);
    kktTagsRef.current = newTags;
    setKktSelectedTags(newTags);
    console.log('[KKT] deleteTag → newTags:', newTags, '→ calling loadKktData');
    loadKktData(1, true);
  };

  // 基于外部筛选设置过滤的法典数据（用于随机灵感）
  const externalFilteredCodex = useMemo(() => {
    if (!externalCodexFilter) return filteredCodex;

    const { r18Filter: extR18Filter, selectedCategories: extCategories } = externalCodexFilter;

    // 如果外部没有设置任何筛选条件，使用当前页面的筛选结果
    if (extR18Filter === 'all' && extCategories.length === 0) {
      return filteredCodex;
    }

    return codexData.filter(item => {
      // R18 Filter
      if (extR18Filter === 'safe' && item.isR18) return false;
      if (extR18Filter === 'r18' && !item.isR18) return false;

      // Category Filter
      if (extCategories.length > 0) {
        const itemKey = `${item.isR18 ? 'nsfw' : 'common'}:${item.category}`;
        if (!extCategories.includes(itemKey)) return false;
      }

      return true;
    });
  }, [codexData, filteredCodex, externalCodexFilter]);

  // 随机灵感预览弹窗状态
  const [randomPreviewItem, setRandomPreviewItem] = useState<CodexItem | null>(null);
  const [isRerolling, setIsRerolling] = useState(false);

  const handleRandomCodex = () => {
    // 优先使用外部筛选设置的结果
    const targetData = externalCodexFilter ? externalFilteredCodex : filteredCodex;

    if (targetData.length > 0) {
      const randomItem = targetData[Math.floor(Math.random() * targetData.length)];
      // 显示预览弹窗，让用户确认
      setRandomPreviewItem(randomItem);
    }
  };

  // 确认添加随机灵感
  const handleConfirmRandomAdd = () => {
    if (randomPreviewItem) {
      onSelectPrompt(randomPreviewItem.content);
      setRandomPreviewItem(null);
      onClose();
    }
  };

  // 重新随机（带动画）
  const handleReroll = () => {
    const targetData = externalCodexFilter ? externalFilteredCodex : filteredCodex;
    if (targetData.length > 0) {
      setIsRerolling(true);
      // 延迟切换内容，让动画有时间播放
      setTimeout(() => {
        const randomItem = targetData[Math.floor(Math.random() * targetData.length)];
        setRandomPreviewItem(randomItem);
        setIsRerolling(false);
      }, 150);
    }
  };

  const toggleCategory = (cat: string) => {
    setSelectedCategories(prev =>
      prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]
    );
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md animate-in fade-in duration-300" onClick={onClose}>
      {/* About Modal */}
      {isAboutOpen && (
        <div className="absolute inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setIsAboutOpen(false)}>
          <div className="bg-[#1e1e2e] border border-gray-700 rounded-xl p-6 max-w-md w-full shadow-2xl relative animate-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setIsAboutOpen(false)}
              className="absolute top-4 right-4 p-1 text-gray-400 hover:text-white rounded-lg hover:bg-white/10 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 bg-indigo-500/20 rounded-xl">
                <Book className="w-8 h-8 text-indigo-400" />
              </div>
              <div>
                <h3 className="text-xl font-bold text-white">关于所长法典</h3>
                <p className="text-xs text-gray-400">Director's Codex</p>
              </div>
            </div>

            <div className="space-y-4 text-sm text-gray-300">
              <p>
                所长法典是一个精心收集的 AI 绘画提示词（Prompt）数据库，旨在为创作者提供高质量的灵感参考。
              </p>
              <div className="bg-black/30 rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Search className="w-4 h-4 text-indigo-400" />
                  <span>支持模糊搜索与标签筛选</span>
                </div>
                <div className="flex items-center gap-2">
                  <Copy className="w-4 h-4 text-green-400" />
                  <span>一键复制或应用提示词</span>
                </div>
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-pink-400" />
                  <span>包含 R18 与全年龄向内容</span>
                </div>
              </div>
              <p className="text-xs text-gray-500 pt-2 border-t border-gray-700">
                数据来源：NAI_NSFW.json & NAI_Common.json
                <br />
                {codexStats && (
                  <>
                    总计 {codexStats.total} 条 (涩涩 {codexStats.nsfwCount} / 常规 {codexStats.commonCount})
                    <br />
                  </>
                )}
                当前版本：v2025.7.29
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 随机灵感预览弹窗 */}
      {randomPreviewItem && (
        <div className="absolute inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setRandomPreviewItem(null)}>
          <div className="bg-[#1e1e2e] border border-gray-700 rounded-xl p-6 w-[480px] h-[400px] shadow-2xl relative animate-in zoom-in-95 duration-200 overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setRandomPreviewItem(null)}
              className="absolute top-4 right-4 p-1 text-gray-400 hover:text-white rounded-lg hover:bg-white/10 transition-colors z-10"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-4 relative shrink-0">
              <div className="p-3 bg-gradient-to-br from-indigo-500/20 to-purple-500/20 rounded-xl">
                <Dice5 className="w-8 h-8 text-indigo-400" />
              </div>
              <div>
                <h3 className="text-xl font-bold text-white">随机灵感</h3>
                <p className="text-xs text-gray-400">Random Inspiration</p>
              </div>
            </div>

            <div className={`flex-1 flex flex-col min-h-0 transition-opacity duration-100 ${isRerolling ? 'opacity-0' : 'opacity-100'}`}>
              {/* 标题和分类 */}
              <div className="flex items-center gap-2 shrink-0 mb-4 overflow-hidden">
                <span className="text-lg font-bold text-white truncate min-w-0 shrink" title={getCodexDisplayTitle(randomPreviewItem)}>{getCodexDisplayTitle(randomPreviewItem)}</span>
                <span className={`px-2 py-0.5 rounded text-xs font-bold whitespace-nowrap shrink-0 ${randomPreviewItem.isR18
                  ? 'bg-pink-500/20 text-pink-400 border border-pink-500/30'
                  : 'bg-green-500/20 text-green-400 border border-green-500/30'
                  }`}>
                  {randomPreviewItem.isR18 ? 'R18' : '全年龄'}
                </span>
                <span className="px-2 py-0.5 bg-indigo-500/20 text-indigo-300 rounded text-xs border border-indigo-500/30 whitespace-nowrap shrink-0">
                  {randomPreviewItem.category}
                </span>
              </div>

              {/* 内容预览 - 固定高度 */}
              <div className="relative bg-black/40 rounded-lg p-4 border border-gray-700 h-[160px] shrink-0 overflow-hidden">
                <button
                  onClick={() => {
                    if (randomPreviewItem) {
                      handleCopyRandomContent(randomPreviewItem.content);
                    }
                  }}
                  className={`absolute top-2 right-2 p-1.5 rounded transition-colors ${randomCopied
                    ? 'bg-green-600 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-white/10'
                    }`}
                  title={randomCopied ? "已复制" : "复制"}
                >
                  {randomCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
                <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap h-full overflow-y-auto custom-scrollbar pr-6">
                  {randomPreviewItem.content}
                </p>
              </div>
            </div>

            {/* 操作按钮 - 不参与渐隐渐显动画 */}
            <div className="flex gap-3 pt-4 shrink-0">
              <button
                onClick={handleReroll}
                disabled={isRerolling}
                className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-all flex items-center justify-center gap-2 font-bold active:scale-95 disabled:opacity-50"
              >
                <Dice5 className="w-4 h-4" />
                换一个
              </button>
              <button
                onClick={handleConfirmRandomAdd}
                className="flex-1 py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white rounded-lg transition-all flex items-center justify-center gap-2 font-bold shadow-lg shadow-indigo-500/20 active:scale-95"
              >
                <Plus className="w-4 h-4" />
                添加到提示词
              </button>
            </div>
          </div>
        </div>
      )}

      {/* KKT Detail Modal */}
      {kktDetailItem && (
        <div className="absolute inset-0 z-[130] flex items-center justify-center bg-black/80 backdrop-blur-md animate-in fade-in duration-200 p-4 lg:p-12" onClick={() => setKktDetailItem(null)}>
          <div className="bg-[#161722] border border-gray-700 rounded-2xl w-full max-w-5xl h-[85vh] shadow-2xl relative flex flex-col md:flex-row overflow-hidden animate-in zoom-in-95 duration-300" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setKktDetailItem(null)}
              className="absolute top-4 right-4 p-2 text-gray-400 hover:text-white bg-black/20 hover:bg-black/40 rounded-full transition-all z-50 backdrop-blur-sm shadow-xl"
              title="关闭详情"
            >
              <X className="w-5 h-5" />
            </button>

            {/* Left Area: Image Viewer */}
            <div className="md:w-1/2 h-64 md:h-full bg-black/60 relative flex items-center justify-center p-4 border-b md:border-b-0 md:border-r border-gray-800">
              {kktDetailItem.image_url ? (
                <div className="relative w-full h-full flex items-center justify-center">
                  {/* Loading skeleton */}
                  <div
                    id={`detail-img-skeleton-${kktDetailItem.name}`}
                    className="absolute inset-0 flex items-center justify-center"
                  >
                    <div className="w-16 h-16 rounded-full border-4 border-indigo-500/30 border-t-indigo-500 animate-spin" />
                  </div>
                  <img
                    src={resolveKktImageUrl(kktDetailItem.image_url, false) || undefined}
                    alt={kktDetailItem.name}
                    className="max-w-full max-h-full object-contain drop-shadow-2xl rounded opacity-0 transition-opacity duration-500 relative z-10"
                    onLoad={e => {
                      e.currentTarget.classList.remove('opacity-0');
                      const skeleton = document.getElementById(`detail-img-skeleton-${kktDetailItem.name}`);
                      if (skeleton) skeleton.style.display = 'none';
                    }}
                  />
                </div>
              ) : (
                <ImageIcon className="w-20 h-20 text-gray-700" />
              )}
              {/* 下载原图按钮 */}
              {kktDetailItem.image_url && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    const url = resolveKktImageUrl(kktDetailItem.image_url!, false);
                    if (!url) return;
                    try {
                      const res = await fetch(url);
                      const blob = await res.blob();
                      const a = document.createElement('a');
                      a.href = URL.createObjectURL(blob);
                      const ext = kktDetailItem.image_url!.split('.').pop() || 'png';
                      a.download = `${kktDetailItem.name}.${ext}`;
                      a.click();
                      URL.revokeObjectURL(a.href);
                    } catch { /* ignore */ }
                  }}
                  className="absolute bottom-3 right-3 z-20 p-2.5 bg-black/50 hover:bg-black/80 text-gray-300 hover:text-white rounded-lg backdrop-blur-sm border border-white/10 hover:border-white/20 transition-all"
                  title="下载原图"
                >
                  <Download className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Right Area: Details & Actions */}
            <div className="md:w-1/2 flex flex-col h-full bg-[#161722]">
              {/* Header */}
              <div className="p-6 border-b border-gray-800 bg-[#1e1e2e]/50 shrink-0">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-gradient-to-br from-indigo-500/20 to-purple-500/20 rounded-xl border border-indigo-500/30 shadow-inner">
                    <Sparkles className="w-6 h-6 text-indigo-400" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white leading-tight mb-1">{kktDetailItem.name}</h2>
                    <p className="text-sm text-gray-400 flex items-center gap-2">
                      <User className="w-3.5 h-3.5" />
                      {kktDetailItem.user_name}
                      <span className="text-gray-600">|</span>
                      <Clock className="w-3.5 h-3.5" />
                      {kktDetailItem.created_time_str}
                    </p>
                  </div>
                </div>
              </div>

              {/* Scrollable Content */}
              <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">

                {/* Basic Params Grid */}
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                  {kktDetailItem.model_name && (
                    <div className="bg-black/30 p-3 rounded-lg border border-gray-800 shadow-sm">
                      <p className="text-[10px] text-gray-500 font-bold mb-1 uppercase tracking-wider flex items-center justify-between">Model</p>
                      <p className="text-xs text-indigo-300 font-mono truncate" title={resolveModelName(kktDetailItem.model_name) || kktDetailItem.model_name}>
                        {resolveModelName(kktDetailItem.model_name)}
                      </p>
                    </div>
                  )}
                  {kktDetailItem.image_size && (
                    <div className="bg-black/30 p-3 rounded-lg border border-gray-800 shadow-sm">
                      <p className="text-[10px] text-gray-500 font-bold mb-1 uppercase tracking-wider">Size</p>
                      <p className="text-xs text-gray-300 font-mono">{kktDetailItem.image_size}</p>
                    </div>
                  )}
                  {kktDetailItem.seed != null && (
                    <div className="bg-black/30 p-3 rounded-lg border border-gray-800 shadow-sm">
                      <p className="text-[10px] text-gray-500 font-bold mb-1 uppercase tracking-wider">Seed</p>
                      <p className="text-xs text-green-400 font-mono">{kktDetailItem.seed}</p>
                    </div>
                  )}
                </div>

                {/* Prompt */}
                {kktDetailItem.prompt && (
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <h4 className="text-sm font-bold text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-green-400 flex items-center gap-2">
                        <Tag className="w-4 h-4 text-emerald-400" />
                        正向提示词
                      </h4>
                      <button
                        onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(kktDetailItem.prompt!); }}
                        className="text-gray-500 hover:text-white transition-colors flex items-center gap-1 text-xs"
                        title="复制提示词"
                      >
                        <Copy className="w-3.5 h-3.5" /> 复制
                      </button>
                    </div>
                    <div className="p-4 bg-black/40 border border-gray-800 rounded-xl shadow-inner">
                      <p className="text-xs text-gray-300 font-mono leading-relaxed break-words">{kktDetailItem.prompt}</p>
                    </div>
                  </div>
                )}

                {/* Negative Prompt */}
                {kktDetailItem.negative_prompt && (
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <h4 className="text-sm font-bold text-transparent bg-clip-text bg-gradient-to-r from-rose-400 to-red-400 flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-rose-400" />
                        反向提示词
                      </h4>
                      <button
                        onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(kktDetailItem.negative_prompt!); }}
                        className="text-gray-500 hover:text-white transition-colors flex items-center gap-1 text-xs"
                        title="复制反向提示词"
                      >
                        <Copy className="w-3.5 h-3.5" /> 复制
                      </button>
                    </div>
                    <div className="p-4 bg-black/40 border border-gray-800 rounded-xl shadow-inner">
                      <p className="text-xs text-gray-400 font-mono leading-relaxed break-words">{kktDetailItem.negative_prompt}</p>
                    </div>
                  </div>
                )}

                {/* Extended Content / JSON Source */}
                <div className="pt-4 border-t border-gray-800">
                  <h4 className="text-[10px] text-gray-500 font-bold mb-2 uppercase tracking-wider flex items-center justify-between">
                    Raw Info
                    <span className="text-gray-600 font-normal normal-case">API 返回的原始数据</span>
                  </h4>
                  <div className="p-3 bg-black/20 rounded-lg whitespace-pre-wrap text-[10px] text-gray-600 font-mono max-h-32 overflow-y-auto custom-scrollbar border border-gray-800">
                    {kktDetailItem.content}
                  </div>
                </div>

              </div>

              {/* Action Bar */}
              <div className="p-6 border-t border-gray-800 bg-[#1e1e2e]/50 shrink-0 flex gap-4">
                <button
                  onClick={() => { if (!downloadingKktId) handleKktImportImage(kktDetailItem, () => setKktDetailItem(null)); }}
                  disabled={!!downloadingKktId}
                  className={`flex-1 py-3 text-white rounded-xl font-bold flex items-center justify-center gap-2 transition-all active:scale-95 ${downloadingKktId
                    ? 'bg-indigo-700 cursor-wait'
                    : 'bg-indigo-600 hover:bg-indigo-500'
                    }`}
                >
                  {downloadingKktId ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      下载中...
                    </>
                  ) : (
                    <>
                      <Download className="w-5 h-5" />
                      导入图片
                    </>
                  )}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); toggleKktFavorite(kktDetailItem.name, e as any); }}
                  className={`px-6 py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-all border ${favoriteKktIds.includes(kktDetailItem.name)
                    ? 'bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20'
                    : 'bg-black/30 border-gray-700 text-gray-400 hover:text-white hover:bg-gray-800 hover:border-gray-500'
                    }`}
                >
                  <Heart className={`w-5 h-5 ${favoriteKktIds.includes(kktDetailItem.name) ? 'fill-current' : ''}`} />
                  {favoriteKktIds.includes(kktDetailItem.name) ? '取消收藏' : '收藏作品'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* KKT About Modal */}
      {isKktAboutOpen && (
        <div className="absolute inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setIsKktAboutOpen(false)}>
          <div className="bg-[#1e1e2e] border border-gray-700 rounded-xl p-6 max-w-md w-full shadow-2xl relative animate-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setIsKktAboutOpen(false)}
              className="absolute top-4 right-4 p-1 text-gray-400 hover:text-white rounded-lg hover:bg-white/10 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 bg-indigo-500/20 rounded-xl">
                <ImageIcon className="w-8 h-8 text-indigo-400" />
              </div>
              <div>
                <h3 className="text-xl font-bold text-white">关于 KKT 收集</h3>
                <p className="text-xs text-gray-400">KKT Collection</p>
              </div>
            </div>

            <div className="space-y-4 text-sm text-gray-300">
              <p>
                KKT 收集是一个精选的 AI 插画图库，汇集了各种风格和主题的高质量生成作品，供您欣赏和参考。
              </p>
              <div className="bg-black/30 rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4 text-indigo-400" />
                  <span>支持 OC、标签及 NSFW 筛选</span>
                </div>
                <div className="flex items-center gap-2">
                  <LayoutGrid className="w-4 h-4 text-green-400" />
                  <span>自适应瀑布流布局展示</span>
                </div>
                <div className="flex items-center gap-2">
                  <Download className="w-4 h-4 text-pink-400" />
                  <span>一键导入参数进行创作</span>
                </div>
              </div>
              <p className="text-xs text-gray-500 pt-2 border-t border-gray-700">
                图片来源：社区投稿与精选
                <br />
                当前版本：v1.0.0
              </p>
            </div>
          </div>
        </div>
      )}

      {/* KKT Filter Modal */}
      {isKktFilterOpen && (
        <div className="absolute inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setIsKktFilterOpen(false)}>
          <div className="bg-[#1e1e2e] border border-gray-700 rounded-xl p-6 max-w-lg w-full shadow-2xl relative animate-in zoom-in-95 duration-200 flex flex-col gap-4" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center border-b border-gray-800 pb-4">
              <h3 className="text-xl font-bold text-white flex items-center gap-2">
                <Filter className="w-5 h-5 text-indigo-400" />
                高级筛选
              </h3>
              <button
                onClick={() => setIsKktFilterOpen(false)}
                className="p-1 text-gray-400 hover:text-white rounded-lg hover:bg-white/10 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-2 custom-scrollbar">
              {/* Text Inputs Grid */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm text-gray-400 font-bold">OC</label>
                  <div className="relative" ref={(el) => {
                    if (el) (el as any)._ocRect = el.getBoundingClientRect();
                  }}>
                    <input
                      type="text"
                      value={kktFilterOcName}
                      onChange={e => setKktFilterOcName(e.target.value)}
                      placeholder="输入角色名..."
                      className="w-full bg-black/30 border border-gray-700 rounded-lg h-10 px-3 pr-8 text-sm text-white outline-none focus:border-indigo-500 transition-all placeholder:text-gray-600"
                    />
                    {kktFilterOcName && (
                      <button
                        onClick={() => setKktFilterOcName('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-gray-500 hover:text-white transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {(() => {
                      if (!kktFilterOcName) return null;
                      const q = kktFilterOcName.toLowerCase();
                      const matched = ocData
                        .filter(oc => {
                          if (oc.name === kktFilterOcName) return false;
                          const n = oc.name.toLowerCase();
                          const en = oc.en_name.toLowerCase();
                          if (n.includes(q) || en.includes(q)) return true;
                          return oc.aliases.some(a => a.toLowerCase().includes(q));
                        })
                        .slice(0, 10);
                      if (matched.length === 0) return null;
                      return (
                        <div
                          className="fixed z-[200] bg-[#1e1e2e] border border-gray-700 rounded-lg shadow-2xl max-h-40 overflow-y-auto"
                          style={{ width: 'var(--oc-w)', left: 'var(--oc-l)', top: 'var(--oc-t)' }}
                          ref={el => {
                            if (!el) return;
                            const parent = el.previousElementSibling?.previousElementSibling?.parentElement;
                            if (parent) {
                              const rect = parent.getBoundingClientRect();
                              el.style.setProperty('--oc-w', rect.width + 'px');
                              el.style.setProperty('--oc-l', rect.left + 'px');
                              el.style.setProperty('--oc-t', (rect.bottom + 4) + 'px');
                            }
                          }}
                        >
                          {matched.map(oc => (
                            <button
                              key={oc.id}
                              onMouseDown={e => { e.preventDefault(); setKktFilterOcName(oc.name); }}
                              className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-indigo-500/20 hover:text-white transition-colors"
                            >
                              {oc.name}{oc.aliases.length > 0 && <span className="text-gray-600 ml-1 text-xs">({oc.aliases[0]})</span>}
                            </button>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-sm text-gray-400 font-bold">角色</label>
                  <div className="relative">
                    <input
                      type="text"
                      value={kktFilterCharacter}
                      onChange={e => setKktFilterCharacter(e.target.value)}
                      placeholder="输入角色英文名..."
                      className="w-full bg-black/30 border border-gray-700 rounded-lg h-10 px-3 pr-8 text-sm text-white outline-none focus:border-indigo-500 transition-all placeholder:text-gray-600"
                    />
                    {kktFilterCharacter && (
                      <button
                        onClick={() => setKktFilterCharacter('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-gray-500 hover:text-white transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {filteredCharacters.length > 0 && (
                      <div
                        className="fixed z-[200] bg-[#1e1e2e] border border-gray-700 rounded-lg shadow-2xl max-h-40 overflow-y-auto"
                        style={{ width: 'var(--ch-w)', left: 'var(--ch-l)', top: 'var(--ch-t)' }}
                        ref={el => {
                          if (!el) return;
                          const parent = el.closest('.relative');
                          if (parent) {
                            const rect = parent.getBoundingClientRect();
                            el.style.setProperty('--ch-w', rect.width + 'px');
                            el.style.setProperty('--ch-l', rect.left + 'px');
                            el.style.setProperty('--ch-t', (rect.bottom + 4) + 'px');
                          }
                        }}
                      >
                        {filteredCharacters.map((c, i) => (
                          <button
                            key={i}
                            onMouseDown={e => { e.preventDefault(); setKktFilterCharacter(c.en); }}
                            className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-indigo-500/20 hover:text-white transition-colors"
                          >
                            {c.en}{c.zh && <span className="text-gray-600 ml-1 text-xs">({c.zh})</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm text-gray-400 font-bold">关键词搜索</label>
                <input
                  type="text"
                  value={kktSearchQuery}
                  onChange={e => setKktSearchQuery(e.target.value)}
                  placeholder="搜索 prompt 内容..."
                  className="w-full bg-black/30 border border-gray-700 rounded-lg h-10 px-3 text-sm text-white outline-none focus:border-indigo-500 transition-all placeholder:text-gray-600"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm text-gray-400 font-bold">图片时间范围</label>
                <div className="flex gap-2 items-center">
                  <input
                    type="date"
                    value={kktFilterDateStart}
                    onChange={e => setKktFilterDateStart(e.target.value)}
                    className="flex-1 bg-black/30 border border-gray-700 rounded-lg h-10 px-3 text-sm text-white outline-none focus:border-indigo-500 transition-all placeholder:text-gray-600"
                  />
                  <span className="text-gray-500">-</span>
                  <input
                    type="date"
                    value={kktFilterDateEnd}
                    onChange={e => setKktFilterDateEnd(e.target.value)}
                    className="flex-1 bg-black/30 border border-gray-700 rounded-lg h-10 px-3 text-sm text-white outline-none focus:border-indigo-500 transition-all placeholder:text-gray-600"
                  />
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-gray-800 flex justify-end gap-2">
              <button
                onClick={() => {
                  setKktFilterDateStart('');
                  setKktFilterDateEnd('');
                  setKktFilterAuthor('');
                  setKktSearchQuery('');
                  setKktSelectedTags([]);
                  setKktFilterOcName('');
                  setKktFilterCharacter('');
                }}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
              >
                重置所有
              </button>
              <button
                onClick={() => { setIsKktFilterOpen(false); loadKktData(1, true); }}
                className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold transition-all shadow-lg shadow-indigo-500/20"
              >
                确认筛选
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-[#1a1b26] border border-gray-700 rounded-xl shadow-2xl w-[90vw] h-[85vh] flex overflow-hidden relative animate-in zoom-in-95 duration-300" onClick={(e) => e.stopPropagation()}>

        {/* Sidebar Navigation */}
        <div className="w-64 bg-black/30 border-r border-gray-800 flex flex-col p-4 gap-2 shrink-0">
          <div className="text-xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-pink-400 mb-6 flex items-center gap-2 px-2">
            <Sparkles className="w-6 h-6 text-pink-400 animate-pulse" />
            灵感空间
          </div>

          <NavButton
            active={activeTab === 'codex'}
            onClick={() => setActiveTab('codex')}
            icon={<Book className="w-5 h-5" />}
            label="所长法典"
            desc="NSFW & Common Tags"
          />
          <NavButton
            active={activeTab === 'kkt'}
            onClick={() => setActiveTab('kkt')}
            icon={<ImageIcon className="w-5 h-5" />}
            label="KKT 收集"
            desc="AI Art Gallery"
          />
          <NavButton
            active={activeTab === 'oc'}
            onClick={() => setActiveTab('oc')}
            icon={<Users className="w-5 h-5" />}
            label="原创角色"
            desc="Original Characters"
          />
          <NavButton
            active={activeTab === 'favorites'}
            onClick={() => setActiveTab('favorites')}
            icon={<Heart className="w-5 h-5" />}
            label="我的收藏"
            desc="My Favorites"
          />

          <div className="mt-auto">
            {/* 显示当前筛选状态 */}
            {(r18Filter !== 'all' || selectedCategories.length > 0) && (
              <div className="mb-2 text-xs text-gray-500 text-center">
                筛选: {r18Filter === 'r18' ? 'R18' : r18Filter === 'safe' ? '全年龄' : '全部'}
                {selectedCategories.length > 0 && ` · ${selectedCategories.length} 分类`}
                {` · ${externalFilteredCodex.length} 条随机灵感`}
              </div>
            )}
            <button
              onClick={handleRandomCodex}
              title={`基于当前筛选设置随机 (${externalFilteredCodex.length} 条可选)`}
              className="w-full py-3 bg-gradient-to-r from-indigo-500 to-purple-500 hover:from-indigo-400 hover:to-purple-400 text-white rounded-lg transition-all flex items-center justify-center gap-2 font-bold shadow-lg hover:shadow-indigo-500/30 active:scale-95 group"
            >
              <Dice5 className="w-5 h-5 group-hover:rotate-180 transition-transform duration-500" />
              随机灵感
            </button>
          </div>
        </div>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#121212]">

          {/* Codex Tab */}
          {activeTab === 'codex' && (
            <div className="flex flex-col h-full animate-in slide-in-from-right-8 fade-in duration-300">
              {/* Header / Filter Bar */}
              <div className="p-4 border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm z-10">
                <div className="flex justify-between items-center mb-3">
                  <div className="flex items-center gap-4 flex-1">
                    <div className="flex items-center gap-2 shrink-0">
                      <Book className="w-6 h-6 text-indigo-400" />
                      <h2 className="text-xl font-bold text-white">所长法典</h2>
                      <button
                        onClick={() => setIsAboutOpen(true)}
                        className="text-gray-600 hover:text-indigo-400 transition-colors"
                        title="关于法典"
                      >
                        <Info className="w-4 h-4" />
                      </button>
                      {/* 显示结果数量 */}
                      {!isCodexLoading && (
                        <span className="text-xs text-gray-500 ml-2">
                          {filteredCodex.length} / {codexData.length}
                        </span>
                      )}
                    </div>

                    {/* Search Bar */}
                    <div className="relative group flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 group-focus-within:text-indigo-500 transition-colors" />
                      <input
                        type="text"
                        placeholder="搜索法典内容..."
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        className="w-full bg-black/30 border border-gray-800 rounded-full pl-10 pr-4 h-10 text-sm text-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all outline-none placeholder:text-gray-600"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2 ml-4">

                    <button
                      onClick={onClose}
                      className="px-4 h-11 bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 border border-red-500/20 hover:border-red-500/50 rounded-lg transition-all flex items-center gap-2 font-bold active:scale-95"
                    >
                      <X className="w-5 h-5" />
                      关闭
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-4">
                  {/* R18 Filter with Sliding Animation */}
                  <div className="grid grid-cols-3 gap-1 bg-black/30 rounded-lg p-1 border border-gray-800 relative w-[200px] h-9">
                    <div
                      className="absolute inset-y-1 bg-gray-700 rounded-md shadow transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]"
                      style={{
                        width: 'calc((100% - 16px) / 3)',
                        transform: `translateX(${r18Filter === 'all' ? '0' : r18Filter === 'safe' ? 'calc(100% + 4px)' : 'calc(200% + 8px)'})`,
                        left: '4px'
                      }}
                    />
                    {[
                      { value: 'all', label: '全部' },
                      { value: 'safe', label: '全年龄' },
                      { value: 'r18', label: 'R18' }
                    ].map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => setR18Filter(opt.value as R18Filter)}
                        className={`relative z-10 px-3 h-full flex items-center justify-center text-xs font-bold rounded-md transition-colors ${r18Filter === opt.value ? 'text-white' : 'text-gray-400 hover:text-gray-200'
                          }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  <div className="w-px h-6 bg-gray-700" />

                  {/* Category Dropdown */}
                  <div className="relative">
                    <button
                      onClick={() => setIsCategoryDropdownOpen(!isCategoryDropdownOpen)}
                      className={`flex items-center gap-2 px-4 h-9 rounded-lg border transition-all ${selectedCategories.length > 0
                        ? 'bg-indigo-500/20 border-indigo-500 text-indigo-300'
                        : 'bg-black/30 border-gray-800 text-gray-400 hover:text-white'
                        }`}
                    >
                      <Filter className="w-4 h-4" />
                      <span className="text-xs font-bold">筛选分类</span>
                      {selectedCategories.length > 0 && (
                        <span className="bg-indigo-500 text-white text-[10px] px-1.5 py-0.5 rounded-full min-w-[1.2em] text-center font-bold">
                          {selectedCategories.length}
                        </span>
                      )}
                      <ChevronDown className={`w-4 h-4 transition-transform duration-300 ${isCategoryDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {/* Backdrop */}
                    {isCategoryDropdownOpen && (
                      <div className="fixed inset-0 z-40" onClick={() => setIsCategoryDropdownOpen(false)} />
                    )}

                    {/* Dropdown Menu */}
                    {isCategoryDropdownOpen && (
                      <div className="absolute top-full left-0 mt-2 w-64 bg-[#1e1e2e] border border-gray-700 rounded-xl shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                        <div className="p-2 space-y-1 max-h-[400px] overflow-y-auto custom-scrollbar">
                          {/* NSFW 分类 */}
                          {categoriesByType.nsfw.length > 0 && (
                            <>
                              <div className="px-2 py-1 text-xs font-bold text-red-400 flex items-center gap-1 border-b border-gray-800 mb-1">
                                <span className="w-2 h-2 rounded-full bg-red-500"></span>
                                涩涩分类 ({categoriesByType.nsfw.length})
                              </div>
                              {categoriesByType.nsfw.map(cat => {
                                const catKey = `nsfw:${cat}`;
                                const isSelected = selectedCategories.includes(catKey);
                                return (
                                  <div
                                    key={catKey}
                                    onClick={() => toggleCategory(catKey)}
                                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/5 cursor-pointer transition-colors group"
                                  >
                                    <div className={`w-5 h-5 rounded border flex items-center justify-center transition-all ${isSelected ? 'bg-red-600 border-red-600' : 'border-gray-600 group-hover:border-gray-500'
                                      }`}>
                                      {isSelected && <Check className="w-3 h-3 text-white" />}
                                    </div>
                                    <span className={`text-sm ${isSelected ? 'text-white font-bold' : 'text-gray-400 group-hover:text-gray-300'}`}>
                                      {cat}
                                    </span>
                                  </div>
                                );
                              })}
                            </>
                          )}

                          {/* Common 分类 */}
                          {categoriesByType.common.length > 0 && (
                            <>
                              <div className="px-2 py-1 text-xs font-bold text-green-400 flex items-center gap-1 border-b border-gray-800 mb-1 mt-2">
                                <span className="w-2 h-2 rounded-full bg-green-500"></span>
                                常规分类 ({categoriesByType.common.length})
                              </div>
                              {categoriesByType.common.map(cat => {
                                const catKey = `common:${cat}`;
                                const isSelected = selectedCategories.includes(catKey);
                                return (
                                  <div
                                    key={catKey}
                                    onClick={() => toggleCategory(catKey)}
                                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/5 cursor-pointer transition-colors group"
                                  >
                                    <div className={`w-5 h-5 rounded border flex items-center justify-center transition-all ${isSelected ? 'bg-green-600 border-green-600' : 'border-gray-600 group-hover:border-gray-500'
                                      }`}>
                                      {isSelected && <Check className="w-3 h-3 text-white" />}
                                    </div>
                                    <span className={`text-sm ${isSelected ? 'text-white font-bold' : 'text-gray-400 group-hover:text-gray-300'}`}>
                                      {cat}
                                    </span>
                                  </div>
                                );
                              })}
                            </>
                          )}

                          {categoriesByType.nsfw.length === 0 && categoriesByType.common.length === 0 && (
                            <div className="p-4 text-center text-gray-500 text-xs">暂无分类</div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Content List */}
              <div
                className="flex-1 overflow-y-auto p-4 content-start flex flex-col gap-3"
                onScroll={handleCodexScroll}
              >
                {isCodexLoading ? (
                  <div className="col-span-full flex flex-col items-center justify-center py-20 text-gray-500">
                    <Loader2 className="w-8 h-8 animate-spin mb-4 text-indigo-500" />
                    <p>正在加载法典数据...</p>
                  </div>
                ) : filteredCodex.length === 0 ? (
                  <div className="col-span-full flex flex-col items-center justify-center py-20 text-gray-500">
                    <Book className="w-12 h-12 mb-4 opacity-30" />
                    <p>没有找到匹配的内容</p>
                    <p className="text-xs mt-1">尝试调整搜索条件或筛选器</p>
                  </div>
                ) : (
                  <>
                    {displayedCodex.map((item, index) => (
                      <div
                        key={item.id}
                        className="group bg-[#1e1e2e] border border-gray-800 hover:border-indigo-500/50 hover:bg-[#252535] transition-all duration-200 flex items-center rounded-lg p-4 hover:translate-x-1"
                      >
                        <div className="w-28 shrink-0">
                          <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${item.isR18 ? 'border-red-500/30 text-red-400 bg-red-500/10' : 'border-green-500/30 text-green-400 bg-green-500/10'}`}>
                            {item.category}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0 mr-4">
                          <div className="flex items-baseline gap-2">
                            <h3 className="font-bold text-gray-200 text-base whitespace-nowrap">{getCodexDisplayTitle(item)}</h3>
                            <p className="text-sm text-gray-600 truncate" title={item.content}>
                              {item.content}
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          <button
                            onClick={() => handleCopyContent(item.id, item.content)}
                            className={`p-2.5 rounded-lg transition-colors ${copiedItemId === item.id
                              ? 'bg-green-600 text-white'
                              : 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white'
                              }`}
                            title={copiedItemId === item.id ? "已复制" : "复制"}
                          >
                            {copiedItemId === item.id ? <Check className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
                          </button>
                          <button
                            onClick={(e) => toggleCodexFavorite(item.id, e)}
                            className={`p-2.5 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors ${favoriteCodexIds.includes(item.id) ? 'text-red-500 hover:text-red-400' : 'text-gray-400 hover:text-white'}`}
                            title="收藏"
                          >
                            <Heart className={`w-5 h-5 ${favoriteCodexIds.includes(item.id) ? 'fill-current' : ''}`} />
                          </button>
                          <button
                            onClick={() => handleAddCodexTag(item.id, item.title, item.content)}
                            className={`px-5 py-2.5 rounded-lg text-sm font-bold transition-colors flex items-center gap-2 shadow-lg ${addedItemId === item.id
                              ? 'bg-green-600 text-white shadow-green-500/20'
                              : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-500/20'
                              }`}
                          >
                            {addedItemId === item.id ? (
                              <>
                                <Check className="w-4 h-4" />
                                已添加
                              </>
                            ) : (
                              <>
                                <Sparkles className="w-4 h-4" />
                                添加
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    ))}
                    {/* 加载更多提示 */}
                    {displayCount < filteredCodex.length && (
                      <div className="col-span-full flex justify-center py-4">
                        <button
                          onClick={loadMoreCodex}
                          className="px-6 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm transition-colors flex items-center gap-2"
                        >
                          <Loader2 className="w-4 h-4" />
                          加载更多 ({displayCount} / {filteredCodex.length})
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* KKT Tab */}
          {activeTab === 'kkt' && (
            <div className="h-full flex flex-col animate-in slide-in-from-right-8 fade-in duration-300">
              {/* Top Bar */}
              <div className="px-4 py-2 border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm z-10">
                <div className="flex justify-between items-center mb-2">
                  <div className="flex items-center gap-4 flex-1">
                    <div className="flex items-center gap-2 shrink-0">
                      <ImageIcon className="w-6 h-6 text-indigo-400" />
                      <h2 className="text-xl font-bold text-white">KKT 收集</h2>
                      <button
                        onClick={() => setIsKktAboutOpen(true)}
                        className="text-gray-600 hover:text-indigo-400 transition-colors"
                        title="关于 KKT"
                      >
                        <Info className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Search Bar */}
                    <div className="relative group flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 group-focus-within:text-indigo-500 transition-colors" />
                      <input
                        type="text"
                        placeholder="名称 / 标签 / 编号 / 种子..."
                        value={kktSearchQuery}
                        onChange={e => setKktSearchQuery(e.target.value)}
                        className="w-full bg-black/30 border border-gray-800 rounded-full pl-10 pr-4 h-10 text-sm text-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all outline-none placeholder:text-gray-600"
                      />
                    </div>

                    {/* NSFW Toggle */}
                    <button
                      onClick={() => {
                        const newVal = !kktNsfwEnabled;
                        kktNsfwRef.current = newVal;
                        setKktNsfwEnabled(newVal);
                        loadKktData(1, true);
                      }}
                      className={`shrink-0 flex items-center gap-2 px-3 h-10 rounded-xl border transition-all duration-300 ${kktNsfwEnabled
                        ? 'bg-amber-500/15 border-amber-500/50 shadow-[0_0_12px_rgba(245,158,11,0.15)]'
                        : 'bg-gray-900/50 border-gray-700/50 hover:border-gray-600 shadow-[0_0_12px_transparent]'
                        }`}
                      title={kktNsfwEnabled ? "NSFW 内容显示中" : "NSFW 内容已隐藏"}
                    >
                      <div className={`w-9 h-5 rounded-full relative shrink-0 transition-colors duration-300 ${kktNsfwEnabled ? 'bg-amber-500' : 'bg-gray-600'}`}>
                        <div className={`absolute top-0.5 w-4 h-4 rounded-full shadow-md transition-all duration-300 ${kktNsfwEnabled ? 'left-[18px] bg-white' : 'left-0.5 bg-gray-300'}`} />
                      </div>
                      <span className={`text-xs font-bold tracking-wide transition-colors duration-300 ${kktNsfwEnabled ? 'text-amber-400' : 'text-gray-500'}`}>NSFW</span>
                    </button>
                  </div>

                  <div className="flex items-center gap-2 ml-4">
                    <button
                      onClick={() => {
                        setIsKktFilterOpen(true);
                        if (ocData.length === 0) {
                          getPublicOCs().then(data => {
                            setOcData(data.map(oc => ({
                              id: oc.id,
                              name: oc.zh_name || oc.en_name,
                              en_name: oc.en_name,
                              aliases: oc.zh_aliases || [],
                              preview: oc.preview_url ? getOCPreviewUrl(oc.en_name) : '',
                              positive: oc.tag_group,
                              created_by: oc.created_by || '',
                            })));
                          });
                        }
                      }}
                      className="flex items-center gap-2 px-4 h-11 bg-black/30 hover:bg-black/50 border border-gray-800 hover:border-gray-600 text-gray-300 rounded-lg transition-all font-bold"
                    >
                      <Filter className="w-5 h-5" />
                      筛选
                    </button>
                    <button
                      onClick={onClose}
                      className="px-4 h-11 bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 border border-red-500/20 hover:border-red-500/50 rounded-lg transition-all flex items-center gap-2 font-bold active:scale-95"
                    >
                      <X className="w-5 h-5" />
                      关闭
                    </button>
                  </div>
                </div>

                {/* Quick Tags & Filters */}
                <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide">
                  <div className="shrink-0 flex items-center h-8 rounded-full bg-black/40 border border-gray-800 p-0.5 gap-px">
                    {[
                      { value: '', label: '全' },
                      { value: 'today', label: '日' },
                      { value: 'week', label: '周' },
                      { value: 'month', label: '月' },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => {
                          kktTimeRangeRef.current = opt.value;
                          setKktTimeRange(opt.value);
                          loadKktData(1, true);
                        }}
                        className={`h-7 px-2.5 rounded-full text-[11px] font-bold transition-all duration-300 active:scale-90 ${kktTimeRange === opt.value
                          ? 'bg-indigo-500/20 text-indigo-300 shadow-[0_0_8px_rgba(99,102,241,0.15)]'
                          : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
                          }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  <div className="w-px h-5 bg-gray-700 shrink-0 mx-1" />

                  {/* Add Tag Button / Input */}
                  <div className="shrink-0">
                    {isAddingTag ? (
                      <div className="h-7 flex items-center bg-black/30 border border-indigo-500 rounded-full pl-3 pr-2 animate-in fade-in zoom-in duration-200">
                        <input
                          autoFocus
                          type="text"
                          value={kktTagInput}
                          onChange={e => setKktTagInput(e.target.value)}
                          onKeyDown={handleAddKktTag}
                          onBlur={() => { if (!kktTagInput) setIsAddingTag(false); }}
                          placeholder="输入标签..."
                          className="w-16 bg-transparent text-[10px] text-white outline-none placeholder:text-gray-600"
                        />
                        <button
                          onClick={() => {
                            if (kktTagInput.trim()) {
                              const newTag = kktTagInput.trim();
                              if (!kktAvailableTags.includes(newTag)) setKktAvailableTags(prev => [...prev, newTag]);
                              const newTags = kktSelectedTags.includes(newTag)
                                ? kktSelectedTags
                                : [...kktSelectedTags, newTag];
                              kktTagsRef.current = newTags;
                              setKktSelectedTags(newTags);
                              setKktTagInput('');
                              loadKktData(1, true);
                            }
                            setIsAddingTag(false);
                          }}
                          className={`p-0.5 rounded-full transition-colors ${kktTagInput.trim() ? 'hover:bg-indigo-500/20 text-indigo-400 hover:text-indigo-300' : 'text-gray-500 hover:bg-white/10 hover:text-gray-300'}`}
                          title={kktTagInput.trim() ? "添加标签" : "关闭"}
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setIsAddingTag(true)}
                        className="h-8 w-8 rounded-full border border-gray-800 bg-gray-900/50 text-gray-400 hover:text-white hover:border-indigo-500 hover:bg-indigo-500/10 transition-all flex items-center justify-center group"
                        title="添加标签"
                      >
                        <Plus className="w-3.5 h-3.5 group-hover:scale-110 transition-transform" />
                      </button>
                    )}
                  </div>

                  {kktAvailableTags.map(tag => (
                    <div key={tag} className="relative group/tag">
                      <button
                        onClick={() => toggleKktTag(tag)}
                        className={`shrink-0 h-8 px-3.5 rounded-full border text-[11px] font-bold transition-all duration-300 active:scale-95 flex items-center gap-2 pr-8 ${kktSelectedTags.includes(tag)
                          ? 'bg-indigo-500/20 border-indigo-500 text-indigo-300 shadow-[0_0_8px_rgba(99,102,241,0.15)]'
                          : 'border-gray-800 bg-gray-900/50 text-gray-400 hover:text-white hover:border-gray-600'
                          }`}
                      >
                        {tag}
                      </button>
                      <button
                        onClick={(e) => handleDeleteKktTag(tag, e)}
                        className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-full opacity-0 group-hover/tag:opacity-100 transition-all"
                        title="删除标签"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Gallery Content */}
              <div className={`flex-1 overflow-y-auto p-4 transition-opacity duration-300 ${isKktLoading && kktItems.length > 0 ? 'opacity-50' : 'opacity-100'}`} onScroll={handleKktScroll}>
                <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-400 text-xs">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>本收集器已于 2025-11-15 暂停收集，当前展示内容为历史数据。</span>
                </div>
                {kktError ? (
                  <div className="flex flex-col items-center justify-center py-20 text-gray-500 h-full gap-3">
                    <ImageIcon className="w-16 h-16 mb-2 opacity-20" />
                    <p className="text-red-400">{kktError}</p>
                    <button
                      onClick={() => loadKktData(1, true)}
                      className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm transition-colors"
                    >
                      <RefreshCw className="w-4 h-4" />
                      重试
                    </button>
                  </div>
                ) : isKktLoading && kktItems.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 text-gray-500 h-full">
                    <Loader2 className="w-8 h-8 animate-spin mb-4 text-indigo-500" />
                    <p>正在加载 KKT 数据...</p>
                  </div>
                ) : kktItems.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 text-gray-500 h-full">
                    <ImageIcon className="w-16 h-16 mb-4 opacity-20" />
                    <p>未找到相关图片</p>
                  </div>
                ) : (
                  <>
                    <KktMasonryGrid
                      items={kktItems}
                      resetKey={kktResetKey}
                      onItemClick={setKktDetailItem}
                      onSelectPrompt={onSelectPrompt}
                      favoriteIds={favoriteKktIds}
                      onToggleFavorite={toggleKktFavorite}
                      onImportImage={handleKktImportImage}
                      downloadingId={downloadingKktId}
                    />
                    {isKktLoading && (
                      <div className="flex justify-center py-6">
                        <Loader2 className="w-5 h-5 animate-spin text-indigo-500" />
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* OC Tab */}
          {activeTab === 'oc' && (
            <OCGalleryTab
              onClose={onClose}
              onSelectPrompt={onSelectPrompt}
              onAddCollapsibleTag={onAddCollapsibleTag ? (tag) => onAddCollapsibleTag({ ...tag, type: 'oc' }) : undefined}
              onAddToCharacter={onAddToCharacter ? (tag) => onAddToCharacter({ ...tag, type: 'oc' }) : undefined}
              favoriteOCIds={favoriteOCIds}
              onToggleFavorite={toggleOCFavorite}
            />
          )}

          {/* Favorites Tab */}
          {activeTab === 'favorites' && (
            <div className="h-full flex flex-col animate-in slide-in-from-right-8 fade-in duration-300">
              {/* Header */}
              <div className="p-4 border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm z-10">
                <div className="flex justify-between items-center mb-3">
                  <div className="flex items-center gap-4 flex-1">
                    <div className="flex items-center gap-2 shrink-0">
                      <Heart className="w-6 h-6 text-red-500" />
                      <h2 className="text-xl font-bold text-white">我的收藏</h2>
                    </div>
                  </div>

                  <button
                    onClick={onClose}
                    className="px-4 h-11 bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 border border-red-500/20 hover:border-red-500/50 rounded-lg transition-all flex items-center gap-2 font-bold active:scale-95"
                  >
                    <X className="w-5 h-5" />
                    关闭
                  </button>
                </div>

                {/* Sub Tabs */}
                <div className="flex items-center gap-4">
                  <div className="flex bg-black/30 p-1 rounded-lg border border-gray-800">
                    <button
                      onClick={() => setFavoritesSubTab('codex')}
                      className={`px-4 py-1.5 rounded-md text-sm font-bold transition-all ${favoritesSubTab === 'codex' ? 'bg-indigo-600 text-white shadow-lg' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
                    >
                      法典收藏
                    </button>
                    <button
                      onClick={() => setFavoritesSubTab('kkt')}
                      className={`px-4 py-1.5 rounded-md text-sm font-bold transition-all ${favoritesSubTab === 'kkt' ? 'bg-indigo-600 text-white shadow-lg' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
                    >
                      KKT 收藏
                    </button>
                    <button
                      onClick={() => setFavoritesSubTab('oc')}
                      className={`px-4 py-1.5 rounded-md text-sm font-bold transition-all ${favoritesSubTab === 'oc' ? 'bg-indigo-600 text-white shadow-lg' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
                    >
                      角色收藏
                    </button>
                  </div>
                </div>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                {favoritesSubTab === 'codex' && (
                  <>
                    {favoriteCodexIds.length > 0 ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {codexData.filter(item => favoriteCodexIds.includes(item.id)).map(item => (
                          <div key={item.id} className="bg-gray-900/50 border border-gray-800 rounded-xl p-4 hover:border-indigo-500/50 transition-all group relative">
                            <div className="flex justify-between items-start mb-2">
                              <div className="flex flex-col">
                                <span className="text-xs text-indigo-400 font-bold mb-0.5">{item.category}</span>
                                <h3 className="font-bold text-white">{getCodexDisplayTitle(item)}</h3>
                              </div>
                              {item.isR18 && <span className="px-1.5 py-0.5 bg-red-500/20 text-red-400 text-[10px] rounded border border-red-500/20 font-bold">R18</span>}
                            </div>
                            <p className="text-sm text-gray-400 line-clamp-3 mb-4 font-mono bg-black/30 p-2 rounded-lg border border-white/5">
                              {item.content}
                            </p>
                            <div className="flex justify-end gap-2">
                              <button
                                onClick={() => handleCopyContent(item.id, item.content)}
                                className={`p-2 rounded-lg transition-colors ${copiedItemId === item.id
                                  ? 'bg-green-600 text-white'
                                  : 'bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white'
                                  }`}
                                title={copiedItemId === item.id ? "已复制" : "复制"}
                              >
                                {copiedItemId === item.id ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                              </button>
                              <button
                                onClick={(e) => toggleCodexFavorite(item.id, e)}
                                className="p-2 bg-gray-800 hover:bg-gray-700 text-red-500 hover:text-red-400 rounded-lg transition-colors"
                                title="取消收藏"
                              >
                                <Heart className="w-4 h-4 fill-current" />
                              </button>
                              <button
                                onClick={() => handleAddCodexTag(item.id, item.title, item.content)}
                                className={`px-4 py-2 rounded-lg text-xs font-bold transition-colors flex items-center gap-2 shadow-lg ${addedItemId === item.id
                                  ? 'bg-green-600 text-white shadow-green-500/20'
                                  : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-500/20'
                                  }`}
                              >
                                {addedItemId === item.id ? (
                                  <>
                                    <Check className="w-3 h-3" />
                                    已添加
                                  </>
                                ) : (
                                  <>
                                    <Sparkles className="w-3 h-3" />
                                    添加
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center py-20 text-gray-500 w-full h-full">
                        <Heart className="w-16 h-16 mb-4 opacity-20" />
                        <p>暂无收藏的法典条目</p>
                      </div>
                    )}
                  </>
                )}

                {favoritesSubTab === 'kkt' && (
                  <>
                    {favoriteKktIds.length > 0 ? (
                      <div className="flex flex-wrap gap-2 after:content-[''] after:grow-[999999999]">
                        {kktItems.filter(item => favoriteKktIds.includes(item.name)).map(item => {
                          const rawAspect = item.width && item.height ? item.width / item.height : 0.66;
                          const aspect = Math.max(0.4, Math.min(2.5, rawAspect));
                          const baseHeight = 260; // 调大基准高度
                          const width = aspect * baseHeight;
                          const imageUrl = resolveKktImageUrl(item.image_url, true);
                          return (
                            <div
                              key={item.name}
                              style={{ width: `${width}px`, flexGrow: aspect * 100 }}
                              className="relative group rounded-xl overflow-hidden cursor-pointer border border-gray-800 hover:border-indigo-500 transition-all h-[260px] max-w-full min-w-[160px]"
                              onClick={() => setKktDetailItem(item)}
                            >
                              {imageUrl ? (
                                <div className="relative w-full h-full bg-gray-800/50 animate-pulse">
                                  <img
                                    src={imageUrl}
                                    alt={item.name}
                                    loading="lazy"
                                    className="w-full h-full object-cover opacity-0 transition-opacity duration-500 relative z-10"
                                    onLoad={e => {
                                      e.currentTarget.classList.remove('opacity-0');
                                      e.currentTarget.parentElement?.classList.remove('animate-pulse');
                                    }}
                                  />
                                </div>
                              ) : (
                                <div className="w-full h-full bg-gradient-to-br from-indigo-500/20 to-purple-500/20 flex items-center justify-center">
                                  <ImageIcon className="w-12 h-12 text-gray-600" />
                                </div>
                              )}
                              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-all duration-300 flex flex-col justify-end p-3 z-20">
                                <p className="text-white font-bold text-xs truncate mb-1">{item.name}</p>
                                {item.model_name && (
                                  <p className="text-[9px] text-gray-300 mb-1.5 truncate" title={`Seed: ${item.seed || '未知'}`}>
                                    {resolveModelName(item.model_name)}
                                  </p>
                                )}
                                <div className="flex gap-1.5">
                                  <button
                                    className={`flex-1 py-1.5 text-white text-[10px] font-bold rounded flex items-center justify-center gap-1 ${downloadingKktId === item.name
                                      ? 'bg-indigo-700 cursor-wait'
                                      : 'bg-indigo-600 hover:bg-indigo-500'
                                      }`}
                                    onClick={e => { e.stopPropagation(); if (downloadingKktId !== item.name) handleKktImportImage(item); }}
                                    disabled={downloadingKktId === item.name}
                                  >
                                    {downloadingKktId === item.name ? (
                                      <>
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                        下载中
                                      </>
                                    ) : (
                                      <>
                                        <Download className="w-3 h-3" />
                                        导入图片
                                      </>
                                    )}
                                  </button>
                                  <button
                                    className="p-1.5 bg-red-500/80 hover:bg-red-500 text-white rounded backdrop-blur-md transition-colors"
                                    onClick={e => toggleKktFavorite(item.name, e)}
                                  >
                                    <Heart className="w-3 h-3 fill-current" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center py-20 text-gray-500 w-full h-full">
                        <Heart className="w-16 h-16 mb-4 opacity-20" />
                        <p>暂无收藏的 KKT 图片</p>
                      </div>
                    )}
                  </>
                )}

                {favoritesSubTab === 'oc' && (
                  <>
                    {isOcLoading ? (
                      <div className="flex flex-col items-center justify-center py-20 text-gray-500 w-full h-full">
                        <Loader2 className="w-8 h-8 animate-spin mb-4 text-indigo-500" />
                        <p>正在加载角色数据...</p>
                      </div>
                    ) : favoriteOCIds.length > 0 ? (
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                        {ocData.filter(oc => favoriteOCIds.includes(oc.id)).map(oc => (
                          <div
                            key={oc.id}
                            className="group relative aspect-[832/1216] rounded-xl overflow-hidden bg-gray-800 cursor-pointer border-2 border-gray-800 hover:border-indigo-500/50 transition-all duration-300 hover:shadow-[0_0_20px_rgba(99,102,241,0.3)]"
                          >
                            {oc.preview ? (
                              <img
                                src={oc.preview}
                                alt={oc.name}
                                loading="lazy"
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <div className="w-full h-full bg-gradient-to-br from-indigo-500/20 to-purple-500/20 flex items-center justify-center">
                                <User className="w-12 h-12 text-gray-600" />
                              </div>
                            )}

                            {/* Token数量 - 左上角, hover显示 */}
                            <span className="absolute top-2 left-2 text-[10px] text-indigo-300 bg-indigo-500/20 px-1.5 py-0.5 rounded backdrop-blur-md opacity-0 group-hover:opacity-100 transition-all">
                              {countTokens(oc.positive)} tokens
                            </span>

                            {/* 收藏按钮 - hover显示 */}
                            <button
                              onClick={(e) => toggleOCFavorite(oc.id, e)}
                              className="absolute top-2 right-2 p-1.5 rounded-full backdrop-blur-md transition-all bg-red-500/80 text-white opacity-0 group-hover:opacity-100"
                            >
                              <Heart className="w-4 h-4 fill-current" />
                            </button>

                            {/* 底部信息 - hover显示 */}
                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/70 to-transparent p-2.5 translate-y-full group-hover:translate-y-0 opacity-0 group-hover:opacity-100 transition-all duration-300">
                              <h3 className="text-sm font-bold text-white truncate mb-1.5">{oc.name}</h3>
                              <div className="flex gap-1.5">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigator.clipboard.writeText(oc.positive);
                                    setCopiedItemId(oc.id);
                                    setTimeout(() => setCopiedItemId(null), 1500);
                                  }}
                                  className={`flex-1 py-1 rounded text-[10px] font-bold transition-colors flex items-center justify-center gap-1 ${copiedItemId === oc.id
                                    ? 'bg-green-600 text-white'
                                    : 'bg-white/10 hover:bg-white/20 text-gray-200'
                                    }`}
                                >
                                  {copiedItemId === oc.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                  {copiedItemId === oc.id ? '已复制' : '复制'}
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (onAddCollapsibleTag) {
                                      onAddCollapsibleTag({
                                        type: 'oc',
                                        label: oc.name,
                                        content: oc.positive,
                                      });
                                      setAddedItemId(oc.id);
                                      setTimeout(() => setAddedItemId(null), 1500);
                                    } else {
                                      onSelectPrompt(oc.positive);
                                      onClose();
                                    }
                                  }}
                                  className={`flex-1 py-1 rounded text-[10px] font-bold transition-colors flex items-center justify-center gap-1 ${addedItemId === oc.id
                                    ? 'bg-green-600 text-white'
                                    : 'bg-indigo-600 hover:bg-indigo-500 text-white'
                                    }`}
                                >
                                  {addedItemId === oc.id ? <Check className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
                                  {addedItemId === oc.id ? '已添加' : '添加'}
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center py-20 text-gray-500 w-full h-full">
                        <Heart className="w-16 h-16 mb-4 opacity-20" />
                        <p>暂无收藏的角色</p>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
};

const NavButton = ({ active, onClick, icon, label, desc }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string, desc: string }) => (
  <button
    onClick={onClick}
    className={`w-full p-3 rounded-xl flex items-center gap-3 transition-all duration-300 text-left group hover:translate-x-1 ${active
      ? 'bg-gradient-to-r from-indigo-600/20 to-purple-600/20 border border-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.1)]'
      : 'hover:bg-white/5 border border-transparent'
      }`}
  >
    <div className={`p-2 rounded-lg ${active ? 'bg-indigo-500 text-white' : 'bg-gray-800 text-gray-400 group-hover:text-white group-hover:bg-gray-700'} transition-all duration-300 group-hover:scale-110`}>
      {icon}
    </div>
    <div>
      <div className={`font-bold text-sm ${active ? 'text-white' : 'text-gray-300 group-hover:text-white'} transition-colors`}>{label}</div>
      <div className="text-[10px] text-gray-500 group-hover:text-gray-400 transition-colors">{desc}</div>
    </div>
  </button>
);
