import { useState, useEffect } from 'react';
import { appBackendApi } from '../api/appBackendApi';
import { API_PATHS } from './apiConfig';

/* ─── 角色识别工具 ─── */
// 桌面 ToolsModal 与移动 tools 共用此实现（两端原为逐字副本，已统一到此处）。
// 行为敏感：LCS 阈值 0.90 与 5 个匹配上限必须保持不变。

interface RoleTagEntry {
  role_en: string;
  role_zh: string[];
  origin_en: string;
  origin_zh: string[];
  ai_validated?: boolean;
}

interface OCEntry {
  zh_name?: string;
  tag_group?: string;
  [key: string]: any;
}

type RoleTagMapping = Record<string, RoleTagEntry>;
type OCData = Record<string, OCEntry>;

let cachedRoleTagMapping: RoleTagMapping | null = null;
let cachedOCData: OCData | null = null;

async function fetchRoleTagMapping(): Promise<RoleTagMapping> {
  if (cachedRoleTagMapping) return cachedRoleTagMapping;
  try {
    const res = await appBackendApi.request(API_PATHS.DATA_ROLE_TAG_MAPPING);
    if (!res.ok) return {};
    cachedRoleTagMapping = await res.json();
    return cachedRoleTagMapping!;
  } catch {
    return {};
  }
}

async function fetchOCData(): Promise<OCData> {
  if (cachedOCData) return cachedOCData;
  try {
    const res = await appBackendApi.request(API_PATHS.DATA_OC_DATA);
    if (!res.ok) return {};
    cachedOCData = await res.json();
    return cachedOCData!;
  } catch {
    return {};
  }
}

function cleanToken(s: string): string {
  s = s.replace(/[+-]?\d+(?:\.\d+)?::/g, '');
  s = s.replace(/[\[\]{}\(\)]/g, '');
  s = s.replace(/:/g, '');
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function tokenizePrompt(text: string): Set<string> {
  const parts = text.split(/[，,]/);
  const out = new Set<string>();
  for (const p of parts) {
    const t = cleanToken(p);
    if (t) out.add(t);
  }
  return out;
}

function tokenizeInOrder(text: string): string[] {
  const parts = text.split(/[，,]/);
  const seq: string[] = [];
  for (const p of parts) {
    const t = cleanToken(p);
    if (t) seq.push(t);
  }
  return seq;
}

function lcsRatio(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[n][m] / n;
}

export interface CharacterMatch {
  zhName: string;
  enTag: string;
  origin: string;
  isOC?: boolean;
}

function matchCharacters(prompt: string, mapping: RoleTagMapping): CharacterMatch[] {
  const tokens = tokenizePrompt(prompt);
  const results: CharacterMatch[] = [];
  for (const [roleEn, info] of Object.entries(mapping)) {
    if (info.origin_en === 'original_character' || info.origin_en === 'oc') continue;
    const cleaned = cleanToken(roleEn);
    if (cleaned && tokens.has(cleaned)) {
      const zh = info.role_zh?.[0] || '';
      if (zh) {
        results.push({ zhName: zh, enTag: roleEn, origin: info.origin_zh?.[0] || info.origin_en || '' });
        if (results.length >= 5) break;
      }
    }
  }
  return results;
}

function matchOCs(prompt: string, ocData: OCData): CharacterMatch[] {
  const promptSeq = tokenizeInOrder(prompt);
  const results: CharacterMatch[] = [];
  for (const [enKey, data] of Object.entries(ocData)) {
    if (!data || typeof data !== 'object') continue;
    const tagGroup = data.tag_group || '';
    if (!tagGroup) continue;
    const ocSeq = tokenizeInOrder(tagGroup);
    if (lcsRatio(ocSeq, promptSeq) >= 0.90) {
      results.push({
        zhName: data.zh_name || enKey,
        enTag: enKey,
        origin: 'OC',
        isOC: true,
      });
      if (results.length >= 5) break;
    }
  }
  return results;
}

export function useCharacterRecognition(prompt: string | undefined): CharacterMatch[] {
  const [matches, setMatches] = useState<CharacterMatch[]>([]);
  useEffect(() => {
    if (!prompt) { setMatches([]); return; }
    let cancelled = false;
    Promise.all([fetchRoleTagMapping(), fetchOCData()]).then(([roleMapping, ocData]) => {
      if (cancelled) return;
      const roleMatches = matchCharacters(prompt, roleMapping);
      const ocMatches = matchOCs(prompt, ocData);
      setMatches([...roleMatches, ...ocMatches].slice(0, 5));
    });
    return () => { cancelled = true; };
  }, [prompt]);
  return matches;
}
