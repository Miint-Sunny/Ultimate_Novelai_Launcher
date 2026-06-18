import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  FileSearch,
  FileX,
  FileEdit,
  Loader2,
  Copy,
  Trash2,
  Image as ImageIcon,
  Archive,
  Check,
  Upload,
  Download,
  ArrowLeftRight,
  ArrowLeft,
  Users,
} from 'lucide-react';
import {
  extractImageMetadata,
  writeCustomMetadataToImage,
  type ImageMetadata,
} from '../../utils/imageMetadata';
import { useDragDrop } from '../../contexts/DragDropContext';
import { buildApiUrl, API_PATHS } from '../../utils/apiConfig';
import JSZip from 'jszip';
import { mobileWeightConvert } from './tools/weightConvert';

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
    const res = await fetch(buildApiUrl('/api/data/oc_data.json'));
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

/* ─── 复用桌面端的工具函数 ─── */

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
// 已抽到 ./tools/weightConvert.tsx（整段 prompt 递归转换，与 utils/promptTags.ts 的单标签版本不同）。

/* ─── 类型 ─── */

interface MetadataFile {
  name: string;
  dataUrl: string;
  metadata: ImageMetadata | null;
  isSelected: boolean;
  fileSize: number;
}

type ToolType = 'metadata' | 'weight';

/* ─── 元数据详情面板（全屏覆盖） ─── */

