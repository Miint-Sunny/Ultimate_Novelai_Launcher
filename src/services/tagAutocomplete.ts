// Danbooru 标签自动补全服务
import { getBackendUrl } from '../utils/apiConfig';
import { sidecarApi } from '../api/sidecar';
import { getAppSettings, type AutocompleteSourceId, type AutocompleteSourceConfig } from './localLibrary';
import { requestSidecarChatCompletion, submitTagTranslations } from './translate';
import { botService } from './botService';

export interface TagWikiPreviewExample {
  type: 'post' | 'asset';
  id: number;
  previewUrl?: string;
  pageUrl: string;
  width?: number;
  height?: number;
}

export interface TagWikiPreview {
  hasWiki: boolean;
  title: string;
  otherNames: string[];
  summary: string;
  summaryZh?: string;
  body: string;
  example?: TagWikiPreviewExample | null;
  examples?: TagWikiPreviewExample[];
}

export interface TagSuggestion {
  value: string;        // 英文tag（用于插入）
  label: string;        // 显示的主标签名
  chineseName?: string; // 中文翻译（显示在第二行）
  postCount?: number;   // 引用数
  category?: string;    // 分类/出处
  source?: 'danbooru' | 'local';
  isOrigin?: boolean;   // 是否为出处（作品）匹配
  originCharCount?: number; // 该出处下的角色数量
  originCharacters?: string[]; // 该出处下的所有角色英文名
  isNaturalLanguage?: boolean; // 是否为"转换自然语言"特殊选项
  verified?: boolean;   // D站验证是否完成（true=已验证，undefined=未验证/验证中）
  // 画师串相关
  isArtist?: boolean;   // 是否为画师串
  artistContent?: string; // 画师串的实际内容（用于插入）
  // OC相关
  isOC?: boolean;       // 是否为OC
  ocContent?: string;   // OC的tag_group内容（用于插入）
  // AI加载占位
  isAiLoading?: boolean; // AI推荐加载中占位项
  // AI 来源标签（用于按来源分类与排序）
  isAiDirect?: boolean;  // AI 直译结果（中文整句→单 tag）
  isAiRecommend?: boolean; // AI 推荐结果（中文查询→多 tag）
  hasWiki?: boolean;
}

/**
 * 按建议类型归类到某个配置源 id。AI 加载占位归入 aiRecommend 槽。
 */
function classifySuggSource(s: TagSuggestion): AutocompleteSourceId | null {
  if (s.isAiLoading) return 'aiRecommend';
  if (s.isNaturalLanguage) return 'nl';
  // AI 直译合并到 aiRecommend 桶里（置顶位置由插入顺序保证）
  if (s.isAiDirect || s.isAiRecommend) return 'aiRecommend';
  if (s.isArtist) return 'artists';
  if (s.isOC) return 'ocs';
  if (s.isOrigin) return 'origins';
  if (s.source === 'local') return 'characters';
  if (s.source === 'danbooru') return 'danbooru';
  return null;
}

/**
 * 按设置里的 autocompleteSources 顺序重排 items：禁用源剔除、按 maxCount 截断、按配置顺序拼接。
 */
function reorderByConfig(items: TagSuggestion[], sources: AutocompleteSourceConfig[]): TagSuggestion[] {
  const grouped: Partial<Record<AutocompleteSourceId, TagSuggestion[]>> = {};
  for (const s of items) {
    const cat = classifySuggSource(s);
    if (cat == null) continue;
    (grouped[cat] ||= []).push(s);
  }
  const result: TagSuggestion[] = [];
  for (const cfg of sources) {
    if (!cfg.enabled) continue;
    const bucket = grouped[cfg.id] || [];
    const limited = cfg.maxCount != null ? bucket.slice(0, cfg.maxCount) : bucket;
    result.push(...limited);
  }
  return result;
}

function getSrcCfg(sources: AutocompleteSourceConfig[], id: AutocompleteSourceId): AutocompleteSourceConfig {
  return sources.find(s => s.id === id) || { id, enabled: false };
}

// 防抖函数
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// 当前正在查询的关键词（用于防止旧查询的异步回调覆盖新结果）
let currentQuery: string = '';

// 缓存
const cache = new Map<string, TagSuggestion[]>();
const wikiExistsCache = new Map<string, boolean>();
const wikiPreviewCache = new Map<string, TagWikiPreview>();
const wikiSummaryZhCache = new Map<string, string>();

// in-flight 去重：同一 tag 的请求未完成前，复用同一个 Promise，避免重复打到后端
const wikiExistsInflight = new Map<string, Promise<Record<string, boolean>>>();
const wikiPreviewInflight = new Map<string, Promise<TagWikiPreview | null>>();
const wikiSummaryZhInflight = new Map<string, Promise<string>>();

function normalizeWikiTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/ /g, '_');
}

// 本地角色标签数据
let roleTagMapping: Record<string, {
  role_en: string;
  role_zh: string[];
  origin_en: string;
  origin_zh: string[];
}> | null = null;

// 画师串数据缓存
interface ArtistData {
  id: string;
  name: string;
  artist_string: string;
  added_by?: string;  // 上传者 botUserId，用于"仅我"筛选
}
let artistDataCache: ArtistData[] | null = null;
let artistDataLoading: Promise<ArtistData[]> | null = null;

// OC数据缓存
interface OCData {
  id: string;
  name: string;        // zh_name 或 en_name
  en_name: string;
  aliases: string[];   // zh_aliases
  tag_group: string;
  created_by?: string; // 创建者 botUserId，用于"仅我"筛选
}
let ocDataCache: OCData[] | null = null;
let ocDataLoading: Promise<OCData[]> | null = null;

// 加载本地角色标签数据
async function loadRoleTagMapping() {
  if (roleTagMapping) return roleTagMapping;

  try {
    roleTagMapping = await sidecarApi.getJson<typeof roleTagMapping>('/api/data/role_tag_mapping.json');
    console.log('Loaded role_tag_mapping.json, entries:', Object.keys(roleTagMapping || {}).length);
  } catch (e) {
    console.warn('Failed to load role_tag_mapping.json:', e);
  }
  return roleTagMapping;
}

