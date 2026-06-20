import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  X,
  FileSearch,
  FileX,
  FileEdit,
  Loader2,
  Copy,
  Trash2,
  Image as ImageIcon,
  Archive,
  Wrench,
  FolderOpen,
  Check,
  Info,
  Upload,
  Download,
  ArrowLeftRight,
  Users,
} from 'lucide-react';
import { extractImageMetadata, writeCustomMetadataToImage, type ImageMetadata } from '../utils/imageMetadata';
import { getFilesFromDirectory, type FileSystemDirectoryHandle } from '../utils/fileSystem';
import { useDragDrop } from '../contexts/DragDropContext';
import { buildApiUrl, API_PATHS } from '../utils/apiConfig';
import JSZip from 'jszip';

/* ─── 角色识别工具 ─── */

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
    const res = await fetch(buildApiUrl(API_PATHS.DATA_ROLE_TAG_MAPPING));
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
    const res = await fetch(buildApiUrl(API_PATHS.DATA_OC_DATA));
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

interface CharacterMatch {
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

function useCharacterRecognition(prompt: string | undefined) {
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

type ToolType = 'metadata' | 'weight';

interface ToolsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export interface MetadataFile {
  name: string;
  dataUrl: string;
  metadata: ImageMetadata | null;
  isSelected: boolean;
  fileSize: number;
}

const TOOLS = [
  { id: 'metadata' as const, name: '元数据工具', icon: FileSearch },
  { id: 'weight' as const, name: '权重转换', icon: ArrowLeftRight },
];

async function cleanImageMetadataProper(dataUrl: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('无法创建 canvas')); return; }
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      for (let i = 3; i < data.length; i += 4) { data[i] = 255; }
      ctx.putImageData(imageData, 0, 0);
      canvas.toBlob(
        (blob) => { if (blob) resolve(blob); else reject(new Error('转换失败')); },
        'image/png'
      );
    };
    img.onerror = () => reject(new Error('加载图片失败'));
    img.src = dataUrl;
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/* ─── 权重转换函数 ─── */

/** SD → NAI: (text:1.2) → 1.2::text::, (text) → {text} */
function convertSDToNAI(text: string): string {
  const res: string[] = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    // 处理转义括号 \( \) → 直接输出字面括号
    if (ch === '\\' && i + 1 < n && (text[i + 1] === '(' || text[i + 1] === ')')) {
      res.push(text[i + 1]);
      i += 2;
      continue;
    }
    if (ch === '(') {
      // 找到匹配的右括号
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')') depth--;
        j++;
      }
      if (depth === 0) {
        const inner = text.slice(i + 1, j - 1);
        // 检查 (content:weight) 格式
        const lastColon = inner.lastIndexOf(':');
        if (lastColon > 0) {
          const left = inner.slice(0, lastColon);
          const right = inner.slice(lastColon + 1);
          if (/^\s*\d+(?:\.\d+)?\s*$/.test(right)) {
            const weight = parseFloat(right.trim());
            const content = convertSDToNAI(left);
            if (Math.abs(weight - 1.05) < 0.001) {
              res.push(`{${content}}`);
            } else if (Math.abs(weight - 0.952381) < 0.001 || Math.abs(weight - 0.95) < 0.001) {
              res.push(`[${content}]`);
            } else {
              res.push(`${weight}::${content}::`);
            }
            i = j;
            continue;
          }
        }
        // 普通 (text) → {text}
        const processedInner = convertSDToNAI(inner);
        res.push(`{${processedInner}}`);
        i = j;
        continue;
      }
    } else if (ch === '[') {
      // SD [text] = decrease weight → NAI [text]
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (text[j] === '[') depth++;
        else if (text[j] === ']') depth--;
        j++;
      }
      if (depth === 0) {
        const inner = text.slice(i + 1, j - 1);
        res.push(`[${convertSDToNAI(inner)}]`);
        i = j;
        continue;
      }
    }
    res.push(ch);
    i++;
  }
  return res.join('');
}

/** NAI → SD: {text} → (text:1.05), [text] → [text], 1.2::text:: → (text:1.2) */
function convertNAIToSD(text: string): string {
  const res: string[] = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    // 检查 weight::content:: 格式
    if (/\d/.test(ch)) {
      // 尝试匹配 number::content::
      const numMatch = text.slice(i).match(/^(\d+(?:\.\d+)?)::/);
      if (numMatch) {
        const weight = parseFloat(numMatch[1]);
        const afterNum = i + numMatch[0].length;
        // 找到结束的 ::
        const endIdx = text.indexOf('::', afterNum);
        if (endIdx !== -1) {
          const content = text.slice(afterNum, endIdx);
          const converted = convertNAIToSD(content);
          res.push(`(${converted}:${weight})`);
          i = endIdx + 2;
          continue;
        }
      }
    }

    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      if (depth === 0) {
        const inner = text.slice(i + 1, j - 1);
        const converted = convertNAIToSD(inner);
        res.push(`(${converted}:1.05)`);
        i = j;
        continue;
      }
    } else if (ch === '[') {
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (text[j] === '[') depth++;
        else if (text[j] === ']') depth--;
        j++;
      }
      if (depth === 0) {
        const inner = text.slice(i + 1, j - 1);
        res.push(`[${convertNAIToSD(inner)}]`);
        i = j;
        continue;
      }
    }

    // 转义字面括号 ( ) → \( \)
    if (ch === '(' || ch === ')') {
      res.push(`\\${ch}`);
      i++;
      continue;
    }

    res.push(ch);
    i++;
  }
  return res.join('');
}