const MobileMetadataDetail: React.FC<{
  file: MetadataFile;
  onBack: () => void;
  onImport?: (metadata: ImageMetadata) => void;
}> = ({ file, onBack, onImport }) => {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const m = file.metadata;
  const fullPrompt = m ? [m.prompt, ...(m.characterPrompts?.map(cp => cp.prompt) || [])].filter(Boolean).join(', ') : '';
  const charMatches = useCharacterRecognition(fullPrompt);

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  };

  const CopyBtn: React.FC<{ text: string; field: string }> = ({ text, field }) => (
    <button onClick={() => handleCopy(text, field)} className="p-1.5 rounded-md text-gray-500 active:text-white active:bg-gray-700/50">
      {copiedField === field ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );

  return (
    <div className="absolute inset-0 z-10 bg-nai-bg flex flex-col">
      {/* 顶栏 */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-gray-800">
        <button onClick={onBack} className="p-1.5 rounded-lg active:bg-gray-700"><ArrowLeft className="w-5 h-5" /></button>
        <span className="text-sm font-semibold truncate flex-1">{file.name}</span>
      </div>

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* 图片 + 基础信息 */}
        <div className="space-y-2">
          {file.dataUrl && <img src={file.dataUrl} alt="" className="w-full max-h-48 object-contain rounded-xl bg-gray-900/60" />}
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

        {!m ? (
          <div className="flex items-center gap-2 text-gray-400 text-sm bg-gray-900/40 rounded-xl p-3">
            此图片不包含可识别的元数据
          </div>
        ) : (
          <>
            {m.prompt && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-gray-400">正向提示词</span>
                  <CopyBtn text={m.prompt} field="prompt" />
                </div>
                <div className="text-xs text-gray-200 bg-gray-900/50 rounded-xl p-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-all">{m.prompt}</div>
              </div>
            )}
            {m.negativePrompt && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-gray-400">负向提示词</span>
                  <CopyBtn text={m.negativePrompt} field="negative" />
                </div>
                <div className="text-xs text-gray-200 bg-gray-900/50 rounded-xl p-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-all">{m.negativePrompt}</div>
              </div>
            )}

            {m.characterPrompts && m.characterPrompts.length > 0 && (
              <div>
                <span className="text-xs font-semibold text-gray-400">角色提示词</span>
                <div className="mt-1.5 space-y-1.5">
                  {m.characterPrompts.map((cp, i) => (
                    <div key={i} className="bg-gray-900/50 rounded-xl p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] text-gray-500">角色 {i + 1}{cp.center ? ` (${cp.center.x.toFixed(2)}, ${cp.center.y.toFixed(2)})` : ''}</span>
                        <CopyBtn text={cp.prompt} field={`char_${i}`} />
                      </div>
                      <div className="text-xs text-gray-200 whitespace-pre-wrap break-all">{cp.prompt}</div>
                      {cp.uc && <div className="text-xs text-red-400/70 mt-1 whitespace-pre-wrap break-all">UC: {cp.uc}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 角色识别 */}
            {charMatches.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Users className="w-3 h-3 text-gray-400" />
                  <span className="text-xs font-semibold text-gray-400">角色识别</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {charMatches.map((ch, i) => (
                    <span key={i} className={`inline-flex items-center gap-0.5 rounded-lg px-2 py-1 text-[11px] ${ch.isOC ? 'bg-purple-500/15 text-purple-400' : 'bg-nai-accent/15 text-nai-accent'}`}>
                      {ch.isOC && <span className="text-[8px] font-bold bg-purple-500/30 rounded px-0.5 py-0.5 mr-0.5">OC</span>}
                      <span className="font-medium">{ch.zhName}</span>
                      <span className={`text-[9px] ${ch.isOC ? 'text-purple-400/60' : 'text-nai-accent/60'}`}>[{ch.enTag}]</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div>
              <span className="text-xs font-semibold text-gray-400">生成参数</span>
              <div className="grid grid-cols-3 gap-1.5 mt-1.5">
                {[
                  { label: 'Seed', value: m.seed },
                  { label: 'Steps', value: m.steps },
                  { label: 'CFG', value: m.scale },
                  { label: 'Sampler', value: m.sampler },
                  { label: 'Noise', value: m.noiseSchedule },
                  { label: 'Rescale', value: m.cfgRescale },
                ].filter(p => p.value != null && p.value !== '').map((p) => (
                  <div key={p.label} className="bg-gray-900/50 rounded-lg px-2 py-1.5">
                    <div className="text-[10px] text-gray-500">{p.label}</div>
                    <div className="text-xs text-white truncate">{String(p.value)}</div>
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
                { label: 'Hires', value: s.hiresUpscale },
                { label: 'Upscaler', value: s.hiresUpscaler },
                { label: 'Hash', value: s.modelHash },
                { label: 'Version', value: s.version },
                { label: 'Lora Hash', value: s.loraHashes },
              ].filter(p => p.value !== undefined && p.value !== null && p.value !== '');
              if (sdParams.length === 0) return null;
              return (
                <div>
                  <span className="text-xs font-semibold text-gray-400">SD 参数</span>
                  <div className="grid grid-cols-3 gap-1.5 mt-1.5">
                    {sdParams.map((p) => (
                      <div key={p.label} className="bg-gray-900/50 rounded-lg px-2 py-1.5">
                        <div className="text-[10px] text-gray-500">{p.label}</div>
                        <div className="text-xs text-white truncate">{String(p.value)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {m.raw && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-gray-400">原始数据</span>
                  <CopyBtn text={JSON.stringify(m.raw, null, 2)} field="raw" />
                </div>
                <pre className="text-[10px] text-gray-400 bg-gray-900/50 rounded-xl p-3 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono">{JSON.stringify(m.raw, null, 2)}</pre>
              </div>
            )}
          </>
        )}
      </div>

      {/* 底部导入按钮 */}
      {onImport && m && (
        <div className="p-3 border-t border-gray-800 shrink-0">
          <button onClick={() => onImport(m)} className="w-full flex items-center justify-center gap-2 py-2.5 bg-nai-accent text-black font-bold rounded-xl text-sm">
            <Download className="w-4 h-4" />
            导入参数到生成面板
          </button>
        </div>
      )}
    </div>
  );
};

/* ─── 主组件 ─── */

export const MobileToolsPage: React.FC = () => {
  const [activeTool, setActiveTool] = useState<ToolType>('weight');
  const { processFileForTarget } = useDragDrop();

  // 元数据工具状态
  const [metadataFiles, setMetadataFiles] = useState<MetadataFile[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState({ current: 0, total: 0 });
  const [batchMode, setBatchMode] = useState<'clean' | 'custom'>('clean');
  const [customPrompt, setCustomPrompt] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [viewingIndex, setViewingIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 权重转换状态
  const [weightDirection, setWeightDirection] = useState<'sd2nai' | 'nai2sd'>('sd2nai');
  const [weightInput, setWeightInput] = useState('');
  const [weightOutput, setWeightOutput] = useState('');
  const [weightCopied, setWeightCopied] = useState(false);
  const [weightStripLora, setWeightStripLora] = useState(true);
  const [weightPage, setWeightPage] = useState<'input' | 'output'>('input');

  const handleWeightConvert = useCallback(() => {
    if (!weightInput.trim()) { setWeightOutput(''); return; }
    try {
      let input = weightInput;
      if (weightStripLora) {
        input = input.replace(/<lora:[^>]*>/g, '').replace(/,\s*,/g, ',').replace(/^\s*,|,\s*$/g, '').trim();
      }
      const result = weightDirection === 'sd2nai' ? mobileWeightConvert.convertSDToNAI(input) : mobileWeightConvert.convertNAIToSD(input);
      setWeightOutput(result);
      setWeightPage('output');
    } catch { setWeightOutput('转换失败'); setWeightPage('output'); }
  }, [weightInput, weightDirection, weightStripLora]);

  const handleWeightCopy = useCallback(() => {
    if (!weightOutput) return;
    navigator.clipboard.writeText(weightOutput);
    setWeightCopied(true);
    setTimeout(() => setWeightCopied(false), 1500);
  }, [weightOutput]);

  const handleImport = useCallback((metadata: ImageMetadata) => {
    processFileForTarget('import', metadata, {
      prompt: true, negativePrompt: true, characters: true,
      appendCharacters: false, settings: true, seed: true, vibes: true, cleanImports: true,
    });
    setViewingIndex(null);
    window.dispatchEvent(new CustomEvent('switch-to-generate'));
  }, [processFileForTarget]);

  // 文件处理
  const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('读取失败'));
      reader.readAsDataURL(file);
    });

  const processFiles = async (files: File[]) => {
    const imgs = files.filter(f => f.type.startsWith('image/'));
    if (!imgs.length) return;
    setIsLoading(true);
    setLoadingProgress({ current: 0, total: imgs.length });
    const newFiles: MetadataFile[] = [];
    for (let i = 0; i < imgs.length; i++) {
      setLoadingProgress({ current: i + 1, total: imgs.length });
      try {
        const dataUrl = await readFileAsDataUrl(imgs[i]);
        const metadata = await extractImageMetadata(imgs[i]);
        newFiles.push({ name: imgs[i].name, dataUrl, metadata, isSelected: false, fileSize: imgs[i].size });
      } catch {
        newFiles.push({ name: imgs[i].name, dataUrl: '', metadata: null, isSelected: false, fileSize: imgs[i].size });
      }
    }
    setMetadataFiles(prev => [...prev, ...newFiles]);
    setIsLoading(false);
    setLoadingProgress({ current: 0, total: 0 });
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    await processFiles(Array.from(e.target.files));
    e.target.value = '';
  };

  const toggleSelect = (i: number) => setMetadataFiles(prev => prev.map((f, idx) => idx === i ? { ...f, isSelected: !f.isSelected } : f));
  const toggleSelectAll = () => { const all = metadataFiles.every(f => f.isSelected); setMetadataFiles(prev => prev.map(f => ({ ...f, isSelected: !all }))); };
  const removeSelected = () => { setMetadataFiles(prev => prev.filter(f => !f.isSelected)); setViewingIndex(null); };
  const clearAll = () => { setMetadataFiles([]); setViewingIndex(null); };

  const getProcessed = (f: MetadataFile) => batchMode === 'clean' ? cleanImageMetadataProper(f.dataUrl) : writeCustomMetadataToImage(f.dataUrl, customPrompt);
  const getSuffix = () => batchMode === 'clean' ? '_clean' : '_custom';
  const getOutName = (f: MetadataFile) => `${f.name.replace(/\.[^/.]+$/, '')}${getSuffix()}.png`;

  const handleDownloadZip = async () => {
    const sel = metadataFiles.filter(f => f.isSelected && f.dataUrl);
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
        for (const f of sel) { try { zip.file(getOutName(f), await getProcessed(f)); } catch (e) { console.error(`处理 ${f.name} 失败:`, e); } }
        const url = URL.createObjectURL(await zip.generateAsync({ type: 'blob' }));
        Object.assign(document.createElement('a'), { href: url, download: `processed_${Date.now()}.zip` }).click();
        URL.revokeObjectURL(url);
      }
    } catch (e) { console.error('处理失败:', e); }
    setIsProcessing(false);
  };

  const selectedCount = metadataFiles.filter(f => f.isSelected).length;
  const allSelected = metadataFiles.length > 0 && metadataFiles.every(f => f.isSelected);
  const hasFiles = metadataFiles.length > 0;
  const viewingFile = viewingIndex !== null ? metadataFiles[viewingIndex] : null;

  return (
    <div className="flex flex-col h-full bg-nai-bg relative">
      {/* 顶栏 + Tab */}
      <header className="shrink-0 bg-nai-panel border-b border-gray-800">
        <div className="px-4 py-3">
          <h1 className="text-lg font-semibold">工具箱</h1>
        </div>
        <div className="flex px-4 pb-2 gap-1">
          {([
            { id: 'weight' as const, label: '权重转换', icon: ArrowLeftRight },
            { id: 'metadata' as const, label: '元数据', icon: FileSearch },
          ] as const).map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTool(t.id)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTool === t.id ? 'bg-nai-accent/15 text-nai-accent' : 'text-gray-400 active:text-white'
              }`}
            >
              <t.icon className="w-4 h-4" />
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {/* ━━ 权重转换 ━━ */}
      {activeTool === 'weight' && weightPage === 'input' && (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* 方向切换 */}
          <div className="shrink-0 flex items-center gap-3 px-4 pt-3 pb-2">
            <div className="flex items-center bg-gray-800 rounded-lg p-0.5 border border-gray-700">
              <button
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${weightDirection === 'sd2nai' ? 'bg-nai-accent text-black' : 'text-gray-400'}`}
                onClick={() => { setWeightDirection('sd2nai'); setWeightOutput(''); }}
              >SD → NAI</button>
              <button
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${weightDirection === 'nai2sd' ? 'bg-nai-accent text-black' : 'text-gray-400'}`}
                onClick={() => { setWeightDirection('nai2sd'); setWeightOutput(''); }}
              >NAI → SD</button>
            </div>
            {weightDirection === 'sd2nai' && (
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={weightStripLora} onChange={e => setWeightStripLora(e.target.checked)} className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-nai-accent" />
                <span className="text-xs text-gray-400">去除 Lora</span>
              </label>
            )}
          </div>

          {/* 输入框铺满 */}
          <div className="flex-1 flex flex-col min-h-0 px-4 pb-2">
            <div className="text-xs text-gray-400 mb-1 shrink-0">{weightDirection === 'sd2nai' ? 'SD 格式' : 'NAI 格式'}</div>
            <textarea
              value={weightInput}
              onChange={e => setWeightInput(e.target.value)}
              placeholder={weightDirection === 'sd2nai' ? '(masterpiece:1.2), (best quality), 1girl' : '1.2::masterpiece::, {best quality}, 1girl'}
              className="flex-1 w-full px-3 py-2.5 bg-gray-900/60 border border-gray-700 rounded-xl text-sm text-white placeholder-gray-600 focus:outline-none focus:border-nai-accent/50 resize-none font-mono"
            />
          </div>

          {/* 转换按钮 */}
          <div className="shrink-0 px-4 py-3">
            <button
              onClick={handleWeightConvert}
              disabled={!weightInput.trim()}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-nai-accent text-black rounded-xl text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ArrowLeftRight className="w-4 h-4" />
              转换
            </button>
          </div>
        </div>
      )}

      {activeTool === 'weight' && weightPage === 'output' && (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* 顶栏：返回 + 标题 + 导入 */}
          <div className="shrink-0 flex items-center gap-3 px-4 pt-3 pb-2">
            <button onClick={() => setWeightPage('input')} className="p-1.5 rounded-lg active:bg-gray-700">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <span className="text-sm font-medium text-gray-300">{weightDirection === 'sd2nai' ? 'NAI 格式结果' : 'SD 格式结果'}</span>
            {weightDirection === 'sd2nai' && weightOutput && (
              <button
                onClick={() => {
                  processFileForTarget('import', {
                    source: '', sourceType: 'unknown' as any, prompt: weightOutput,
                    negativePrompt: '', width: 0, height: 0, seed: 0,
                  }, { prompt: true, negativePrompt: false, characters: false, appendCharacters: false, settings: false, seed: false, vibes: false, cleanImports: false });
                  window.dispatchEvent(new CustomEvent('switch-to-generate'));
                }}
                className="flex items-center gap-1 text-xs text-nai-accent active:text-nai-accent/70 px-2 py-1 rounded-lg ml-auto"
              >
                <Download className="w-3.5 h-3.5" />
                导入提示词
              </button>
            )}
          </div>

          {/* 结果铺满 */}
          <div className="flex-1 min-h-0 px-4 pb-2">
            <div className="h-full w-full px-3 py-2.5 bg-gray-900/60 border border-gray-700 rounded-xl text-sm text-gray-200 font-mono whitespace-pre-wrap break-all overflow-y-auto">
              {weightOutput
                ? (weightDirection === 'sd2nai' ? mobileWeightConvert.renderNAIHighlighted(weightOutput) : mobileWeightConvert.renderSDHighlighted(weightOutput))
                : null}
            </div>
          </div>

          {/* 底部复制按钮 */}
          <div className="shrink-0 px-4 py-3">
            <button onClick={handleWeightCopy} disabled={!weightOutput} className="w-full flex items-center justify-center gap-2 py-2.5 bg-nai-accent text-black rounded-xl text-sm font-bold disabled:opacity-40">
              {weightCopied ? <><Check className="w-4 h-4" />已复制</> : <><Copy className="w-4 h-4" />复制结果</>}
            </button>
          </div>
        </div>
      )}

      {/* ━━ 元数据工具 ━━ */}
      {activeTool === 'metadata' && !hasFiles && (
        <div className="flex-1 flex flex-col items-center justify-center px-8">
          <div className="w-20 h-20 rounded-2xl bg-gray-800/60 flex items-center justify-center mb-5">
            <Upload className="w-10 h-10 text-gray-500" />
          </div>
          <h4 className="text-lg font-semibold text-white mb-1.5">添加图片</h4>
          <p className="text-xs text-gray-400 text-center mb-6">查看生成参数，批量清除或覆写元数据</p>
          <input ref={fileInputRef} type="file" multiple accept="image/*" onChange={handleFileSelect} className="hidden" />
          <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 px-6 py-3 bg-nai-accent text-black rounded-xl text-sm font-bold">
            <ImageIcon className="w-5 h-5" />
            选择图片
          </button>
        </div>
      )}

      {activeTool === 'metadata' && hasFiles && (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* 操作栏 */}
          <div className="shrink-0 px-3 py-2.5 border-b border-gray-800 flex items-center gap-2 flex-wrap">
            <input ref={fileInputRef} type="file" multiple accept="image/*" onChange={handleFileSelect} className="hidden" />
            <button onClick={() => fileInputRef.current?.click()} disabled={isLoading} className="flex items-center gap-1.5 px-3 py-1.5 bg-nai-accent/15 text-nai-accent border border-nai-accent/25 rounded-lg text-xs font-medium">
              {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5" />}
              添加
            </button>
            <button onClick={toggleSelectAll} className="text-xs text-gray-400 px-2 py-1.5 rounded-lg active:bg-gray-800">{allSelected ? '取消全选' : '全选'}</button>
            {selectedCount > 0 && (
              <button onClick={removeSelected} className="text-xs text-red-400 px-2 py-1.5 rounded-lg active:bg-gray-800 flex items-center gap-1">
                <Trash2 className="w-3 h-3" />{selectedCount}
              </button>
            )}
            <button onClick={clearAll} className="text-xs text-gray-500 px-2 py-1.5 rounded-lg active:bg-gray-800 ml-auto">清空</button>
          </div>

          {/* 加载进度 */}
          {isLoading && loadingProgress.total > 0 && (
            <div className="px-3 py-2 bg-gray-900/40 border-b border-gray-800 shrink-0">
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>{loadingProgress.current}/{loadingProgress.total}</span>
                <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
                  <div className="h-full bg-nai-accent/60 rounded-full transition-all" style={{ width: `${(loadingProgress.current / loadingProgress.total) * 100}%` }} />
                </div>
              </div>
            </div>
          )}

          {/* 缩略图网格 */}
          <div className="flex-1 overflow-y-auto p-2.5">
            <div className="grid grid-cols-3 gap-1.5">
              {metadataFiles.map((file, index) => (
                <div
                  key={index}
                  className={`relative group rounded-xl overflow-hidden border-2 aspect-square ${
                    file.isSelected ? 'border-nai-accent/50' : 'border-transparent'
                  }`}
                  onClick={() => setViewingIndex(index)}
                >
                  {file.dataUrl ? (
                    <img src={file.dataUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full bg-gray-800 flex items-center justify-center"><ImageIcon className="w-5 h-5 text-gray-600" /></div>
                  )}
                  <button
                    className={`absolute top-1 left-1 w-5 h-5 rounded-md flex items-center justify-center ${
                      file.isSelected ? 'bg-nai-accent text-black' : 'bg-black/40 text-transparent'
                    }`}
                    onClick={e => { e.stopPropagation(); toggleSelect(index); }}
                  >
                    <Check className="w-3 h-3" strokeWidth={3} />
                  </button>
                  {file.metadata && (
                    <div className="absolute top-1 right-1 px-1 py-0.5 rounded bg-nai-accent text-[8px] font-bold text-black">META</div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 底部操作栏 */}
          {selectedCount > 0 && (
            <div className="shrink-0 px-3 py-3 border-t border-gray-800 bg-gray-900/50 space-y-2">
              {/* 覆写输入框（仅覆写模式） */}
              {batchMode === 'custom' && (
                <input type="text" value={customPrompt} onChange={e => setCustomPrompt(e.target.value)} placeholder="自定义提示词..." className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-white placeholder-gray-500 focus:outline-none" />
              )}
              {/* 按钮行 */}
              <div className="flex items-center gap-2">
                <div className="flex items-center bg-gray-800 rounded-lg p-0.5 border border-gray-700 shrink-0">
                  <button className={`px-3.5 py-2 rounded-md text-xs font-medium flex items-center gap-1 ${batchMode === 'clean' ? 'bg-nai-accent text-black' : 'text-gray-400'}`} onClick={() => setBatchMode('clean')}>
                    <FileX className="w-3.5 h-3.5" />清除
                  </button>
                  <button className={`px-3.5 py-2 rounded-md text-xs font-medium flex items-center gap-1 ${batchMode === 'custom' ? 'bg-nai-accent text-black' : 'text-gray-400'}`} onClick={() => setBatchMode('custom')}>
                    <FileEdit className="w-3.5 h-3.5" />覆写
                  </button>
                </div>
                <button
                  onClick={handleDownloadZip}
                  disabled={isProcessing || (batchMode === 'custom' && !customPrompt)}
                  className="flex items-center gap-1.5 px-5 py-2.5 bg-nai-accent text-black rounded-lg text-sm font-bold ml-auto shrink-0 disabled:opacity-50"
                >
                  {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
                  {selectedCount > 1 ? `打包 (${selectedCount})` : '下载'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 元数据详情覆盖层 */}
      {viewingFile && (
        <MobileMetadataDetail
          file={viewingFile}
          onBack={() => setViewingIndex(null)}
          onImport={handleImport}
        />
      )}
    </div>
  );
};