// 加载画师串数据
async function loadArtistData(): Promise<ArtistData[]> {
  if (artistDataCache) return artistDataCache;
  if (artistDataLoading) return artistDataLoading;

  artistDataLoading = (async () => {
    try {
      const sessionId = botService.getAuthState().sessionId || '';
      const data = await sidecarApi.getJson<{ artists?: any[] }>(
        `/api/artists/list?session_id=${encodeURIComponent(sessionId)}`,
      );
      const artists: ArtistData[] = (data.artists || []).map((a: any) => ({
        id: a.id,
        name: a.name,
        artist_string: a.artist_string,
        added_by: a.added_by,
      }));
      artistDataCache = artists;
      console.log('Loaded artist data, entries:', artists.length);
      return artists;
    } catch (e) {
      console.warn('Failed to load artist data:', e);
    }
    return [];
  })();

  const result = await artistDataLoading;
  artistDataLoading = null;
  return result;
}

// 加载OC数据
async function loadOCData(): Promise<OCData[]> {
  if (ocDataCache) return ocDataCache;
  if (ocDataLoading) return ocDataLoading;

  ocDataLoading = (async () => {
    try {
      const sessionId = botService.getAuthState().sessionId || '';
      const data = await sidecarApi.getJson<{ ocs?: any[] }>(
        `/api/oc/list?session_id=${encodeURIComponent(sessionId)}`,
      );
      const ocs: OCData[] = (data.ocs || []).map((oc: any) => ({
        id: oc.id,
        name: oc.zh_name || oc.en_name,
        en_name: oc.en_name,
        aliases: oc.zh_aliases || [],
        tag_group: oc.tag_group,
        created_by: oc.created_by,
      }));
      ocDataCache = ocs;
      console.log('Loaded OC data, entries:', ocs.length);
      return ocs;
    } catch (e) {
      console.warn('Failed to load OC data:', e);
    }
    return [];
  })();

  const result = await ocDataLoading;
  ocDataLoading = null;
  return result;
}