/** 将 NAI 格式文本解析为带权重高亮的 React 节点（匹配主编辑器样式） */
function renderNAIHighlighted(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let i = 0;
  const n = text.length;
  let key = 0;
  let plain = '';

  const flush = () => {
    if (plain) { nodes.push(<span key={key++}>{plain}</span>); plain = ''; }
  };

  while (i < n) {
    const ch = text[i];

    // weight::content:: 格式
    if (/\d/.test(ch) || ch === '-') {
      const m = text.slice(i).match(/^(-?\d+(?:\.\d+)?)::([\s\S]*?)::/);
      if (m) {
        flush();
        const w = parseFloat(m[1]);
        const bg = w >= 0 ? 'rgba(116, 39, 13, 1)' : 'rgba(96, 165, 250, 0.3)';
        nodes.push(
          <span key={key++} style={{ backgroundColor: bg, borderRadius: '2px' }}>
            {m[0]}
          </span>
        );
        i += m[0].length;
        continue;
      }
    }

    if (ch === '{') {
      let depth = 1; let j = i + 1;
      while (j < n && depth > 0) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
      if (depth === 0) {
        flush();
        nodes.push(<span key={key++} style={{ backgroundColor: 'rgba(116, 39, 13, 0.5)', borderRadius: '2px' }}>{text.slice(i, j)}</span>);
        i = j; continue;
      }
    }

    if (ch === '[') {
      let depth = 1; let j = i + 1;
      while (j < n && depth > 0) { if (text[j] === '[') depth++; else if (text[j] === ']') depth--; j++; }
      if (depth === 0) {
        flush();
        nodes.push(<span key={key++} style={{ backgroundColor: 'rgba(96, 165, 250, 0.15)', borderRadius: '2px' }}>{text.slice(i, j)}</span>);
        i = j; continue;
      }
    }

    plain += ch;
    i++;
  }
  flush();
  return nodes;
}

/** 将 SD 格式文本解析为带权重高亮的 React 节点（匹配主编辑器样式） */
function renderSDHighlighted(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let i = 0;
  const n = text.length;
  let key = 0;
  let plain = '';

  const flush = () => {
    if (plain) { nodes.push(<span key={key++}>{plain}</span>); plain = ''; }
  };

  while (i < n) {
    const ch = text[i];

    if (ch === '(') {
      let depth = 1; let j = i + 1;
      while (j < n && depth > 0) { if (text[j] === '(') depth++; else if (text[j] === ')') depth--; j++; }
      if (depth === 0) {
        flush();
        const inner = text.slice(i + 1, j - 1);
        const lastColon = inner.lastIndexOf(':');
        let bg = 'rgba(116, 39, 13, 0.5)';
        if (lastColon > 0) {
          const wStr = inner.slice(lastColon + 1);
          if (/^\s*-?\d+(?:\.\d+)?\s*$/.test(wStr)) {
            const w = parseFloat(wStr);
            bg = w >= 1 ? 'rgba(116, 39, 13, 0.5)' : 'rgba(96, 165, 250, 0.15)';
          }
        }
        nodes.push(<span key={key++} style={{ backgroundColor: bg, borderRadius: '2px' }}>{text.slice(i, j)}</span>);
        i = j; continue;
      }
    }

    if (ch === '[') {
      let depth = 1; let j = i + 1;
      while (j < n && depth > 0) { if (text[j] === '[') depth++; else if (text[j] === ']') depth--; j++; }
      if (depth === 0) {
        flush();
        nodes.push(<span key={key++} style={{ backgroundColor: 'rgba(96, 165, 250, 0.15)', borderRadius: '2px' }}>{text.slice(i, j)}</span>);
        i = j; continue;
      }
    }

    plain += ch;
    i++;
  }
  flush();
  return nodes;
}


