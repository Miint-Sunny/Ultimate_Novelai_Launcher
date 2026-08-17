// 图库视图的纯逻辑(无 React/DOM 依赖,node --experimental-strip-types 可直接加载,供 parity 脚本消费)
// P5 图库页对齐 Plana:日期分组网格、搜索+模型/时间筛选(全 AND)、勾选集随筛选收敛、
// 翻图画布的页码换算与邻页预取窗口。UI 组件只消费这里的谓词,不自建判断。

import type { HistoryItem } from '../../../contexts/GenerationContext';

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (ts: number): number => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// Math.round 吸收跨 DST 的 ±1h 误差
const dayDiff = (ts: number, now: number): number =>
  Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS);

export interface GalleryDateGroup<T> {
  /** startOfDay 时间戳字符串,同日同 key */
  key: string;
  /** 今天 / 昨天 / M月d日(同年) / YYYY年M月d日(跨年) */
  label: string;
  items: T[];
}

export function dateGroupLabel(ts: number, now: number): string {
  const diff = dayDiff(ts, now);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  const d = new Date(ts);
  if (d.getFullYear() === new Date(now).getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** items 约定为新的在前(history 顺序);分组顺序 = 组内首图出现顺序,即按日期倒序 */
export function groupHistoryByDate<T extends { timestamp: number }>(
  items: T[],
  now: number = Date.now(),
): GalleryDateGroup<T>[] {
  const groups: GalleryDateGroup<T>[] = [];
  const byKey = new Map<string, GalleryDateGroup<T>>();
  for (const item of items) {
    const key = String(startOfDay(item.timestamp));
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: dateGroupLabel(item.timestamp, now), items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/** 段内缩略图只标 HH:mm(日期已在段标题上) */
export function formatSectionTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export type GalleryTimeRange = 'all' | 'today' | 'yesterday' | 'last7d' | 'last30d';

/** 无元数据(老图/导入图)归到统一的未知模型桶,筛选时可显式选中 */
export const UNKNOWN_MODEL_KEY = '__unknown__';

export interface GalleryFilter {
  /** 子串匹配(大小写不敏感):seed / 正负面提示词 / 模型名 */
  query: string;
  /** 命中的模型 key 集合;空数组 = 不限 */
  models: string[];
  timeRange: GalleryTimeRange;
}

export const EMPTY_GALLERY_FILTER: GalleryFilter = { query: '', models: [], timeRange: 'all' };

export function isGalleryFilterActive(filter: GalleryFilter): boolean {
  return filter.query.trim() !== '' || filter.models.length > 0 || filter.timeRange !== 'all';
}

export function modelKeyOf(item: HistoryItem): string {
  return item.metadata?.model ?? UNKNOWN_MODEL_KEY;
}

/** 全 AND:模型集合 ∧ 时间范围 ∧ 查询子串,任一不满足即排除 */
export function matchesGalleryFilter(
  item: HistoryItem,
  filter: GalleryFilter,
  now: number = Date.now(),
): boolean {
  if (filter.models.length > 0 && !filter.models.includes(modelKeyOf(item))) return false;

  if (filter.timeRange !== 'all') {
    const diff = dayDiff(item.timestamp, now);
    if (filter.timeRange === 'today' && diff !== 0) return false;
    if (filter.timeRange === 'yesterday' && diff !== 1) return false;
    if (filter.timeRange === 'last7d' && (diff < 0 || diff > 6)) return false;
    if (filter.timeRange === 'last30d' && (diff < 0 || diff > 29)) return false;
  }

  const query = filter.query.trim().toLowerCase();
  if (query) {
    const haystack = [
      String(item.seed),
      item.metadata?.positivePrompt ?? '',
      item.metadata?.negativePrompt ?? '',
      item.metadata?.model ?? '',
    ]
      .join('\n')
      .toLowerCase();
    if (!haystack.includes(query)) return false;
  }

  return true;
}

export function filterHistory(
  items: HistoryItem[],
  filter: GalleryFilter,
  now: number = Date.now(),
): HistoryItem[] {
  return items.filter((item) => matchesGalleryFilter(item, filter, now));
}

/** 筛选 UI 的模型选项:去重排序,未知桶固定排最后 */
export function distinctModelKeys(items: HistoryItem[]): string[] {
  const seen = new Set<string>();
  for (const item of items) seen.add(modelKeyOf(item));
  return [...seen].sort((a, b) => {
    if (a === UNKNOWN_MODEL_KEY) return 1;
    if (b === UNKNOWN_MODEL_KEY) return -1;
    return a.localeCompare(b);
  });
}

/**
 * 勾选集随筛选收敛:筛掉的 id 从勾选集中移除。
 * 无变化时返回原集合的拷贝(调用方据此避免多余重渲染之外的语义变化)。
 */
export function convergeSelectionIds(
  selected: ReadonlySet<string>,
  visibleIds: ReadonlySet<string>,
): Set<string> {
  let changed = false;
  const next = new Set<string>();
  selected.forEach((id) => {
    if (visibleIds.has(id)) {
      next.add(id);
    } else {
      changed = true;
    }
  });
  return changed ? next : new Set(selected);
}

/**
 * 翻图画布邻页预取窗口:返回 history 下标。0 = 最新在左,
 * current-1 是更新(左邻),current+1 是更旧(右邻),各取 radius 页。
 */
export function prefetchWindowIndexes(
  length: number,
  currentIndex: number,
  radius: number = 1,
): number[] {
  const indexes: number[] = [];
  for (let d = 1; d <= radius; d++) {
    const newer = currentIndex - d;
    const older = currentIndex + d;
    if (newer >= 0) indexes.push(newer);
    if (older < length) indexes.push(older);
  }
  return indexes;
}

/** 画布页 = 生成中头部在跑任务卡(hasLiveTask 时占第 0 页) + history 一项一页 */
export function galleryPageCount(historyLength: number, hasLiveTask: boolean): number {
  return historyLength + (hasLiveTask ? 1 : 0);
}

export function historyIndexToPage(historyIndex: number, hasLiveTask: boolean): number {
  return historyIndex + (hasLiveTask ? 1 : 0);
}

/** 页码 → history 下标;落在在跑任务卡上时返回 null */
export function pageToHistoryIndex(page: number, hasLiveTask: boolean): number | null {
  const index = page - (hasLiveTask ? 1 : 0);
  return index < 0 ? null : index;
}
