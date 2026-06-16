import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUp,
  Trash2,
  Copy,
  ExternalLink,
  Plus,
  Eye,
  EyeOff,
  X,
} from 'lucide-react';
import { getTagSuggestionsDebounced, fetchWikiChineseNames, type TagSuggestion, getTranslationCacheSnapshot, setTranslationCacheEntries, lookupCharacterChineseName } from '../services/tagAutocomplete';
import { translateSegments } from '../services/translate';
import { getAppSettings } from '../services/localLibrary';
import { getBackendUrl } from '../utils/apiConfig';
import { DesktopSuggestionDropdown } from './desktop-chip-editor/DesktopSuggestionDropdown';
import { useDesktopSuggestionSelection } from './desktop-chip-editor/useDesktopSuggestionSelection';
import { useDesktopPanelActions, useDesktopTagActions } from './desktop-chip-editor/useDesktopTagActions';
import { SuggestionWikiPreviewCard } from './prompt-editor/SuggestionWikiPreviewCard';
import { useSuggestionWikiPreview } from './prompt-editor/useSuggestionWikiPreview';
import { RelatedTagsRow } from './RelatedTagsRow';
import { getMarkerVisual } from './tag-manager/markerVisual';
import {
  NEWLINE_SENTINEL, isCollapsibleMarker, parseCollapsibleMarker, splitPromptToTags,
  cleanTagName, getTagWeightInfo, detectAbnormalWeight, isSDWeightFormat, parseSDWeight,
  analyzeTagGroups, getEffectiveWeight, getWeightStyle,
  stepNumericWeight,
} from '../utils/promptTags';

// ========== 提示词工具函数已抽取至 utils/promptTags（与移动端共享） ==========

// collapsible 芯片视觉已抽取至 tag-manager/markerVisual（与移动端共享）

const globalTagTranslationCache = getTranslationCacheSnapshot();

interface DesktopChipEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  type?: 'prompt' | 'undesired';
  onContentHeightChange?: (height: number) => void;
}