// 搜索画师串
async function searchArtists(query: string, maxCount: number, scope: 'mine' | 'all', currentUserId: string | null): Promise<TagSuggestion[]> {
  if (maxCount <= 0) return [];
  const allArtists = await loadArtistData();
  if (!allArtists.length) return [];

  // 'mine' 范围：无登录或无 userId 时直接空结果
  const artists = scope === 'mine'
    ? (currentUserId ? allArtists.filter(a => a.added_by === currentUserId) : [])
    : allArtists;
  if (!artists.length) return [];

  const queryLower = query.toLowerCase();
  const results: { suggestion: TagSuggestion; score: number }[] = [];

  for (const artist of artists) {
    let score = 0;
    const nameLower = artist.name.toLowerCase();

    // 精确匹配
    if (nameLower === queryLower) {
      score = 200;
    }
    // 开头匹配
    else if (nameLower.startsWith(queryLower)) {
      score = 150;
    }
    // 包含匹配
    else if (nameLower.includes(queryLower)) {
      score = 100;
    }

    if (score > 0) {
      results.push({
        suggestion: {
          value: artist.name,
          label: artist.name,
          source: 'local' as const,
          isArtist: true,
          artistContent: artist.artist_string,
          category: '画师串',
        },
        score,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, maxCount).map(r => r.suggestion);
}

// 搜索OC
async function searchOCs(query: string, maxCount: number, scope: 'mine' | 'all', currentUserId: string | null): Promise<TagSuggestion[]> {
  if (maxCount <= 0) return [];
  const allOCs = await loadOCData();
  if (!allOCs.length) return [];

  const ocs = scope === 'mine'
    ? (currentUserId ? allOCs.filter(oc => oc.created_by === currentUserId) : [])
    : allOCs;
  if (!ocs.length) return [];

  const queryLower = query.toLowerCase();
  const results: { suggestion: TagSuggestion; score: number }[] = [];

  for (const oc of ocs) {
    let score = 0;
    const nameLower = oc.name.toLowerCase();

    // 中文名精确匹配
    if (nameLower === queryLower) {
      score = 200;
    }
    // 别名精确匹配
    else if (oc.aliases.some(alias => alias.toLowerCase() === queryLower)) {
      score = 180;
    }
    // 中文名开头匹配
    else if (nameLower.startsWith(queryLower)) {
      score = 150;
    }
    // 别名开头匹配
    else if (oc.aliases.some(alias => alias.toLowerCase().startsWith(queryLower))) {
      score = 130;
    }
    // 中文名包含匹配
    else if (nameLower.includes(queryLower)) {
      score = 100;
    }
    // 别名包含匹配
    else if (oc.aliases.some(alias => alias.toLowerCase().includes(queryLower))) {
      score = 80;
    }

    if (score > 0) {
      results.push({
        suggestion: {
          value: oc.name,
          label: oc.name,
          chineseName: oc.en_name !== oc.name ? oc.en_name : undefined,
          source: 'local' as const,
          isOC: true,
          ocContent: oc.tag_group,
          category: 'OC',
        },
        score,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, maxCount).map(r => r.suggestion);
}

// 搜索本地角色标签（支持中文）
// 本地搜索结果分为高优先和低优先
interface LocalSearchResult {
  high: TagSuggestion[];  // 精确/开头匹配
  low: TagSuggestion[];   // 包含/作品名匹配
}

async function searchLocalTags(query: string, sources: AutocompleteSourceConfig[], currentUserId: string | null): Promise<LocalSearchResult> {
  const mapping = await loadRoleTagMapping();
  if (!mapping) return { high: [], low: [] };

  const artistsCfg = getSrcCfg(sources, 'artists');
  const ocsCfg = getSrcCfg(sources, 'ocs');
  const charactersEnabled = getSrcCfg(sources, 'characters').enabled;
  const originsEnabled = getSrcCfg(sources, 'origins').enabled;

  const high: { suggestion: TagSuggestion; score: number }[] = [];
  const low: { suggestion: TagSuggestion; score: number }[] = [];
  const queryLower = query.toLowerCase();

  // 统计每个出处下的角色数量和角色列表
  const originCounts = new Map<string, number>();
  const originChars = new Map<string, string[]>();
  for (const data of Object.values(mapping)) {
    const key = data.origin_en.toLowerCase();
    originCounts.set(key, (originCounts.get(key) || 0) + 1);
    if (!originChars.has(key)) originChars.set(key, []);
    originChars.get(key)!.push(data.role_en);
  }

  // 出处匹配（去重）
  const matchedOrigins = new Set<string>();
  if (originsEnabled) for (const data of Object.values(mapping)) {
    const originKey = data.origin_en.toLowerCase();
    if (matchedOrigins.has(originKey)) continue;

    let originScore = 0;
    // 中文出处精确匹配
    if (data.origin_zh.some(zh => zh === query)) {
      originScore = 180;
    }
    // 英文出处精确匹配
    else if (originKey === queryLower) {
      originScore = 170;
    }
    // 中文出处开头匹配
    else if (data.origin_zh.some(zh => zh.startsWith(query))) {
      originScore = 65;
    }
    // 英文出处开头匹配
    else if (originKey.startsWith(queryLower)) {
      originScore = 55;
    }
    // 中文出处包含匹配
    else if (data.origin_zh.some(zh => zh.includes(query))) {
      originScore = 45;
    }
    // 英文出处包含匹配
    else if (originKey.includes(queryLower)) {
      originScore = 35;
    }

    if (originScore > 0) {
      matchedOrigins.add(originKey);
      const charCount = originCounts.get(originKey) || 0;
      const characters = originChars.get(originKey) || [];
      const entry = {
        suggestion: {
          value: data.origin_en,
          label: data.origin_en,
          chineseName: data.origin_zh[0] || undefined,
          source: 'local' as const,
          isOrigin: true,
          originCharCount: charCount,
          originCharacters: characters,
        },
        score: originScore,
      };
      if (originScore >= 65) high.push(entry); else low.push(entry);
    }
  }

  if (charactersEnabled) for (const [key, data] of Object.entries(mapping)) {
    // 跳过 OC 角色（以 OC_ 开头），OC 从专门的 OC 列表搜索
    if (data.role_en.startsWith('OC_')) continue;

    let score = 0;
    let isHigh = false;

    // 精确匹配中文角色名（最高优先级）
    if (data.role_zh.some(zh => zh === query)) {
      score = 200; isHigh = true;
    }
    // 英文精确匹配
    else if (data.role_en.toLowerCase() === queryLower) {
      score = 190; isHigh = true;
    }
    // 中文角色名开头匹配
    else if (data.role_zh.some(zh => zh.startsWith(query))) {
      score = 80; isHigh = true;
    }
    // 英文开头匹配
    else if (data.role_en.toLowerCase().startsWith(queryLower)) {
      score = 70; isHigh = true;
    }
    // 中文角色名包含（低优先）
    else if (data.role_zh.some(zh => zh.includes(query))) {
      score = 60;
    }
    // 英文包含（低优先）
    else if (data.role_en.toLowerCase().includes(queryLower)) {
      score = 40;
    }
    // 中文作品名匹配（低优先）
    else if (data.origin_zh.some(zh => zh.includes(query))) {
      score = 30;
    }

    if (score > 0) {
      const entry = {
        suggestion: {
          value: data.role_en,
          label: data.role_en,
          chineseName: data.role_zh[0] || undefined,
          source: 'local' as const,
          category: data.origin_zh[0] || data.origin_en,
        },
        score,
      };
      if (isHigh) high.push(entry); else low.push(entry);
    }
  }

  // 并行搜索画师串和OC（按配置决定是否调用、限额以及范围）
  const [artistResults, ocResults] = await Promise.all([
    artistsCfg.enabled ? searchArtists(query, artistsCfg.maxCount ?? 5, artistsCfg.scope ?? 'all', currentUserId) : Promise.resolve([] as TagSuggestion[]),
    ocsCfg.enabled ? searchOCs(query, ocsCfg.maxCount ?? 5, ocsCfg.scope ?? 'all', currentUserId) : Promise.resolve([] as TagSuggestion[]),
  ]);

  // 画师串和OC结果加入高优先级列表（它们是精确匹配类型）
  for (const artist of artistResults) {
    high.push({ suggestion: artist, score: 250 }); // 画师串优先级最高
  }
  for (const oc of ocResults) {
    high.push({ suggestion: oc, score: 240 }); // OC次之
  }

  return {
    high: high.sort((a, b) => b.score - a.score).slice(0, 10).map(r => r.suggestion),
    low: low.sort((a, b) => b.score - a.score).slice(0, 10).map(r => r.suggestion),
  };
}

/**
 * 批量获取标签的中文别名（导出供外部使用）
 *
 * per-tag 缓存 + inflight 去重：
 * - 正缓存：查到的中文名
 * - 负缓存（null）：后端成功响应但确认无翻译的 tag，会话内不再重查——
 *   否则翻译不出来的 tag 会在每次编辑标签集合变化时反复发起相同请求
 * - 请求异常 / 非 200：不写缓存，允许下次重试（后端恢复后可继续工作）
 */
const wikiNamesCache = new Map<string, string[] | null>();
const wikiNamesInflight = new Map<string, Promise<Record<string, string[]>>>();

export async function fetchWikiChineseNames(tags: string[]): Promise<Record<string, string[]>> {
  if (!tags.length) return {};

  const result: Record<string, string[]> = {};
  const missing: string[] = [];
  const pending = new Set<Promise<Record<string, string[]>>>();
  const seen = new Set<string>();
  for (const tag of tags) {
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    if (wikiNamesCache.has(tag)) {
      const cached = wikiNamesCache.get(tag)!;
      if (cached) result[tag] = cached;
    } else {
      const flying = wikiNamesInflight.get(tag);
      if (flying) pending.add(flying);
      else missing.push(tag);
    }
  }

  if (missing.length > 0) {
    const promise = (async (): Promise<Record<string, string[]>> => {
      try {
        const backendUrl = getBackendUrl();
        const res = await fetch(`${backendUrl}/api/tags/wiki?tags=${encodeURIComponent(missing.join(','))}`);
        if (res.ok) {
          const data = await res.json() as Record<string, string[]>;
          for (const tag of missing) {
            const names = data?.[tag];
            wikiNamesCache.set(tag, Array.isArray(names) && names.length > 0 ? names : null);
          }
          return data || {};
        }
      } catch (e) {
        console.warn('Failed to fetch wiki names:', e);
      }
      return {};
    })();
    promise.finally(() => {
      for (const tag of missing) {
        if (wikiNamesInflight.get(tag) === promise) wikiNamesInflight.delete(tag);
      }
    });
    for (const tag of missing) wikiNamesInflight.set(tag, promise);
    pending.add(promise);
  }

  if (pending.size > 0) {
    const settled = await Promise.all(pending);
    for (const data of settled) {
      for (const tag of seen) {
        if (result[tag]) continue;
        const names = data?.[tag];
        if (Array.isArray(names) && names.length > 0) result[tag] = names;
      }
    }
  }
  return result;
}

/**
 * 从 Danbooru 获取标签建议（通过后端代理）
 * onWikiLoaded: 可选回调，wiki中文名加载完成后调用
 */
export async function fetchWikiExistsBatch(tags: string[]): Promise<Record<string, boolean>> {
  const normalized = Array.from(new Set(tags.map(normalizeWikiTag).filter(Boolean)));
  if (normalized.length === 0) return {};

  const result: Record<string, boolean> = {};
  const missing: string[] = [];
  const pending = new Set<Promise<Record<string, boolean>>>();
  for (const tag of normalized) {
    if (wikiExistsCache.has(tag)) {
      result[tag] = wikiExistsCache.get(tag)!;
      continue;
    }
    const flying = wikiExistsInflight.get(tag);
    if (flying) pending.add(flying);
    else missing.push(tag);
  }

  if (missing.length > 0) {
    const promise = (async (): Promise<Record<string, boolean>> => {
      try {
        const backendUrl = getBackendUrl();
        const res = await fetch(`${backendUrl}/api/tags/wiki-exists-batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: missing }),
        });
        if (res.ok) {
          const data = await res.json() as Record<string, boolean>;
          const normalizedData: Record<string, boolean> = {};
          Object.entries(data || {}).forEach(([tag, hasWiki]) => {
            const normalizedTag = normalizeWikiTag(tag);
            wikiExistsCache.set(normalizedTag, !!hasWiki);
            normalizedData[normalizedTag] = !!hasWiki;
          });
          return normalizedData;
        }
      } catch (e) {
        console.warn('Failed to fetch wiki existence batch:', e);
      }
      return {};
    })();
    promise.finally(() => {
      for (const tag of missing) {
        if (wikiExistsInflight.get(tag) === promise) wikiExistsInflight.delete(tag);
      }
    });
    for (const tag of missing) wikiExistsInflight.set(tag, promise);
    pending.add(promise);
  }

  if (pending.size > 0) {
    const settled = await Promise.all(pending);
    for (const data of settled) {
      for (const [tag, hasWiki] of Object.entries(data)) {
        if (!(tag in result)) result[tag] = hasWiki;
      }
    }
  }

  return result;
}

export async function fetchTagWikiPreview(tag: string): Promise<TagWikiPreview | null> {
  const normalized = normalizeWikiTag(tag);
  if (!normalized) return null;
  if (wikiPreviewCache.has(normalized)) return wikiPreviewCache.get(normalized)!;

  const flying = wikiPreviewInflight.get(normalized);
  if (flying) return flying;

  const promise = (async (): Promise<TagWikiPreview | null> => {
    try {
      const backendUrl = getBackendUrl();
      const res = await fetch(`${backendUrl}/api/tags/wiki-preview?tag=${encodeURIComponent(normalized)}`);
      if (!res.ok) return null;
      const data = await res.json() as TagWikiPreview;
      wikiExistsCache.set(normalized, !!data?.hasWiki);
      if (!data?.hasWiki) return null;
      wikiPreviewCache.set(normalized, data);
      return data;
    } catch (e) {
      console.warn('Failed to fetch wiki preview:', e);
      return null;
    }
  })();
  promise.finally(() => {
    if (wikiPreviewInflight.get(normalized) === promise) wikiPreviewInflight.delete(normalized);
  });
  wikiPreviewInflight.set(normalized, promise);
  return promise;
}

export async function fetchTagWikiSummaryZh(tag: string): Promise<string> {
  const normalized = normalizeWikiTag(tag);
  if (!normalized) return '';
  if (wikiSummaryZhCache.has(normalized)) return wikiSummaryZhCache.get(normalized)!;

  const flying = wikiSummaryZhInflight.get(normalized);
  if (flying) return flying;

  const promise = (async (): Promise<string> => {
    try {
      const backendUrl = getBackendUrl();
      const res = await fetch(`${backendUrl}/api/tags/wiki-preview-summary-zh?tag=${encodeURIComponent(normalized)}`);
      if (!res.ok) return '';
      const data = await res.json() as { hasWiki?: boolean; summaryZh?: string };
      const summaryZh = data?.hasWiki && data.summaryZh ? data.summaryZh : '';
      if (summaryZh) {
        wikiSummaryZhCache.set(normalized, summaryZh);
        const cached = wikiPreviewCache.get(normalized);
        if (cached) wikiPreviewCache.set(normalized, { ...cached, summaryZh });
      }
      return summaryZh;
    } catch (e) {
      console.warn('Failed to fetch wiki Chinese summary:', e);
      return '';
    }
  })();
  promise.finally(() => {
    if (wikiSummaryZhInflight.get(normalized) === promise) wikiSummaryZhInflight.delete(normalized);
  });
  wikiSummaryZhInflight.set(normalized, promise);
  return promise;
}

export async function getTagSuggestions(
  query: string,
  onWikiLoaded?: (suggestions: TagSuggestion[]) => void
): Promise<TagSuggestion[]> {
  if (!query) return [];

  // 获取设置 + 当前 bot 用户 id（用于 artists/ocs 的 "仅我" 过滤）
  const settings = getAppSettings();
  const currentUserId = botService.getAuthState().botUserId || null;

  // 如果补全被禁用，直接返回空
  if (!settings.autocompleteEnabled) return [];

  // 检测是否包含中文
  const hasChinese = /[\u4e00-\u9fa5]/.test(query);

  // 如果包含中文但中文补全被禁用，返回空
  if (hasChinese && !settings.autocompleteChineseEnabled) return [];

  // 中文1个字符就触发，英文需要2个
  if (!hasChinese && query.length < 2) return [];

  const cacheKey = query.toLowerCase();
  if (cache.has(cacheKey)) {
    const raw = cache.get(cacheKey)!;
    // 用户可能在上次缓存后调整过数据源配置，这里按最新配置再过滤/重排
    const cached = reorderByConfig(raw, settings.autocompleteSources);
    // 缓存命中但有未翻译的标签，异步补翻译
    if (onWikiLoaded && settings.autocompleteShowWiki) {
      const needTranslate = cached.filter(s => !s.chineseName && s.source === 'danbooru');
      if (needTranslate.length > 0) {
        (async () => {
          try {
            const wikiNames = await fetchWikiChineseNames(needTranslate.map(s => s.value));
            const stillMissing: TagSuggestion[] = [];
            let updated = false;
            for (const s of needTranslate) {
              const names = wikiNames[s.value];
              if (names && names.length > 0) {
                s.chineseName = names.join(' / ');
                updated = true;
              } else {
                stillMissing.push(s);
              }
            }
            if (stillMissing.length > 0) {
              const aiResults = await Promise.allSettled(
                stillMissing.map(s => translateTagWithGemini(s.value))
              );
              for (let i = 0; i < stillMissing.length; i++) {
                const r = aiResults[i];
                if (r.status === 'fulfilled' && r.value) {
                  stillMissing[i].chineseName = r.value;
                  updated = true;
                }
              }
            }
            if (updated) {
              cache.set(cacheKey, cached);
              onWikiLoaded(cached);
            }
          } catch { /* ignore */ }
        })();
      }
    }
    return cached;
  }

  try {
    let suggestions: TagSuggestion[] = [];
    const queryLower = query.toLowerCase();
    const backendUrl = getBackendUrl();

    if (hasChinese) {
      // 中文搜索：本地 + Danbooru + AI 推荐并行，统一合并
      const sortByMatch = (arr: TagSuggestion[]) => {
        arr.sort((a, b) => {
          const getMatchScore = (s: TagSuggestion) => {
            const val = s.value.toLowerCase();
            const label = s.label.toLowerCase();
            const chinese = s.chineseName?.toLowerCase() || '';
            if (val === queryLower || label === queryLower || chinese === query) return 100;
            if (val.startsWith(queryLower) || label.startsWith(queryLower) || chinese.startsWith(query)) return 80;
            if (val.includes(queryLower) || label.includes(queryLower) || chinese.includes(query)) return 60;
            return 0;
          };
          return getMatchScore(b) - getMatchScore(a);
        });
      };

      // AI 推荐和直译不依赖 autocomplete 结果，提前并行启动
      // aiDirect 已合并到 aiRecommend，共享同一开关
      const aiRecommendCfg = getSrcCfg(settings.autocompleteSources, 'aiRecommend');
      const nlCfg = getSrcCfg(settings.autocompleteSources, 'nl');
      const danbooruCfg = getSrcCfg(settings.autocompleteSources, 'danbooru');
      const aiPromise = onWikiLoaded && aiRecommendCfg.enabled
        ? Promise.all([aiRecommendTags(query), aiDirectTranslate(query)])
        : null;

      // 先只等本地结果（瞬时），Danbooru 异步补充
      const localResults = await searchLocalTags(query, settings.autocompleteSources, currentUserId);

      // 用本地结果构建初始 suggestions
      const normalizeKey = (s: string) => s.toLowerCase().replace(/ /g, '_');
      const localValues = new Set<string>();
      const initialMerged: TagSuggestion[] = [];

      for (const s of localResults.high) {
        localValues.add(normalizeKey(s.value));
        initialMerged.push(s);
      }
      for (const s of localResults.low) {
        localValues.add(normalizeKey(s.value));
      }
      // 低优先本地结果追加
      for (const s of localResults.low) initialMerged.push(s);

      suggestions = initialMerged.slice(0, 10);

      // 中文输入时，含中文逗号或超过3个中文字符才显示"转换自然语言"选项
      const chineseCharCount = (query.match(/[\u4e00-\u9fa5]/g) || []).length;
      if (nlCfg.enabled && (query.includes('，') || chineseCharCount > 3)) {
        suggestions.unshift({
          value: query,
          label: '翻译为英文',
          chineseName: '直接翻译为英文',
          source: 'danbooru' as const,
          isNaturalLanguage: true,
        });
      }

      // 合并模式：先弹出一个加载占位，待所有数据源返回后统一显示，
      // 不再分阶段刷新，避免推荐列表多次跳变
      if (onWikiLoaded) {
        onWikiLoaded([{
          value: '__ai_loading__',
          label: '加载推荐中…',
          source: 'danbooru' as const,
          isAiLoading: true,
        }]);
      }

      // Danbooru 异步补充（中文命中率低，但仍尝试）
      const danbooruLimit = danbooruCfg.enabled ? Math.min(Math.max(danbooruCfg.maxCount ?? 7, 1), 20) : 0;
      const danbooruPromise = danbooruLimit > 0
        ? fetch(`${backendUrl}/api/tags/autocomplete?query=${encodeURIComponent(query)}&limit=${danbooruLimit}`)
            .then(res => res.ok ? res.json() : [])
            .catch(() => [])
        : Promise.resolve([]);

      // DanbooruSearch HF Space 语义搜索（中文场景命中率高，与 /autocomplete 互补）
      // 与 danbooru 共用 enabled 开关：用户禁用 Danbooru 源时一并跳过
      const dsSearchLimit = danbooruCfg.enabled
        ? Math.min(Math.max(danbooruCfg.maxCount ?? 10, 10), 30)
        : 0;
      const dsSearchPromise = dsSearchLimit > 0
        ? fetch(`${backendUrl}/api/tags/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, limit: dsSearchLimit, show_nsfw: true }),
          }).then(res => res.ok ? res.json() : { results: [] })
            .catch(() => ({ results: [] }))
        : Promise.resolve({ results: [] });

      // 等待所有数据源（Danbooru 自动补全 / 语义搜索 / AI 推荐）全部返回后统一合并
      const [danbooruData, dsData, aiResolved] = await Promise.all([
        danbooruPromise,
        dsSearchPromise,
        (aiPromise ?? Promise.resolve(null)).catch(() => null),
      ]);

      // Danbooru 自动补全结果
      if (Array.isArray(danbooruData) && danbooruData.length > 0) {
        const existingKeys = new Set(suggestions.map(s => normalizeKey(s.value)));
        for (const item of danbooruData) {
          const val = item.value?.replace(/ /g, '_') || item.name?.replace(/ /g, '_') || '';
          const postCount = item.post_count || 0;
          const key = normalizeKey(val);
          if (val && !existingKeys.has(key) && !localValues.has(key) && (!postCount || postCount >= 50)) {
            existingKeys.add(key);
            suggestions.push({
              value: val,
              label: item.label || item.value || item.name || '',
              postCount: item.post_count,
              source: 'danbooru' as const,
            });
          }
        }
      }

      // DanbooruSearch HF Space 语义搜索结果
      const dsResults: any[] = (dsData && Array.isArray((dsData as any).results)) ? (dsData as any).results : [];
      if (dsResults.length > 0) {
        const existingKeys = new Set(suggestions.map(s => normalizeKey(s.value)));
        for (const item of dsResults) {
          const rawTag = String(item?.tag || '').trim();
          if (!rawTag) continue;
          const tag = rawTag.replace(/ /g, '_').toLowerCase();
          const key = normalizeKey(tag);
          if (existingKeys.has(key) || localValues.has(key)) continue;
          existingKeys.add(key);
          const cn = typeof item.cn_name === 'string' ? item.cn_name.trim() : '';
          const cnt = typeof item.count === 'number' ? item.count : undefined;
          suggestions.push({
            value: tag,
            label: tag.replace(/_/g, ' '),
            chineseName: cn || undefined,
            postCount: cnt,
            category: typeof item.category === 'string' ? item.category : undefined,
            source: 'danbooru' as const,
            verified: true, // 上游来自 Danbooru, 视为已验证, 无需再走 /verify
          });
        }
      }

      // AI 推荐 / AI 直译结果
      if (aiResolved) {
        const [aiTags, directTag] = aiResolved;
        const existingKeys = new Set(suggestions.map(s => normalizeKey(s.value)));
        // AI 直译结果 → 插到"翻译为英文"选项之后
        if (directTag) {
          const key = normalizeKey(directTag);
          if (!existingKeys.has(key)) {
            existingKeys.add(key);
            const nlCount = suggestions.filter(s => s.isNaturalLanguage).length;
            suggestions.splice(nlCount, 0, { value: directTag, label: directTag, source: 'danbooru' as const, verified: true, isAiDirect: true });
          }
        }
        // AI 推荐结果
        for (const t of aiTags) {
          const key = normalizeKey(t);
          if (!existingKeys.has(key)) {
            existingKeys.add(key);
            suggestions.push({ value: t, label: t, source: 'danbooru' as const, isAiRecommend: true });
          }
        }
      }

      // 标签验证（postCount）+ Wiki 中文名 并行获取
      const tagsNeedVerify = suggestions.filter(s => !s.isNaturalLanguage && s.source === 'danbooru' && !s.postCount).map(s => s.value);
      const allNeedWiki = suggestions.filter(s => !s.chineseName && !s.isNaturalLanguage && s.source === 'danbooru').map(s => s.value);
      const [verifyResult, wikiNames] = await Promise.all([
        tagsNeedVerify.length > 0
          ? fetch(`${backendUrl}/api/tags/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags: tagsNeedVerify.map(t => t.replace(/ /g, '_')) }),
          }).then(res => res.ok ? res.json() as Promise<Record<string, number>> : ({} as Record<string, number>)).catch(() => ({} as Record<string, number>))
          : Promise.resolve({} as Record<string, number>),
        allNeedWiki.length > 0
          ? fetchWikiChineseNames(allNeedWiki).catch(() => ({} as Record<string, string[]>))
          : Promise.resolve({} as Record<string, string[]>),
      ]);

      // 应用验证结果
      if (tagsNeedVerify.length > 0) {
        const needVerifySet = new Set(tagsNeedVerify.map(t => t.replace(/ /g, '_').toLowerCase()));
        for (const s of suggestions) {
          const normalizedValue = s.value.replace(/ /g, '_').toLowerCase();
          if (needVerifySet.has(normalizedValue)) {
            s.verified = true;
            if (verifyResult[normalizedValue]) s.postCount = verifyResult[normalizedValue];
          }
        }
      }

      // 应用 Wiki 中文名，缺失的用 AI 翻译兜底
      if (allNeedWiki.length > 0) {
        const stillMissing: TagSuggestion[] = [];
        for (const s of suggestions) {
          if (!s.chineseName && !s.isNaturalLanguage && s.source === 'danbooru') {
            const names = wikiNames[s.value];
            if (names && names.length > 0) {
              s.chineseName = names.join(' / ');
            } else {
              stillMissing.push(s);
            }
          }
        }
        if (stillMissing.length > 0) {
          const aiTranslations = await Promise.allSettled(
            stillMissing.map(s => translateTagWithGemini(s.value))
          );
          for (let i = 0; i < stillMissing.length; i++) {
            const result = aiTranslations[i];
            if (result.status === 'fulfilled' && result.value) {
              stillMissing[i].chineseName = result.value;
            }
          }
        }
      }
    } else {
      // 英文搜索：先用本地结果立即弹面板，Danbooru 异步补充
      const danbooruCfg = getSrcCfg(settings.autocompleteSources, 'danbooru');
      const localResults = await searchLocalTags(query, settings.autocompleteSources, currentUserId);

      // 先用本地结果构建初始 suggestions
      const localSuggestions: TagSuggestion[] = [...localResults.high, ...localResults.low];
      suggestions = localSuggestions;

      // 立即将本地结果通过回调显示面板（不等 Danbooru）
      if (localSuggestions.length > 0 && onWikiLoaded) {
        const reordered = reorderByConfig(suggestions, settings.autocompleteSources);
        cache.set(cacheKey, reordered);
        onWikiLoaded(reordered);
      }

      // Danbooru 异步获取并合并
      const danbooruLimit = danbooruCfg.enabled ? Math.min(Math.max(danbooruCfg.maxCount ?? 7, 1), 20) : 0;
      const danbooruPromise = danbooruLimit > 0
        ? fetch(`${backendUrl}/api/tags/autocomplete?query=${encodeURIComponent(query)}&limit=${danbooruLimit}`)
            .then(res => res.ok ? res.json() : [])
            .catch(() => [])
        : Promise.resolve([]);

      (async () => {
        try {
          const data = await danbooruPromise;

          const danbooruSuggestions: TagSuggestion[] = data.map((item: any) => ({
            value: item.value?.replace(/ /g, '_') || item.name?.replace(/ /g, '_') || '',
            label: item.label || item.value || item.name || '',
            postCount: item.post_count,
            source: 'danbooru' as const,
          })).filter((s: TagSuggestion) => s.value && s.value.length > 1 && (!s.postCount || s.postCount >= 50));

          if (danbooruSuggestions.length === 0) return;

          // 合并：去除与本地重复的 Danbooru 结果
          const localValues = new Set(
            localSuggestions.map(s => s.value.toLowerCase())
          );
          const filteredDanbooru = danbooruSuggestions.filter(s => !localValues.has(s.value.toLowerCase())).slice(0, 10);

          // 构建合并结果：Danbooru 在前，local 在后
          const merged = [...filteredDanbooru, ...localSuggestions];

          // 排序
          if (settings.autocompleteSortOrder === 'prefix-first') {
            merged.sort((a, b) => {
              // local 始终排在自己的区域
              if (a.source === 'local' && b.source !== 'local') return 1;
              if (a.source !== 'local' && b.source === 'local') return -1;
              if (a.source === 'local' && b.source === 'local') return 0;
              const aStartsWith = a.value.toLowerCase().startsWith(queryLower);
              const bStartsWith = b.value.toLowerCase().startsWith(queryLower);
              if (aStartsWith && !bStartsWith) return -1;
              if (!aStartsWith && bStartsWith) return 1;
              return (b.postCount || 0) - (a.postCount || 0);
            });
          } else {
            merged.sort((a, b) => {
              if (a.source === 'local' && b.source !== 'local') return 1;
              if (a.source !== 'local' && b.source === 'local') return -1;
              return (b.postCount || 0) - (a.postCount || 0);
            });
          }

          // 按配置顺序/限额重排（取代旧的硬截断 10/5）
          const limitedMerged = reorderByConfig(merged, settings.autocompleteSources);

          // 更新 suggestions 引用
          suggestions.length = 0;
          suggestions.push(...limitedMerged);
          cache.set(cacheKey, suggestions);
          if (onWikiLoaded) onWikiLoaded(suggestions);

          // 异步获取中文别名
          if (settings.autocompleteShowWiki && onWikiLoaded) {
            const tagValues = suggestions.filter(s => s.source === 'danbooru').map(s => s.value);
            if (tagValues.length > 0) {
              const wikiNames = await fetchWikiChineseNames(tagValues);
              let hasUpdate = false;
              const missingTags: TagSuggestion[] = [];
              for (const s of suggestions) {
                if (s.source === 'danbooru') {
                  const chineseNames = wikiNames[s.value];
                  if (chineseNames && chineseNames.length > 0) {
                    s.chineseName = chineseNames.join(' / ');
                    hasUpdate = true;
                  } else {
                    missingTags.push(s);
                  }
                }
              }
              if (hasUpdate) {
                cache.set(cacheKey, suggestions);
                onWikiLoaded(suggestions);
                const wikiEntries = suggestions
                  .filter(s => s.source === 'danbooru' && s.chineseName && wikiNames[s.value])
                  .map(s => ({ tag: s.value, zh: s.chineseName!, source: 'wiki' as const }));
                submitTagTranslations(wikiEntries);
              }
              if (missingTags.length > 0) {
                const aiResults = await Promise.allSettled(
                  missingTags.map(s => translateTagWithGemini(s.value))
                );
                let aiUpdate = false;
                for (let i = 0; i < missingTags.length; i++) {
                  const result = aiResults[i];
                  if (result.status === 'fulfilled' && result.value) {
                    missingTags[i].chineseName = result.value;
                    aiUpdate = true;
                  }
                }
                if (aiUpdate) {
                  cache.set(cacheKey, suggestions);
                  onWikiLoaded(suggestions);
                  const aiEntries = missingTags
                    .filter(s => s.chineseName)
                    .map(s => ({ tag: s.value, zh: s.chineseName!, source: 'ai' as const }));
                  submitTagTranslations(aiEntries);
                }
              }
            }
          }
        } catch { /* ignore */ }
      })();
    }

    // 按配置顺序/限额重排（取代旧的硬截断 10/10）
    suggestions = reorderByConfig(suggestions, settings.autocompleteSources);

    // 缓存结果（先缓存无中文名的版本）
    cache.set(cacheKey, suggestions);

    // 限制缓存大小
    if (cache.size > 500) {
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
    }

    return suggestions;
  } catch (error) {
    console.warn('Failed to fetch tag suggestions:', error);
    return [];
  }
}

/**
 * 带防抖的标签建议获取
 */
export function getTagSuggestionsDebounced(
  query: string,
  callback: (suggestions: TagSuggestion[]) => void,
  delay = 200
): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  if (!query || query.length < 2) {
    currentQuery = '';
    callback([]);
    return;
  }

  // 记录当前查询
  currentQuery = query;

  debounceTimer = setTimeout(async () => {
    // 检查查询是否仍然是当前查询
    if (query !== currentQuery) return;

    // 传入包装后的回调，确保只有当前查询的结果才会被应用
    const wrappedCallback = (suggestions: TagSuggestion[]) => {
      // 再次检查，防止异步回调返回时查询已变化
      if (query === currentQuery) {
        callback(suggestions);
      }
    };

    const suggestions = await getTagSuggestions(query, wrappedCallback);
    // 最终结果也要检查
    if (query === currentQuery) {
      callback(suggestions);
    }
  }, delay);
}

/**
 * 清除缓存
 */
export function clearTagCache(): void {
  cache.clear();
}

/**
 * 取消当前的防抖请求（选择补全后调用，防止旧回调触发）
 */
export function cancelPendingAutocomplete(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  currentQuery = '';
}

/**
 * 清除画师串和OC数据缓存（数据更新后调用）
 */
export function clearArtistOCCache(): void {
  artistDataCache = null;
  ocDataCache = null;
  cache.clear(); // 同时清除搜索结果缓存
}

/**
 * 预加载画师串、OC和角色标签数据（登录后立即调用，无需等面板打开）
 */
export function preloadAutocompleteData(): void {
  loadRoleTagMapping().catch(() => {});
  loadArtistData().catch(() => {});
  loadOCData().catch(() => {});
}

/**
 * 从本地角色映射库查询角色的中文名
 */
export function lookupCharacterChineseName(roleEn: string): string | undefined {
  if (!roleTagMapping) return undefined;
  const key = roleEn.toLowerCase().replace(/ /g, '_');
  for (const data of Object.values(roleTagMapping)) {
    if (data.role_en.toLowerCase().replace(/ /g, '_') === key) {
      return data.role_zh[0] || undefined;
    }
  }
  return undefined;
}

// Gemini 翻译缓存（启动时从 localStorage 恢复）
const TRANSLATE_CACHE_KEY = 'tag_translate_cache';
const TRANSLATE_CACHE_MAX = 2000;

const geminiTranslateCache = new Map<string, string>();

// 从 localStorage 恢复翻译缓存
try {
  const stored = localStorage.getItem(TRANSLATE_CACHE_KEY);
  if (stored) {
    const entries: [string, string][] = JSON.parse(stored);
    for (const [k, v] of entries) geminiTranslateCache.set(k, v);
  }
} catch { /* ignore */ }

// 持久化翻译缓存（节流，最多每 5 秒写一次）
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistTranslateCache() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const entries = Array.from(geminiTranslateCache.entries()).slice(-TRANSLATE_CACHE_MAX);
      localStorage.setItem(TRANSLATE_CACHE_KEY, JSON.stringify(entries));
    } catch { /* ignore */ }
  }, 5000);
}

/**
 * 获取持久化翻译缓存的只读快照（供芯片编辑器初始化用）
 */
export function getTranslationCacheSnapshot(): Map<string, string> {
  return new Map(geminiTranslateCache);
}

/**
 * 将翻译结果写入持久化缓存（供芯片编辑器回写用）
 */
export function setTranslationCacheEntries(entries: Map<string, string>) {
  let changed = false;
  entries.forEach((v, k) => {
    if (v && !geminiTranslateCache.has(k)) {
      geminiTranslateCache.set(k, v);
      changed = true;
    }
  });
  if (changed) persistTranslateCache();
}

// AI 推荐标签缓存（中文 → 英文标签列表）
const aiRecommendCache = new Map<string, string[]>();

/**
 * 使用 AI 根据中文描述推荐 Danbooru 英文标签
 * 返回英文标签数组（下划线格式）
 */
async function aiRecommendTags(chineseQuery: string): Promise<string[]> {
  if (!chineseQuery) return [];

  const cached = aiRecommendCache.get(chineseQuery);
  if (cached) return cached;

  try {
    const messages = [{
      role: 'user',
      content: `你是 Danbooru 标签专家。用户输入中文描述，你需要推荐最相关的 Danbooru 英文标签。
规则：
- 只输出标签，每行一个，用下划线连接单词
- 推荐 5-8 个最相关的标签，按相关度排序
- 只推荐 Danbooru 上真实存在的标签
- 不要输出任何解释

用户输入：${chineseQuery}`
    }];

    const data = await requestSidecarChatCompletion(messages, 0.1, 200);
    const content = data.choices?.[0]?.message?.content?.trim() || '';

    const tags = content
      .split('\n')
      .map((line: string) => line.trim().replace(/^[-*•\d.)\s]+/, '').trim())
      .filter((t: string) => t && /^[a-z0-9_()]+$/i.test(t))
      .map((t: string) => t.toLowerCase())
      .slice(0, 8);

    if (tags.length > 0) {
      aiRecommendCache.set(chineseQuery, tags);
      if (aiRecommendCache.size > 200) {
        const firstKey = aiRecommendCache.keys().next().value;
        if (firstKey) aiRecommendCache.delete(firstKey);
      }
    }

    return tags;
  } catch (e) {
    console.warn('AI recommend tags error:', e);
    return [];
  }
}

// AI 直接翻译缓存（中文 → 单个英文标签）
const aiDirectTranslateCache = new Map<string, string>();

/**
 * 使用 AI 将中文直接翻译为一个英文标签（不限制 D 站标签）
 * 例如 "短灰色头发" → "short_gray_hair"
 */
async function aiDirectTranslate(chineseQuery: string): Promise<string> {
  if (!chineseQuery) return '';

  const cached = aiDirectTranslateCache.get(chineseQuery);
  if (cached) return cached;

  try {
    const messages = [{
      role: 'user',
      content: `将以下中文描述直接翻译为一个英文标签，用下划线连接单词。
规则：
- 只输出一个标签，不要多个
- 直接翻译，不要拆分成多个概念
- 用下划线连接单词，全小写
- 只输出标签本身，不要任何解释

中文：${chineseQuery}`
    }];

    const data = await requestSidecarChatCompletion(messages, 0.1, 50);
    const content = data.choices?.[0]?.message?.content?.trim() || '';

    // 取第一行，清理格式
    const tag = content.split('\n')[0].trim().replace(/^[-*•\s]+/, '').replace(/ /g, '_').toLowerCase();
    if (tag && /^[a-z0-9_()]+$/.test(tag)) {
      aiDirectTranslateCache.set(chineseQuery, tag);
      if (aiDirectTranslateCache.size > 200) {
        const firstKey = aiDirectTranslateCache.keys().next().value;
        if (firstKey) aiDirectTranslateCache.delete(firstKey);
      }
      return tag;
    }
    return '';
  } catch (e) {
    console.warn('AI direct translate error:', e);
    return '';
  }
}


// ========== 批量翻译队列 ==========
// 收集短时间内的翻译请求，合并为一次 API 调用
let batchQueue: { tag: string; resolve: (v: string) => void }[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;
const BATCH_DELAY = 150; // 收集窗口 150ms
const BATCH_MAX_SIZE = 30; // 单次最多翻译 30 个标签

function flushBatchQueue() {
  batchTimer = null;
  if (batchQueue.length === 0) return;

  const batch = batchQueue.splice(0, BATCH_MAX_SIZE);
  // 如果还有剩余，继续排队
  if (batchQueue.length > 0) {
    batchTimer = setTimeout(flushBatchQueue, BATCH_DELAY);
  }

  const tags = batch.map(b => b.tag);

  (async () => {
    try {
      const prompt = `将以下 Danbooru 图像标签翻译成简洁的中文。返回 JSON 数组，顺序与输入一致，每个元素是对应标签的中文翻译。
只输出 JSON 数组，不要其他内容。

${JSON.stringify(tags.map(t => t.replace(/_/g, ' ')))}`;

      const messages = [{ role: 'user', content: prompt }];
      const data = await requestSidecarChatCompletion(messages, 0.1, 2000);
      const content = data.choices?.[0]?.message?.content?.trim() || '';

      // 解析 JSON 数组
      let parsed: string[] | null = null;
      try {
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
      } catch { /* ignore */ }

      for (let i = 0; i < batch.length; i++) {
        const translation = (parsed && i < parsed.length && typeof parsed[i] === 'string') ? parsed[i].trim() : '';
        if (translation) {
          geminiTranslateCache.set(batch[i].tag, translation);
        }
        batch[i].resolve(translation);
      }
      persistTranslateCache();
      // AI 翻译结果回写映射库
      if (parsed) {
        const entries = batch
          .map((b, i) => ({ tag: b.tag, zh: (parsed![i] || '').trim(), source: 'ai' as const }))
          .filter(e => e.zh && e.zh !== e.tag);
        submitTagTranslations(entries);
      }
    } catch {
      for (const b of batch) b.resolve('');
    }
  })();
}

/**
 * 使用 AI 翻译英文标签为中文（自动合并为批量请求）
 * 短时间内的多次调用会被合并为一次 API 请求
 */
export function translateTagWithGemini(tag: string): Promise<string> {
  if (!tag) return Promise.resolve('');

  const cached = geminiTranslateCache.get(tag);
  if (cached !== undefined) return Promise.resolve(cached);

  return new Promise((resolve) => {
    batchQueue.push({ tag, resolve });
    if (!batchTimer) {
      batchTimer = setTimeout(flushBatchQueue, BATCH_DELAY);
    }
    // 队列满了立即发送
    if (batchQueue.length >= BATCH_MAX_SIZE) {
      if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
      flushBatchQueue();
    }
  });
}
