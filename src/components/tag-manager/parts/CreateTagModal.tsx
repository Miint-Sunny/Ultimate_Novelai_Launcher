// 统一新建面板 - 4 分类共用 (角色 / 画风 / 场景 / 其他)
// 设计:横向大面板 960x680,左预览右表单
//   - 字段可见性按 subtype 切换,公共字段:名字/正向/负面/标签
//   - 预览图区:有图(character/scene 1 张,artist 4 张) → 双栏;无图(other) → 单栏全宽
//   - 同步发布到公共:仅 character/artist 显示 footer 第二个按钮
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown, Clipboard as ClipboardIcon, Download, Globe, History, Loader2, Plus, RefreshCw,
  Save, Sparkles, Undo2, Upload, UserCog, Wand2, X,
} from 'lucide-react';
import type { SubtypeDef } from '../types';
import { getLucideIcon } from '../registry';
import { countTokens } from '../../../services/tokenizer';
import { useConfirm } from './useConfirm';

type PreviewMode = 'none' | 'single' | 'multi';

interface FieldConfig {
  showAliases: boolean;
  showPublicUpload: boolean;
  canGeneratePreview: boolean;
  previewMode: PreviewMode;
  /** single mode 下的预览图容器宽高比,CSS aspect-ratio 值 */
  previewAspect: string;
  /** single mode 下图片填充方式:contain=完整缩略(兼容旧版方图素材),cover=裁切铺满 */
  previewFit: 'cover' | 'contain';
}

function getFieldConfig(subtype: SubtypeDef): FieldConfig {
  switch (subtype.id) {
    case 'character':
      return { showAliases: true, showPublicUpload: true, canGeneratePreview: true, previewMode: 'single', previewAspect: '832 / 1216', previewFit: 'cover' };
    // 画风:横图容器,但兼容旧版存的方图素材 → contain 完整缩略,letterbox 留黑
    case 'artist-style':
      return { showAliases: false, showPublicUpload: true, canGeneratePreview: true, previewMode: 'single', previewAspect: '1216 / 832', previewFit: 'contain' };
    case 'scene':
      return { showAliases: false, showPublicUpload: false, canGeneratePreview: false, previewMode: 'single', previewAspect: '1 / 1', previewFit: 'cover' };
    case 'other':
      return { showAliases: false, showPublicUpload: false, canGeneratePreview: false, previewMode: 'single', previewAspect: '1 / 1', previewFit: 'cover' };
    default:
      return { showAliases: false, showPublicUpload: false, canGeneratePreview: false, previewMode: 'none', previewAspect: '1 / 1', previewFit: 'cover' };
  }
}

// 不同 subtype 的预览图提示文案
function getPreviewHint(subtype: SubtypeDef): string | null {
  switch (subtype.id) {
    case 'character':
      return '建议为竖图(832×1216),用于展示角色全身';
    case 'artist-style':
      return '建议为横图(1216×832),用于展示画风样例';
    case 'scene':
      return '建议为横图,展示场景氛围';
    case 'other':
      return '可选: 上传一张示意图帮助识别';
    default:
      return null;
  }
}

export interface CreateTagPayload {
  name: string;
  positive: string;
  negative?: string;
  aliases?: string[];
  previews: string[];
  tags?: string[];
}

export type TagOrigin = 'local' | 'favorited' | 'created';

export interface EditingTarget {
  id: string;
  origin: TagOrigin;
  initialPayload: CreateTagPayload;
  /** origin='favorited' 时,源公共 OC/画师串 的 id - 用于 fork 时精确链接 */
  sourcePublicId?: string;
}

interface Props {
  isOpen: boolean;
  subtype: SubtypeDef;
  onClose: () => void;
  /** 返回 false 时不关闭 modal (例如用户在保存前的二次确认里点了取消) */
  onSave: (payload: CreateTagPayload) => void | boolean | Promise<void | boolean>;
  onUploadPublic?: (payload: CreateTagPayload) => void | boolean | Promise<void | boolean>;
  /** 「保存为本地副本」按钮回调 - 仅在编辑 created 模式下显示;不传则不显示按钮 */
  onSaveAsCopy?: (payload: CreateTagPayload) => void | boolean | Promise<void | boolean>;
  /** 「取消发布」按钮回调 - 仅在编辑 created 模式下显示;不传则不显示按钮 */
  onUnpublish?: () => Promise<{ success: boolean; message?: string }>;
  /** 编辑模式 - 传入既有 tag 数据,标题/字段锁定/按钮按 origin 切换 */
  editing?: EditingTarget;
  tagPool?: string[];
  /** 主面板当前的正向提示词,用于"导入主提示词"快捷键 */
  currentMainPrompt?: string;
  /** 主面板当前的负面提示词,导入主提示词时一并同步 */
  currentMainNegative?: string;
  /** 主面板当前的角色提示词数组,character subtype 下优先于 currentMainPrompt */
  currentCharacterPrompts?: Array<{
    positive: string;
    negative?: string;
    enabled: boolean;
    name?: string;
  }>;
  /** 主面板生成历史,用于"从历史选取"按钮 */
  imageHistory?: Array<{
    id: string;
    imageUrl: string;
    width: number;
    height: number;
    timestamp: number;
  }>;
  /** 真实预览图生成:返回 base64 dataURL,失败返回 null */
  onGeneratePreview?: (positive: string, index: number, onProgress?: (step: number, total: number) => void) => Promise<string | null>;
  /** 点「获取编号」时返回建议名称(自动编号),不提供则按钮不显示 */
  onSuggestName?: () => string | null;
  /** 转让所有者 - 仅 created 编辑模式; 不传则不显示按钮 */
  onTransferOwner?: (newOwnerId: string) => Promise<{ success: boolean; message?: string }>;
}

