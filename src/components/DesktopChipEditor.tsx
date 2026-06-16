import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Plus } from 'lucide-react';
import { getTagSuggestionsDebounced, fetchWikiChineseNames, type TagSuggestion, getTranslationCacheSnapshot, setTranslationCacheEntries, lookupCharacterChineseName } from '../services/tagAutocomplete';
import { translateSegments } from '../services/translate';
import { getAppSettings } from '../services/localLibrary';
import { useDesktopChipDrag } from './desktop-chip-editor/useDesktopChipDrag';
import { useDesktopFloatingPanelLifecycle } from './desktop-chip-editor/useDesktopFloatingPanelLifecycle';
import { DesktopInlineTagEditor } from './desktop-chip-editor/DesktopInlineTagEditor';
import { DesktopMultiSelectPanel } from './desktop-chip-editor/DesktopMultiSelectPanel';
import { DesktopMarkerChip, DesktopTagChip } from './desktop-chip-editor/DesktopPromptChips';
import { DesktopSuggestionDropdown } from './desktop-chip-editor/DesktopSuggestionDropdown';
import { DesktopTagQuickPanel } from './desktop-chip-editor/DesktopTagQuickPanel';
import { useDesktopSuggestionSelection } from './desktop-chip-editor/useDesktopSuggestionSelection';
import { useDesktopPanelActions, useDesktopTagActions } from './desktop-chip-editor/useDesktopTagActions';
import { SuggestionWikiPreviewCard } from './prompt-editor/SuggestionWikiPreviewCard';
import { useSuggestionWikiPreview } from './prompt-editor/useSuggestionWikiPreview';
import {
  NEWLINE_SENTINEL, isCollapsibleMarker, parseCollapsibleMarker, splitPromptToTags,
  cleanTagName, getTagWeightInfo,
  analyzeTagGroups,
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

  // 芯片点击防抖：防止点击芯片引发的布局重排触发 scroll 事件关闭面板
  const chipClickTimeRef = useRef<number>(0);

  // 撤回栈：所有修改操作自动入栈
  const undoStackRef = useRef<string[]>([]);
  const isUndoingRef = useRef(false);

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

  const {
    dragIndex,
    dragOverIndex,
    dragGhostInfo,
    handleDragStart,
    handleDragEnd,
    handleDragOver,
    handleContainerDragOver,
  } = useDesktopChipDrag({
    parsedTags,
    tagTranslations,
    scrollRef,
    rebuildValue,
    setSelectedTags,
  });

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

  const { translationLoading, tagPanelPostCount } = useDesktopFloatingPanelLifecycle({
    tagPanel,
    tagPanelRef,
    scrollRef,
    suggestionsRef,
    inputRef,
    chipRefsMap,
    chipClickTimeRef,
    parsedTags,
    tagTranslations,
    showSuggestions,
    setNumWeight,
    setTagPanel,
    setSelectedTags,
    setTagTranslations,
    setShowSuggestions,
    setSuggestions,
  });

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
              return (
                <React.Fragment key={index}>
                  {insertBtn}
                  {dropPlaceholder}
                  <DesktopMarkerChip
                    index={index}
                    markerInfo={markerInfo}
                    isSelected={selectedTags.has(index)}
                    chipRefsMap={chipRefsMap}
                    dragIndex={dragIndex}
                    handleDragStart={handleDragStart}
                    handleDragEnd={handleDragEnd}
                    handleDragOver={handleDragOver}
                    handleChipClick={handleChipClick}
                    handleChipDoubleClick={handleChipDoubleClick}
                  />
                </React.Fragment>
              );
            }
            // 双击编辑模式：渲染内联输入框
            if (editingTag && editingTag.index === index) {
              return (
                <React.Fragment key={index}>
                  {insertBtn}
                  {dropPlaceholder}
                  <DesktopInlineTagEditor
                    index={index}
                    editingTag={editingTag}
                    editInputRef={editInputRef}
                    showSuggestions={showSuggestions}
                    displaySuggs={displaySuggs}
                    selectedSuggIdx={selectedSuggIdx}
                    setSelectedSuggIdx={setSelectedSuggIdx}
                    selectSuggestion={selectSuggestion}
                    triggerAutocomplete={triggerAutocomplete}
                    commitEdit={commitEdit}
                    cancelEdit={cancelEdit}
                    setEditingTag={setEditingTag}
                    setShowSuggestions={setShowSuggestions}
                    setSuggestions={setSuggestions}
                  />
                </React.Fragment>
              );
            }
            return (
              <React.Fragment key={index}>
                {insertBtn}
                {dropPlaceholder}
                <DesktopTagChip
                  index={index}
                  rawTag={rawTag}
                  group={tagGroups[index]}
                  parsedTags={parsedTags}
                  tagGroups={tagGroups}
                  selectedTags={selectedTags}
                  tagTranslations={tagTranslations}
                  translatingTags={translatingTags}
                  chipRefsMap={chipRefsMap}
                  dragIndex={dragIndex}
                  handleDragStart={handleDragStart}
                  handleDragEnd={handleDragEnd}
                  handleDragOver={handleDragOver}
                  handleChipClick={handleChipClick}
                  handleChipDoubleClick={handleChipDoubleClick}
                />
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

      {tagPanel && !ctrlHeld && !shiftHeld && (
        <DesktopTagQuickPanel
          tagPanel={tagPanel}
          tagPanelRef={tagPanelRef}
          chipRefsMap={chipRefsMap}
          parsedTags={parsedTags}
          tagPanelPostCount={tagPanelPostCount}
          translationLoading={translationLoading}
          weightPresets={weightPresets}
          numWeight={numWeight}
          panelActions={panelActions}
          rebuildValue={rebuildValue}
          setNumWeight={setNumWeight}
          setSelectedTags={setSelectedTags}
          setTagPanel={setTagPanel}
          setEditingTag={setEditingTag}
        />
      )}

      {hasSelection && selectedTags.size >= 2 && !ctrlHeld && !shiftHeld && (
        <DesktopMultiSelectPanel
          selectedTags={selectedTags}
          chipRefsMap={chipRefsMap}
          parsedTags={parsedTags}
          weightPresets={weightPresets}
          multiNumWeight={multiNumWeight}
          tagActions={tagActions}
          rebuildValue={rebuildValue}
          setMultiNumWeight={setMultiNumWeight}
          setSelectedTags={setSelectedTags}
        />
      )}
    </div>
  );
};

export default DesktopChipEditor;
