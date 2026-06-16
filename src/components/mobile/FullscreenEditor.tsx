import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  Copy,
  Dices,
  Eye,
  EyeOff,
  Languages,
  Palette,
  Sparkles,
  Tag,
  Trash2,
  User,
  Users,
  X,
} from 'lucide-react';
import {
  NEWLINE_SENTINEL,
  splitPromptToTags,
  isCollapsibleMarker,
  parseCollapsibleMarker,
  cleanTagName,
  getTagWeightInfo,
  detectAbnormalWeight,
  isSDWeightFormat,
  parseSDWeight,
  convertSDToNAI,
  analyzeTagGroups,
  getEffectiveWeight,
  getWeightStyle,
  extractTagsFromList,
  stepNumericWeight,
} from '../../utils/promptTags';
import { getMarkerVisual } from '../tag-manager/markerVisual';
import { getAppSettings } from '../../services/localLibrary';
import { getBackendUrl } from '../../utils/apiConfig';
import { translateSegments, translateToNaturalLanguage } from '../../services/translate';
import {
  fetchWikiChineseNames,
  getTagSuggestionsDebounced,
  type TagSuggestion,
  getTranslationCacheSnapshot,
  setTranslationCacheEntries,
  cancelPendingAutocomplete,
  fetchTagWikiPreview,
  fetchTagWikiSummaryZh,
} from '../../services/tagAutocomplete';
import { RelatedTagsRow } from '../RelatedTagsRow';
import { EditorToolbar } from './fullscreen-editor/EditorToolbar';
import { WikiPreviewSheet, type WikiPreviewState } from './fullscreen-editor/WikiPreviewSheet';

// ==================== 全屏输入页面组件 ====================

// 标签解析使用 utils/promptTags 的共享 splitPromptToTags（保护通用 <<type:...>> 标记，换行保留为 NEWLINE_SENTINEL）

// 展开 prompt 中的折叠标记（artist/oc/codex 等）为实际内容（生成与 token 计数使用，与 cleanPromptMarkers 行为一致）
// 换行哨兵当作分隔符处理
export const expandCollapsibleMarkers = (prompt: string): string => {
  return splitPromptToTags(prompt).filter(t => t !== NEWLINE_SENTINEL).map(tag => {
    const marker = parseCollapsibleMarker(tag);
    return marker ? marker.content : tag;
  }).join(', ');
};

export interface FullscreenEditorProps {
  isOpen: boolean;
  onClose: () => void;
  type: 'prompt' | 'undesired';
  value: string;
  onChange: (value: string) => void;
  presetTokens?: number;
  totalTokens?: number;
}

// 模块级标签翻译缓存（从持久化缓存初始化）
const globalTagTranslationCache = getTranslationCacheSnapshot();
// 翻译彻底失败的标签（wiki 确认无 + AI 未给出翻译）：会话内不再重查，避免每次编辑都重打接口；刷新页面后可重试
const failedTranslationTags = new Set<string>();