export const CreateTagModal: React.FC<Props> = ({
  isOpen, subtype, onClose, onSave, onUploadPublic, onSaveAsCopy, onUnpublish, editing, tagPool = [],
  currentMainPrompt, currentMainNegative, currentCharacterPrompts, imageHistory = [],
  onGeneratePreview, onSuggestName, onTransferOwner,
}) => {
  const isEdit = !!editing;
  // character / artist-style 编辑 favorited 走 fork 流程:不锁字段,由保存前 confirm 二次确认替代
  const forkOnSave = ['character', 'artist-style'].includes(subtype.id);
  // 字段锁定:favorited 模式只能改 tags,其余字段只读;local/created 全部可改
  const isLocked = !!editing && editing.origin === 'favorited' && !forkOnSave;
  const cfg = getFieldConfig(subtype);
  const Icon = getLucideIcon(subtype.iconName);
  const previewSlots = cfg.previewMode === 'multi' ? 4 : cfg.previewMode === 'single' ? 1 : 0;
  const hasPreviewArea = previewSlots > 0;
  // single 模式下,从 aspect 字符串解析横/竖向,决定 width:100% 还是 height:100% 让 aspectRatio 生效
  const isLandscapePreview = (() => {
    const [w, h] = cfg.previewAspect.split('/').map(s => parseFloat(s.trim()));
    return Number.isFinite(w) && Number.isFinite(h) ? w >= h : true;
  })();

  const [name, setName] = useState('');
  const [positive, setPositive] = useState('');
  const [negative, setNegative] = useState('');
  const [aliases, setAliases] = useState<string[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [coverIndex, setCoverIndex] = useState(0);
  const [tags, setTags] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatingIndex, setGeneratingIndex] = useState<number | null>(null);
  const [genProgress, setGenProgress] = useState<{ step: number; total: number } | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isUnpublishing, setIsUnpublishing] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferInput, setTransferInput] = useState('');
  const [isTransferring, setIsTransferring] = useState(false);
  const { confirm, confirmDialog } = useConfirm();
  const [showNegative, setShowNegative] = useState(false);
  const [showAliasesField, setShowAliasesField] = useState(false);
  const [historyPickerOpen, setHistoryPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 打开时重置(创建)或填入初始值(编辑)
  useEffect(() => {
    if (!isOpen) return;
    const init = editing?.initialPayload;
    setName(init?.name || '');
    setPositive(init?.positive || '');
    setNegative(init?.negative || '');
    setAliases(init?.aliases || []);
    setPreviews(init?.previews || []);
    setCoverIndex(0);
    setTags(init?.tags || []);
    setIsGenerating(false);
    setGeneratingIndex(null);
    setShowNegative(!!init?.negative);
    setShowAliasesField(!!(init?.aliases && init.aliases.length > 0));
    setHistoryPickerOpen(false);
  }, [isOpen, editing]);

  // Esc 关闭
  useEffect(() => {
    if (!isOpen) return;
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [isOpen, onClose]);

  const positiveTokens = useMemo(() => countTokens(positive), [positive]);
  const negativeTokens = useMemo(() => countTokens(negative), [negative]);

  if (!isOpen) return null;

  const canSave = name.trim().length > 0 && positive.trim().length > 0;

  // 导入来源:character subtype 下优先用角色提示词(若有 enabled+内容),否则用主提示词
  const usableCharacterPrompts = subtype.id === 'character'
    ? (currentCharacterPrompts || []).filter(c => c.enabled && c.positive?.trim())
    : [];
  const useCharacterSource = usableCharacterPrompts.length > 0;
  const hasMainPrompt = !!currentMainPrompt?.trim();
  const hasImportSource = useCharacterSource || hasMainPrompt;

  const importLabel = useCharacterSource
    ? (usableCharacterPrompts.length === 1
      ? '导入当前角色提示词'
      : `导入当前角色提示词 (${usableCharacterPrompts.length})`)
    : '导入主提示词';
  const importTitle = useCharacterSource
    ? `把角色提示词${usableCharacterPrompts.length > 1 ? '(取第一个 enabled)' : ''}带进来`
    : '把主面板当前的正向提示词带进来';

  const handleImport = () => {
    if (useCharacterSource) {
      const target = usableCharacterPrompts[0];
      setPositive(target.positive.trim());
      if (target.negative?.trim()) {
        setNegative(target.negative.trim());
        setShowNegative(true);
      }
    } else if (hasMainPrompt) {
      setPositive(currentMainPrompt!.trim());
      if (currentMainNegative?.trim()) {
        setNegative(currentMainNegative.trim());
        setShowNegative(true);
      }
    }
  };

  // 处理上传(支持多文件,自动填充空位)
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    Promise.all(files.slice(0, previewSlots).map(f => new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onloadend = () => resolve(r.result as string);
      r.readAsDataURL(f);
    }))).then(b64s => {
      setPreviews(prev => {
        const next = [...prev];
        while (next.length < previewSlots) next.push('');
        const hasEmptySlot = next.some(s => !s);
        let idx = hasEmptySlot ? 0 : Math.min(Math.max(coverIndex, 0), previewSlots - 1);
        for (const b of b64s) {
          if (hasEmptySlot) {
            while (idx < previewSlots && next[idx]) idx++;
            if (idx >= previewSlots) break;
          }
          next[idx] = b;
          idx = (idx + 1) % previewSlots;
        }
        return next;
      });
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSlotClick = (idx: number) => {
    if (!previews[idx]) {
      fileInputRef.current?.click();
    } else {
      setCoverIndex(idx);
    }
  };

  // Blob URL → base64 (内联,storage.ts 里没 export)
  const blobUrlToBase64 = (blobUrl: string): Promise<string> =>
    fetch(blobUrl).then(r => r.blob()).then(b => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(b);
    }));

  const handlePickFromHistory = async (imageUrl: string) => {
    try {
      const base64 = await blobUrlToBase64(imageUrl);
      setPreviews(prev => {
        const next = [...prev];
        while (next.length < previewSlots) next.push('');
        const emptyIdx = next.findIndex(s => !s);
        if (emptyIdx >= 0) next[emptyIdx] = base64;
        else next[coverIndex] = base64;
        return next;
      });
    } catch (err) {
      console.warn('从历史选取失败:', err);
    } finally {
      setHistoryPickerOpen(false);
    }
  };

  const handleRemoveSlot = (idx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setPreviews(prev => prev.filter((_, i) => i !== idx));
    if (coverIndex >= idx && coverIndex > 0) setCoverIndex(coverIndex - 1);
  };

  // 真实生成:用父级传入的 onGeneratePreview(角色单图 / 画师 4 图模板)
  const handleGenerate = () => {
    if (!onGeneratePreview || !positive.trim()) return;
    setIsGenerating(true);
    const run = async () => {
      const result: string[] = [];
      for (let i = 0; i < previewSlots; i++) {
        setGeneratingIndex(i);
        setGenProgress(null);
        const b64 = await onGeneratePreview(positive.trim(), i, (step, total) => setGenProgress({ step, total }));
        if (b64) {
          result.push(b64);
        } else {
          result.push(`https://placehold.co/512x512/ef4444/fff?text=Failed+${i + 1}`);
        }
        setPreviews([...result]);
      }
      setGeneratingIndex(null);
      setGenProgress(null);
      setIsGenerating(false);
    };
    run();
  };

  const handleRegenerateAt = async (idx: number) => {
    if (!onGeneratePreview || !positive.trim()) return;
    setIsGenerating(true);
    setGeneratingIndex(idx);
    setGenProgress(null);
    const b64 = await onGeneratePreview(positive.trim(), idx, (step, total) => setGenProgress({ step, total }));
    setPreviews(prev => {
      const next = [...prev];
      next[idx] = b64 || `https://placehold.co/512x512/ef4444/fff?text=Failed`;
      return next;
    });
    setGeneratingIndex(null);
    setGenProgress(null);
    setIsGenerating(false);
  };

  const handlePastePrompt = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setPositive(text);
    } catch { /* clipboard denied */ }
  };

  const handlePasteNegative = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setNegative(text);
        setShowNegative(true);
      }
    } catch { /* clipboard denied */ }
  };

  const buildPayload = (): CreateTagPayload => {
    // 把封面 index 排到 0
    const reordered = [...previews].filter(Boolean);
    if (coverIndex > 0 && coverIndex < reordered.length) {
      const [c] = reordered.splice(coverIndex, 1);
      reordered.unshift(c);
    }
    return {
      name: name.trim(),
      positive: positive.trim(),
      negative: negative.trim() || undefined,
      aliases: cfg.showAliases && aliases.length > 0 ? aliases : undefined,
      previews: reordered,
      tags: tags.length > 0 ? tags : undefined,
    };
  };

  const handleSave = async () => {
    if (!canSave) return;
    const result = await onSave(buildPayload());
    if (result !== false) onClose();
  };

  const handlePublishPublic = async () => {
    if (!canSave || !onUploadPublic || isPublishing) return;
    setIsPublishing(true);
    try {
      const result = await onUploadPublic(buildPayload());
      if (result !== false) onClose();
    } finally {
      setIsPublishing(false);
    }
  };

  const handleSaveAsCopy = async () => {
    if (!canSave || !onSaveAsCopy) return;
    const result = await onSaveAsCopy(buildPayload());
    if (result !== false) onClose();
  };

  const handleUnpublish = async () => {
    if (!onUnpublish || isUnpublishing) return;
    const ok = await confirm({
      title: '撤回公共发布',
      message: `将撤回此条目的公共发布,本地会保留一份私人副本(可继续编辑)。\n\n确定继续吗?`,
      confirmLabel: '撤回',
      danger: true,
    });
    if (!ok) return;
    setIsUnpublishing(true);
    try {
      const result = await onUnpublish();
      if (result.success) onClose();
    } finally {
      setIsUnpublishing(false);
    }
  };

  const handleTransferConfirm = async () => {
    if (!onTransferOwner) return;
    const target = transferInput.trim();
    if (!target) return;
    const ok = await confirm({
      title: '转让所有者',
      message: `将把「${name}」的所有权转让给用户 ${target}。\n\n转让后你将失去管理权 (不能再编辑/撤回此条目)。\n\n确定继续吗?`,
      confirmLabel: '确认转让',
      danger: true,
    });
    if (!ok) return;
    setIsTransferring(true);
    try {
      const result = await onTransferOwner(target);
      if (result.success) {
        setTransferOpen(false);
        setTransferInput('');
        onClose();
      }
    } finally {
      setIsTransferring(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[110] grid place-items-center bg-black/55 backdrop-blur-md animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[min(960px,95vw)] h-[min(680px,90vh)] grid grid-rows-[auto_1fr_auto] overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.06] bg-nai-dark/50">
          <span className="text-nai-accent inline-flex w-9 h-9 rounded-lg bg-nai-accent/10 items-center justify-center">
            {Icon ? <Icon className="w-[22px] h-[22px]" strokeWidth={1.75} /> : <Plus className="w-[22px] h-[22px]" />}
          </span>
          <div className="flex flex-col leading-tight flex-1 min-w-0">
            <span className="text-[16px] font-bold text-white whitespace-nowrap tracking-wide">
              {isEdit ? `编辑 ${subtype.label}` : `新建 ${subtype.label}`}
            </span>
          </div>
          <button
            onClick={onClose}
            title="关闭 (Esc)"
            className="w-9 h-9 grid place-items-center rounded-lg text-nai-text-dim hover:bg-white/[0.06] hover:text-white transition-colors cursor-pointer shrink-0"
          >
            <X className="w-[18px] h-[18px]" />
          </button>
        </header>

        {/* Banner - 编辑模式下按 origin 提示;走 fork 流程的 subtype 不需要 banner (改由保存前 confirm 提示) */}
        {isEdit && editing && editing.origin === 'favorited' && !forkOnSave && (
          <div className="px-5 py-2 bg-amber-500/10 border-b border-amber-500/30 text-[12px] text-amber-200">
            这是从公共库收藏的副本,只能改你的<strong>私有标签</strong>。要改 prompt / 预览图,请在卡片菜单点「创建本地副本」转为本地版本。
          </div>
        )}

        {/* Body */}
        <div className="flex gap-6 px-6 py-5 overflow-hidden min-h-0">
          {/* 左栏: 预览图区 */}
          {hasPreviewArea && (
            <div className="w-[380px] shrink-0 flex flex-col gap-3 min-h-0">
              <input
                type="file"
                multiple={cfg.previewMode === 'multi'}
                ref={fileInputRef}
                className="hidden"
                accept="image/*"
                onChange={handleFileUpload}
              />
              {cfg.previewMode === 'multi' ? (
                // 画师串: 2x2 网格
                <div className="aspect-square bg-black/20 rounded-lg border border-gray-700 overflow-hidden shadow-lg">
                  <div className="w-full h-full grid grid-cols-2 grid-rows-2 gap-1 p-1">
                    {[0, 1, 2, 3].map((i) => (
                      <PreviewSlot
                        key={i}
                        src={previews[i]}
                        isCover={!!previews[i] && coverIndex === i}
                        showCoverBadge
                        isLoading={generatingIndex === i}
                        progress={generatingIndex === i ? genProgress : null}
                        onClick={() => handleSlotClick(i)}
                        onRemove={(e) => handleRemoveSlot(i, e)}
                        onRegenerate={cfg.canGeneratePreview ? () => handleRegenerateAt(i) : undefined}
                        canRegenerate={!!positive.trim() && !isGenerating}
                      />
                    ))}
                  </div>
                </div>
              ) : cfg.previewFit === 'contain' ? (
                // 画风: 横图容器 + contain 兼容旧版方图
                //  - 外层 flex-1 居中,占剩余高度的视觉中心
                //  - 内层按横/竖向给一根轴 100%,另一根 aspect-ratio 推算
                //  - 配合 max-w/h-full 防溢出,旧方图素材会以 letterbox 完整显示
                <div className="flex-1 min-h-0 grid place-items-center min-w-0">
                  <div
                    className="bg-black/20 rounded-lg border border-gray-700 overflow-hidden shadow-lg p-1 max-w-full max-h-full"
                    style={{
                      aspectRatio: cfg.previewAspect,
                      width: isLandscapePreview ? '100%' : 'auto',
                      height: isLandscapePreview ? 'auto' : '100%',
                    }}
                  >
                    <PreviewSlot
                      src={previews[0]}
                      fit="contain"
                      onClick={() => handleSlotClick(0)}
                      onRemove={(e) => handleRemoveSlot(0, e)}
                      onRegenerate={cfg.canGeneratePreview ? () => handleRegenerateAt(0) : undefined}
                      canRegenerate={!!positive.trim() && !isGenerating}
                      isLoading={generatingIndex === 0}
                      progress={generatingIndex === 0 ? genProgress : null}
                    />
                  </div>
                </div>
              ) : (
                // 角色/场景: 1 张大图,按 subtype 决定宽高比(角色竖图 832/1216,场景方图)
                // flex-1 + min-h-0 抢剩余高度,aspect-ratio 推算宽度,max-w-full 防溢出
                <div
                  className="bg-black/20 rounded-lg border border-gray-700 overflow-hidden shadow-lg p-1 mx-auto flex-1 min-h-0 max-w-full"
                  style={{ aspectRatio: cfg.previewAspect }}
                >
                  <PreviewSlot
                    src={previews[0]}
                    onClick={() => handleSlotClick(0)}
                    onRemove={(e) => handleRemoveSlot(0, e)}
                    onRegenerate={cfg.canGeneratePreview ? () => handleRegenerateAt(0) : undefined}
                    canRegenerate={!!positive.trim() && !isGenerating}
                    isLoading={generatingIndex === 0}
                    progress={generatingIndex === 0 ? genProgress : null}
                  />
                </div>
              )}

              {/* 工具栏 */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isLocked}
                  title={isLocked ? '收藏的副本不可改图' : '从本地上传图片'}
                  className="flex-1 h-10 inline-flex items-center justify-center gap-1.5 rounded-md bg-gray-700/70 hover:bg-gray-600/85 text-white text-[13.5px] font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Upload className="w-4 h-4" />
                  上传
                </button>
                {imageHistory.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setHistoryPickerOpen(true)}
                    disabled={isLocked}
                    title={isLocked ? '收藏的副本不可改图' : '从主页生成历史中选一张'}
                    className="flex-1 h-10 inline-flex items-center justify-center gap-1.5 rounded-md bg-gray-700/70 hover:bg-gray-600/85 text-white text-[13.5px] font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <History className="w-4 h-4" />
                    历史
                  </button>
                )}
                {cfg.canGeneratePreview && (
                  <button
                    type="button"
                    onClick={handleGenerate}
                    disabled={isLocked || !positive.trim() || isGenerating}
                    title={isLocked ? '收藏的副本不可改图' : !positive.trim() ? '先填正向提示词' : '用 prompt 自动生成预览'}
                    className="flex-1 h-10 inline-flex items-center justify-center gap-1.5 rounded-md bg-nai-accent hover:bg-nai-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-[#1a1410] text-[13.5px] font-bold transition-colors cursor-pointer shadow-sm"
                  >
                    {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                    {isGenerating
                      ? (genProgress ? `生成中 ${genProgress.step}/${genProgress.total}` : '生成中…')
                      : '一键生成'}
                  </button>
                )}
              </div>
              {(() => {
                const hint = getPreviewHint(subtype);
                return hint ? (
                  <p className="text-[11.5px] text-nai-text-dim text-center leading-snug px-1">
                    {hint}
                  </p>
                ) : null;
              })()}
            </div>
          )}

          {/* 右栏: 表单 */}
          <div className="flex-1 min-w-0 flex flex-col gap-4 overflow-y-auto custom-scrollbar pr-1">
            <Field label="名字" required>
              <div className="relative">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={`给${subtype.label}起个名字`}
                  autoFocus={!isLocked}
                  disabled={isLocked}
                  className={`h-10 ${onSuggestName && !isLocked ? 'pr-[110px]' : 'pr-3.5'} pl-3.5 rounded-md bg-gray-800/60 border border-gray-700 text-[14px] text-white placeholder:text-nai-text-dim outline-none focus:border-nai-accent transition-colors w-full disabled:opacity-60 disabled:cursor-not-allowed`}
                />
                {onSuggestName && !isLocked && (
                  <button
                    type="button"
                    onClick={() => {
                      const suggested = onSuggestName();
                      if (suggested) setName(suggested);
                    }}
                    title="按现有编号自动取下一个"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 h-7 inline-flex items-center gap-1 px-2 rounded text-[11px] font-bold text-gray-300 bg-gray-700/70 border border-gray-600 hover:text-white hover:bg-gray-600 transition-colors cursor-pointer"
                  >
                    <Sparkles className="w-3 h-3" />
                    获取编号
                  </button>
                )}
              </div>
            </Field>

            <Field
              label="正向提示词"
              required
              actionRight={
                <div className="flex items-center gap-2">
                  <span
                    title="估算 token 数(基于 NovelAI CLIP tokenizer)"
                    className="text-[11px] text-nai-text-dim tabular-nums px-2 py-0.5 rounded bg-gray-800/60 border border-gray-700/60"
                  >
                    {positiveTokens} tokens
                  </span>
                  {hasImportSource && (
                    <button
                      type="button"
                      onClick={handleImport}
                      title={importTitle}
                      className="text-[12px] inline-flex items-center gap-1 px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      {importLabel}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handlePastePrompt}
                    className="text-[12px] inline-flex items-center gap-1 px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors cursor-pointer"
                  >
                    <ClipboardIcon className="w-3.5 h-3.5" />
                    粘贴
                  </button>
                </div>
              }
            >
              <textarea
                value={positive}
                onChange={(e) => setPositive(e.target.value)}
                placeholder="例如:wlop, rurudo"
                rows={5}
                disabled={isLocked}
                className="px-3.5 py-2.5 rounded-md bg-gray-800/60 border border-gray-700 text-[14px] text-white placeholder:text-nai-text-dim outline-none focus:border-nai-accent transition-colors w-full resize-y leading-relaxed font-mono disabled:opacity-60 disabled:cursor-not-allowed"
              />
            </Field>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setShowNegative(v => !v)}
                  className="inline-flex items-center gap-1.5 text-[13px] font-bold text-gray-300 hover:text-white transition-colors cursor-pointer"
                >
                  <ChevronDown className={`w-4 h-4 transition-transform ${showNegative ? '' : '-rotate-90'}`} />
                  负面提示词
                  {!negative.trim() && (
                    <span className="text-nai-text-dim font-normal ml-1 text-[12px]">(可选)</span>
                  )}
                </button>
                <div className="flex items-center gap-2">
                  {negative.trim() && (
                    <span
                      title="估算 token 数(基于 NovelAI CLIP tokenizer)"
                      className="text-[11px] text-nai-text-dim tabular-nums px-2 py-0.5 rounded bg-gray-800/60 border border-gray-700/60"
                    >
                      {negativeTokens} tokens
                    </span>
                  )}
                  {showNegative && (
                    <button
                      type="button"
                      onClick={handlePasteNegative}
                      className="text-[12px] inline-flex items-center gap-1 px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors cursor-pointer"
                    >
                      <ClipboardIcon className="w-3.5 h-3.5" />
                      粘贴
                    </button>
                  )}
                </div>
              </div>
              {showNegative && (
                <textarea
                  value={negative}
                  onChange={(e) => setNegative(e.target.value)}
                  placeholder="例如:bad anatomy, worst quality"
                  rows={3}
                  autoFocus={!isLocked}
                  disabled={isLocked}
                  className="px-3.5 py-2.5 rounded-md bg-gray-800/60 border border-gray-700 text-[14px] text-white placeholder:text-nai-text-dim outline-none focus:border-nai-accent transition-colors w-full resize-y leading-relaxed font-mono disabled:opacity-60 disabled:cursor-not-allowed"
                />
              )}
            </div>

            {cfg.showAliases && (
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => setShowAliasesField(v => !v)}
                  className="self-start inline-flex items-center gap-1.5 text-[13px] font-bold text-gray-300 hover:text-white transition-colors cursor-pointer"
                >
                  <ChevronDown className={`w-4 h-4 transition-transform ${showAliasesField ? '' : '-rotate-90'}`} />
                  别名
                  <span className="text-nai-text-dim font-normal ml-1 text-[12px]">
                    {aliases.length > 0 ? `(已加 ${aliases.length} 个)` : '(可选)'}
                  </span>
                </button>
                {showAliasesField && (
                  <InlineChipInput
                    selected={aliases}
                    onChange={setAliases}
                    placeholder="输入别名,Enter 添加…"
                  />
                )}
              </div>
            )}

            <Field
              label="标签"
              actionRight={
                <span className="text-[12px] text-nai-text-dim tabular-nums">
                  {tags.length} 已选
                </span>
              }
            >
              <ChipPicker
                selected={tags}
                onChange={setTags}
                pool={tagPool}
                placeholder="新建标签…"
                chipPrefix="#"
              />
            </Field>
          </div>
        </div>

        {/* Footer */}
        <footer className="flex items-center gap-2.5 px-6 py-4 border-t border-white/[0.06] bg-nai-dark/30">
          {/* 撤回公共发布 - 仅 created 编辑模式; 放最左,与右侧"保存类"按钮分隔 */}
          {isEdit && editing && editing.origin === 'created' && onUnpublish && (
            <button
              onClick={handleUnpublish}
              disabled={isUnpublishing || isPublishing}
              title="撤回公共发布,本地保留一份私人副本"
              className="px-4 py-2.5 text-[14px] font-bold text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-colors cursor-pointer"
            >
              {isUnpublishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Undo2 className="w-4 h-4" />}
              {isUnpublishing ? '撤回中…' : '取消发布'}
            </button>
          )}
          {/* 转让所有者 - 仅 created 编辑模式 */}
          {isEdit && editing && editing.origin === 'created' && onTransferOwner && (
            <button
              onClick={() => { setTransferInput(''); setTransferOpen(true); }}
              disabled={isUnpublishing || isPublishing || isTransferring}
              title="把此条目转让给其他用户(自己将失去管理权)"
              className="px-4 py-2.5 text-[14px] font-bold text-gray-300 hover:text-white hover:bg-white/[0.06] rounded-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-colors cursor-pointer"
            >
              <UserCog className="w-4 h-4" />
              转让所有者
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="px-4 py-2 text-[14px] font-bold text-gray-300 hover:text-white transition-colors cursor-pointer"
          >
            取消
          </button>

          {/* 创建模式: 仅本地 + 保存并发布(若 subtype 支持公共) */}
          {!isEdit && (
            <>
              <button
                onClick={handleSave}
                disabled={!canSave || isPublishing}
                className="px-5 py-2.5 text-[14px] font-bold bg-gray-700 text-white rounded-md hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-colors cursor-pointer"
              >
                <Save className="w-4 h-4" />
                {cfg.showPublicUpload ? '保存到本地' : '保存'}
              </button>
              {cfg.showPublicUpload && onUploadPublic && (
                <button
                  onClick={handlePublishPublic}
                  disabled={!canSave || isPublishing}
                  className="px-5 py-2.5 text-[14px] font-bold bg-nai-accent text-[#1a1410] rounded-md hover:bg-nai-accent-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-sm transition-colors cursor-pointer"
                >
                  {isPublishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe className="w-4 h-4" />}
                  {isPublishing ? '发布中…' : '保存并发布'}
                </button>
              )}
            </>
          )}

          {/* 编辑模式: 按 origin 切换 */}
          {isEdit && editing && editing.origin === 'local' && (
            <>
              <button
                onClick={handleSave}
                disabled={!canSave || isPublishing}
                className={
                  cfg.showPublicUpload && onUploadPublic
                    ? 'px-5 py-2.5 text-[14px] font-bold bg-gray-700 text-white rounded-md hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-colors cursor-pointer'
                    : 'px-5 py-2.5 text-[14px] font-bold bg-nai-accent text-[#1a1410] rounded-md hover:bg-nai-accent-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-sm transition-colors cursor-pointer'
                }
              >
                <Save className="w-4 h-4" />
                保存
              </button>
              {cfg.showPublicUpload && onUploadPublic && (
                <button
                  onClick={handlePublishPublic}
                  disabled={!canSave || isPublishing}
                  className="px-5 py-2.5 text-[14px] font-bold bg-nai-accent text-[#1a1410] rounded-md hover:bg-nai-accent-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-sm transition-colors cursor-pointer"
                >
                  {isPublishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe className="w-4 h-4" />}
                  {isPublishing ? '发布中…' : '保存并发布'}
                </button>
              )}
            </>
          )}
          {isEdit && editing && editing.origin === 'favorited' && (
            <button
              onClick={handleSave}
              disabled={forkOnSave ? !canSave : false}
              className="px-5 py-2.5 text-[14px] font-bold bg-nai-accent text-[#1a1410] rounded-md hover:bg-nai-accent-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-sm transition-colors cursor-pointer"
            >
              <Save className="w-4 h-4" />
              {forkOnSave ? '保存为本地副本' : '保存私有标签'}
            </button>
          )}
          {isEdit && editing && editing.origin === 'created' && onSaveAsCopy && (
            <button
              onClick={handleSaveAsCopy}
              disabled={!canSave}
              title="基于当前编辑内容另存一份独立本地副本,不修改公共数据"
              className="px-5 py-2.5 text-[14px] font-bold bg-gray-700 text-white rounded-md hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-colors cursor-pointer"
            >
              <Save className="w-4 h-4" />
              保存为本地副本
            </button>
          )}
          {isEdit && editing && editing.origin === 'created' && onUploadPublic && (
            <button
              onClick={handlePublishPublic}
              disabled={!canSave || isPublishing}
              className="px-5 py-2.5 text-[14px] font-bold bg-nai-accent text-[#1a1410] rounded-md hover:bg-nai-accent-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-sm transition-colors cursor-pointer"
            >
              {isPublishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe className="w-4 h-4" />}
              {isPublishing ? '同步中…' : '保存并同步公共'}
            </button>
          )}
        </footer>
      </div>

      {/* 从历史选取 - 内嵌 picker */}
      {historyPickerOpen && (
        <div
          className="fixed inset-0 z-[120] grid place-items-center bg-black/60 backdrop-blur-md animate-in fade-in duration-200"
          onClick={() => setHistoryPickerOpen(false)}
        >
          <div
            className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[min(760px,92vw)] max-h-[82vh] grid grid-rows-[auto_1fr] overflow-hidden animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.06] bg-nai-dark/50">
              <span className="text-nai-accent inline-flex w-9 h-9 rounded-lg bg-nai-accent/10 items-center justify-center">
                <History className="w-[22px] h-[22px]" strokeWidth={1.75} />
              </span>
              <div className="flex flex-col leading-tight flex-1 min-w-0">
                <span className="text-[16px] font-bold text-white whitespace-nowrap tracking-wide">从历史选取预览图</span>
                <span className="text-[11.5px] text-nai-text-dim">共 {imageHistory.length} 张,点击选用</span>
              </div>
              <button
                onClick={() => setHistoryPickerOpen(false)}
                title="关闭"
                className="w-9 h-9 grid place-items-center rounded-lg text-nai-text-dim hover:bg-white/[0.06] hover:text-white transition-colors cursor-pointer shrink-0"
              >
                <X className="w-[18px] h-[18px]" />
              </button>
            </header>
            <div className="overflow-y-auto p-4 custom-scrollbar">
              <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
                {imageHistory.map(it => (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => handlePickFromHistory(it.imageUrl)}
                    title={`${it.width}×${it.height}`}
                    className="group relative aspect-square rounded-md overflow-hidden border border-gray-700 hover:border-nai-accent transition-colors bg-black/30 cursor-pointer"
                  >
                    <img src={it.imageUrl} alt="" className="w-full h-full object-cover" />
                    <div className="absolute inset-x-0 bottom-0 bg-black/70 backdrop-blur-sm px-2 py-1 text-[10px] text-white opacity-0 group-hover:opacity-100 transition-opacity tabular-nums text-center">
                      {it.width}×{it.height}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 转让所有者 - 输入新主人 ID */}
      {transferOpen && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 backdrop-blur-md animate-in fade-in duration-150"
          onClick={() => { if (!isTransferring) setTransferOpen(false); }}
        >
          <div
            className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[420px] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-gray-800 flex items-center gap-2 bg-nai-dark/50">
              <UserCog className="w-5 h-5 text-nai-accent" />
              <span className="font-bold text-white text-base">转让所有者</span>
            </div>
            <div className="px-5 py-4 flex flex-col gap-3">
              <p className="text-[13px] text-gray-300 leading-relaxed">
                把「{name}」的所有权转让给其他用户。转让后你将<strong className="text-red-400">失去管理权</strong> (不能再编辑/撤回此条目)。
              </p>
              <label className="text-[12px] font-bold text-gray-400">新主人 ID (QQ 号)</label>
              <input
                type="text"
                autoFocus
                value={transferInput}
                onChange={(e) => setTransferInput(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && transferInput.trim() && !isTransferring) handleTransferConfirm();
                  if (e.key === 'Escape' && !isTransferring) setTransferOpen(false);
                }}
                placeholder="输入 QQ 号"
                inputMode="numeric"
                className="h-10 px-3.5 rounded-md bg-gray-800 border border-gray-700 text-[14px] text-white placeholder:text-nai-text-dim outline-none focus:border-nai-accent transition-colors w-full"
              />
            </div>
            <div className="px-5 py-3 border-t border-gray-800 flex items-center justify-end gap-2 bg-nai-dark/30">
              <button
                onClick={() => setTransferOpen(false)}
                disabled={isTransferring}
                className="px-3.5 py-1.5 text-[13px] font-bold text-gray-300 hover:text-white hover:bg-white/[0.06] rounded-md transition-colors cursor-pointer disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={handleTransferConfirm}
                disabled={!transferInput.trim() || isTransferring}
                className="px-3.5 py-1.5 text-[13px] font-bold bg-red-500/85 text-white rounded-md hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                {isTransferring ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserCog className="w-3.5 h-3.5" />}
                {isTransferring ? '转让中…' : '确认转让'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDialog}
    </div>,
    document.body
  );
};

// --- 子组件 ---

const Field: React.FC<{
  label: string;
  required?: boolean;
  hint?: string;
  actionRight?: React.ReactNode;
  children: React.ReactNode;
}> = ({ label, required, hint, actionRight, children }) => (
  <div className="flex flex-col gap-2">
    <div className="flex items-center justify-between">
      <label className="text-[13px] font-bold text-gray-300 inline-flex items-center gap-1">
        {label}
        {required && <span className="text-red-400">*</span>}
      </label>
      {actionRight}
    </div>
    {children}
    {hint && <span className="text-[11.5px] text-nai-text-dim">{hint}</span>}
  </div>
);

const PreviewSlot: React.FC<{
  src?: string;
  isCover?: boolean;
  showCoverBadge?: boolean;
  isLoading?: boolean;
  /** 拿到流式进度时显示真实进度条;为空则 fallback 到转圈 spinner */
  progress?: { step: number; total: number } | null;
  /** single 大图用 contain 完整缩略,multi 小格用 cover 铺满 */
  fit?: 'cover' | 'contain';
  onClick: () => void;
  onRemove?: (e: React.MouseEvent) => void;
  onRegenerate?: () => void;
  canRegenerate?: boolean;
}> = ({ src, isCover, showCoverBadge, isLoading, progress, fit = 'cover', onClick, onRemove, onRegenerate, canRegenerate }) => (
  <div
    className={`group/preview relative w-full h-full rounded overflow-hidden cursor-pointer transition-all ${
      src
        ? (isCover ? 'ring-2 ring-nai-accent' : 'hover:ring-1 hover:ring-gray-500')
        : 'bg-gray-800/50 hover:bg-gray-700/60'
    }`}
    onClick={onClick}
  >
    {isLoading && (
      <div className="absolute inset-0 bg-black/70 grid place-items-center z-10 text-white">
        {progress && progress.total > 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-4 w-full max-w-[160px]">
            <div className="w-full h-1.5 bg-white/15 rounded-full overflow-hidden">
              <div
                className="h-full bg-nai-accent transition-all duration-150"
                style={{ width: `${Math.min(100, Math.round((progress.step / progress.total) * 100))}%` }}
              />
            </div>
            <span className="text-[11px] tabular-nums text-nai-accent font-bold">
              {progress.step} / {progress.total}
            </span>
          </div>
        ) : (
          <Loader2 className="w-5 h-5 text-nai-accent animate-spin" />
        )}
      </div>
    )}
    {src ? (
      <>
        <img src={src} alt="" className={`w-full h-full ${fit === 'contain' ? 'object-contain' : 'object-cover'}`} />
        {showCoverBadge && isCover && (
          <div className="absolute top-1 right-1 bg-nai-accent text-black text-[10px] px-1.5 py-0.5 rounded font-bold z-[5]">封面</div>
        )}
        {/* 右下角悬浮按钮组: 无遮罩,hover 才显示 */}
        <div className="absolute bottom-2 right-2 flex items-center gap-2 opacity-0 group-hover/preview:opacity-100 transition-opacity z-[5]">
          {onRegenerate && (
            <button
              onClick={(e) => { e.stopPropagation(); onRegenerate(); }}
              disabled={!canRegenerate}
              className="w-11 h-11 grid place-items-center bg-white text-black rounded-full shadow-lg ring-1 ring-black/10 hover:scale-110 transition-transform disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              title="重新生成"
            >
              <RefreshCw className="w-5 h-5" />
            </button>
          )}
          {onRemove && (
            <button
              onClick={onRemove}
              className="w-11 h-11 grid place-items-center bg-red-500 text-white rounded-full shadow-lg ring-1 ring-black/10 hover:scale-110 hover:bg-red-400 transition-transform cursor-pointer"
              title="删除"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </>
    ) : (
      <div className="w-full h-full grid place-items-center text-gray-500">
        <div className="flex flex-col items-center gap-1">
          <Plus className="w-6 h-6" />
          <span className="text-[10px]">点击上传</span>
        </div>
      </div>
    )}
  </div>
);

// 三段式 chip picker: 已选 chips · 可选 chips · 新建输入
// 已选金色实填可点 ×;可选灰色 outline 加号(从 pool 来),点击转入已选
// 中间用虚线分隔,新建输入独立一行
const ChipPicker: React.FC<{
  selected: string[];
  onChange: (next: string[]) => void;
  pool?: string[];
  placeholder?: string;
  chipPrefix?: string;
}> = ({ selected, onChange, pool = [], placeholder, chipPrefix = '' }) => {
  const [input, setInput] = useState('');
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const available = pool.filter(t => !selected.includes(t));
  const trimmed = input.trim();
  const canCreate = trimmed.length > 0 && !selected.some(s => s.toLowerCase() === trimmed.toLowerCase());

  const add = (v: string) => {
    const t = v.trim();
    if (!t || selected.includes(t)) return;
    onChange([...selected, t]);
  };
  const remove = (v: string) => onChange(selected.filter(x => x !== v));
  const startCreate = () => {
    setCreating(true);
    setInput('');
    setTimeout(() => inputRef.current?.focus(), 0);
  };
  const cancelCreate = () => { setCreating(false); setInput(''); };
  const handleCreate = () => {
    if (!canCreate) { cancelCreate(); return; }
    add(trimmed);
    setInput('');
  };

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-3 rounded-md bg-gray-800/30 border border-gray-700/60">
      {/* 已选 */}
      {selected.map(t => (
        <button
          key={`sel-${t}`}
          type="button"
          onClick={() => remove(t)}
          title="点击移除"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-nai-accent text-[#1a1410] text-[12.5px] font-bold border border-nai-accent shadow-sm hover:bg-nai-accent-hover transition-colors cursor-pointer"
        >
          {chipPrefix}{t}
          <X className="w-3.5 h-3.5" />
        </button>
      ))}

      {/* 可选 */}
      {available.map(t => (
        <button
          key={`av-${t}`}
          type="button"
          onClick={() => add(t)}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-gray-800/60 text-gray-300 text-[12.5px] font-bold border border-gray-700 hover:bg-gray-700 hover:text-white hover:border-gray-500 transition-colors cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          {chipPrefix}{t}
        </button>
      ))}

      {/* 新建 - 默认是一个 + 新建 chip,点击后变成 inline input */}
      {creating ? (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-gray-800/60 border border-nai-accent/60 focus-within:border-nai-accent transition-colors">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); handleCreate(); }
              else if (e.key === 'Escape') cancelCreate();
            }}
            onBlur={() => { if (!trimmed) cancelCreate(); }}
            placeholder={placeholder}
            className="w-[140px] h-6 bg-transparent text-[12.5px] font-bold text-white placeholder:text-nai-text-dim outline-none"
          />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleCreate}
            disabled={!canCreate}
            title="确认新建 (Enter)"
            className="text-nai-accent hover:text-nai-accent-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={startCreate}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full border border-dashed border-gray-600 text-gray-400 text-[12.5px] font-bold hover:border-nai-accent/60 hover:text-nai-accent hover:bg-nai-accent/5 transition-colors cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          新建
        </button>
      )}
    </div>
  );
};

// 单行 chip 输入: chips + 内联 input (无 pool,只支持新建)
// 用于别名等只需要快速添加几个标签的场景
const InlineChipInput: React.FC<{
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  chipPrefix?: string;
}> = ({ selected, onChange, placeholder, chipPrefix = '' }) => {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (v: string) => {
    const t = v.trim();
    if (!t || selected.includes(t)) return;
    onChange([...selected, t]);
    setInput('');
  };
  const remove = (v: string) => onChange(selected.filter(x => x !== v));

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 px-2.5 py-2 rounded-md bg-gray-800/60 border border-gray-700 focus-within:border-nai-accent transition-colors cursor-text min-h-[40px]"
      onClick={() => inputRef.current?.focus()}
    >
      {selected.map(t => (
        <span
          key={t}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-nai-accent text-[#1a1410] text-[12px] font-bold border border-nai-accent"
        >
          {chipPrefix}{t}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); remove(t); }}
            className="hover:text-black/70 transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); add(input); }
          else if (e.key === 'Backspace' && !input && selected.length > 0) {
            remove(selected[selected.length - 1]);
          }
        }}
        placeholder={selected.length === 0 ? placeholder : ''}
        className="flex-1 min-w-[120px] h-6 bg-transparent text-[13px] text-white placeholder:text-nai-text-dim outline-none"
      />
    </div>
  );
};
