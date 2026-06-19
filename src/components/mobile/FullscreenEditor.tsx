import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  NEWLINE_SENTINEL,
  splitPromptToTags,
  isCollapsibleMarker,
  parseCollapsibleMarker,
  cleanTagName,
  getTagWeightInfo,
  detectAbnormalWeight,
  isSDWeightFormat,
  analyzeTagGroups,
  getEffectiveWeight,
  getWeightStyle,
} from '../../utils/promptTags';
import { getMarkerVisual } from '../tag-manager/markerVisual';
import { getAppSettings } from '../../services/localLibrary';
import {
  getTagSuggestionsDebounced,
  type TagSuggestion,
} from '../../services/tagAutocomplete';
import { EditorToolbar } from './fullscreen-editor/EditorToolbar';
import { SelectedTagPanel } from './fullscreen-editor/SelectedTagPanel';
import { SuggestionStrip } from './fullscreen-editor/SuggestionStrip';
import { useChipDragSort } from './fullscreen-editor/useChipDragSort';
import { useFullscreenTagActions } from './fullscreen-editor/useFullscreenTagActions';
import { useFullscreenTagTranslations } from './fullscreen-editor/useFullscreenTagTranslations';
import { useFullscreenWiki } from './fullscreen-editor/useFullscreenWiki';
import { useFullscreenOpenLifecycle } from './fullscreen-editor/useFullscreenOpenLifecycle';
import { useFullscreenUndoValue } from './fullscreen-editor/useFullscreenUndoValue';
import { useFullscreenViewportHeight } from './fullscreen-editor/useFullscreenViewportHeight';
import { useSuggestionSelection } from './fullscreen-editor/useSuggestionSelection';
import { WikiPreviewSheet } from './fullscreen-editor/WikiPreviewSheet';

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

export const FullscreenEditor: React.FC<FullscreenEditorProps> = ({
  isOpen, onClose, type, value, onChange, presetTokens = 0, totalTokens = 0,
}) => {
  const viewportHeight = useFullscreenViewportHeight(isOpen);

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
  // 补全选中后短暂屏蔽芯片点击
  const suppressChipClickRef = useRef(false);
  // 标签编辑状态
  const [editingTagText, setEditingTagText] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const clearSelection = useCallback(() => setSelectedTags(new Set()), []);
  const clearEditing = useCallback(() => setEditingTagText(null), []);

  useFullscreenOpenLifecycle({
    isOpen,
    inputRef,
    clearSelection,
    clearEditing,
  });

  const { saveValue, handleUndo, undoDepth } = useFullscreenUndoValue({
    isOpen,
    type,
    value,
    onChange,
    clearSelection,
    clearEditing,
  });

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
  const { tagTranslations, setTagTranslations, translatingTags } = useFullscreenTagTranslations(parsedTags);

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

  const {
    dragState,
    isDragging,
    dragGhost,
    dragOverIndex,
    chipRefsMap,
    handleChipTouchStart,
    handleChipTouchMove,
    handleChipTouchEnd,
  } = useChipDragSort({
    parsedTags,
    tagTranslations,
    scrollRef,
    rebuildValue,
    onClearSelection: () => setSelectedTags(new Set()),
  });

  // 分析权重组
  const tagGroups = useMemo(() => analyzeTagGroups(parsedTags), [parsedTags]);

  // 选中标签越界校正
  useEffect(() => {
    if (selectedTags.size === 0) return;
    const valid = new Set<number>();
    selectedTags.forEach(i => { if (i < parsedTags.length) valid.add(i); });
    if (valid.size !== selectedTags.size) setSelectedTags(valid);
  }, [parsedTags.length, selectedTags]);

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

  const selectSuggestion = useSuggestionSelection({
    rawMode,
    value,
    inputText,
    editingTagText,
    selectedTags,
    parsedTags,
    tagTranslations,
    textareaRef,
    suppressChipClickRef,
    saveValue,
    commitInput,
    rebuildValue,
    setInputText,
    setShowSuggestions,
    setSuggestions,
    setNlTranslating,
    setSelectedTags,
    setEditingTagText,
    setTagTranslations,
  });

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

  const { tagActions, currentNumericWeight } = useFullscreenTagActions({
    parsedTags,
    selectedTags,
    tagGroups,
    rebuildValue,
    setSelectedTags,
  });

  const {
    selectedPostCount,
    wikiPreview,
    wikiImageIndex,
    setWikiImageIndex,
    setWikiPreview,
    singleCleanTag,
    openWikiPreview,
  } = useFullscreenWiki({ selectedTags, parsedTags });

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

      <SuggestionStrip
        showSuggestions={showSuggestions}
        suggestions={suggestions}
        selectedSuggIdx={selectedSuggIdx}
        hasSelection={hasSelection}
        editingTagText={editingTagText}
        onCommitInput={commitInput}
        onSelectSuggestion={selectSuggestion}
      />

      <SelectedTagPanel
        rawMode={rawMode}
        hasSelection={hasSelection}
        selectedTags={selectedTags}
        parsedTags={parsedTags}
        tagGroups={tagGroups}
        selectedTag={selectedTag}
        editingTagText={editingTagText}
        selectedPostCount={selectedPostCount}
        singleCleanTag={singleCleanTag}
        currentNumericWeight={currentNumericWeight}
        weightPresets={weightPresets}
        tagTranslations={tagTranslations}
        tagActions={tagActions}
        editInputRef={editInputRef}
        onEditingTagTextChange={setEditingTagText}
        onTriggerAutocomplete={triggerAutocomplete}
        onCommitTagEdit={commitTagEdit}
        onCancelTagEdit={cancelTagEdit}
        onOpenWikiPreview={openWikiPreview}
        onRebuildValue={rebuildValue}
        onSelectedTagsChange={setSelectedTags}
      />

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