/* ─── 右侧详情面板 ─── */
const CopyBtn: React.FC<{ text: string; field: string; copiedField: string | null; onCopy: (text: string, field: string) => void }> = ({ text, field, copiedField, onCopy }) => (
  <button
    onClick={() => onCopy(text, field)}
    className="p-1.5 rounded-md text-gray-500 hover:text-white hover:bg-gray-700/50 transition-colors"
  >
    {copiedField === field ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
  </button>
);

const PromptBlock: React.FC<{ label: string; text: string; field: string; copiedField: string | null; onCopy: (text: string, field: string) => void }> = ({ label, text, field, copiedField, onCopy }) => (
  <div>
    <div className="flex items-center justify-between mb-2">
      <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{label}</span>
      <CopyBtn text={text} field={field} copiedField={copiedField} onCopy={onCopy} />
    </div>
    <div className="text-[13px] text-gray-200 bg-gray-900/50 rounded-xl p-4 max-h-36 overflow-y-auto leading-relaxed whitespace-pre-wrap break-all">
      {text}
    </div>
  </div>
);

export const MetadataDetailPanel: React.FC<{ file: MetadataFile; onImport?: (metadata: ImageMetadata) => void }> = ({ file, onImport }) => {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const m = file.metadata;
  const fullPrompt = m ? [m.prompt, ...(m.characterPrompts?.map(cp => cp.prompt) || [])].filter(Boolean).join(', ') : '';
  const charMatches = useCharacterRecognition(fullPrompt);

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  };

  return (
    <div className="flex flex-col h-full">
      {/* 图片预览 + 基础信息 */}
      <div className="p-5 border-b border-gray-700/40 shrink-0">
        <div className="flex gap-4">
          {file.dataUrl && (
            <img src={file.dataUrl} alt={file.name} className="w-28 h-28 object-contain rounded-xl bg-gray-900/60 shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-white truncate mb-2">{file.name}</div>
            <div className="space-y-1 text-xs">
              {[
                { label: '大小', value: file.fileSize > 0 ? formatFileSize(file.fileSize) : '-' },
                { label: '尺寸', value: m ? `${m.width}×${m.height}` : '-' },
                { label: '格式', value: m?.sourceType || '-' },
                { label: '来源', value: m?.source || '未知' },
              ].map(item => (
                <div key={item.label} className="flex items-start gap-2">
                  <span className="text-gray-500 shrink-0">{item.label}</span>
                  <span className="text-white break-all">{item.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 详细元数据 */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {!m ? (
          <div className="flex items-center gap-3 text-gray-400 text-sm bg-gray-900/40 rounded-xl p-4">
            <Info className="w-5 h-5 shrink-0" />
            此图片不包含可识别的元数据
          </div>
        ) : (
          <>
            {m.prompt && <PromptBlock label="正向提示词" text={m.prompt} field="prompt" copiedField={copiedField} onCopy={handleCopy} />}
            {m.negativePrompt && <PromptBlock label="负向提示词" text={m.negativePrompt} field="negative" copiedField={copiedField} onCopy={handleCopy} />}

            {/* 角色提示词 */}
            {m.characterPrompts && m.characterPrompts.length > 0 && (
              <div>
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">角色提示词</span>
                <div className="mt-2 space-y-2">
                  {m.characterPrompts.map((cp, i) => (
                    <div key={i} className="bg-gray-900/50 rounded-xl p-3.5">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-gray-500 font-medium">
                          角色 {i + 1}{cp.center ? ` (${cp.center.x.toFixed(2)}, ${cp.center.y.toFixed(2)})` : ''}
                        </span>
                        <CopyBtn text={cp.prompt} field={`char_${i}`} copiedField={copiedField} onCopy={handleCopy} />
                      </div>
                      <div className="text-[13px] text-gray-200 whitespace-pre-wrap break-all">{cp.prompt}</div>
                      {cp.uc && <div className="text-[13px] text-red-400/70 mt-1.5 whitespace-pre-wrap break-all">UC: {cp.uc}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 角色识别 */}
            {charMatches.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <Users className="w-3.5 h-3.5 text-gray-400" />
                  <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">角色识别</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {charMatches.map((ch, i) => (
                    <span key={i} className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs ${ch.isOC ? 'bg-purple-500/15 text-purple-400' : 'bg-nai-accent/15 text-nai-accent'}`}>
                      {ch.isOC && <span className="text-[9px] font-bold bg-purple-500/30 rounded px-1 py-0.5 mr-0.5">OC</span>}
                      <span className="font-medium">{ch.zhName}</span>
                      <span className={`text-[10px] ${ch.isOC ? 'text-purple-400/60' : 'text-nai-accent/60'}`}>[{ch.enTag}]</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 生成参数 */}
            <div>
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">生成参数</span>
              <div className="grid grid-cols-3 gap-2 mt-2">
                {[
                  { label: 'Seed', value: m.seed },
                  { label: 'Steps', value: m.steps },
                  { label: 'CFG Scale', value: m.scale },
                  { label: 'Sampler', value: m.sampler },
                  { label: 'Noise Schedule', value: m.noiseSchedule },
                  { label: 'CFG Rescale', value: m.cfgRescale },
                ].filter(p => p.value !== undefined && p.value !== null && p.value !== '').map((p) => (
                  <div key={p.label} className="bg-gray-900/50 rounded-lg px-3 py-2.5">
                    <div className="text-[10px] text-gray-500 uppercase">{p.label}</div>
                    <div className="text-xs text-white mt-0.5 truncate">{String(p.value)}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* SD 额外参数 */}
            {m.raw?.type === 'stable-diffusion' && m.raw?.settings && (() => {
              const s = m.raw.settings;
              const sdParams = [
                { label: 'Denoising', value: s.denoisingStrength },
                { label: 'Clip Skip', value: s.clipSkip },
                { label: 'Hires Upscale', value: s.hiresUpscale },
                { label: 'Hires Upscaler', value: s.hiresUpscaler },
                { label: 'Model Hash', value: s.modelHash },
                { label: 'Version', value: s.version },
                { label: 'Lora Hashes', value: s.loraHashes },
              ].filter(p => p.value !== undefined && p.value !== null && p.value !== '');
              if (sdParams.length === 0) return null;
              return (
                <div>
                  <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">SD 参数</span>
                  <div className="grid grid-cols-3 gap-2 mt-2">
                    {sdParams.map((p) => (
                      <div key={p.label} className="bg-gray-900/50 rounded-lg px-3 py-2.5">
                        <div className="text-[10px] text-gray-500 uppercase">{p.label}</div>
                        <div className="text-xs text-white mt-0.5 truncate">{String(p.value)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* LoRA */}
            {m.loras && m.loras.length > 0 && (
              <div>
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">LoRA</span>
                <div className="mt-2 space-y-1.5">
                  {m.loras.map((lora, i) => (
                    <div key={i} className="flex items-center justify-between bg-gray-900/50 rounded-lg px-3.5 py-2.5">
                      <span className="text-xs text-white truncate">{lora.name}</span>
                      <span className="text-xs text-gray-400 shrink-0 ml-3 font-mono">{lora.weight}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Vibe */}
            {m.vibes && m.vibes.length > 0 && (
              <div>
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Vibe Transfer ({m.vibes.length})</span>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  {m.vibes.map((v, i) => (
                    <div key={i} className="bg-gray-900/50 rounded-lg px-3 py-2.5">
                      <div className="text-[10px] text-gray-500">Vibe {i + 1}</div>
                      <div className="text-xs text-white">强度: {v.strength}</div>
                      {v.informationExtracted !== undefined && <div className="text-xs text-gray-400">提取: {v.informationExtracted}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 原始 JSON */}
            {m.raw && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">原始数据</span>
                  <CopyBtn text={JSON.stringify(m.raw, null, 2)} field="raw" copiedField={copiedField} onCopy={handleCopy} />
                </div>
                <pre className="text-[11px] text-gray-400 bg-gray-900/50 rounded-xl p-4 max-h-52 overflow-auto whitespace-pre-wrap break-all font-mono leading-relaxed">
                  {JSON.stringify(m.raw, null, 2)}
                </pre>
              </div>
            )}
          </>
        )}
      </div>

      {/* 导入参数按钮 */}
      {onImport && m && (
        <div className="p-4 border-t border-gray-700/40 shrink-0">
          <button
            onClick={() => onImport(m)}
            className="w-full flex items-center justify-center gap-2 py-2.5 bg-nai-accent hover:bg-nai-accent/80 text-black font-bold rounded-xl transition-colors text-sm"
          >
            <Download className="w-4 h-4" />
            导入参数到生成面板
          </button>
        </div>
      )}
    </div>
  );
};

/* ─── 主组件 ─── */
export const ToolsModal: React.FC<ToolsModalProps> = ({ isOpen, onClose }) => {
  const [activeTool, setActiveTool] = useState<ToolType>('metadata');
  const [metadataFiles, setMetadataFiles] = useState<MetadataFile[]>([]);
  const [isLoadingMetadata, setIsLoadingMetadata] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState({ current: 0, total: 0 });
  const [batchMode, setBatchMode] = useState<'clean' | 'custom'>('clean');
  const [customPrompt, setCustomPrompt] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [viewingIndex, setViewingIndex] = useState<number | null>(null);
  const [isDraggingInModal, setIsDraggingInModal] = useState(false);
  const metadataInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);
  const _stable = useCallback(() => {}, []);
  void _stable;

  // 权重转换工具状态
  const [weightDirection, setWeightDirection] = useState<'sd2nai' | 'nai2sd'>('sd2nai');
  const [weightInput, setWeightInput] = useState('');
  const [weightOutput, setWeightOutput] = useState('');
  const [weightCopied, setWeightCopied] = useState(false);
  const [weightStripLora, setWeightStripLora] = useState(true);

  const handleWeightConvert = useCallback(() => {
    if (!weightInput.trim()) { setWeightOutput(''); return; }
    try {
      let input = weightInput;
      if (weightStripLora) {
        // 去除 <lora:name:weight> 格式，并清理多余逗号/空格
        input = input.replace(/<lora:[^>]*>/g, '').replace(/,\s*,/g, ',').replace(/^\s*,|,\s*$/g, '').trim();
      }
      setWeightOutput(weightDirection === 'sd2nai' ? convertSDToNAI(input) : convertNAIToSD(input));
    } catch { setWeightOutput('转换失败'); }
  }, [weightInput, weightDirection, weightStripLora]);

  const handleWeightCopy = useCallback(() => {
    if (!weightOutput) return;
    navigator.clipboard.writeText(weightOutput);
    setWeightCopied(true);
    setTimeout(() => setWeightCopied(false), 1500);
  }, [weightOutput]);

  const { processFileForTarget } = useDragDrop();

  const handleImportToGeneration = useCallback((metadata: ImageMetadata) => {
    processFileForTarget('import', metadata, {
      prompt: true,
      negativePrompt: true,
      characters: true,
      appendCharacters: false,
      settings: true,
      seed: true,
      vibes: true,
      cleanImports: true,
    });
    onClose();
  }, [processFileForTarget, onClose]);

  const canSaveToFolder = typeof (window as any).showDirectoryPicker === 'function';

  if (!isOpen) return null;

  const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });

  const processFiles = async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    setIsLoadingMetadata(true);
    setLoadingProgress({ current: 0, total: imageFiles.length });
    const newFiles: MetadataFile[] = [];
    for (let i = 0; i < imageFiles.length; i++) {
      setLoadingProgress({ current: i + 1, total: imageFiles.length });
      try {
        const dataUrl = await readFileAsDataUrl(imageFiles[i]);
        const metadata = await extractImageMetadata(imageFiles[i]);
        newFiles.push({ name: imageFiles[i].name, dataUrl, metadata, isSelected: false, fileSize: imageFiles[i].size });
      } catch {
        newFiles.push({ name: imageFiles[i].name, dataUrl: '', metadata: null, isSelected: false, fileSize: imageFiles[i].size });
      }
    }
    setMetadataFiles((prev) => [...prev, ...newFiles]);
    setIsLoadingMetadata(false);
    setLoadingProgress({ current: 0, total: 0 });
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    await processFiles(Array.from(e.target.files));
    e.target.value = '';
  };

  const handleFolderSelect = async () => {
    try {
      const dirHandle = await (window as any).showDirectoryPicker() as FileSystemDirectoryHandle;
      await processFiles(await getFilesFromDirectory(dirHandle));
    } catch (err: any) {
      if (err?.name !== 'AbortError') console.error('打开文件夹失败:', err);
    }
  };

  const toggleSelect = (i: number) =>
    setMetadataFiles((prev) => prev.map((f, idx) => idx === i ? { ...f, isSelected: !f.isSelected } : f));

  const toggleSelectAll = () => {
    const all = metadataFiles.every((f) => f.isSelected);
    setMetadataFiles((prev) => prev.map((f) => ({ ...f, isSelected: !all })));
  };

  const removeSelected = () => {
    setMetadataFiles((prev) => prev.filter((f) => !f.isSelected));
    setViewingIndex(null);
  };

  const clearAll = () => { setMetadataFiles([]); setViewingIndex(null); };

  const getProcessed = (f: MetadataFile) =>
    batchMode === 'clean' ? cleanImageMetadataProper(f.dataUrl) : writeCustomMetadataToImage(f.dataUrl, customPrompt);
  const getSuffix = () => batchMode === 'clean' ? '_clean' : '_custom';
  const getOutName = (f: MetadataFile) => `${f.name.replace(/\.[^/.]+$/, '')}${getSuffix()}.png`;

  const handleDownloadZip = async () => {
    const sel = metadataFiles.filter((f) => f.isSelected && f.dataUrl);
    if (!sel.length) return;
    setIsProcessing(true);
    try {
      if (sel.length === 1) {
        const blob = await getProcessed(sel[0]);
        const url = URL.createObjectURL(blob);
        Object.assign(document.createElement('a'), { href: url, download: getOutName(sel[0]) }).click();
        URL.revokeObjectURL(url);
      } else {
        const zip = new JSZip();
        for (const f of sel) {
          try { zip.file(getOutName(f), await getProcessed(f)); }
          catch (e) { console.error(`处理 ${f.name} 失败:`, e); }
        }
        const url = URL.createObjectURL(await zip.generateAsync({ type: 'blob' }));
        Object.assign(document.createElement('a'), { href: url, download: `processed_${Date.now()}.zip` }).click();
        URL.revokeObjectURL(url);
      }
    } catch (e) { console.error('处理失败:', e); }
    setIsProcessing(false);
  };

  const handleSaveToFolder = async () => {
    const sel = metadataFiles.filter((f) => f.isSelected && f.dataUrl);
    if (!sel.length) return;
    setIsProcessing(true);
    try {
      const dirHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' }) as FileSystemDirectoryHandle;
      for (const f of sel) {
        try {
          const blob = await getProcessed(f);
          const fileHandle = await dirHandle.getFileHandle(getOutName(f), { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
        } catch (e) { console.error(`处理 ${f.name} 失败:`, e); }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') console.error('保存失败:', e);
    }
    setIsProcessing(false);
  };

  const selectedCount = metadataFiles.filter((f) => f.isSelected).length;
  const allSelected = metadataFiles.length > 0 && metadataFiles.every((f) => f.isSelected);
  const viewingFile = viewingIndex !== null ? metadataFiles[viewingIndex] : null;
  const hasFiles = metadataFiles.length > 0;

  const handleModalDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) setIsDraggingInModal(true);
  };
  const handleModalDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDraggingInModal(false);
  };
  const handleModalDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const handleModalDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDraggingInModal(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length > 0) {
      setActiveTool('metadata');
      await processFiles(files);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70"
      onClick={onClose}
      onDragEnter={handleModalDragEnter}
      onDragLeave={handleModalDragLeave}
      onDragOver={handleModalDragOver}
      onDrop={handleModalDrop}
    >
      <div className="bg-nai-panel border border-gray-700 rounded-2xl shadow-2xl w-[90vw] max-w-[1020px] h-[85vh] max-h-[700px] flex flex-col overflow-hidden relative" onClick={(e) => e.stopPropagation()}>

        {/* 拖拽提示覆盖层 */}
        {isDraggingInModal && (
          <div className="absolute inset-0 z-10 bg-nai-accent/10 border-2 border-dashed border-nai-accent rounded-2xl flex items-center justify-center pointer-events-none">
            <div className="flex flex-col items-center gap-2">
              <Upload className="w-10 h-10 text-nai-accent" />
              <span className="text-sm font-semibold text-nai-accent">拖放图片到此处</span>
            </div>
          </div>
        )}

        {/* ━━ 顶栏：标题 + Tab + 关闭 ━━ */}
        <div className="shrink-0 border-b border-gray-700 flex items-center px-6 py-3">
          <div className="flex items-center gap-3 shrink-0">
            <Wrench className="w-5 h-5 text-nai-accent" />
            <h3 className="text-lg font-bold text-white">工具箱</h3>
          </div>
          <div className="flex items-center ml-6">
            {TOOLS.map((tool) => (
              <button
                key={tool.id}
                className={`relative flex items-center gap-2 px-5 py-2.5 text-sm font-medium transition-colors ${
                  activeTool === tool.id ? 'text-nai-accent' : 'text-gray-400 hover:text-white'
                }`}
                onClick={() => setActiveTool(tool.id)}
              >
                <tool.icon className="w-4 h-4" />
                {tool.name}
                {activeTool === tool.id && <div className="absolute bottom-0 left-3 right-3 h-0.5 bg-nai-accent rounded-full" />}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-700 rounded-lg text-gray-400 hover:text-white transition-colors ml-auto">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ━━ 内容区 ━━ */}
        {activeTool === 'metadata' && !hasFiles && (
          /* ── 空状态：大面积引导 ── */
          <div className="flex-1 flex flex-col items-center justify-center px-10">
            <div className="w-24 h-24 rounded-3xl bg-gray-800/60 flex items-center justify-center mb-6">
              <Upload className="w-11 h-11 text-gray-500" />
            </div>
            <h4 className="text-xl font-semibold text-white mb-2">添加图片开始使用</h4>
            <p className="text-sm text-gray-400 text-center max-w-sm leading-relaxed mb-8">
              查看图片的完整生成参数，或批量清除 / 覆写元数据后下载
            </p>
            <div className="flex items-center gap-4">
              <input ref={metadataInputRef} type="file" multiple accept="image/*" onChange={handleFileSelect} className="hidden" />
              <button
                onClick={() => metadataInputRef.current?.click()}
                className="flex items-center gap-2.5 px-7 py-3 bg-nai-accent text-black rounded-xl text-sm font-bold hover:bg-nai-accent/90 transition-colors"
              >
                <ImageIcon className="w-5 h-5" />
                选择图片
              </button>
              <button
                onClick={handleFolderSelect}
                className="flex items-center gap-2.5 px-7 py-3 bg-gray-800 text-gray-200 border border-gray-600 rounded-xl text-sm font-semibold hover:bg-gray-700 hover:text-white transition-colors"
              >
                <FolderOpen className="w-5 h-5" />
                扫描文件夹
              </button>
            </div>
          </div>
        )}

        {activeTool === 'metadata' && hasFiles && (
          <div className="flex-1 flex overflow-hidden">

            {/* ── 左侧：图片网格 ── */}
            <div className="w-[65%] shrink-0 flex flex-col border-r border-gray-700/50">

              {/* 操作栏 */}
              <div className="px-4 py-3 border-b border-gray-700/40 bg-gray-900/20 shrink-0 flex items-center gap-2 flex-wrap">
                <input ref={metadataInputRef} type="file" multiple accept="image/*" onChange={handleFileSelect} className="hidden" />
                <button
                  onClick={() => metadataInputRef.current?.click()}
                  disabled={isLoadingMetadata}
                  className="flex items-center gap-2 px-3.5 py-2 bg-nai-accent/15 text-nai-accent border border-nai-accent/25 rounded-lg text-sm font-medium hover:bg-nai-accent/25 transition-colors"
                >
                  {isLoadingMetadata ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageIcon className="w-4 h-4" />}
                  添加
                </button>
                <button
                  onClick={handleFolderSelect}
                  disabled={isLoadingMetadata}
                  className="flex items-center gap-2 px-3.5 py-2 bg-gray-800/80 text-gray-300 border border-gray-700 rounded-lg text-sm font-medium hover:bg-gray-700 hover:text-white transition-colors"
                >
                  <FolderOpen className="w-4 h-4" />
                  文件夹
                </button>
                <div className="w-px h-5 bg-gray-700 mx-1" />
                <button onClick={toggleSelectAll} className="text-sm text-gray-400 hover:text-white px-2.5 py-1.5 rounded-lg hover:bg-gray-800 transition-colors">
                  {allSelected ? '取消全选' : '全选'}
                </button>
                {selectedCount > 0 && (
                  <button onClick={removeSelected} className="text-sm text-red-400 hover:text-red-300 px-2.5 py-1.5 rounded-lg hover:bg-gray-800 flex items-center gap-1.5 transition-colors">
                    <Trash2 className="w-3.5 h-3.5" /> {selectedCount}
                  </button>
                )}
                <button onClick={clearAll} className="text-sm text-gray-500 hover:text-gray-300 px-2.5 py-1.5 rounded-lg hover:bg-gray-800 transition-colors ml-auto">
                  清空
                </button>
              </div>

              {/* 加载进度 */}
              {isLoadingMetadata && loadingProgress.total > 0 && (
                <div className="px-4 py-2 bg-gray-900/40 border-b border-gray-700/30 shrink-0">
                  <div className="flex items-center gap-3 text-sm text-gray-400">
                    <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                    <span className="shrink-0">{loadingProgress.current}/{loadingProgress.total}</span>
                    <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div className="h-full bg-nai-accent/60 rounded-full transition-all duration-300" style={{ width: `${(loadingProgress.current / loadingProgress.total) * 100}%` }} />
                    </div>
                  </div>
                </div>
              )}

              {/* 缩略图网格 */}
              <div className="flex-1 overflow-y-auto p-3">
                <div className="grid grid-cols-4 gap-2">
                  {metadataFiles.map((file, index) => (
                    <div
                      key={index}
                      className={`relative group rounded-xl overflow-hidden cursor-pointer border-2 transition-all aspect-square ${
                        viewingIndex === index
                          ? 'border-nai-accent shadow-lg shadow-nai-accent/10'
                          : file.isSelected
                            ? 'border-nai-accent/40'
                            : 'border-transparent hover:border-gray-600'
                      }`}
                      onClick={() => setViewingIndex(index)}
                    >
                      {file.dataUrl ? (
                        <img src={file.dataUrl} alt={file.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full bg-gray-800 flex items-center justify-center">
                          <ImageIcon className="w-6 h-6 text-gray-600" />
                        </div>
                      )}

                      {/* 选中勾 */}
                      <button
                        className={`absolute top-1.5 left-1.5 w-6 h-6 rounded-lg flex items-center justify-center transition-all ${
                          file.isSelected
                            ? 'bg-nai-accent text-black shadow-md'
                            : 'bg-black/40 text-transparent group-hover:text-gray-300 group-hover:bg-black/60 backdrop-blur-sm'
                        }`}
                        onClick={(e) => { e.stopPropagation(); toggleSelect(index); }}
                      >
                        <Check className="w-3.5 h-3.5" strokeWidth={3} />
                      </button>

                      {/* 元数据标记 */}
                      {file.metadata && (
                        <div className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-nai-accent text-[10px] font-bold text-black" title="包含元数据">
                          META
                        </div>
                      )}

                      {/* 文件名 hover 提示 */}
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 py-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <div className="text-[11px] text-white truncate">{file.name}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 底部操作栏 */}
              {selectedCount > 0 && (
                <div className="px-4 py-3 border-t border-gray-700 bg-gray-900/50 shrink-0">
                  <div className="flex items-center gap-2.5">
                    <div className="flex items-center bg-gray-800 rounded-lg p-0.5 border border-gray-700">
                      <button
                        className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-1.5 ${
                          batchMode === 'clean'
                            ? 'bg-nai-accent text-black shadow-sm'
                            : 'text-gray-400 hover:text-white'
                        }`}
                        onClick={() => setBatchMode('clean')}
                      >
                        <FileX className="w-4 h-4" />
                        清除
                      </button>
                      <button
                        className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-1.5 ${
                          batchMode === 'custom'
                            ? 'bg-nai-accent text-black shadow-sm'
                            : 'text-gray-400 hover:text-white'
                        }`}
                        onClick={() => setBatchMode('custom')}
                      >
                        <FileEdit className="w-4 h-4" />
                        覆写
                      </button>
                    </div>

                    {batchMode === 'custom' && (
                      <input
                        type="text"
                        value={customPrompt}
                        onChange={(e) => setCustomPrompt(e.target.value)}
                        placeholder="自定义提示词..."
                        className="flex-1 px-3.5 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-nai-accent/50 min-w-0"
                      />
                    )}

                    <div className="flex items-center gap-2 ml-auto shrink-0">
                      {canSaveToFolder && (
                        <button
                          onClick={handleSaveToFolder}
                          disabled={isProcessing || (batchMode === 'custom' && !customPrompt)}
                          className="flex items-center gap-2 px-4 py-2 bg-gray-800 text-gray-200 border border-gray-600 rounded-lg text-sm font-semibold hover:bg-gray-700 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderOpen className="w-4 h-4" />}
                          保存 ({selectedCount})
                        </button>
                      )}
                      <button
                        onClick={handleDownloadZip}
                        disabled={isProcessing || (batchMode === 'custom' && !customPrompt)}
                        className="flex items-center gap-2 px-5 py-2 bg-nai-accent text-black rounded-lg text-sm font-bold hover:bg-nai-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
                        {selectedCount > 1 ? `打包 (${selectedCount})` : `下载`}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* ── 右侧：详情面板 ── */}
            <div className="flex-1 min-w-0">
              {viewingFile ? (
                <MetadataDetailPanel file={viewingFile} onImport={handleImportToGeneration} />
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-gray-500">
                  <FileSearch className="w-12 h-12 mb-4 opacity-20" />
                  <p className="text-sm">点击左侧图片查看详细元数据</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ━━ 权重转换工具 ━━ */}
        {activeTool === 'weight' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* 顶部：方向切换 + 格式说明 */}
            <div className="shrink-0 px-6 py-4 border-b border-gray-700/40 flex items-center gap-4 flex-wrap">
              <div className="flex items-center bg-gray-800 rounded-lg p-0.5 border border-gray-700">
                <button
                  className={`px-5 py-2 rounded-md text-sm font-medium transition-all ${
                    weightDirection === 'sd2nai' ? 'bg-nai-accent text-black shadow-sm' : 'text-gray-400 hover:text-white'
                  }`}
                  onClick={() => { setWeightDirection('sd2nai'); setWeightOutput(''); }}
                >
                  SD → NAI
                </button>
                <button
                  className={`px-5 py-2 rounded-md text-sm font-medium transition-all ${
                    weightDirection === 'nai2sd' ? 'bg-nai-accent text-black shadow-sm' : 'text-gray-400 hover:text-white'
                  }`}
                  onClick={() => { setWeightDirection('nai2sd'); setWeightOutput(''); }}
                >
                  NAI → SD
                </button>
              </div>
              {weightDirection === 'sd2nai' && (
                <label className="flex items-center gap-2 ml-auto cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={weightStripLora}
                    onChange={(e) => setWeightStripLora(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-nai-accent focus:ring-nai-accent/50 cursor-pointer"
                  />
                  <span className="text-xs text-gray-400">去除 Lora</span>
                </label>
              )}
            </div>

            {/* 左右双栏 */}
            <div className="flex-1 flex overflow-hidden">
              {/* 左侧：输入 */}
              <div className="w-1/2 flex flex-col border-r border-gray-700/40">
                <div className="shrink-0 px-4 pt-3 pb-2">
                  <span className="text-xs text-gray-400">
                    {weightDirection === 'sd2nai' ? 'SD 格式提示词' : 'NAI 格式提示词'}
                  </span>
                </div>
                <div className="flex-1 flex flex-col min-h-0 px-4 pb-4">
                  <textarea
                    value={weightInput}
                    onChange={(e) => setWeightInput(e.target.value)}
                    placeholder={weightDirection === 'sd2nai'
                      ? '(masterpiece:1.2), (best quality), 1girl, (long hair:1.1)'
                      : '1.2::masterpiece::, {best quality}, 1girl, 1.1::long hair::'}
                    className="flex-1 w-full px-4 py-3 bg-gray-900/60 border border-gray-700 rounded-xl text-sm text-white placeholder-gray-600 focus:outline-none focus:border-nai-accent/50 resize-none font-mono leading-relaxed"
                  />
                  <button
                    onClick={handleWeightConvert}
                    disabled={!weightInput.trim()}
                    className="mt-3 shrink-0 w-full flex items-center justify-center gap-2 py-2.5 bg-nai-accent text-black rounded-xl text-sm font-bold hover:bg-nai-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <ArrowLeftRight className="w-4 h-4" />
                    转换
                  </button>
                </div>
              </div>

              {/* 右侧：输出 */}
              <div className="w-1/2 flex flex-col">
                <div className="shrink-0 px-4 pt-3 pb-2 flex items-center justify-between">
                  <span className="text-xs text-gray-400">
                    {weightDirection === 'sd2nai' ? 'NAI 格式结果' : 'SD 格式结果'}
                  </span>
                  {weightOutput && (
                    <button
                      onClick={handleWeightCopy}
                      className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white px-2.5 py-1 rounded-lg hover:bg-gray-800 transition-colors"
                    >
                      {weightCopied
                        ? <><Check className="w-3.5 h-3.5 text-green-400" /><span className="text-green-400">已复制</span></>
                        : <><Copy className="w-3.5 h-3.5" />复制</>}
                    </button>
                  )}
                </div>
                <div className="flex-1 flex flex-col min-h-0 px-4 pb-4">
                  <div className={`flex-1 w-full px-4 py-3 bg-gray-900/60 border border-gray-700 rounded-xl text-sm font-mono leading-relaxed whitespace-pre-wrap break-all overflow-y-auto ${weightOutput ? 'text-gray-200' : ''}`}>
                    {weightOutput
                      ? (weightDirection === 'sd2nai' ? renderNAIHighlighted(weightOutput) : renderSDHighlighted(weightOutput))
                      : null}
                  </div>
                  {/* 导入到提示词 / 复制（底部按钮，与左侧转换按钮对称） */}
                  {weightDirection === 'sd2nai' ? (
                    <button
                      onClick={() => {
                        if (!weightOutput) return;
                        processFileForTarget('import', {
                          source: '',
                          sourceType: 'unknown' as any,
                          prompt: weightOutput,
                          negativePrompt: '',
                          width: 0,
                          height: 0,
                          seed: 0,
                        }, {
                          prompt: true,
                          negativePrompt: false,
                          characters: false,
                          appendCharacters: false,
                          settings: false,
                          seed: false,
                          vibes: false,
                          cleanImports: false,
                        });
                        onClose();
                      }}
                      disabled={!weightOutput}
                      className="mt-3 shrink-0 w-full flex items-center justify-center gap-2 py-2.5 bg-gray-800 text-gray-200 border border-gray-600 rounded-xl text-sm font-semibold hover:bg-gray-700 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <Download className="w-4 h-4" />
                      导入到提示词
                    </button>
                  ) : (
                    <button
                      onClick={handleWeightCopy}
                      disabled={!weightOutput}
                      className="mt-3 shrink-0 w-full flex items-center justify-center gap-2 py-2.5 bg-gray-800 text-gray-200 border border-gray-600 rounded-xl text-sm font-semibold hover:bg-gray-700 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {weightCopied
                        ? <><Check className="w-4 h-4 text-green-400" /><span className="text-green-400">已复制</span></>
                        : <><Copy className="w-4 h-4" />复制结果</>}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