export const DesktopChipEditor: React.FC<DesktopChipEditorProps> = ({
  value, onChange, placeholder = '输入标签，逗号分隔...', className = '', type = 'prompt', onContentHeightChange,
}) => {
  const [weightPresets, setWeightPresets] = useState(() => getAppSettings().weightPresets || [-1, 0.5, 0.8, 1.5, 2.0]);
  // 监听设置变更（同页面 + 跨标签页）
  useEffect(() => {
    const sync = () => setWeightPresets(getAppSettings().weightPresets || [-1, 0.5, 0.8, 1.5, 2.0]);
    window.addEventListener('storage', sync);
    window.addEventListener('app-settings-changed', sync);
    return () => { window.removeEventListener('storage', sync); window.removeEventListener('app-settings-changed', sync); };
  }, []);

  const [selectedTags, setSelectedTags] = useState<Set<number>>(new Set());
  const [tagTranslations, setTagTranslations] = useState<Map<string, string>>(() => new Map(globalTagTranslationCache));
  const [translatingTags, setTranslatingTags] = useState<Set<string>>(new Set());
  const [inputText, setInputText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chipContainerRef = useRef<HTMLDivElement>(null);
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggIdx, setSelectedSuggIdx] = useState(0);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const suggestionScrollLockRef = useRef(false);
  const [suggestionPos, setSuggestionPos] = useState<{ top: number; left: number } | null>(null);

  const [tagPanel, setTagPanel] = useState<{
    index: number; rawTag: string; tag: string; translation: string; screenX: number; screenY: number;
  } | null>(null);
  const tagPanelRef = useRef<HTMLDivElement>(null);
  const chipRefsMap = useRef<Map<number, HTMLElement>>(new Map());
  const [numWeight, setNumWeight] = useState(1.0);
  const [translationLoading, setTranslationLoading] = useState(false);
  // 当前 tagPanel 标签在 Danbooru 的 post_count；null=未拉取/无数据
  const [tagPanelPostCount, setTagPanelPostCount] = useState<number | null>(null);

  // 芯片点击防抖：防止点击芯片引发的布局重排触发 scroll 事件关闭面板
  const chipClickTimeRef = useRef<number>(0);

  // 撤回栈：所有修改操作自动入栈
  const undoStackRef = useRef<string[]>([]);
  const isUndoingRef = useRef(false);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [dragGhostInfo, setDragGhostInfo] = useState<{ text: string; sub?: string } | null>(null);

  const [editingTag, setEditingTag] = useState<{ index: number; text: string; width: number; height: number } | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // Ctrl 按下状态：按住 Ctrl 多选时隐藏面板
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Control') setCtrlHeld(true);
      if (e.key === 'Shift') setShiftHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Control') setCtrlHeld(false);
      if (e.key === 'Shift') setShiftHeld(false);
    };
    const blur = () => { setCtrlHeld(false); setShiftHeld(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, []);

  useEffect(() => {
    tagTranslations.forEach((v, k) => globalTagTranslationCache.set(k, v));
    setTranslationCacheEntries(tagTranslations);
  }, [tagTranslations]);

  const saveValue = useCallback((newValue: string) => {
    if (!isUndoingRef.current && newValue !== value) {
      undoStackRef.current.push(value);
      // 限制栈深度
      if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    }
    onChange(newValue);
  }, [onChange, value]);
  const parsedTags = useMemo(() => splitPromptToTags(value), [value]);
  const tagGroups = useMemo(() => analyzeTagGroups(parsedTags), [parsedTags]);
  const rebuildValue = useCallback((tags: string[]) => {
    // 逐 tag 构建：普通 tag 用逗号连接，NEWLINE_SENTINEL 输出为 \n
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

  // 现在 tagAutocomplete.reorderByConfig 已经在服务层按配置顺序/数量组装好结果，这里直接透传
  const displaySuggs = suggestions;
  const {
    wikiMap: suggestionWikiMap,
    preview: suggestionWikiPreview,
    previewHeight: suggestionWikiPreviewHeight,
    previewContentRef: suggestionWikiPreviewContentRef,
    previewImageIndex: wikiPreviewImageIndex,
    showPreview: showSuggestionWikiPreview,
    hidePreview: hideSuggestionWikiPreview,
    keepPreviewVisible: keepSuggestionWikiPreviewVisible,
  } = useSuggestionWikiPreview({
    suggestions: displaySuggs,
    visible: showSuggestions,
  });

  useEffect(() => {
    if (displaySuggs.length > 0) setSelectedSuggIdx(prev => Math.min(prev, displaySuggs.length - 1));
  }, [displaySuggs]);

  // 键盘上下移动时，将选中项滚入其所在分组的可视区
  useEffect(() => {
    if (!showSuggestions || !suggestionsRef.current) return;
    if (suggestionScrollLockRef.current) { suggestionScrollLockRef.current = false; return; }
    const el = suggestionsRef.current.querySelector(`[data-sugg-idx="${selectedSuggIdx}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedSuggIdx, showSuggestions]);

  useEffect(() => {
    if (selectedTags.size === 0) return;
    const valid = new Set<number>();
    selectedTags.forEach(i => { if (i < parsedTags.length) valid.add(i); });
    if (valid.size !== selectedTags.size) setSelectedTags(valid);
  }, [parsedTags.length, selectedTags]);

  const cleanTagKeys = useMemo(() => {
    const set = new Set<string>();
    parsedTags.forEach(t => {
      if (isCollapsibleMarker(t)) return;
      const c = cleanTagName(t);
      if (c && !/[\u4e00-\u9fa5]/.test(c) && /[a-zA-Z]/.test(c) && !c.startsWith('artist:')) set.add(c);
    });
    return Array.from(set);
  }, [parsedTags]);
  const cleanTagKeysKey = cleanTagKeys.join('\n');

  useEffect(() => {
    if (cleanTagKeys.length === 0) return;
    const toTranslate = cleanTagKeys.filter(t => !tagTranslations.has(t));
    if (toTranslate.length === 0) return;
    setTranslatingTags(prev => { const next = new Set(prev); toTranslate.forEach(t => next.add(t)); return next; });
    let cancelled = false;
    const load = async () => {
      const newMap = new Map(tagTranslations);
      try {
        const queryTags = toTranslate.map(t => t.replace(/ /g, '_'));
        const result = await fetchWikiChineseNames(queryTags);
        if (cancelled) return;
        for (const tag of toTranslate) { const qTag = tag.replace(/ /g, '_'); const tr = result[qTag]?.[0]; if (tr) newMap.set(tag, tr); }
      } catch { /* ignore */ }
      const stillMissing = toTranslate.filter(t => !newMap.has(t));
      if (!cancelled && stillMissing.length > 0) {
        try {
          const aiResults = await translateSegments(stillMissing);
          if (cancelled) return;
          for (let i = 0; i < stillMissing.length; i++) { const translated = aiResults[i]; if (translated && translated !== stillMissing[i]) newMap.set(stillMissing[i], translated); }
        } catch { /* ignore */ }
      }
      if (!cancelled) {
        setTagTranslations(new Map(newMap));
        setTranslatingTags(prev => { const next = new Set(prev); toTranslate.forEach(t => next.delete(t)); return next; });
      }
    };
    const timer = setTimeout(load, 300);
    return () => { cancelled = true; clearTimeout(timer); setTranslatingTags(prev => { const next = new Set(prev); toTranslate.forEach(t => next.delete(t)); return next; }); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanTagKeysKey]);

  const commitInput = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const newVal = value ? value + ', ' + trimmed : trimmed;
    saveValue(newVal);
    setInputText('');
    setShowSuggestions(false);
    setSuggestions([]);
  }, [value, saveValue]);

  const triggerAutocomplete = useCallback((text: string) => {
    const trimmed = text.trim();
    const hasChinese = /[\u4e00-\u9fa5]/.test(trimmed);
    const minLen = hasChinese ? 1 : 2;
    if (trimmed.length >= minLen) {
      // 根据当前焦点选择定位元素
      const posRef = editingTag ? editInputRef.current : inputRef.current;
      if (posRef) {
        const rect = posRef.getBoundingClientRect();
        setSuggestionPos({ top: rect.bottom + window.scrollY, left: rect.left + window.scrollX });
      }
      getTagSuggestionsDebounced(trimmed, (newSuggestions) => {
        if (newSuggestions.length > 0) {
          setSuggestions([...newSuggestions]);
          setShowSuggestions(true);
          setSelectedSuggIdx(prev => Math.min(prev, newSuggestions.length - 1));
        } else { setShowSuggestions(false); setSuggestions([]); }
      }, 250);
    } else { setShowSuggestions(false); setSuggestions([]); }
  }, [editingTag]);

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
  }, [value, saveValue, triggerAutocomplete]);

  // 提交双击编辑
  const commitEdit = useCallback((index: number, newText: string) => {
    const trimmed = newText.trim();
    if (!trimmed) {
      rebuildValue(parsedTags.filter((_, i) => i !== index));
    } else if (trimmed !== parsedTags[index]?.trim()) {
      const t = [...parsedTags];
      t[index] = trimmed;
      rebuildValue(t);
    }
    setEditingTag(null);
  }, [parsedTags, rebuildValue]);

  // 取消双击编辑（如果是插入的占位符则删除）
  const cancelEdit = useCallback(() => {
    if (editingTag) {
      const rawTag = parsedTags[editingTag.index];
      if (rawTag && rawTag.trim() === 'new_tag') {
        rebuildValue(parsedTags.filter((_, i) => i !== editingTag.index));
      }
    }
    setEditingTag(null);
  }, [editingTag, parsedTags, rebuildValue]);

  const { nlTranslating, selectSuggestion } = useDesktopSuggestionSelection({
    value,
    inputText,
    editingTag,
    tagTranslations,
    saveValue,
    commitInput,
    commitEdit,
    setInputText,
    setShowSuggestions,
    setSuggestions,
    setTagTranslations,
  });

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    if (!pasted) return;
    // 保留换行结构：先按行拆分，每行内按逗号拆分
    const lines = pasted.split(/\r?\n/).map(line =>
      line.split(/[,，]/).map(s => s.trim()).filter(Boolean).join(', ')
    ).filter(Boolean);
    if (lines.length === 0) return;
    if (lines.length === 1 && !lines[0].includes(',')) return; // 单个tag不拦截
    e.preventDefault();
    const allTags = lines.join('\n');
    const newVal = value ? value + ', ' + allTags : allTags;
    saveValue(newVal);
    setInputText('');
    setShowSuggestions(false);
    setSuggestions([]);
  }, [value, saveValue]);

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Ctrl+A / Cmd+A 全选所有标签
    if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !inputText) {
      e.preventDefault();
      if (parsedTags.length > 0) {
        const allIndices = new Set<number>();
        for (let i = 0; i < parsedTags.length; i++) allIndices.add(i);
        setSelectedTags(allIndices);
        setTagPanel(null);
      }
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (showSuggestions && displaySuggs.length > 0) {
        e.preventDefault();
        const idx = selectedSuggIdx >= 0 && selectedSuggIdx < displaySuggs.length ? selectedSuggIdx : 0;
        const s = displaySuggs[idx];
        if (s.isAiLoading) return; // 跳过 AI 加载占位项
        if (s.isOrigin) {
          const chars = s.originCharacters || [];
          if (chars.length > 0) { const rc = chars[Math.floor(Math.random() * chars.length)]; selectSuggestion({ ...s, value: rc, chineseName: lookupCharacterChineseName(rc), isOrigin: false }); }
        } else { selectSuggestion(s); }
      } else if (e.key === 'Enter' && inputText.trim()) { e.preventDefault(); commitInput(inputText); }
    } else if (e.key === 'ArrowDown' && showSuggestions && displaySuggs.length > 0) { e.preventDefault(); setSelectedSuggIdx(prev => { let next = (prev + 1) % displaySuggs.length; if (displaySuggs[next]?.isAiLoading) next = (next + 1) % displaySuggs.length; return next; }); }
    else if (e.key === 'ArrowUp' && showSuggestions && displaySuggs.length > 0) { e.preventDefault(); setSelectedSuggIdx(prev => { let next = (prev - 1 + displaySuggs.length) % displaySuggs.length; if (displaySuggs[next]?.isAiLoading) next = (next - 1 + displaySuggs.length) % displaySuggs.length; return next; }); }
    else if (e.key === 'Escape') {
      if (showSuggestions) { setShowSuggestions(false); setSuggestions([]); }
      else if (tagPanel) setTagPanel(null);
      else if (selectedTags.size > 0) setSelectedTags(new Set());
    } else if (e.key === 'Backspace' && !inputText && parsedTags.length > 0) { e.preventDefault(); const tags = [...parsedTags]; tags.pop(); rebuildValue(tags); }
  }, [showSuggestions, displaySuggs, selectedSuggIdx, selectSuggestion, inputText, commitInput, parsedTags, rebuildValue, selectedTags, tagPanel]);

  const tagActions = useDesktopTagActions({
    selectedTags,
    tagGroups,
    parsedTags,
    rebuildValue,
    setSelectedTags,
    setTagPanel,
  });
  const panelActions = useDesktopPanelActions({
    tagPanel,
    tagGroups,
    parsedTags,
    rebuildValue,
    setSelectedTags,
    setTagPanel,
  });

  const currentNumericWeight = useMemo(() => {
    if (selectedTags.size === 0) return null;
    const idx = Array.from(selectedTags).sort((a, b) => a - b)[0];
    const w = getTagWeightInfo(parsedTags[idx]?.trim() || '');
    return w.type === 'numeric' ? w.numericValue ?? null : null;
  }, [selectedTags, parsedTags]);

  const selectedTag = selectedTags.size === 1 ? parsedTags[Array.from(selectedTags)[0]] : null;
  const hasSelection = selectedTags.size > 0 && !tagPanel;

  // 多选时的数值权重状态
  const [multiNumWeight, setMultiNumWeight] = useState(1.0);
  useEffect(() => { setMultiNumWeight(currentNumericWeight ?? 1.0); }, [currentNumericWeight]);

  useEffect(() => { if (!tagPanel) return; const m = tagPanel.rawTag.match(/^(-?\d+(?:\.\d+)?)::/); setNumWeight(m ? parseFloat(m[1]) : 1.0); }, [tagPanel]);

  useEffect(() => {
    if (!tagPanel || tagPanel.translation) { setTranslationLoading(false); return; }
    let cancelled = false;
    const queryTag = tagPanel.tag.replace(/ /g, '_');
    setTranslationLoading(true);
    (async () => {
      try {
        const result = await fetchWikiChineseNames([queryTag]);
        if (cancelled) return;
        let translation = result[queryTag]?.[0] || '';
        if (!translation) { const aiResults = await translateSegments([tagPanel.tag]); if (cancelled) return; translation = aiResults[0] && aiResults[0] !== tagPanel.tag ? aiResults[0] : ''; }
        if (cancelled) return;
        if (translation) {
          setTagTranslations(prev => new Map(prev).set(tagPanel.tag, translation));
          setTagPanel(prev => prev && prev.index === tagPanel.index ? { ...prev, translation } : prev);
        }
      } catch { } finally {
        if (!cancelled) setTranslationLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tagPanel?.index, tagPanel?.tag, tagPanel?.translation]);

  // 拉当前 tagPanel 标签的 Danbooru post_count
  useEffect(() => {
    if (!tagPanel) { setTagPanelPostCount(null); return; }
    let cancelled = false;
    const queryTag = tagPanel.tag.toLowerCase().replace(/ /g, '_').replace(/-/g, '_');
    setTagPanelPostCount(null);
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
        if (typeof v === 'number') setTagPanelPostCount(v);
      } catch { /* 静默 */ }
    })();
    return () => { cancelled = true; };
  }, [tagPanel?.index, tagPanel?.tag]);

  useEffect(() => {
    if (!tagPanel) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (tagPanelRef.current?.contains(e.target as globalThis.Node)) return;
      if (scrollRef.current?.contains(e.target as globalThis.Node)) return;
      setTagPanel(null);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [tagPanel]);

  // 面板打开时支持左右方向键切换到相邻芯片
  useEffect(() => {
    if (!tagPanel) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      let newIndex = tagPanel.index + dir;
      while (newIndex >= 0 && newIndex < parsedTags.length && parsedTags[newIndex] === NEWLINE_SENTINEL) {
        newIndex += dir;
      }
      if (newIndex < 0 || newIndex >= parsedTags.length) return;
      const rawTag = parsedTags[newIndex];
      if (!rawTag) return;
      e.preventDefault();
      // 抑制即将由 scrollIntoView 触发的 scroll 关闭面板
      chipClickTimeRef.current = Date.now();
      const chipEl = chipRefsMap.current.get(newIndex);
      chipEl?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      requestAnimationFrame(() => {
        const el = chipRefsMap.current.get(newIndex);
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const clean = cleanTagName(rawTag);
        setSelectedTags(new Set([newIndex]));
        setTagPanel({
          index: newIndex,
          rawTag: rawTag.trim(),
          tag: clean,
          translation: tagTranslations.get(clean) || '',
          screenX: rect.left,
          screenY: rect.bottom + 4,
        });
      });
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [tagPanel, parsedTags, tagTranslations]);

  useEffect(() => {
    if (!showSuggestions) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as globalThis.Node;
      if (suggestionsRef.current?.contains(target)) return;
      if (inputRef.current?.contains(target)) return;
      // Wiki 预览卡片是独立 portal，点击其中（如 Wiki 跳转链接）不应关闭补全，
      // 否则会触发清空 suggestionWikiPreview，使卡片在 click 派发前卸载、链接失效
      if (target instanceof Element && target.closest('.wiki-preview-floating')) return;
      setShowSuggestions(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSuggestions]);

  // 滚动时关闭面板和补全（保留选中状态，只在点击空白处才清除）
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const handleScroll = () => {
      // 芯片点击后短时间内忽略 scroll 事件，避免布局重排导致面板被误关
      if (Date.now() - chipClickTimeRef.current < 150) return;
      setTagPanel(null);
      setShowSuggestions(false);
      setSuggestions([]);
    };
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // 内容高度变化通知：仅在 value 变化时测量（用户增删 tag），
  // 不用 ResizeObserver 避免翻译加载等异步事件导致高度波动
  useEffect(() => {
    if (!onContentHeightChange || !chipContainerRef.current) return;
    requestAnimationFrame(() => {
      if (chipContainerRef.current) {
        onContentHeightChange(chipContainerRef.current.offsetHeight + 16);
      }
    });
  }, [value, onContentHeightChange]);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(index));
    // 使用 1x1 透明像素替代默认拖拽预览
    const emptyImg = new Image();
    emptyImg.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    e.dataTransfer.setDragImage(emptyImg, 0, 0);
    (e.currentTarget as HTMLElement).style.opacity = '0.4';
    const rawTag = parsedTags[index];
    const markerInfo = parseCollapsibleMarker(rawTag);
    if (markerInfo) {
      const tagCount = markerInfo.content.split(/[,，]/).filter(t => t.trim()).length;
      setDragGhostInfo({ text: `${getMarkerVisual(markerInfo.type).label} · ${markerInfo.name}`, sub: `${tagCount} 个标签` });
    } else {
      const clean = cleanTagName(rawTag);
      setDragGhostInfo({ text: rawTag.trim(), sub: tagTranslations.get(clean) || undefined });
    }
  }, [parsedTags, tagTranslations]);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).style.opacity = '1';
    if (dragIndex !== null && dragOverIndex !== null && dragIndex !== dragOverIndex) {
      const tags = [...parsedTags]; const [moved] = tags.splice(dragIndex, 1);
      tags.splice(dragOverIndex > dragIndex ? dragOverIndex - 1 : dragOverIndex, 0, moved);
      rebuildValue(tags); setSelectedTags(new Set());
    }
    setDragIndex(null); setDragOverIndex(null); setDragGhostInfo(null);
  }, [dragIndex, dragOverIndex, parsedTags, rebuildValue]);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverIndex(index);
  }, []);

  // 容器级 dragOver：处理边缘自动滚动
  const dragMouseY = useRef<number | null>(null);

  // 持续自动滚动：根据鼠标位置决定滚动方向和速度
  useEffect(() => {
    if (dragIndex === null) {
      dragMouseY.current = null;
      return;
    }
    const timer = setInterval(() => {
      const container = scrollRef.current;
      const y = dragMouseY.current;
      if (!container || y === null) return;
      const rect = container.getBoundingClientRect();
      const edgeZone = 50;
      if (y < rect.top + edgeZone) {
        const intensity = Math.max(2, Math.round((rect.top + edgeZone - y) / edgeZone * 12));
        container.scrollTop -= intensity;
      } else if (y > rect.bottom - edgeZone) {
        const intensity = Math.max(2, Math.round((y - (rect.bottom - edgeZone)) / edgeZone * 12));
        container.scrollTop += intensity;
      }
    }, 16);
    return () => clearInterval(timer);
  }, [dragIndex]);

  const handleContainerDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragMouseY.current = e.clientY;
  }, []);


  const handleChipClick = useCallback((e: React.MouseEvent, index: number) => {
    e.stopPropagation();
    chipClickTimeRef.current = Date.now();
    if (editingTag !== null) return;
    if (e.ctrlKey || e.metaKey) {
      setTagPanel(null);
      setSelectedTags(prev => { const next = new Set(prev); if (next.has(index)) next.delete(index); else next.add(index); return next; });
    } else if (e.shiftKey && selectedTags.size > 0) {
      setTagPanel(null);
      const existing = Array.from(selectedTags).sort((a, b) => a - b);
      const from = Math.min(existing[0], index), to = Math.max(existing[0], index);
      const next = new Set<number>(); for (let i = from; i <= to; i++) next.add(i);
      setSelectedTags(next);
    } else {
      const rawTag = parsedTags[index]; if (!rawTag) return;
      if (tagPanel && tagPanel.index === index) { setTagPanel(null); setSelectedTags(new Set()); return; }
      setSelectedTags(new Set([index]));
      const chipEl = e.currentTarget as HTMLElement;
      const rect = chipEl.getBoundingClientRect();
      const clean = cleanTagName(rawTag);
      setTagPanel({ index, rawTag: rawTag.trim(), tag: clean, translation: tagTranslations.get(clean) || '', screenX: rect.left, screenY: rect.bottom + 4 });
    }
  }, [selectedTags, parsedTags, tagPanel, tagTranslations, editingTag]);

  // 双击芯片：进入编辑模式
  const handleChipDoubleClick = useCallback((e: React.MouseEvent, index: number) => {
    e.stopPropagation();
    const rawTag = parsedTags[index];
    if (!rawTag || isCollapsibleMarker(rawTag)) return;
    setTagPanel(null);
    setSelectedTags(new Set());
    const chipEl = chipRefsMap.current.get(index);
    const chipWidth = chipEl ? chipEl.getBoundingClientRect().width : 80;
    const chipHeight = chipEl ? chipEl.getBoundingClientRect().height : 32;
    setEditingTag({ index, text: rawTag.trim(), width: Math.max(80, chipWidth), height: chipHeight });
  }, [parsedTags]);

  const handleContainerClick = useCallback(() => {
    setSelectedTags(new Set()); setTagPanel(null); setEditingTag(null);
    inputRef.current?.focus();
  }, []);

  // 编辑模式激活时聚焦并全选（仅在进入编辑或切换编辑目标时触发）
  const editingIndex = editingTag?.index ?? null;
  useEffect(() => {
    if (editingIndex !== null && editInputRef.current) {
      editInputRef.current.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingIndex]);

  // 全局键盘事件处理（支持在容器聚焦时 Ctrl+A 全选、Delete/Backspace 删除、Ctrl+C 复制）
  const handleContainerKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Ctrl+A / Cmd+A 全选所有标签
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      // 如果输入框有内容，让输入框处理
      if (inputText) return;
      e.preventDefault();
      if (parsedTags.length > 0) {
        const allIndices = new Set<number>();
        for (let i = 0; i < parsedTags.length; i++) allIndices.add(i);
        setSelectedTags(allIndices);
        setTagPanel(null);
      }
    }
    // Ctrl+C / Cmd+C 复制选中的标签
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selectedTags.size > 0 && !inputText) {
      e.preventDefault();
      const indices = Array.from(selectedTags).sort((a, b) => a - b);
      const tagsToCopy = indices.map(i => parsedTags[i]).join(', ');
      navigator.clipboard.writeText(tagsToCopy).catch(() => { });
    }
    // Delete / Backspace 删除选中的标签
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedTags.size > 0 && !inputText) {
      e.preventDefault();
      rebuildValue(parsedTags.filter((_, i) => !selectedTags.has(i)));
      setSelectedTags(new Set());
      setTagPanel(null);
    }
    // Ctrl+Z / Cmd+Z 撤回操作
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !inputText) {
      const prev = undoStackRef.current.pop();
      if (prev !== undefined) {
        e.preventDefault();
        isUndoingRef.current = true;
        saveValue(prev);
        isUndoingRef.current = false;
        setSelectedTags(new Set());
        setTagPanel(null);
      }
    }
  }, [inputText, parsedTags, selectedTags, rebuildValue, saveValue]);

  // 拖拽期间允许滚轮滚动（浏览器默认会阻止拖拽时的滚轮事件）
  useEffect(() => {
    if (dragIndex === null) return;
    const container = scrollRef.current;
    if (!container) return;
    const handleWheel = (e: WheelEvent) => {
      container.scrollTop += e.deltaY;
    };
    // capture 阶段拦截，确保拖拽期间也能收到 wheel 事件
    window.addEventListener('wheel', handleWheel, { capture: true, passive: true });
    return () => {
      window.removeEventListener('wheel', handleWheel, { capture: true } as EventListenerOptions);
    };
  }, [dragIndex]);

  // 原生滚轮处理，解决滚动到底部时外部接力的卡顿问题
  // 以及 Shift+滚轮时强制垂直滚动（浏览器默认 Shift+滚轮 = 水平滚动）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      // 如果正在拖拽，交由上面的 capture 逻辑处理
      if (dragIndex !== null) return;

      // Shift+滚轮：浏览器默认会变成水平滚动，这里拦截并强制垂直滚动
      if (e.shiftKey && el.scrollHeight > el.clientHeight) {
        e.preventDefault();
        const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        el.scrollTop += delta;
        return;
      }

      // 如果内容不足以出现滚动条（如空状态），交由原生处理，保证原生顺滑的整体滚动体验
      if (el.scrollHeight <= el.clientHeight) {
        return;
      }

      const isAtTop = el.scrollTop <= 0;
      const isAtBottom = Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight - 1;

      if ((isAtTop && e.deltaY < 0) || (isAtBottom && e.deltaY > 0)) {
        const outerScroll = el.parentElement?.closest('.overflow-y-auto, .custom-scrollbar') as HTMLElement;
        if (outerScroll) {
          e.preventDefault();
          let delta = e.deltaY;
          if (e.deltaMode === 1) delta *= 40;
          else if (e.deltaMode === 2) delta *= outerScroll.clientHeight || 800;
          const isTouchpad = e.deltaMode === 0 && (Math.abs(e.deltaY) < 50 || e.deltaY % 1 !== 0);
          outerScroll.scrollBy({ top: delta, behavior: isTouchpad ? 'auto' : 'smooth' });
        }
      }
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [dragIndex]);

  return (
    <div className={`flex flex-col h-full ${className}`} onKeyDown={handleContainerKeyDown} tabIndex={-1}>
      <style>{`
        @keyframes chipSuggFadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
        .chip-suggestion-dropdown { animation: chipSuggFadeIn 0.15s ease-out; }
        @keyframes chipPanelFadeIn { from { opacity: 0; transform: translateY(-2px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
        .chip-tag-quick-panel { animation: chipPanelFadeIn 0.12s ease-out; }
        @keyframes chipChNameExpand { from { opacity: 0; max-height: 0; margin-top: 0; } to { opacity: 1; max-height: 20px; margin-top: 1px; } }
        .chip-chinese-name-fade { animation: chipChNameExpand 0.25s ease-out forwards; overflow: hidden; }
        @keyframes chipSuggItemIn { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: translateX(0); } }
        .chip-sugg-item { animation: chipSuggItemIn 0.18s ease-out both; }
        .chip-weight-dynamic:hover { filter: brightness(1.35); }
        .chip-insert-btn { opacity: 0; width: 0; padding: 0; margin: 0 -2px; overflow: visible; position: relative; z-index: 2; cursor: pointer; border: none; background: none; transition: opacity 0.15s ease; }
        .chip-insert-btn::after { content: ''; position: absolute; top: -8px; bottom: -8px; left: -8px; right: -8px; }
        .chip-insert-btn:hover { opacity: 1; }
        .chip-insert-btn:hover > * { background: #fceda4; color: #1e1e1e; border-radius: 50%; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); }
      `}</style>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-hide p-2" onClick={handleContainerClick} onDragOver={handleContainerDragOver}>
        <div ref={chipContainerRef} className="chip-container flex flex-wrap gap-x-1 gap-y-0 items-center content-start select-none">
          {parsedTags.map((rawTag, index) => {
            // 换行标记：强制芯片换行
            if (rawTag === NEWLINE_SENTINEL) {
              // 检查是否为连续换行（多个 NEWLINE_SENTINEL 相邻 = 空行间距）
              const isConsecutive = index > 0 && parsedTags[index - 1] === NEWLINE_SENTINEL;
              // 单个换行：渲染零高度占位，强制 flex 换行但不增加间距
              if (!isConsecutive) return <div key={`nl-${index}`} className="basis-full h-0" />;
              // 连续换行（2+）：渲染间距
              return <div key={`nl-${index}`} className="basis-full h-2" />;
            }
            const showDropIndicator = dragIndex !== null && dragOverIndex === index && dragIndex !== index && dragOverIndex !== dragIndex + 1;
            const dropPlaceholder = showDropIndicator && dragGhostInfo ? (
              <div className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border-2 border-dashed border-[#fceda4]/40 bg-[#fceda4]/8">
                <span className="flex flex-col items-start">
                  <span className="font-tag text-xs leading-tight text-[#fceda4]/40">{dragGhostInfo.text}</span>
                  {dragGhostInfo.sub && <span className="text-[10px] leading-tight text-[#fceda4]/20">{dragGhostInfo.sub}</span>}
                </span>
              </div>
            ) : null;
            // 插入按钮：始终渲染以保持布局稳定，仅在可用时启用交互
            const canInsert = dragIndex === null && editingTag === null && selectedTags.size === 0;
            const insertBtn = (
              <button
                key={`ins-${index}`}
                className={`chip-insert-btn inline-flex items-center justify-center w-0 h-5 rounded text-[#fceda4]/60${canInsert ? '' : ' !opacity-0 pointer-events-none'}`}
                onClick={canInsert ? (e: React.MouseEvent) => {
                  e.stopPropagation();
                  const t = [...parsedTags];
                  t.splice(index, 0, 'new_tag');
                  rebuildValue(t);
                  setTimeout(() => {
                    const chipEl = chipRefsMap.current.get(index);
                    const chipWidth = chipEl ? chipEl.getBoundingClientRect().width : 80;
                    const chipHeight = chipEl ? chipEl.getBoundingClientRect().height : 32;
                    setEditingTag({ index, text: '', width: Math.max(80, chipWidth), height: chipHeight });
                  }, 0);
                } : undefined}
                title={canInsert ? "在此处插入标签" : undefined}
              ><Plus className="w-3 h-3 flex-shrink-0" /></button>
            );
            const markerInfo = parseCollapsibleMarker(rawTag);
            if (markerInfo) {
              const isSelected = selectedTags.has(index);
              const tagCount = markerInfo.content.split(/[,，]/).filter(t => t.trim()).length;
              // 类型配置 (builtin 固定配色 / 自定义走 registry)
              const cfg = getMarkerVisual(markerInfo.type);
              const MarkerIcon = cfg.Icon;
              return (
                <React.Fragment key={index}>
                  {insertBtn}
                  {dropPlaceholder}
                  <button draggable onDragStart={(e) => handleDragStart(e, index)} onDragEnd={handleDragEnd} onDragOver={(e) => handleDragOver(e, index)}
                    ref={(el) => { if (el) chipRefsMap.current.set(index, el); else chipRefsMap.current.delete(index); }}
                    className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded transition-colors cursor-grab active:cursor-grabbing border ${dragIndex === index ? 'opacity-30' : ''} ${isSelected ? 'bg-nai-accent/40 border-nai-accent/70' : 'bg-nai-accent/20 border-nai-accent/50 hover:bg-nai-accent/30'}`}
                    onClick={(e) => handleChipClick(e, index)} onDoubleClick={(e) => handleChipDoubleClick(e, index)}>
                    <MarkerIcon className="w-3.5 h-3.5 shrink-0 text-white/90" strokeWidth={2} />
                    <span className="flex flex-col items-start">
                      <span className="text-xs font-medium leading-tight text-white/90">{markerInfo.name}</span>
                      <span className="text-[10px] leading-tight text-white/40">{tagCount} 个标签</span>
                    </span>
                  </button>
                </React.Fragment>
              );
            }
            // 双击编辑模式：渲染内联输入框
            if (editingTag && editingTag.index === index) {
              return (
                <React.Fragment key={index}>
                  {insertBtn}
                  {dropPlaceholder}
                  <div className="inline-flex items-center rounded border border-[#fceda4]/50 bg-[#fceda4]/10" style={{ width: editingTag.width, height: editingTag.height }}>
                    <input
                      ref={editInputRef}
                      type="text"
                      value={editingTag.text}
                      onChange={(e) => {
                        const newText = e.target.value;
                        setEditingTag(prev => prev ? { ...prev, text: newText } : null);
                        triggerAutocomplete(newText);
                      }}
                      onKeyDown={(e) => {
                        if (showSuggestions && displaySuggs.length > 0) {
                          if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedSuggIdx(prev => { let next = (prev + 1) % displaySuggs.length; if (displaySuggs[next]?.isAiLoading) next = (next + 1) % displaySuggs.length; return next; }); return; }
                          if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedSuggIdx(prev => { let next = (prev - 1 + displaySuggs.length) % displaySuggs.length; if (displaySuggs[next]?.isAiLoading) next = (next - 1 + displaySuggs.length) % displaySuggs.length; return next; }); return; }
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            const s = displaySuggs[selectedSuggIdx];
                            if (s && !s.isAiLoading) {
                              if (s.isOrigin) { const chars = s.originCharacters || []; if (chars.length > 0) { const rc = chars[Math.floor(Math.random() * chars.length)]; selectSuggestion({ ...s, value: rc, chineseName: lookupCharacterChineseName(rc), isOrigin: false }); } }
                              else selectSuggestion(s);
                            }
                            e.stopPropagation(); return;
                          }
                          if (e.key === 'Escape') { e.preventDefault(); setShowSuggestions(false); setSuggestions([]); e.stopPropagation(); return; }
                        }
                        if (e.key === 'Enter') { e.preventDefault(); commitEdit(index, editingTag.text); }
                        else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                        e.stopPropagation();
                      }}
                      onBlur={(e) => {
                        // 点击补全列表时不要提交
                        const related = e.relatedTarget as HTMLElement | null;
                        if (related?.closest('.chip-suggestion-dropdown')) return;
                        setTimeout(() => {
                          if (!showSuggestions) commitEdit(index, editingTag.text);
                          else commitEdit(index, editingTag.text);
                        }, 150);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="bg-transparent text-[#fceda4] text-sm font-tag outline-none px-1.5 py-0.5 w-full"
                      autoFocus
                    />
                  </div>
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
            const roundedClass = group.position === 'first' ? 'rounded-l rounded-r-none' : group.position === 'middle' ? 'rounded-none' : group.position === 'last' ? 'rounded-r rounded-l-none' : 'rounded';
            const gapClass = (group.position === 'first' || group.position === 'middle') ? '-mr-[2px]' : '';
            // 动态权重颜色
            const weightStyle = getWeightStyle(effectiveWeight);
            const chipStyle: React.CSSProperties = abnormalWeight
              ? { backgroundColor: 'rgba(239, 68, 68, 0.2)', borderColor: 'rgba(248, 113, 113, 0.5)' }
              : isSelected
                ? { backgroundColor: 'rgba(252, 237, 164, 0.15)', borderColor: 'rgba(252, 237, 164, 0.5)' }
                : isGroupSelected
                  ? { backgroundColor: 'rgba(252, 237, 164, 0.08)', borderColor: 'rgba(252, 237, 164, 0.25)' }
                  : isSDFormat
                    ? { backgroundColor: 'rgba(245, 158, 11, 0.25)', borderColor: 'rgba(251, 191, 36, 0.4)' }
                    : weightStyle;
            const usesDynamicColor = !abnormalWeight && !isSelected && !isGroupSelected && !isSDFormat && !isHidden;
            if (isHidden && !isSelected) {
              chipStyle.backgroundColor = 'rgba(255, 255, 255, 0.03)';
              chipStyle.borderColor = 'rgba(255, 255, 255, 0.08)';
            }
            return (
              <React.Fragment key={index}>
                {insertBtn}
                {dropPlaceholder}
                <button draggable onDragStart={(e) => handleDragStart(e, index)} onDragEnd={handleDragEnd} onDragOver={(e) => handleDragOver(e, index)}
                  ref={(el) => { if (el) chipRefsMap.current.set(index, el); else chipRefsMap.current.delete(index); }}
                  className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 my-[2px] transition-all cursor-grab active:cursor-grabbing border ${roundedClass} ${gapClass} ${dragIndex === index ? 'opacity-30' : ''} ${isSelected ? 'z-[1]' : ''} ${usesDynamicColor ? 'chip-weight-dynamic' : abnormalWeight ? 'hover:brightness-125' : ''}`}
                  style={chipStyle}
                  onClick={(e) => handleChipClick(e, index)} onDoubleClick={(e) => handleChipDoubleClick(e, index)} title={abnormalWeight ? `⚠️ ${abnormalWeight}` : isSDFormat ? `SD格式: ${rawTag.trim()} - 点击转换` : rawTag.trim()}>
                  <span className="flex flex-col items-start">
                    <span className="flex items-center gap-1">
                      {abnormalWeight && <span className="text-[9px] text-red-400" title={abnormalWeight}>⚠️</span>}
                      {isSDFormat && !abnormalWeight && <span className="text-[9px] text-amber-300" title="SD WebUI 格式">SD</span>}
                      <span className={`font-tag text-sm leading-tight ${isHidden ? 'text-white/25 line-through' : abnormalWeight ? 'text-red-300' : isSelected ? 'text-[#fceda4]' : isSDFormat ? 'text-amber-200' : 'text-white/85'}`}>{rawTag.trim()}</span>
                    </span>
                    {abnormalWeight ? (<span className="text-[10px] leading-tight text-red-400/70">{abnormalWeight}</span>)
                      : translation ? (<span className={`text-[10px] leading-tight ${isSelected ? 'text-[#fceda4]/50' : 'text-white/35'}`}>{translation}</span>)
                        : isTranslating ? (<span className="text-[10px] leading-tight text-white/20 animate-pulse">翻译中…</span>)
                          : needsTranslation ? (<span className="text-[10px] leading-tight text-white/15">…</span>) : <span className="text-[10px] leading-tight">&nbsp;</span>}
                  </span>
                </button>
              </React.Fragment>
            );
          })}
          <div className="relative inline-flex flex-1 min-w-[80px] my-[2px]">
            <input ref={inputRef} type="text" value={inputText} onChange={(e) => handleInputChange(e.target.value)} onKeyDown={handleInputKeyDown} onPaste={handlePaste}
              placeholder={parsedTags.length === 0 ? placeholder : '继续添加...'} className="w-full bg-transparent text-white text-sm font-tag outline-none placeholder-gray-500 placeholder:text-sm py-0.5" onClick={(e) => e.stopPropagation()} />
            {nlTranslating && (
              <div className="absolute left-0 top-full mt-1 flex items-center gap-1.5 px-2.5 py-1 bg-[#1a1a1a]/90 backdrop-blur-md rounded-lg shadow-lg border border-cyan-500/20 z-50">
                <span className="inline-block w-3 h-3 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
                <span className="text-[11px] text-cyan-200/80">翻译中...</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {showSuggestions && (
        <DesktopSuggestionDropdown
          suggestions={displaySuggs}
          selectedIndex={selectedSuggIdx}
          suggestionPos={suggestionPos}
          suggestionsRef={suggestionsRef}
          suggestionWikiMap={suggestionWikiMap}
          onSelectSuggestion={selectSuggestion}
          onHighlight={(index) => {
            suggestionScrollLockRef.current = true;
            setSelectedSuggIdx(prev => prev === index ? prev : index);
          }}
          onShowWikiPreview={showSuggestionWikiPreview}
          onHideWikiPreview={hideSuggestionWikiPreview}
        />
      )}

      <SuggestionWikiPreviewCard
        preview={suggestionWikiPreview}
        height={suggestionWikiPreviewHeight}
        contentRef={suggestionWikiPreviewContentRef}
        imageIndex={wikiPreviewImageIndex}
        onKeepVisible={keepSuggestionWikiPreviewVisible}
        onHide={() => hideSuggestionWikiPreview(80)}
      />

      {tagPanel && !ctrlHeld && !shiftHeld && (() => {
        const markerData = parseCollapsibleMarker(tagPanel.rawTag);
        if (markerData) {
          const tagCount = markerData.content.split(/[,，]/).filter(t => t.trim()).length;
          // 类型配置 (lucide 图标 + 中文名, 配色统一 nai-accent)
          const cfg = getMarkerVisual(markerData.type);
          const MarkerIcon = cfg.Icon;
          return createPortal(
            <div ref={tagPanelRef} className="fixed z-[99999] chip-tag-quick-panel bg-[#0f0f0f] rounded-lg shadow-[0_16px_40px_-10px_rgba(0,0,0,0.85)] border border-[#fceda4]/20 overflow-hidden"
              style={{ top: tagPanel.screenY, left: tagPanel.screenX, minWidth: 220, maxWidth: 340 }}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}>
              <div className="flex items-start gap-2 px-3 py-2 border-b border-white/10">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5"><MarkerIcon className="w-3.5 h-3.5 shrink-0 text-nai-accent" strokeWidth={2} /><span className="text-xs font-medium text-white/90 truncate">{markerData.name}</span></div>
                  <div className="text-[10px] text-white/40 mt-0.5">{cfg.label} · {tagCount} 个标签</div>
                </div>
                <button className="shrink-0 w-6 h-6 flex items-center justify-center text-white/40 hover:text-white/80 rounded hover:bg-white/10 transition-colors" onClick={() => setTagPanel(null)}><X className="w-4 h-4" /></button>
              </div>
              <div className="px-2 py-1.5 flex items-center gap-2">
                <button className="flex-1 h-6 text-[10px] bg-nai-accent/15 hover:bg-nai-accent/30 text-nai-accent rounded transition-colors"
                  onClick={() => { const t = [...parsedTags]; t.splice(tagPanel.index, 1, ...markerData.content.split(/[,，]/).map(s => s.trim()).filter(s => s)); rebuildValue(t); setSelectedTags(new Set()); setTagPanel(null); }}>展开为标签</button>
                <button className="flex-1 h-6 text-[10px] bg-red-500/10 hover:bg-red-500/25 text-red-400/70 rounded transition-colors flex items-center justify-center gap-0.5"
                  onClick={() => panelActions.deleteTag()}><Trash2 className="w-3 h-3" /> 删除</button>
              </div>
            </div>, document.body
          );
        }
        return createPortal(
          <div ref={tagPanelRef} className="fixed z-[99999] chip-tag-quick-panel"
            style={{ top: tagPanel.screenY, left: tagPanel.screenX, minWidth: 300, maxWidth: 420 }}
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}>
            <div className="bg-[#0f0f0f] rounded-lg shadow-[0_16px_40px_-10px_rgba(0,0,0,0.85),0_0_0_1px_rgba(252,237,164,0.08)] overflow-hidden">
            {/* 标题 */}
            <div className="flex items-start gap-2 px-3 py-2.5">
              <div className="min-w-0 flex-1 cursor-text" onClick={() => {
                const chipEl = chipRefsMap.current.get(tagPanel.index);
                const chipWidth = chipEl ? chipEl.getBoundingClientRect().width : 80;
                const chipHeight = chipEl ? chipEl.getBoundingClientRect().height : 32;
                setEditingTag({ index: tagPanel.index, text: tagPanel.rawTag, width: Math.max(80, chipWidth), height: chipHeight });
                setTagPanel(null);
                setSelectedTags(new Set());
              }}>
                <div className="flex items-baseline gap-1.5 min-w-0">
                  <span className="font-tag text-[14px] leading-tight text-[#fceda4] truncate hover:text-[#fceda4]/85 transition-colors" title={tagPanel.tag}>{tagPanel.tag.replace(/ /g, '_')}</span>
                  {tagPanelPostCount != null && tagPanelPostCount > 0 && (
                    <span className="shrink-0 text-[11px] tabular-nums text-white/40" title={`Danbooru 引用数：${tagPanelPostCount}`}>
                      {tagPanelPostCount >= 1000 ? `${(tagPanelPostCount / 1000).toFixed(0)}k` : tagPanelPostCount}
                    </span>
                  )}
                </div>
                <div className="text-[11px] leading-tight text-white/50 mt-1 relative">
                  <span className={tagPanel.translation ? '' : 'invisible'}>{tagPanel.translation || '\u00A0'}</span>
                  {!tagPanel.translation && translationLoading && (
                    <span className="absolute inset-0 flex items-center gap-1">
                      <span className="inline-block w-1 h-1 rounded-full bg-white/50 animate-pulse" style={{ animationDelay: '0ms' }} />
                      <span className="inline-block w-1 h-1 rounded-full bg-white/50 animate-pulse" style={{ animationDelay: '150ms' }} />
                      <span className="inline-block w-1 h-1 rounded-full bg-white/50 animate-pulse" style={{ animationDelay: '300ms' }} />
                    </span>
                  )}
                </div>
              </div>
              <button className="shrink-0 w-6 h-6 flex items-center justify-center text-white/40 hover:text-white/90 rounded-md hover:bg-white/[0.08] transition-colors" onClick={() => { setTagPanel(null); setSelectedTags(new Set()); }} title="关闭"><X className="w-3.5 h-3.5" strokeWidth={2} /></button>
            </div>
            {/* SD 格式转换提示 */}
            {isSDWeightFormat(tagPanel.rawTag) && (() => {
              const sdInfo = parseSDWeight(tagPanel.rawTag);
              return (
                <div className="mx-2 mb-1.5 rounded-md bg-amber-500/10 ring-1 ring-amber-500/20 px-2.5 py-1.5 flex items-center gap-2">
                  <span className="text-[10px] text-amber-300 font-medium">SD WebUI</span>
                  <span className="text-[10px] text-amber-200/60">{sdInfo?.weight !== null ? `权重 ${sdInfo?.weight}` : '无权重'}</span>
                  <div className="flex-1" />
                  <button className="px-2 py-0.5 text-[10px] bg-amber-500/25 hover:bg-amber-500/40 text-amber-100 rounded transition-colors" onClick={panelActions.convertSDToNAI} title="转换为 NAI 格式">转 NAI</button>
                </div>
              );
            })()}
            {/* 权重行 */}
            <div className="px-2 pb-1.5">
              <div className="flex items-center gap-1 mb-1.5">
                <button className="px-2 h-6 text-[11px] font-mono bg-[#74270D]/50 hover:bg-[#74270D]/80 text-orange-200 rounded transition-colors" onClick={panelActions.addWeight} title="增加权重 {tag}">{'{+}'}</button>
                <button className="px-2 h-6 text-[11px] font-mono bg-blue-500/20 hover:bg-blue-500/40 text-blue-200 rounded transition-colors" onClick={panelActions.reduceWeight} title="降低权重 [tag]">{'[−]'}</button>
                <div className="flex-1" />
                <button className="w-6 h-6 flex items-center justify-center text-sm bg-blue-500/15 hover:bg-blue-500/35 text-blue-200 rounded transition-colors" onClick={() => { const v = stepNumericWeight(numWeight, -0.1); setNumWeight(v); panelActions.setNumericWeight(v); }} title="减少 0.1">−</button>
                <span className={`w-11 text-center text-[12px] font-mono tabular-nums font-medium ${numWeight > 1 ? 'text-orange-200' : numWeight < 1 ? 'text-blue-200' : 'text-white/80'}`}>{numWeight.toFixed(1)}</span>
                <button className="w-6 h-6 flex items-center justify-center text-sm bg-[#74270D]/40 hover:bg-[#74270D]/70 text-orange-200 rounded transition-colors" onClick={() => { const v = stepNumericWeight(numWeight, 0.1); setNumWeight(v); panelActions.setNumericWeight(v); }} title="增加 0.1">+</button>
              </div>
              {/* 预设 */}
              <div className="flex items-center gap-1">
                {weightPresets.map(w => {
                  const active = Math.abs(numWeight - w) < 0.01;
                  const isOrange = w > 1;
                  const base = isOrange ? 'bg-[#74270D]/35 hover:bg-[#74270D]/65 text-orange-200' : 'bg-blue-500/15 hover:bg-blue-500/30 text-blue-200';
                  return (
                    <button key={w} className={`flex-1 h-6 text-[11px] font-mono tabular-nums rounded transition-colors ${base} ${active ? 'ring-1 ring-inset ring-[#fceda4]/60' : ''}`}
                      onClick={() => { setNumWeight(w); panelActions.setNumericWeight(w); }} title={`${w}::tag::`}>{w}</button>
                  );
                })}
                <button className="px-2 h-6 text-[11px] text-white/50 hover:text-white/80 hover:bg-white/[0.08] rounded transition-colors" onClick={panelActions.clearWeight} title="清除所有权重">清除</button>
              </div>
            </div>
            {/* 分隔 */}
            <div className="mx-2 h-px bg-white/[0.08]" />
            {/* 关联推荐: 紧贴权重栏与工具栏之间; 失败/空时整段不渲染 */}
            <RelatedTagsRow
              anchorTags={[tagPanel.tag]}
              existingTagSet={new Set(parsedTags.map(t => cleanTagName(t).toLowerCase().replace(/\s+/g, '_')))}
              onAdd={(addedTag, addToEnd) => {
                const newTags = [...parsedTags];
                if (addToEnd) {
                  newTags.push(addedTag);
                } else {
                  newTags.splice(tagPanel.index + 1, 0, addedTag);
                }
                rebuildValue(newTags);
              }}
            />
            <div className="mx-2 h-px bg-white/[0.08]" />
            {/* 操作行 */}
            <div className="px-2 py-1.5 flex items-center gap-0.5">
              <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-white/60 hover:text-white hover:bg-white/[0.08] rounded transition-colors" onClick={panelActions.openDanbooru} title="在 Danbooru 中查看"><ExternalLink className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} /><span>Wiki</span></button>
              <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-white/60 hover:text-white hover:bg-white/[0.08] rounded transition-colors" onClick={panelActions.moveToFront} title="移到最前"><ArrowUp className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} /><span>置顶</span></button>
              <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-white/60 hover:text-white hover:bg-white/[0.08] rounded transition-colors" onClick={panelActions.toggleHide} title={tagPanel.rawTag.trim().startsWith('~') ? '启用此标签' : '禁用此标签'}>
                {tagPanel.rawTag.trim().startsWith('~') ? <Eye className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} /> : <EyeOff className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />}<span>{tagPanel.rawTag.trim().startsWith('~') ? '启用' : '禁用'}</span>
              </button>
              <div className="flex-1" />
              <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-red-400/75 hover:text-red-300 hover:bg-red-500/15 rounded transition-colors" onClick={panelActions.deleteTag} title="删除标签"><Trash2 className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} /><span>删除</span></button>
            </div>
            </div>
          </div>, document.body
        );
      })()}

      {/* 多选操作面板 */}
      {hasSelection && selectedTags.size >= 2 && !ctrlHeld && !shiftHeld && (() => {
        // 计算面板位置：取第一个选中芯片的位置
        const firstIdx = Array.from(selectedTags).sort((a, b) => a - b)[0];
        const chipEl = chipRefsMap.current.get(firstIdx);
        const rect = chipEl?.getBoundingClientRect();
        const panelX = rect ? rect.left : 100;
        const panelY = rect ? rect.bottom + 4 : 100;
        return createPortal(
          <div className="fixed z-[99999] chip-tag-quick-panel"
            style={{ top: panelY, left: panelX, minWidth: 300, maxWidth: 420 }}
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}>
            <div className="bg-[#0f0f0f] rounded-lg shadow-[0_16px_40px_-10px_rgba(0,0,0,0.85),0_0_0_1px_rgba(252,237,164,0.08)] overflow-hidden">
            {/* 标题 */}
            <div className="flex items-start gap-2 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="font-tag text-[14px] leading-tight text-[#fceda4] truncate">已选 {selectedTags.size} 个标签</div>
                <div className="text-[11px] leading-tight text-white/50 mt-1">批量操作</div>
              </div>
              <button className="shrink-0 w-6 h-6 flex items-center justify-center text-white/40 hover:text-white/90 rounded-md hover:bg-white/[0.08] transition-colors" onClick={() => setSelectedTags(new Set())} title="关闭"><X className="w-3.5 h-3.5" strokeWidth={2} /></button>
            </div>
            {/* SD 格式批量转换提示 */}
            {(() => {
              const sdCount = Array.from(selectedTags).filter(i => isSDWeightFormat(parsedTags[i] || '')).length;
              if (sdCount === 0) return null;
              return (
                <div className="mx-2 mb-1.5 rounded-md bg-amber-500/10 ring-1 ring-amber-500/20 px-2.5 py-1.5 flex items-center gap-2">
                  <span className="text-[10px] text-amber-300 font-medium">SD WebUI</span>
                  <span className="text-[10px] text-amber-200/60">{sdCount} 个 SD 格式标签</span>
                  <div className="flex-1" />
                  <button className="px-2 py-0.5 text-[10px] bg-amber-500/25 hover:bg-amber-500/40 text-amber-100 rounded transition-colors cursor-pointer" onClick={() => tagActions.convertSDToNAI()} title="批量转换为 NAI 格式">转 NAI</button>
                </div>
              );
            })()}
            {/* 权重行 */}
            <div className="px-2 pb-1.5">
              <div className="flex items-center gap-1 mb-1.5">
                <button className="px-2 h-6 text-[11px] font-mono bg-[#74270D]/50 hover:bg-[#74270D]/80 text-orange-200 rounded transition-colors" onClick={() => tagActions.addBrace()} title="增加权重 {tags}">{'{+}'}</button>
                <button className="px-2 h-6 text-[11px] font-mono bg-blue-500/20 hover:bg-blue-500/40 text-blue-200 rounded transition-colors" onClick={() => tagActions.addBracket()} title="降低权重 [tags]">{'[−]'}</button>
                <div className="flex-1" />
                <button className="w-6 h-6 flex items-center justify-center text-sm bg-blue-500/15 hover:bg-blue-500/35 text-blue-200 rounded transition-colors"
                  onClick={() => { const v = stepNumericWeight(multiNumWeight, -0.1); setMultiNumWeight(v); tagActions.setNumeric(v); }} title="减少 0.1">−</button>
                <span className={`w-11 text-center text-[12px] font-mono tabular-nums font-medium ${multiNumWeight > 1 ? 'text-orange-200' : multiNumWeight < 1 ? 'text-blue-200' : 'text-white/80'}`}>{multiNumWeight.toFixed(1)}</span>
                <button className="w-6 h-6 flex items-center justify-center text-sm bg-[#74270D]/40 hover:bg-[#74270D]/70 text-orange-200 rounded transition-colors"
                  onClick={() => { const v = stepNumericWeight(multiNumWeight, 0.1); setMultiNumWeight(v); tagActions.setNumeric(v); }} title="增加 0.1">+</button>
              </div>
              {/* 预设 */}
              <div className="flex items-center gap-1">
                {weightPresets.map(w => {
                  const active = Math.abs(multiNumWeight - w) < 0.01;
                  const isOrange = w > 1;
                  const base = isOrange ? 'bg-[#74270D]/35 hover:bg-[#74270D]/65 text-orange-200' : 'bg-blue-500/15 hover:bg-blue-500/30 text-blue-200';
                  return (
                    <button key={w} className={`flex-1 h-6 text-[11px] font-mono tabular-nums rounded transition-colors ${base} ${active ? 'ring-1 ring-inset ring-[#fceda4]/60' : ''}`}
                      onClick={() => { setMultiNumWeight(w); tagActions.setNumeric(w); }} title={`${w}::tags::`}>{w}</button>
                  );
                })}
                <button className="px-2 h-6 text-[11px] text-white/50 hover:text-white/80 hover:bg-white/[0.08] rounded transition-colors" onClick={() => tagActions.clearWeight()} title="清除所有权重">清除</button>
              </div>
            </div>
            {/* 分隔 */}
            <div className="mx-2 h-px bg-white/[0.08]" />
            {/* 多选关联推荐: 紧贴权重栏与工具栏之间; 失败/空时整段不渲染 */}
            <RelatedTagsRow
              anchorTags={Array.from(selectedTags)
                .map(i => parsedTags[i])
                .filter(t => t && !isCollapsibleMarker(t))
                .map(t => cleanTagName(t))}
              existingTagSet={new Set(parsedTags.map(t => cleanTagName(t).toLowerCase().replace(/\s+/g, '_')))}
              onAdd={(addedTag, addToEnd) => {
                const newTags = [...parsedTags];
                if (addToEnd) {
                  newTags.push(addedTag);
                } else {
                  const lastIdx = Math.max(...Array.from(selectedTags));
                  newTags.splice(lastIdx + 1, 0, addedTag);
                }
                rebuildValue(newTags);
              }}
            />
            <div className="mx-2 h-px bg-white/[0.08]" />
            {/* 操作行 */}
            <div className="px-2 py-1.5 flex items-center gap-0.5">
              <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-white/60 hover:text-white hover:bg-white/[0.08] rounded transition-colors" onClick={() => tagActions.moveToFront()} title="移到最前"><ArrowUp className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} /><span>置顶</span></button>
              <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-white/60 hover:text-white hover:bg-white/[0.08] rounded transition-colors" onClick={() => tagActions.toggleHide()} title="禁用/启用">
                {(() => { const firstIdx = Array.from(selectedTags).sort((a, b) => a - b)[0]; return parsedTags[firstIdx]?.trim().startsWith('~') ? <Eye className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} /> : <EyeOff className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />; })()}
                <span>{(() => { const firstIdx = Array.from(selectedTags).sort((a, b) => a - b)[0]; return parsedTags[firstIdx]?.trim().startsWith('~') ? '启用' : '禁用'; })()}</span>
              </button>
              <div className="flex-1" />
              <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-red-400/75 hover:text-red-300 hover:bg-red-500/15 rounded transition-colors" onClick={() => tagActions.deleteTag()} title="删除标签"><Trash2 className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} /><span>删除</span></button>
            </div>
            </div>
          </div>, document.body
        );
      })()}
    </div>
  );
};

export default DesktopChipEditor;
