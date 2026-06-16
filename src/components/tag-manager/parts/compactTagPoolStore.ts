// Compact subtype 标签池 - 按 subtypeId 独立 localStorage 存储
// 与 character (tag_pool:character) / artist (tag_pool:artist-style) 同套命名约定
// 池本身独立持久化, 与「items 自身 tags 字段聚合」并集后给 ChipRow 使用

const KEY = (subtypeId: string) => `tag_pool:${subtypeId}`;

export function loadCompactTagPool(subtypeId: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY(subtypeId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCompactTagPool(subtypeId: string, pool: string[]): void {
  const sorted = Array.from(new Set(pool.filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  localStorage.setItem(KEY(subtypeId), JSON.stringify(sorted));
}
