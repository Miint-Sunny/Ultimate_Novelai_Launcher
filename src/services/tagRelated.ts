/**
 * 关联推荐服务 - 调用后端 /api/tags/related (DanbooruSearch 共现代理)
 *
 * 给定一个或多个已选 tag, 返回 Danbooru 上常一起出现的标签 (基于 NPMI 共现统计).
 * 后端有 LRU 缓存, 前端再加一层内存缓存, 避免重复请求.
 */
import { getBackendUrl } from '../utils/apiConfig';

export interface RelatedTag {
  tag: string;            // Danbooru 英文标签 (下划线格式)
  cn_name?: string;       // 中文名 (DanbooruSearch 自带, 多个用逗号分隔)
  category?: string;      // 'General' | 'Character' | 'Copyright'
  nsfw?: '0' | '1';
  npmi?: number;          // 共现强度 (0-1)
  score?: number;         // 备用排序字段
  count?: number;         // Danbooru 上的图片数
  wiki?: string;          // 维基释义
}

interface RelatedResponse {
  results: RelatedTag[];
  error?: string;
  cached?: boolean;
}

// 客户端 LRU 缓存 (key = sorted_tags)
const cache = new Map<string, RelatedTag[]>();
const CACHE_MAX = 200;
const inflight = new Map<string, Promise<RelatedTag[]>>();

function buildCacheKey(tags: string[]): string {
  return tags
    .map(t => t.toLowerCase().trim().replace(/\s+/g, '_'))
    .filter(Boolean)
    .sort()
    .join('|');
}

/**
 * 获取与给定 tag 集合关联度最高的标签
 * @param tags       已选 tag 列表 (单个也行)
 * @param limit      最多返回多少个 (后端默认 30)
 * @param showNsfw   是否包含 NSFW 标签 (默认 true, 由前端过滤更可控)
 * @param categories 仅保留这些类别 (如 ["General"]); 不传 = 所有类别
 */
export async function fetchRelatedTags(
  tags: string[],
  limit = 30,
  showNsfw = true,
  categories?: string[],
): Promise<RelatedTag[]> {
  if (!tags.length) return [];

  const catKey = categories && categories.length ? categories.slice().sort().join(',') : '';
  const key = buildCacheKey(tags) + '|' + catKey;
  if (!key) return [];

  // 命中本地缓存
  const cached = cache.get(key);
  if (cached) return cached;

  // 同一 key 已有飞行中的请求 → 复用 (避免双击/快速切换重复打)
  const flying = inflight.get(key);
  if (flying) return flying;

  const promise = (async () => {
    try {
      const backendUrl = getBackendUrl();
      const body: Record<string, unknown> = {
        tags: tags.map(t => t.toLowerCase().trim().replace(/\s+/g, '_')),
        limit,
        show_nsfw: showNsfw,
      };
      if (categories && categories.length) body.categories = categories;
      const res = await fetch(`${backendUrl}/api/tags/related`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return [];
      const data: RelatedResponse = await res.json();
      const results = Array.isArray(data.results) ? data.results : [];
      // 写入 LRU 缓存
      cache.set(key, results);
      if (cache.size > CACHE_MAX) {
        const firstKey = cache.keys().next().value;
        if (firstKey) cache.delete(firstKey);
      }
      return results;
    } catch (e) {
      console.warn('[tagRelated] fetch failed:', e);
      return [];
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/**
 * 取首个中文名 (cn_name 字段可能是 "内裤,白色内裤" 这种逗号分隔的多名)
 */
export function pickPrimaryChineseName(rt: RelatedTag): string | undefined {
  if (!rt.cn_name) return undefined;
  const first = rt.cn_name.split(/[,，]/)[0]?.trim();
  return first || undefined;
}