export const FullscreenEditor: React.FC<FullscreenEditorProps> = ({
  isOpen, onClose, type, value, onChange, presetTokens = 0, totalTokens = 0,
}) => {
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);

  // 权重预设（来自设置，监听同页面 + 跨标签页变更，与桌面端一致）
  const [weightPresets, setWeightPresets] = useState(() => getAppSettings().weightPresets || [-1, 0.5, 0.8, 1.5, 2.0]);
  useEffect(() => {
    const sync = () => setWeightPresets(getAppSettings().weightPresets || [-1, 0.5, 0.8, 1.5, 2.0]);
    window.addEventListener('storage', sync);
    window.addEventListener('app-settings-changed', sync);
    return () => { window.removeEventListener('storage', sync); window.removeEventListener('app-settings-changed', sync); };
  }, []);

  // 选中的标签索引（支持多选）
  const [selectedTags, setSelectedTags] = useState<Set<number>>(new Set());
  // 标签翻译缓存（从全局缓存初始化）
  const [tagTranslations, setTagTranslations] = useState<Map<string, string>>(() => new Map(globalTagTranslationCache));
  // 同步翻译缓存到全局 + 持久化
  useEffect(() => {
    tagTranslations.forEach((v, k) => globalTagTranslationCache.set(k, v));
    setTranslationCacheEntries(tagTranslations);
  }, [tagTranslations]);
  // 输入框
  const [inputText, setInputText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 布局模式：芯片 vs 纯文本
  const [rawMode, setRawMode] = useState(false);
  // 自动补全
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggIdx, setSelectedSuggIdx] = useState(0);
  const [nlTranslating, setNlTranslating] = useState(false);
  // 正在翻译中的标签集合（用于显示加载动画）
  const [translatingTags, setTranslatingTags] = useState<Set<string>>(new Set());
  // 补全选中后短暂屏蔽芯片点击
  const suppressChipClickRef = useRef(false);
  // 标签编辑状态
  const [editingTagText, setEditingTagText] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // ========== 长按拖拽排序 ==========
  const dragState = useRef<{
    index: number;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    chipW: number;
    chipH: number;
    longPressTimer: ReturnType<typeof setTimeout> | null;
    activated: boolean;
    chipPositions: Array<{ idx: number; left: number; top: number; width: number; height: number }>;
    startScrollTop: number;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number; w: number; h: number; text: string; sub?: string } | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const chipRefsMap = useRef<Map<number, HTMLElement>>(new Map());
  const autoScrollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // 全局 touchend/touchcancel 兜底：确保拖拽状态一定被清理
  useEffect(() => {
    const cleanup = () => {
      // 只在拖拽激活后才兜底清理，避免干扰正常 tap
      if (dragState.current?.activated) {
        if (dragState.current.longPressTimer) clearTimeout(dragState.current.longPressTimer);
        dragState.current = null;
        setIsDragging(false);
        setDragGhost(null);
        setDragOverIndex(null);
        if (autoScrollTimer.current) { clearInterval(autoScrollTimer.current); autoScrollTimer.current = null; }
      }
    };
    window.addEventListener('touchend', cleanup);
    window.addEventListener('touchcancel', cleanup);
    return () => {
      window.removeEventListener('touchend', cleanup);
      window.removeEventListener('touchcancel', cleanup);
    };
  }, []);

  // 打开时聚焦输入框，关闭时重置选中
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    } else {
      setSelectedTags(new Set());
      setEditingTagText(null);
    }
  }, [isOpen]);

  // 监听 visualViewport 变化
  useEffect(() => {
    if (!isOpen) return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    const handleResize = () => setViewportHeight(viewport.height);
    handleResize();
    viewport.addEventListener('resize', handleResize);
    viewport.addEventListener('scroll', handleResize);
    return () => { viewport.removeEventListener('resize', handleResize); viewport.removeEventListener('scroll', handleResize); };
  }, [isOpen]);

  // 实时保存 + 撤回栈（与桌面端一致，50 层；连续输入 800ms 内合并为一步，避免纯文本模式逐字符入栈）
  const undoStackRef = useRef<string[]>([]);
  const isUndoingRef = useRef(false);
  const lastUndoPushRef = useRef(0);
  const [undoDepth, setUndoDepth] = useState(0);

  const saveValue = useCallback((newValue: string) => {
    if (!isUndoingRef.current && newValue !== value) {
      const now = Date.now();
      if (now - lastUndoPushRef.current > 800) {
        undoStackRef.current.push(value);
        if (undoStackRef.current.length > 50) undoStackRef.current.shift();
        setUndoDepth(undoStackRef.current.length);
      }
      lastUndoPushRef.current = now;
    }
    onChange(newValue);
  }, [onChange, value]);

  const handleUndo = useCallback(() => {
    const prev = undoStackRef.current.pop();
    if (prev === undefined) return;
    setUndoDepth(undoStackRef.current.length);
    isUndoingRef.current = true;
    saveValue(prev);
    isUndoingRef.current = false;
    lastUndoPushRef.current = 0; // 撤回后下一次编辑立即入栈，不与撤回前的操作合并
    setSelectedTags(new Set());
    setEditingTagText(null);
  }, [saveValue]);

  // 编辑器打开/编辑目标切换（角色编辑器 tab 切换 type）时重置撤回栈，避免跨字段混入历史
  useEffect(() => {
    undoStackRef.current = [];
    lastUndoPushRef.current = 0;
    setUndoDepth(0);
  }, [isOpen, type]);

  // 滚动到底部（让输入框不被补全遮挡）
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, []);

  // 返回：先提交输入框中未确认的文本，再关闭
  const handleBack = () => {
    if (inputText.trim()) {
      const final = value ? value + ', ' + inputText.trim() : inputText.trim();
      saveValue(final);
      setInputText('');
    }
    setSelectedTags(new Set());
    onClose();
  };

  // ========== 解析标签 ==========
  const parsedTags = useMemo(() => {
    return splitPromptToTags(value);
  }, [value]);

  const rebuildValue = useCallback((tags: string[]) => {
    // 逐 tag 构建：普通 tag 用逗号连接，NEWLINE_SENTINEL 输出为 \n（与桌面端一致）
    let result = '';
    for (const t of tags) {
      if (t === NEWLINE_SENTINEL) {
        // 去掉换行前多余的逗号和空格
        result = result.replace(/,\s*$/, '');
        result += '\n';
      } else {
        // 如果 result 不为空且不以换行结尾，加逗号分隔
        if (result && !result.endsWith('\n')) {
          result += ', ';
        }
        result += t;
      }
    }
    saveValue(result.replace(/,\s*$/, ''));
  }, [saveValue]);

  // ========== 长按拖拽排序处理函数 ==========
  const handleChipTouchStart = useCallback((e: React.TouchEvent, index: number) => {
    const touch = e.touches[0];
    const chip = e.currentTarget as HTMLElement;
    const rect = chip.getBoundingClientRect();
    dragState.current = {
      index,
      startX: touch.clientX,
      startY: touch.clientY,
      offsetX: touch.clientX - rect.left,
      offsetY: touch.clientY - rect.top,
      chipW: rect.width,
      chipH: rect.height,
      longPressTimer: setTimeout(() => {
        if (!dragState.current) return;
        dragState.current.activated = true;
        // 快照所有芯片位置（拖拽期间不再读取 live DOM，避免布局抖动）
        const positions: typeof dragState.current.chipPositions = [];
        chipRefsMap.current.forEach((el, idx) => {
          const r = el.getBoundingClientRect();
          positions.push({ idx, left: r.left, top: r.top, width: r.width, height: r.height });
        });
        dragState.current.chipPositions = positions;
        dragState.current.startScrollTop = scrollRef.current?.scrollTop ?? 0;
        setIsDragging(true);
        setDragOverIndex(index);
        if (navigator.vibrate) navigator.vibrate(30);
        const ds = dragState.current;
        const rawTag = parsedTags[index];
        const ghostMarker = parseCollapsibleMarker(rawTag);
        const ghostBase = { x: ds.startX - ds.offsetX, y: ds.startY - ds.offsetY, w: ds.chipW, h: ds.chipH };
        if (ghostMarker) {
          const tagCount = ghostMarker.content.split(/[,，]/).filter(t => t.trim()).length;
          setDragGhost({ ...ghostBase, text: `${getMarkerVisual(ghostMarker.type).label} · ${ghostMarker.name}`, sub: `${tagCount} 个标签` });
        } else {
          const clean = cleanTagName(rawTag);
          setDragGhost({ ...ghostBase, text: rawTag.trim(), sub: tagTranslations.get(clean) });
        }
      }, 300),
      activated: false,
      chipPositions: [],
      startScrollTop: 0,
    };
  }, [parsedTags, tagTranslations]);

  const handleChipTouchMove = useCallback((e: React.TouchEvent) => {
    const ds = dragState.current;
    if (!ds) return;
    const touch = e.touches[0];
    if (!ds.activated) {
      if (Math.abs(touch.clientX - ds.startX) > 10 || Math.abs(touch.clientY - ds.startY) > 10) {
        if (ds.longPressTimer) clearTimeout(ds.longPressTimer);
        ds.longPressTimer = null;
      }
      return;
    }
    e.preventDefault();
    setDragGhost(prev => prev ? {
      ...prev,
      x: touch.clientX - ds.offsetX,
      y: touch.clientY - ds.offsetY,
    } : null);
    const cx = touch.clientX;
    const cy = touch.clientY;

    // 自动滚动：手指靠近滚动容器顶部/底部时自动滚动
    const container = scrollRef.current;
    if (container) {
      const rect = container.getBoundingClientRect();
      const edgeZone = 60; // 边缘触发区域（px）
      const distTop = cy - rect.top;
      const distBottom = rect.bottom - cy;
      let scrollSpeed = 0;
      if (distTop < edgeZone && container.scrollTop > 0) {
        scrollSpeed = -Math.max(4, (edgeZone - distTop) / 2);
      } else if (distBottom < edgeZone && container.scrollTop < container.scrollHeight - container.clientHeight) {
        scrollSpeed = Math.max(4, (edgeZone - distBottom) / 2);
      }
      if (scrollSpeed !== 0) {
        if (autoScrollTimer.current) clearInterval(autoScrollTimer.current);
        autoScrollTimer.current = setInterval(() => {
          container.scrollTop += scrollSpeed;
        }, 16);
      } else if (autoScrollTimer.current) {
        clearInterval(autoScrollTimer.current);
        autoScrollTimer.current = null;
      }
    }

    // 用滚动偏移量补偿快照位置
    const scrollDelta = (container?.scrollTop ?? 0) - ds.startScrollTop;

    let closest = -1;
    let minDist = Infinity;
    // 使用拖拽开始时的快照位置，用 scrollDelta 补偿滚动
    for (const pos of ds.chipPositions) {
      if (pos.idx === ds.index) continue;
      const mx = pos.left + pos.width / 2;
      const my = pos.top + pos.height / 2 - scrollDelta;
      const dist = Math.hypot(cx - mx, cy - my);
      if (dist < minDist) { minDist = dist; closest = pos.idx; }
    }
    if (closest >= 0) {
      const pos = ds.chipPositions.find(p => p.idx === closest)!;
      const insertAfter = cx > pos.left + pos.width / 2;
      const dropIdx = insertAfter ? closest + 1 : closest;
      setDragOverIndex(dropIdx);
    }
  }, []);

  const handleChipTouchEnd = useCallback(() => {
    if (autoScrollTimer.current) { clearInterval(autoScrollTimer.current); autoScrollTimer.current = null; }
    const ds = dragState.current;
    if (ds?.longPressTimer) clearTimeout(ds.longPressTimer);
    if (ds?.activated && dragOverIndex !== null && dragOverIndex !== ds.index && dragOverIndex !== ds.index + 1) {
      const tags = [...parsedTags];
      const [moved] = tags.splice(ds.index, 1);
      const insertAt = dragOverIndex > ds.index ? dragOverIndex - 1 : dragOverIndex;
      tags.splice(insertAt, 0, moved);
      rebuildValue(tags);
      setSelectedTags(new Set());
    }
    dragState.current = null;
    setIsDragging(false);
    setDragGhost(null);
    setDragOverIndex(null);
  }, [parsedTags, dragOverIndex, rebuildValue]);

  // 分析权重组
  const tagGroups = useMemo(() => analyzeTagGroups(parsedTags), [parsedTags]);

  // 选中标签越界校正
  useEffect(() => {
    if (selectedTags.size === 0) return;
    const valid = new Set<number>();
    selectedTags.forEach(i => { if (i < parsedTags.length) valid.add(i); });
    if (valid.size !== selectedTags.size) setSelectedTags(valid);
  }, [parsedTags.length, selectedTags]);

  // 需要翻译的纯标签名（去重，去权重符号，稳定引用）
  const cleanTagKeys = useMemo(() => {
    const set = new Set<string>();
    parsedTags.forEach(t => {
      if (isCollapsibleMarker(t)) return; // 跳过折叠标记（artist/oc/codex 等）
      const c = cleanTagName(t);
      // 跳过中文标签、纯数字/符号标签（不含字母的不需要翻译）
      if (c && !c.includes('\n') && !/[\u4e00-\u9fa5]/.test(c) && /[a-zA-Z]/.test(c) && !c.startsWith('artist:')) set.add(c);
    });
    return Array.from(set);
  }, [parsedTags]);
  const cleanTagKeysKey = cleanTagKeys.join('\n');

  // ========== 异步加载翻译：先查wiki，未命中的用AI翻译 ==========
  useEffect(() => {
    if (cleanTagKeys.length === 0) return;
    const toTranslate = cleanTagKeys.filter(t => !tagTranslations.has(t) && !failedTranslationTags.has(t));
    if (toTranslate.length === 0) return;
    // 标记正在翻译的标签
    setTranslatingTags(prev => {
      const next = new Set(prev);
      toTranslate.forEach(t => next.add(t));
      return next;
    });
    let cancelled = false;
    const loadTranslations = async () => {
      const newMap = new Map(tagTranslations);

      // 第一步：wiki查询
      try {
        const queryTags = toTranslate.map(t => t.replace(/ /g, '_'));
        const result = await fetchWikiChineseNames(queryTags);
        if (cancelled) return;
        for (const tag of toTranslate) {
          const queryTag = tag.replace(/ /g, '_');
          const translation = result[queryTag]?.[0];
          if (translation) newMap.set(tag, translation);
        }
      } catch { /* ignore wiki errors */ }

      // 第二步：wiki未命中的用AI翻译
      const stillMissing = toTranslate.filter(t => !newMap.has(t));
      if (!cancelled && stillMissing.length > 0) {
        try {
          const aiResults = await translateSegments(stillMissing);
          if (cancelled) return;
          for (let i = 0; i < stillMissing.length; i++) {
            const translated = aiResults[i];
            if (translated && translated !== stillMissing[i]) {
              newMap.set(stillMissing[i], translated);
            }
          }
          // wiki 与 AI 都未给出翻译的 → 负缓存（translateSegments 失败时返回原文无法区分，统一会话内不重试）
          for (const t of stillMissing) {
            if (!newMap.has(t)) failedTranslationTags.add(t);
          }
        } catch { /* ignore AI errors */ }
      }

      if (!cancelled) {
        setTagTranslations(new Map(newMap));
        // 清除已完成翻译的标记
        setTranslatingTags(prev => {
          const next = new Set(prev);
          toTranslate.forEach(t => next.delete(t));
          return next;
        });
      }
    };
    const timer = setTimeout(loadTranslations, 300);
    return () => { cancelled = true; clearTimeout(timer); setTranslatingTags(prev => { const next = new Set(prev); toTranslate.forEach(t => next.delete(t)); return next; }); };
    // 依赖刻意不含 tagTranslations（与桌面端一致）：翻译失败时 setTagTranslations 新引用会再次触发 effect，
    // 而失败标签仍在 toTranslate 中 → 无限重试风暴
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanTagKeysKey]);

  // ========== 输入框逻辑 ==========
  const commitInput = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const newVal = value ? value + ', ' + trimmed : trimmed;
    saveValue(newVal);
    setInputText('');
    setShowSuggestions(false);
    setSuggestions([]);
  }, [value, saveValue]);

  const handleInputChange = useCallback((text: string) => {
    // 检测逗号 → 自动提交（仅当逗号前内容不含中文时触发）
    const commaMatch = text.match(/[,，]/);
    if (commaMatch) {
      const beforeComma = text.slice(0, commaMatch.index);
      const hasChinese = /[\u4e00-\u9fa5]/.test(beforeComma);
      if (!hasChinese) {
        const parts = text.split(/[,，]/);
        const tagsToCommit = parts.slice(0, -1).map(s => s.trim()).filter(Boolean);
        if (tagsToCommit.length > 0) {
          const allTags = tagsToCommit.join(', ');
          const newVal = value ? value + ', ' + allTags : allTags;
          saveValue(newVal);
        }
        const remaining = parts[parts.length - 1];
        setInputText(remaining);
        setShowSuggestions(false);
        setSuggestions([]);
        triggerAutocomplete(remaining);
        return;
      }
    }
    setInputText(text);
    triggerAutocomplete(text);
  }, [value, saveValue]);

  const triggerAutocomplete = useCallback((text: string) => {
    const trimmed = text.trim();
    const hasChinese = /[\u4e00-\u9fa5]/.test(trimmed);
    const minLen = hasChinese ? 1 : 2;
    if (trimmed.length >= minLen) {
      getTagSuggestionsDebounced(trimmed, (newSuggestions) => {
        if (newSuggestions.length > 0) {
          setSuggestions([...newSuggestions]);
          setShowSuggestions(true);
          setSelectedSuggIdx(-1);
          scrollToBottom();
        } else {
          setShowSuggestions(false);
          setSuggestions([]);
        }
      }, 250);
    } else {
      setShowSuggestions(false);
      setSuggestions([]);
    }
  }, [scrollToBottom]);

  const selectSuggestion = useCallback((suggestion: TagSuggestion) => {
    // 编辑模式：选取补全后直接替换被编辑的标签（与桌面端一致）
    if (editingTagText !== null && selectedTags.size === 1) {
      if (suggestion.isNaturalLanguage || suggestion.isArtist || suggestion.isOC) {
        // 特殊类型在编辑模式下不处理
        setShowSuggestions(false);
        setSuggestions([]);
        return;
      }
      const idx = Array.from(selectedTags)[0];
      const t = [...parsedTags];
      t[idx] = suggestion.value;
      rebuildValue(t);
      setSelectedTags(new Set());
      setEditingTagText(null);
      setShowSuggestions(false);
      setSuggestions([]);
      if (suggestion.chineseName) {
        const cleanKey = suggestion.value.replace(/_/g, ' ').trim();
        if (cleanKey && !tagTranslations.has(cleanKey)) {
          setTagTranslations(prev => new Map(prev).set(cleanKey, suggestion.chineseName!));
        }
      }
      return;
    }
    if (suggestion.isNaturalLanguage) {
      // 自然语言翻译：清空输入，显示加载提示，翻译完成后插入
      const chineseText = inputText.trim();
      setInputText('');
      setShowSuggestions(false);
      setSuggestions([]);
      cancelPendingAutocomplete(); // 取消待执行的防抖回调
      setNlTranslating(true);
      translateToNaturalLanguage(chineseText).then((translated) => {
        setNlTranslating(false);
        if (translated && translated !== chineseText) {
          commitInput(translated);
        } else {
          setInputText(chineseText);
        }
      });
      return;
    }
    // 画师串：插入 <<artist:名称:内容>> 格式的标记
    if (suggestion.isArtist && suggestion.artistContent) {
      const artistMarker = `<<artist:${suggestion.label}:${suggestion.artistContent}>>`;
      if (rawMode && textareaRef.current) {
        const ta = textareaRef.current;
        const pos = ta.selectionStart;
        const before = value.slice(0, pos);
        const after = value.slice(pos);
        const lastComma = Math.max(before.lastIndexOf(','), before.lastIndexOf('，'));
        const newBefore = before.slice(0, lastComma + 1) + (lastComma >= 0 ? ' ' : '') + artistMarker;
        saveValue(newBefore + after);
        const newPos = newBefore.length;
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = newPos;
        });
      } else {
        const newVal = value ? value + ', ' + artistMarker : artistMarker;
        saveValue(newVal);
      }
      setInputText('');
      setShowSuggestions(false);
      setSuggestions([]);
      suppressChipClickRef.current = true;
      setTimeout(() => { suppressChipClickRef.current = false; }, 300);
      return;
    }
    // OC：以标签块形式插入
    if (suggestion.isOC && suggestion.ocContent) {
      const ocMarker = `<<oc:${suggestion.label}:${suggestion.ocContent}>>`;
      if (rawMode && textareaRef.current) {
        const ta = textareaRef.current;
        const pos = ta.selectionStart;
        const before = value.slice(0, pos);
        const after = value.slice(pos);
        const lastComma = Math.max(before.lastIndexOf(','), before.lastIndexOf('，'));
        const newBefore = before.slice(0, lastComma + 1) + (lastComma >= 0 ? ' ' : '') + ocMarker;
        saveValue(newBefore + after);
        const newPos = newBefore.length;
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = newPos;
        });
      } else {
        const newVal = value ? value + ', ' + ocMarker : ocMarker;
        saveValue(newVal);
      }
      setInputText('');
      setShowSuggestions(false);
      setSuggestions([]);
      suppressChipClickRef.current = true;
      setTimeout(() => { suppressChipClickRef.current = false; }, 300);
      return;
    }
    if (rawMode && textareaRef.current) {
      // 纯文本模式：替换光标前最后一个逗号后的文本
      const ta = textareaRef.current;
      const pos = ta.selectionStart;
      const before = value.slice(0, pos);
      const after = value.slice(pos);
      const lastComma = Math.max(before.lastIndexOf(','), before.lastIndexOf('，'));
      const newBefore = before.slice(0, lastComma + 1) + (lastComma >= 0 ? ' ' : '') + suggestion.value;
      saveValue(newBefore + after);
      // 光标移到插入标签之后
      const newPos = newBefore.length;
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = newPos;
      });
    } else {
      commitInput(suggestion.value);
    }
    setShowSuggestions(false);
    setSuggestions([]);
    // 如果补全项已有中文翻译，直接写入芯片翻译缓存，避免重复请求
    if (suggestion.chineseName) {
      const cleanKey = suggestion.value.replace(/_/g, ' ').trim();
      if (cleanKey && !tagTranslations.has(cleanKey)) {
        setTagTranslations(prev => new Map(prev).set(cleanKey, suggestion.chineseName!));
      }
    }
    // 短暂屏蔽芯片点击，防止手指抬起误触新芯片
    suppressChipClickRef.current = true;
    setTimeout(() => { suppressChipClickRef.current = false; }, 300);
  }, [rawMode, value, saveValue, commitInput, tagTranslations, inputText, editingTagText, selectedTags, parsedTags, rebuildValue]);

  // 粘贴时自动分割多个标签（保留换行结构，与桌面端一致）
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (!pasted) return;
    // 保留换行结构：先按行拆分，每行内按逗号规整
    const lines = pasted.split(/\r?\n/).map(line =>
      line.split(/[,，]/).map(s => s.trim()).filter(Boolean).join(', ')
    ).filter(Boolean);
    if (lines.length === 0) return;
    if (lines.length === 1 && !lines[0].includes(',')) return; // 单个标签走正常 onChange 流程
    e.preventDefault();
    const allTags = lines.join('\n');
    const newVal = value ? value + ', ' + allTags : allTags;
    saveValue(newVal);
    setInputText('');
    setShowSuggestions(false);
    setSuggestions([]);
  }, [value, saveValue]);

  // Backspace 空输入时删除最后一个标签
  const handleInputKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (inputText.trim()) {
        commitInput(inputText);
      }
    } else if (e.key === 'ArrowDown' && showSuggestions) {
      e.preventDefault();
      setSelectedSuggIdx(prev => (prev + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp' && showSuggestions) {
      e.preventDefault();
      setSelectedSuggIdx(prev => (prev - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Backspace' && !inputText && parsedTags.length > 0) {
      e.preventDefault();
      const tags = [...parsedTags];
      tags.pop();
      rebuildValue(tags);
    }
  }, [showSuggestions, suggestions, selectedSuggIdx, selectSuggestion, inputText, commitInput, parsedTags, rebuildValue]);

  // ========== 标签操作（多选 + 权重组感知） ==========
  const tagActions = useMemo(() => {
    const getIndices = (): number[] => {
      const arr = Array.from(selectedTags).sort((a, b) => a - b);
      if (arr.length === 0) return [];
      // 如果只选了一个且它在组内，扩展到整个组
      if (arr.length === 1) {
        const g = tagGroups[arr[0]];
        if (g && g.groupId !== -1) {
          return tagGroups.map((tg, idx) => tg.groupId === g.groupId ? idx : -1).filter(x => x >= 0);
        }
      }
      return arr;
    };

    return {
      addBrace: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        const t = [...parsedTags];
        // 将连续索引分组，每组单独包裹
        const groups: number[][] = [];
        let currentGroup = [indices[0]];
        for (let i = 1; i < indices.length; i++) {
          if (indices[i] === indices[i - 1] + 1) {
            currentGroup.push(indices[i]);
          } else {
            groups.push(currentGroup);
            currentGroup = [indices[i]];
          }
        }
        groups.push(currentGroup);
        for (const group of groups) {
          const first = group[0], last = group[group.length - 1];
          t[first] = `{${t[first]}`;
          t[last] = `${t[last]}}`;
        }
        rebuildValue(t);
      },
      addBracket: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        const t = [...parsedTags];
        const groups: number[][] = [];
        let currentGroup = [indices[0]];
        for (let i = 1; i < indices.length; i++) {
          if (indices[i] === indices[i - 1] + 1) {
            currentGroup.push(indices[i]);
          } else {
            groups.push(currentGroup);
            currentGroup = [indices[i]];
          }
        }
        groups.push(currentGroup);
        for (const group of groups) {
          const first = group[0], last = group[group.length - 1];
          t[first] = `[${t[first]}`;
          t[last] = `${t[last]}]`;
        }
        rebuildValue(t);
      },
      setNumeric: (w: number) => {
        const indices = getIndices();
        if (indices.length === 0) return;
        const t = [...parsedTags];
        if (indices.length === 1) {
          // 单标签：直接设置
          const cleaned = cleanTagName(t[indices[0]]).replace(/ /g, '_');
          t[indices[0]] = `${w}::${cleaned}::`;
        } else {
          // 多标签：将连续索引分组，每组用 w::...:: 包裹
          const groups: number[][] = [];
          let currentGroup = [indices[0]];
          for (let i = 1; i < indices.length; i++) {
            if (indices[i] === indices[i - 1] + 1) {
              currentGroup.push(indices[i]);
            } else {
              groups.push(currentGroup);
              currentGroup = [indices[i]];
            }
          }
          groups.push(currentGroup);

          for (const group of groups) {
            if (group.length === 1) {
              const cleaned = cleanTagName(t[group[0]]).replace(/ /g, '_');
              t[group[0]] = `${w}::${cleaned}::`;
            } else {
              const first = group[0], last = group[group.length - 1];
              for (const i of group) {
                t[i] = cleanTagName(t[i]);
              }
              t[first] = `${w}::${t[first]}`;
              t[last] = `${t[last]}::`;
            }
          }
        }
        rebuildValue(t);
      },
      clearWeight: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        const t = [...parsedTags];
        // 收集所有需要清除权重的索引（包括选中标签所属的完整权重组）
        const toClear = new Set<number>(indices);
        for (const i of indices) {
          const g = tagGroups[i];
          if (g && g.groupId !== -1) {
            // 把同组的所有标签也加入清除集合
            tagGroups.forEach((tg, idx) => {
              if (tg.groupId === g.groupId) toClear.add(idx);
            });
          }
        }
        for (const i of toClear) {
          t[i] = cleanTagName(t[i]);
        }
        rebuildValue(t);
      },
      convertSDToNAI: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        const t = [...parsedTags];
        for (const i of indices) {
          if (isSDWeightFormat(t[i])) {
            t[i] = convertSDToNAI(t[i]);
          }
        }
        rebuildValue(t);
      },
      deleteTag: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        const t = parsedTags.filter((_, i) => !indices.includes(i));
        rebuildValue(t);
        setSelectedTags(new Set());
      },
      toggleHide: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        const t = [...parsedTags];
        const isHidden = t[indices[0]]?.trim().startsWith('~');
        for (const i of indices) {
          if (isHidden) t[i] = t[i].replace(/^(\s*)~/, '$1');
          else t[i] = t[i].replace(/^(\s*)/, '$1~');
        }
        rebuildValue(t); setSelectedTags(new Set());
      },
    };
  }, [parsedTags, selectedTags, tagGroups, rebuildValue]);

  // 当前选中标签的数值权重（用于加减器）
  const currentNumericWeight = useMemo(() => {
    if (selectedTags.size === 0) return null;
    const firstIdx = Array.from(selectedTags).sort((a, b) => a - b)[0];
    const tag = parsedTags[firstIdx];
    if (!tag) return null;
    const info = getTagWeightInfo(tag.trim());
    if (info.type === 'numeric' && info.numericValue !== undefined) return info.numericValue;
    return null;
  }, [selectedTags, parsedTags]);

  // ===== Wiki：post_count + 预览卡（移动端为点按触发的底部抽屉，桌面端为悬停浮卡） =====
  const [selectedPostCount, setSelectedPostCount] = useState<number | null>(null);
  const [wikiPreview, setWikiPreview] = useState<WikiPreviewState | null>(null);
  const [wikiImageIndex, setWikiImageIndex] = useState(0);
  const wikiReqRef = useRef(0);

  // 单选标签的干净名（多选/标记/换行哨兵时为 null）
  const singleCleanTag = useMemo(() => {
    if (selectedTags.size !== 1) return null;
    const t = parsedTags[Array.from(selectedTags)[0]];
    if (!t || t === NEWLINE_SENTINEL || isCollapsibleMarker(t)) return null;
    return cleanTagName(t);
  }, [selectedTags, parsedTags]);

  // 拉取单选标签的 Danbooru post_count（与桌面端 tagPanel 一致）
  useEffect(() => {
    setSelectedPostCount(null);
    if (!singleCleanTag) return;
    let cancelled = false;
    const queryTag = singleCleanTag.toLowerCase().replace(/ /g, '_').replace(/-/g, '_');
    (async () => {
      try {
        const res = await fetch(`${getBackendUrl()}/api/tags/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: [queryTag] }),
        });
        if (!res.ok || cancelled) return;
        const data = await res.json() as Record<string, number>;
        const v = data[queryTag];
        if (typeof v === 'number') setSelectedPostCount(v);
      } catch { /* 静默 */ }
    })();
    return () => { cancelled = true; };
  }, [singleCleanTag]);

  // 打开 Wiki 预览卡：先拉预览数据，缺中文摘要时异步补拉
  const openWikiPreview = useCallback((tag: string) => {
    const normalized = tag.trim().toLowerCase().replace(/ /g, '_');
    if (!normalized) return;
    const reqId = ++wikiReqRef.current;
    setWikiImageIndex(0);
    setWikiPreview({ tag: normalized, data: null, loading: true });
    fetchTagWikiPreview(normalized).then((data) => {
      if (wikiReqRef.current !== reqId) return;
      if (!data) {
        setWikiPreview(prev => prev && prev.tag === normalized ? { ...prev, data: null, loading: false } : prev);
        return;
      }
      setWikiPreview({ tag: normalized, data, loading: false, summaryZhLoading: !data.summaryZh });
      if (!data.summaryZh) {
        fetchTagWikiSummaryZh(normalized).then((summaryZh) => {
          if (wikiReqRef.current !== reqId) return;
          setWikiPreview(prev => prev && prev.tag === normalized && prev.data ? {
            ...prev,
            summaryZhLoading: false,
            data: summaryZh ? { ...prev.data, summaryZh } : prev.data,
          } : prev);
        }).catch(() => {
          if (wikiReqRef.current !== reqId) return;
          setWikiPreview(prev => prev && prev.tag === normalized ? { ...prev, summaryZhLoading: false } : prev);
        });
      }
    }).catch(() => {
      if (wikiReqRef.current !== reqId) return;
      setWikiPreview(prev => prev && prev.tag === normalized ? { ...prev, data: null, loading: false } : prev);
    });
  }, []);

  // 选中变化时退出编辑模式
  const prevSelectedRef = useRef(selectedTags);
  useEffect(() => {
    if (prevSelectedRef.current !== selectedTags) {
      prevSelectedRef.current = selectedTags;
      setEditingTagText(null);
    }
  }, [selectedTags]);

  // 提交标签编辑
  const commitTagEdit = useCallback(() => {
    if (editingTagText === null || selectedTags.size !== 1) { setEditingTagText(null); return; }
    const idx = Array.from(selectedTags)[0];
    const trimmed = editingTagText.trim();
    if (!trimmed) {
      rebuildValue(parsedTags.filter((_, i) => i !== idx));
      setSelectedTags(new Set());
    } else if (trimmed !== parsedTags[idx]?.trim()) {
      const t = [...parsedTags];
      t[idx] = trimmed;
      rebuildValue(t);
      setSelectedTags(new Set());
    }
    setEditingTagText(null);
    setShowSuggestions(false);
    setSuggestions([]);
  }, [editingTagText, selectedTags, parsedTags, rebuildValue]);

  // 取消标签编辑
  const cancelTagEdit = useCallback(() => {
    setEditingTagText(null);
    setShowSuggestions(false);
    setSuggestions([]);
  }, []);

  if (!isOpen) return null;

  const selectedTag = selectedTags.size === 1 ? parsedTags[Array.from(selectedTags)[0]] : null;
  const selectedGroup = selectedTags.size === 1 ? tagGroups[Array.from(selectedTags)[0]] : null;
  const selectedWeightInfo = selectedTag
    ? (selectedGroup && selectedGroup.groupId !== -1
      ? { type: selectedGroup.groupType as 'brace' | 'bracket', level: selectedGroup.groupLevel } as ReturnType<typeof getTagWeightInfo>
      : getTagWeightInfo(selectedTag.trim()))
    : null;
  const hasSelection = selectedTags.size > 0;

  return (
    <div
      className="fixed inset-x-0 top-0 z-50 bg-black flex flex-col animate-fade-in"
      style={{ height: viewportHeight ? `${viewportHeight}px` : '100vh' }}
    >
      {/* 主编辑区域 */}
      {rawMode ? (
        /* 纯文本模式 */
        <div className="flex-1 min-h-0 overflow-y-auto px-3 pt-3 pb-2">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              saveValue(e.target.value);
              // 触发自动补全：取光标前最后一个逗号后的文本
              const v = e.target.value;
              const pos = e.target.selectionStart;
              const before = v.slice(0, pos);
              const lastComma = Math.max(before.lastIndexOf(','), before.lastIndexOf('，'));
              const current = before.slice(lastComma + 1).trim();
              triggerAutocomplete(current);
            }}
            placeholder={type === 'prompt' ? '输入提示词，逗号分隔...' : '输入排除标签...'}
            className="w-full h-full bg-transparent text-white text-[13px] font-mono outline-none placeholder-gray-600 resize-none leading-relaxed"
            autoFocus
          />
        </div>
      ) : (
        /* 芯片模式 */
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-y-auto px-3 pt-3 pb-2"
          style={isDragging ? { touchAction: 'none' } : undefined}
          onClick={() => { setSelectedTags(new Set()); inputRef.current?.focus(); }}
        >
          <div className="flex flex-wrap gap-1.5 items-center content-start select-none chip-no-select" onContextMenu={(e) => e.preventDefault()}>
            {parsedTags.map((rawTag, index) => {
              // 换行标记：强制芯片换行（连续多个 = 空行间距），与桌面端一致
              if (rawTag === NEWLINE_SENTINEL) {
                const isConsecutive = index > 0 && parsedTags[index - 1] === NEWLINE_SENTINEL;
                if (!isConsecutive) return <div key={`nl-${index}`} className="basis-full h-0" />;
                return <div key={`nl-${index}`} className="basis-full h-2" />;
              }
              const srcIdx = dragState.current?.index ?? -1;
              const isNoOp = dragOverIndex === srcIdx || dragOverIndex === srcIdx + 1;
              const showPlaceholder = isDragging && dragOverIndex === index && !isNoOp && dragGhost;
              const dropIndicator = showPlaceholder ? (
                <div key={`drop-${index}`} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border-2 border-dashed border-[#fceda4]/50 bg-[#fceda4]/10">
                  <span className="flex flex-col items-start">
                    <span className="font-tag text-[13px] leading-tight text-[#fceda4]/50">{dragGhost.text}</span>
                    {dragGhost.sub && (
                      <span className="text-[10px] leading-tight text-[#fceda4]/25">{dragGhost.sub}</span>
                    )}
                  </span>
                </div>
              ) : null;

              // 折叠标记芯片（artist/oc/codex/scene/自定义 subtype，视觉与桌面端统一：lucide 图标 + nai-accent）
              const markerInfo = parseCollapsibleMarker(rawTag);
              if (markerInfo) {
                const isSelected = selectedTags.has(index);
                const tagCount = markerInfo.content.split(/[,，]/).filter(t => t.trim()).length;
                const MarkerIcon = getMarkerVisual(markerInfo.type).Icon;
                return (
                  <React.Fragment key={index}>
                    {dropIndicator}
                    <button
                      ref={(el) => { if (el) chipRefsMap.current.set(index, el); else chipRefsMap.current.delete(index); }}
                      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg transition-all active:scale-95 border ${isDragging && dragState.current?.index === index ? 'opacity-30' : ''
                        } ${isSelected
                          ? 'bg-nai-accent/40 border-nai-accent/70 z-[1]'
                          : 'bg-nai-accent/20 border-nai-accent/50'
                        }`}
                      onTouchStart={(e) => handleChipTouchStart(e, index)}
                      onTouchMove={handleChipTouchMove}
                      onTouchEnd={(e) => {
                        const ds = dragState.current;
                        if (ds?.activated) { e.preventDefault(); handleChipTouchEnd(); return; }
                        // 非拖拽：清理 timer，让 click 处理选中
                        if (ds?.longPressTimer) clearTimeout(ds.longPressTimer);
                        dragState.current = null;
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (suppressChipClickRef.current) return;
                        setSelectedTags(prev => {
                          const next = new Set(prev);
                          if (next.has(index)) next.delete(index);
                          else next.add(index);
                          return next;
                        });
                      }}
                    >
                      <MarkerIcon className="w-3.5 h-3.5 shrink-0 text-white/90" strokeWidth={2} />
                      <span className="flex flex-col items-start">
                        <span className="text-[12px] font-medium leading-tight text-white/90">
                          {markerInfo.name}
                        </span>
                        <span className="text-[10px] leading-tight text-white/40">
                          {tagCount} 个标签
                        </span>
                      </span>
                    </button>
                  </React.Fragment>
                );
              }

              const clean = cleanTagName(rawTag);
              const translation = tagTranslations.get(clean);
              const needsTranslation = clean && !/[\u4e00-\u9fa5]/.test(clean) && /[a-zA-Z]/.test(clean) && !clean.startsWith('artist:');
              const isTranslating = needsTranslation && !translation && translatingTags.has(clean);
              const weightInfo = getTagWeightInfo(rawTag.trim());
              const group = tagGroups[index];
              const isSelected = selectedTags.has(index);
              const isGroupSelected = selectedTags.size > 0 && group.groupId !== -1 && Array.from(selectedTags).some(si => tagGroups[si]?.groupId === group.groupId);
              const effectiveWeight = getEffectiveWeight(rawTag, group, parsedTags, tagGroups);
              const isSDFormat = isSDWeightFormat(rawTag);
              const abnormalWeight = detectAbnormalWeight(rawTag);
              const isHidden = rawTag.trim().startsWith('~');

              const roundedClass = group.position === 'first' ? 'rounded-l-lg rounded-r-none'
                : group.position === 'middle' ? 'rounded-none'
                  : group.position === 'last' ? 'rounded-r-lg rounded-l-none'
                    : 'rounded-lg';
              const gapClass = (group.position === 'first' || group.position === 'middle') ? '-mr-[3px]' : '';

              // 动态权重颜色（移动端全屏黑底需要更亮的中性色）
              const weightStyle = getWeightStyle(effectiveWeight, {
                backgroundColor: 'rgba(255, 255, 255, 0.15)',
                borderColor: 'rgba(255, 255, 255, 0.22)',
              });
              const chipStyle: React.CSSProperties = abnormalWeight
                ? { backgroundColor: 'rgba(239, 68, 68, 0.2)', borderColor: 'rgba(248, 113, 113, 0.5)' }
                : isSelected
                  ? { backgroundColor: 'rgba(252, 237, 164, 0.15)', borderColor: 'rgba(252, 237, 164, 0.5)' }
                  : isGroupSelected
                    ? { backgroundColor: 'rgba(252, 237, 164, 0.08)', borderColor: 'rgba(252, 237, 164, 0.25)' }
                    : isSDFormat
                      ? { backgroundColor: 'rgba(245, 158, 11, 0.25)', borderColor: 'rgba(251, 191, 36, 0.4)' }
                      : weightStyle;
              if (isHidden && !isSelected) {
                chipStyle.backgroundColor = 'rgba(255, 255, 255, 0.03)';
                chipStyle.borderColor = 'rgba(255, 255, 255, 0.08)';
              }

              return (
                <React.Fragment key={index}>
                  {dropIndicator}
                  <button
                    ref={(el) => { if (el) chipRefsMap.current.set(index, el); else chipRefsMap.current.delete(index); }}
                    className={`inline-flex items-center gap-1 px-2 py-1 transition-all border ${roundedClass} ${gapClass} ${isDragging && dragState.current?.index === index ? 'opacity-30' : ''
                      } ${isSelected ? 'z-[1]' : ''}`}
                    style={chipStyle}
                    onTouchStart={(e) => handleChipTouchStart(e, index)}
                    onTouchMove={handleChipTouchMove}
                    onTouchEnd={(e) => {
                      const ds = dragState.current;
                      if (ds?.activated) { e.preventDefault(); handleChipTouchEnd(); return; }
                      if (ds?.longPressTimer) clearTimeout(ds.longPressTimer);
                      dragState.current = null;
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (suppressChipClickRef.current) return;
                      setSelectedTags(prev => {
                        const next = new Set(prev);
                        if (next.has(index)) next.delete(index);
                        else next.add(index);
                        return next;
                      });
                      // 面板出现后芯片区域高度变化，滚动到选中芯片防止位移感
                      setTimeout(() => {
                        const el = chipRefsMap.current.get(index);
                        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                      }, 50);
                    }}
                  >
                    <span className="flex flex-col items-start">
                      <span className="flex items-center gap-1">
                        {abnormalWeight && <span className="text-[9px] text-red-400" title={abnormalWeight}>⚠️</span>}
                        {isSDFormat && !abnormalWeight && <span className="text-[9px] text-amber-300">SD</span>}
                        <span className={`font-tag text-[13px] leading-tight ${isHidden ? 'text-white/25 line-through' : abnormalWeight ? 'text-red-300' : isSelected ? 'text-[#fceda4]' : isSDFormat ? 'text-amber-200' : 'text-white/85'}`}>
                          {rawTag.trim()}
                        </span>
                      </span>
                      {abnormalWeight ? (
                        <span className="text-[10px] leading-tight text-red-400/70">{abnormalWeight}</span>
                      ) : translation ? (
                        <span className={`text-[10px] leading-tight ${isSelected ? 'text-[#fceda4]/50' : 'text-white/35'}`}>
                          {translation}
                        </span>
                      ) : isTranslating ? (
                        <span className="text-[10px] leading-tight text-white/20 animate-pulse">翻译中…</span>
                      ) : needsTranslation ? (
                        <span className="text-[10px] leading-tight text-white/15">…</span>
                      ) : <span className="text-[10px] leading-tight">&nbsp;</span>}
                    </span>
                  </button>
                </React.Fragment>
              );
            })}
            <input
              ref={inputRef}
              type="text"
              value={inputText}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleInputKeyDown}
              onPaste={handlePaste}
              onFocus={scrollToBottom}
              placeholder={parsedTags.length === 0 ? (type === 'prompt' ? '输入标签，逗号分隔...' : '输入排除标签...') : '继续添加...'}
              className="flex-1 min-w-[100px] bg-transparent text-white text-[14px] font-tag outline-none placeholder-gray-600 py-1"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
      )}

      {/* 拖拽浮动芯片 */}
      {isDragging && dragGhost && (
        <div
          className="fixed z-[100] pointer-events-none"
          style={{
            left: dragGhost.x,
            top: dragGhost.y,
            width: dragGhost.w,
          }}
        >
          <div className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-[#fceda4]/70 bg-[#fceda4]/20 shadow-lg shadow-[#fceda4]/10 scale-105">
            <span className="flex flex-col items-start">
              <span className="font-tag text-[13px] leading-tight text-[#fceda4]">{dragGhost.text}</span>
              {dragGhost.sub && (
                <span className="text-[10px] leading-tight text-[#fceda4]/50">{dragGhost.sub}</span>
              )}
            </span>
          </div>
        </div>
      )}

      {/* 自然语言翻译加载提示 */}
      {nlTranslating && !showSuggestions && (
        <div className="flex-shrink-0 bg-nai-panel border-t border-white/[0.06] px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="inline-block w-3.5 h-3.5 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
            <span className="text-xs text-cyan-200/80">翻译中...</span>
          </div>
        </div>
      )}

      {/* 自动补全列表 — 标签行 + 角色/OC行 + 画师串行（编辑标签时也显示，用于替换） */}
      {showSuggestions && suggestions.length > 0 && (!hasSelection || editingTagText !== null) && (() => {
        const tagSuggestions = suggestions.filter(s => s.source !== 'local' && !s.isArtist && !s.isOC && !s.isAiLoading);
        const aiLoading = suggestions.some(s => s.isAiLoading);
        const charAndOCSuggestions = suggestions.filter(s => (s.source === 'local' && !s.isArtist) || s.isOC);
        const artistSuggestions = suggestions.filter(s => s.isArtist);
        const swipeHandlers = {
          onTouchStart: (e: React.TouchEvent) => {
            const t = e.touches[0];
            (e.currentTarget as any)._touchStart = { x: t.clientX, y: t.clientY };
            (e.currentTarget as any)._swiped = false;
          },
          onTouchMove: (e: React.TouchEvent) => {
            const start = (e.currentTarget as any)._touchStart;
            if (!start) return;
            const t = e.touches[0];
            if (Math.abs(t.clientX - start.x) > 8 || Math.abs(t.clientY - start.y) > 8) {
              (e.currentTarget as any)._swiped = true;
            }
          },
        };
        const renderSuggButton = (suggestion: TagSuggestion, index: number) => {
          const isSel = index === selectedSuggIdx;
          const baseClass = isSel
            ? 'bg-[#fceda4]/20 text-[#fceda4]'
            : 'bg-white/[0.06] text-white/80 active:bg-[#fceda4]/15';

          // 根据类型选择图标
          const renderIcon = () => {
            const iconClass = "w-3 h-3";
            if (suggestion.isNaturalLanguage) return <Languages className={iconClass} />;
            if (suggestion.isArtist) return <Palette className={iconClass} />;
            if (suggestion.isOC) return <Users className={iconClass} />;
            if (suggestion.isOrigin) return <Dices className={iconClass} />;
            if (suggestion.source === 'local' && !suggestion.isArtist && !suggestion.isOC) return <User className={iconClass} />;
            if (suggestion.verified && !suggestion.postCount) return <Sparkles className={iconClass} />;
            return <Tag className={iconClass} />;
          };

          // 第二行文字
          let subText = '';
          if (suggestion.isNaturalLanguage) subText = '直接翻译为英文';
          else if (suggestion.isArtist) subText = '画师串';
          else if (suggestion.isOC) subText = `${suggestion.chineseName || 'OC'}`;
          else if (suggestion.isOrigin) subText = `${suggestion.chineseName || suggestion.value} · ${suggestion.originCharCount}个角色`;
          else if (suggestion.chineseName) subText = `${suggestion.chineseName}${suggestion.category ? ` · ${suggestion.category}` : ''}`;

          const handleClick = () => {
            if (suggestion.isOrigin) {
              const chars = suggestion.originCharacters || [];
              if (chars.length > 0) {
                const randomChar = chars[Math.floor(Math.random() * chars.length)];
                commitInput(randomChar);
              }
            } else {
              selectSuggestion(suggestion);
            }
          };

          return (
            <button
              key={`${suggestion.value}-${suggestion.isNaturalLanguage ? 'nl' : suggestion.isArtist ? 'artist' : suggestion.isOC ? 'oc' : suggestion.isOrigin ? 'origin' : suggestion.source}`}
              className={`flex-shrink-0 px-2.5 py-1.5 rounded-lg transition-colors ${baseClass}`}
              style={{ animation: 'mobileSuggItemIn 0.18s ease-out both' }}
              onMouseDown={(e) => e.preventDefault()}
              onTouchEnd={(e) => {
                e.preventDefault();
                const container = e.currentTarget.parentElement;
                if (container && (container as any)._swiped) return;
                handleClick();
              }}
              onClick={handleClick}
            >
              <span className="flex flex-col items-start">
                <span className={`flex items-center gap-1 ${suggestion.isNaturalLanguage ? 'text-[14px]' : 'font-tag text-[14px]'} leading-tight whitespace-nowrap`}>
                  {renderIcon()} {suggestion.isNaturalLanguage ? suggestion.label : suggestion.value}
                  {suggestion.postCount && !suggestion.isOrigin && !suggestion.isArtist && !suggestion.isOC && (
                    <span className="text-[9px] text-white/25 ml-1">
                      {suggestion.postCount >= 1000 ? `${(suggestion.postCount / 1000).toFixed(0)}k` : suggestion.postCount}
                    </span>
                  )}
                </span>
                {subText ? (
                  <span className={`text-[11px] leading-tight whitespace-nowrap ${isSel ? 'text-[#fceda4]/50' : 'text-white/35'}`}>
                    {subText}
                  </span>
                ) : (
                  <span className="text-[11px] leading-tight whitespace-nowrap text-white/20 animate-pulse">翻译中…</span>
                )}
              </span>
            </button>
          );
        };
        return (
          <div className="flex-shrink-0 bg-nai-panel border-t border-white/[0.06] px-2 py-1.5 space-y-1">
            {/* 画师串匹配行 */}
            {artistSuggestions.length > 0 && (
              <div className="flex gap-1.5 overflow-x-auto scrollbar-hide" {...swipeHandlers}>
                {artistSuggestions.map((s) => renderSuggButton(s, suggestions.indexOf(s)))}
              </div>
            )}
            {/* 角色/OC匹配行 */}
            {charAndOCSuggestions.length > 0 && (
              <div className="flex gap-1.5 overflow-x-auto scrollbar-hide" {...swipeHandlers}>
                {charAndOCSuggestions.map((s) => renderSuggButton(s, suggestions.indexOf(s)))}
              </div>
            )}
            {/* 标签补全行 */}
            {(tagSuggestions.length > 0 || aiLoading) && (
              <div className="flex gap-1.5 overflow-x-auto scrollbar-hide" {...swipeHandlers}>
                {tagSuggestions.map((s) => renderSuggButton(s, suggestions.indexOf(s)))}
                {aiLoading && (
                  <div className="flex-shrink-0 px-2.5 py-1.5 rounded-lg bg-white/[0.04] flex items-center gap-1.5">
                    <span className="inline-block w-3 h-3 border-2 border-[#fceda4]/20 border-t-[#fceda4]/60 rounded-full animate-spin" />
                    <span className="text-[11px] text-white/30 whitespace-nowrap">AI 推荐中…</span>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* 选中标签时的权重操作面板（仅芯片模式） */}
      {!rawMode && hasSelection && (() => {
        // 检查是否选中了单个折叠标记（artist/oc/codex/scene/自定义 subtype）
        const selectedIdx = Array.from(selectedTags).sort((a, b) => a - b);
        const markerData = selectedIdx.length === 1 ? parseCollapsibleMarker(parsedTags[selectedIdx[0]]) : null;

        if (markerData) {
          const tagCount = markerData.content.split(/[,，]/).filter(t => t.trim()).length;
          const markerCfg = getMarkerVisual(markerData.type);
          const MarkerIcon = markerCfg.Icon;
          return (
            <div className="flex-shrink-0 bg-nai-panel border-t border-white/[0.06] px-4 py-2 space-y-1.5">
              <div className="flex items-center gap-2">
                <MarkerIcon className="w-4 h-4 shrink-0 text-nai-accent" strokeWidth={2} />
                <span className="text-sm font-medium text-white/90 truncate">{markerData.name}</span>
                <span className="text-xs text-white/30">{markerCfg.label} · {tagCount} 个标签</span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  className="h-8 flex-1 text-xs bg-nai-accent/15 active:bg-nai-accent/30 text-nai-accent rounded-lg transition-colors"
                  onClick={() => {
                    // 展开为散标签
                    const t = [...parsedTags];
                    t.splice(selectedIdx[0], 1, ...markerData.content.split(/[,，]/).map(s => s.trim()).filter(s => s));
                    rebuildValue(t);
                    setSelectedTags(new Set());
                  }}
                >展开为标签</button>
                <button
                  className="h-8 flex-1 text-xs bg-red-500/10 active:bg-red-500/25 text-red-400/70 active:text-red-400 rounded-lg transition-colors flex items-center justify-center gap-1"
                  onClick={() => tagActions.deleteTag()}
                >
                  <Trash2 className="w-3.5 h-3.5" /> 删除
                </button>
              </div>
            </div>
          );
        }

        return (
          <div className="flex-shrink-0 bg-nai-panel border-t border-white/[0.06] px-4 py-2 space-y-1.5">
            {/* SD 格式提示 */}
            {(() => {
              const indices = Array.from(selectedTags).sort((a, b) => a - b);
              const hasSDFormat = indices.some(i => isSDWeightFormat(parsedTags[i]));
              if (!hasSDFormat) return null;
              const sdInfo = indices.length === 1 ? parseSDWeight(parsedTags[indices[0]]) : null;
              return (
                <div className="flex items-center gap-2 px-2 py-1.5 bg-amber-500/10 rounded-lg">
                  <span className="text-[10px] text-amber-300">⚠️ SD WebUI 格式</span>
                  {sdInfo && <span className="text-[10px] text-amber-200/60">{sdInfo.weight !== null ? `权重: ${sdInfo.weight}` : '无权重 → {}'}</span>}
                  <div className="flex-1" />
                  <button className="px-2 py-0.5 text-[10px] bg-amber-500/30 active:bg-amber-500/50 text-amber-100 rounded transition-colors"
                    onClick={() => tagActions.convertSDToNAI()}>转换为 NAI</button>
                </div>
              );
            })()}
            {/* 第一行：选中信息 + 操作按钮 */}
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0 flex flex-col">
                {editingTagText !== null && selectedTags.size === 1 ? (
                  /* 编辑模式 */
                  <div className="flex items-center gap-1.5">
                    <input
                      ref={editInputRef}
                      type="text"
                      value={editingTagText}
                      onChange={(e) => { setEditingTagText(e.target.value); triggerAutocomplete(e.target.value); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commitTagEdit(); }
                        else if (e.key === 'Escape') { e.preventDefault(); cancelTagEdit(); }
                      }}
                      className="flex-1 min-w-0 bg-white/5 text-[#fceda4] text-sm font-tag outline-none px-2 py-1 rounded-lg border border-[#fceda4]/30 focus:border-[#fceda4]/60"
                      autoFocus
                    />
                    <button
                      className="h-8 w-8 flex items-center justify-center rounded-lg bg-green-500/20 active:bg-green-500/40 text-green-300 transition-colors"
                      onClick={commitTagEdit}
                    >
                      <Check className="w-4 h-4" />
                    </button>
                    <button
                      className="h-8 w-8 flex items-center justify-center rounded-lg bg-white/5 active:bg-white/15 text-white/40 transition-colors"
                      onClick={cancelTagEdit}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : selectedTags.size === 1 && selectedTag ? (
                  /* 单选：可点击进入编辑 */
                  <button
                    className="flex items-center gap-1.5 min-w-0 text-left"
                    onClick={() => {
                      if (!isCollapsibleMarker(selectedTag)) {
                        setEditingTagText(selectedTag.trim());
                        setTimeout(() => editInputRef.current?.focus(), 50);
                      }
                    }}
                  >
                    <div className="flex-1 min-w-0 flex flex-col">
                      <span className="flex items-baseline gap-1.5 min-w-0">
                        <span className="font-tag text-sm text-[#fceda4] truncate">{cleanTagName(selectedTag).replace(/ /g, '_')}</span>
                        {selectedPostCount != null && selectedPostCount > 0 && (
                          <span className="shrink-0 text-[11px] tabular-nums text-white/40" title={`Danbooru 引用数：${selectedPostCount}`}>
                            {selectedPostCount >= 1000 ? `${(selectedPostCount / 1000).toFixed(0)}k` : selectedPostCount}
                          </span>
                        )}
                      </span>
                      {tagTranslations.get(cleanTagName(selectedTag)) && (
                        <span className="text-xs text-white/40 truncate">{tagTranslations.get(cleanTagName(selectedTag))}</span>
                      )}
                    </div>
                  </button>
                ) : (
                  <span className="text-sm text-[#fceda4]">已选 {selectedTags.size} 个标签</span>
                )}
              </div>
              {editingTagText === null && (
                <div className="flex-shrink-0 flex items-center gap-1.5">
                  {singleCleanTag && (
                    <button
                      className="h-8 w-8 flex items-center justify-center rounded-lg bg-white/5 active:bg-white/15 text-white/40 active:text-white/80 transition-colors"
                      onClick={() => openWikiPreview(singleCleanTag)}
                      title="Wiki 预览"
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                  )}
                  {selectedTags.size >= 1 && (
                    <button
                      className="h-8 w-8 flex items-center justify-center rounded-lg bg-white/5 active:bg-white/15 text-white/40 active:text-white/80 transition-colors"
                      onClick={() => {
                        const { extracted } = extractTagsFromList(parsedTags, selectedTags, tagGroups);
                        navigator.clipboard?.writeText(extracted.join(', '));
                      }}
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                  )}
                  {selectedTags.size >= 1 && (
                    <button
                      className="h-8 w-8 flex items-center justify-center rounded-lg bg-white/5 active:bg-white/15 text-white/40 active:text-white/80 transition-colors"
                      onClick={() => {
                        const { extracted, remaining } = extractTagsFromList(parsedTags, selectedTags, tagGroups);
                        rebuildValue([...extracted, ...remaining]);
                        setSelectedTags(new Set(extracted.map((_, i) => i)));
                      }}
                    >
                      <ArrowUp className="w-4 h-4" />
                    </button>
                  )}
                </div>
              )}
            </div>
            {/* 第二行：括号权重 + 数值加减器 */}
            <div className="flex items-center gap-1.5">
              <button className="h-8 px-3 text-sm bg-[#74270D]/60 active:bg-[#74270D] text-orange-200 rounded-lg transition-colors" onClick={() => tagActions.addBrace()}>{'{+}'}</button>
              <button className="h-8 px-3 text-sm bg-blue-500/20 active:bg-blue-500/40 text-blue-200 rounded-lg transition-colors" onClick={() => tagActions.addBracket()}>{'[-]'}</button>
              <div className="flex-1" />
              {/* 数值加减器 */}
              <button className="h-8 w-8 flex items-center justify-center text-sm bg-blue-500/15 active:bg-blue-500/30 text-blue-200 rounded-lg transition-colors"
                onClick={() => tagActions.setNumeric(stepNumericWeight(currentNumericWeight ?? 1, -0.1))}>−</button>
              <span className="h-8 w-10 flex items-center justify-center text-[11px] font-mono tabular-nums text-white/70 bg-white/5 rounded-lg">
                {(currentNumericWeight ?? 1).toFixed(1)}
              </span>
              <button className="h-8 w-8 flex items-center justify-center text-sm bg-[#74270D]/40 active:bg-[#74270D]/70 text-orange-200 rounded-lg transition-colors"
                onClick={() => tagActions.setNumeric(stepNumericWeight(currentNumericWeight ?? 1, 0.1))}>+</button>
            </div>
            {/* 预设行：来自设置（与桌面端共用 weightPresets） */}
            <div className="flex items-center gap-1.5">
              {weightPresets.map(w => (
                <button
                  key={w}
                  className={`h-8 flex-1 text-xs font-mono tabular-nums rounded-lg transition-colors ${currentNumericWeight !== null && Math.abs(currentNumericWeight - w) < 0.01 ? 'ring-1 ring-inset ring-[#fceda4]/50 ' : ''
                    }${w > 1 ? 'bg-[#74270D]/40 active:bg-[#74270D]/70 text-orange-200' : 'bg-blue-500/15 active:bg-blue-500/30 text-blue-200'}`}
                  onClick={() => tagActions.setNumeric(w)}
                >{w}</button>
              ))}
            </div>
            {/* 第三行：清除 / 禁用启用 / 删除 */}
            <div className="flex items-center gap-1.5">
              <button className="h-8 flex-1 text-xs bg-white/5 active:bg-white/15 text-white/50 rounded-lg transition-colors" onClick={() => tagActions.clearWeight()}>清除权重</button>
              <button className="h-8 flex-1 text-xs bg-white/5 active:bg-white/15 text-white/40 active:text-[#fceda4] rounded-lg transition-colors flex items-center justify-center gap-1" onClick={() => tagActions.toggleHide()}>{(() => { const idx = Array.from(selectedTags).sort((a, b) => a - b)[0]; return parsedTags[idx]?.trim().startsWith('~') ? <><Eye className="w-3.5 h-3.5" /> 启用</> : <><EyeOff className="w-3.5 h-3.5" /> 禁用</>; })()}</button>
              <button className="h-8 flex-1 text-xs bg-red-500/10 active:bg-red-500/25 text-red-400/70 active:text-red-400 rounded-lg transition-colors flex items-center justify-center gap-1" onClick={() => tagActions.deleteTag()}>
                <Trash2 className="w-3.5 h-3.5" /> 删除
              </button>
            </div>
            {/* 关联推荐：跟随选中标签的 Danbooru 共现标签（失败/空时自动折叠，编辑时隐藏；触摸横滑，无箭头） */}
            {editingTagText === null && (
              <RelatedTagsRow
                hideNav
                anchorTags={Array.from(selectedTags)
                  .map(i => parsedTags[i])
                  .filter(t => t && t !== NEWLINE_SENTINEL && !isCollapsibleMarker(t))
                  .map(t => cleanTagName(t))}
                existingTagSet={new Set(parsedTags.map(t => cleanTagName(t).toLowerCase().replace(/\s+/g, '_')))}
                onAdd={(addedTag, addToEnd) => {
                  const newTags = [...parsedTags];
                  if (addToEnd || selectedTags.size === 0) {
                    newTags.push(addedTag);
                  } else {
                    const lastIdx = Math.max(...Array.from(selectedTags));
                    newTags.splice(lastIdx + 1, 0, addedTag);
                  }
                  rebuildValue(newTags);
                }}
              />
            )}
          </div>
        );
      })()}

      <EditorToolbar
        totalTokens={totalTokens}
        undoDepth={undoDepth}
        rawMode={rawMode}
        inputText={inputText}
        value={value}
        onBack={handleBack}
        onUndo={handleUndo}
        onSaveValue={saveValue}
        onInputTextChange={setInputText}
        onClearSelection={() => setSelectedTags(new Set())}
        onRawModeChange={setRawMode}
      />

      {/* Wiki 预览底部抽屉 */}
      {wikiPreview && (
        <WikiPreviewSheet
          preview={wikiPreview}
          imageIndex={wikiImageIndex}
          onImageIndexChange={setWikiImageIndex}
          onClose={() => setWikiPreview(null)}
        />
      )}

    </div>
  );
};
