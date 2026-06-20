// Character (OC) 标签系统 - localStorage 旁路存储
//
// 为什么不放进 OCFile / OCData 后端类型?
//   - OC 公共库 API 是 readonly,无法持久化用户标签
//   - "我收藏的 OC" 来自公共池,也不能改后端数据
//   → 标签是"用户对 OC 的本地视角"概念,与 OC 数据本身解耦
//
// 存储结构:
//   localStorage[POOL_KEY]      = string[]                       (整个池)
//   localStorage[OVERRIDES_KEY] = Record<ocId, string[]>          (单条 tags)

const POOL_KEY = 'tag_pool:character';
const OVERRIDES_KEY = 'oc_tag_overrides:v1';

export function loadCharacterTagPool(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(POOL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCharacterTagPool(pool: string[]): void {
  const sorted = Array.from(new Set(pool)).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  localStorage.setItem(POOL_KEY, JSON.stringify(sorted));
}

export function loadCharacterTagOverrides(): Record<string, string[]> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getCharacterTags(id: string, overrides?: Record<string, string[]>): string[] {
  const all = overrides ?? loadCharacterTagOverrides();
  return all[id] || [];
}

export function setCharacterTags(id: string, tags: string[]): Record<string, string[]> {
  const all = loadCharacterTagOverrides();
  if (tags.length === 0) {
    delete all[id];
  } else {
    all[id] = tags;
  }
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(all));
  return all;
}

/** 自动把 ids 的 tags 与一组新标签合并,返回新的 overrides map (调用方 set state) */
export function mergeCharacterTags(ids: string[], newTags: string[]): Record<string, string[]> {
  if (ids.length === 0 || newTags.length === 0) return loadCharacterTagOverrides();
  const all = loadCharacterTagOverrides();
  for (const id of ids) {
    const cur = new Set(all[id] || []);
    for (const t of newTags) cur.add(t);
    all[id] = Array.from(cur);
  }
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(all));
  return all;
}

/** 删除某个标签时,同步从所有 OC overrides 里移除该标签 */
export function removeTagFromAllOCs(tagName: string): Record<string, string[]> {
  const all = loadCharacterTagOverrides();
  const next: Record<string, string[]> = {};
  for (const [id, tags] of Object.entries(all)) {
    const filtered = tags.filter(t => t !== tagName);
    if (filtered.length > 0) next[id] = filtered;
  }
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(next));
  return next;
}

/** 统计某个标签被多少个 OC 使用 (供删除前确认提示用) */
export function countCharacterTagUsage(
  tagName: string,
  overrides?: Record<string, string[]>
): number {
  const all = overrides ?? loadCharacterTagOverrides();
  let count = 0;
  for (const tags of Object.values(all)) {
    if (tags.includes(tagName)) count++;
  }
  return count;
}
