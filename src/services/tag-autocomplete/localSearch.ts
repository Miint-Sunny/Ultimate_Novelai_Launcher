// 本地搜索与本地数据缓存（local search/cache）
// 角色映射、画师串、OC 的加载与按中文/英文打分搜索，
// 以及登录后预加载、角色中文名查询、数据更新后的缓存清理。
// 打分阈值与排序保持不变。

import { sidecarApi } from '../../api/sidecar';
import type { AutocompleteSourceConfig } from '../localLibrary';
import { botService } from '../botService';
import { getSrcCfg } from './ranking';
import { clearTagCache } from './suggestionCache';
import type { TagSuggestion } from './types';

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
export interface LocalSearchResult {
  high: TagSuggestion[];  // 精确/开头匹配
  low: TagSuggestion[];   // 包含/作品名匹配
}

export async function searchLocalTags(query: string, sources: AutocompleteSourceConfig[], currentUserId: string | null): Promise<LocalSearchResult> {
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
 * 清除画师串和OC数据缓存（数据更新后调用）
 */
export function clearArtistOCCache(): void {
  artistDataCache = null;
  ocDataCache = null;
  clearTagCache(); // 同时清除搜索结果缓存
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
