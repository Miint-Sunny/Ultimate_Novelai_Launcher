import React, { useState, useRef, useEffect, useMemo } from 'react';
import { type TagSuggestion } from '../services/tagAutocomplete';
import { useDesktopContentHeight } from './desktop-chip-editor/useDesktopContentHeight';
import { useDesktopChipDrag } from './desktop-chip-editor/useDesktopChipDrag';
import { useDesktopChipInput } from './desktop-chip-editor/useDesktopChipInput';
import { useDesktopChipKeyboard } from './desktop-chip-editor/useDesktopChipKeyboard';
import { useDesktopChipSelection } from './desktop-chip-editor/useDesktopChipSelection';
import { useDesktopChipValue } from './desktop-chip-editor/useDesktopChipValue';
import { useDesktopFloatingPanelLifecycle } from './desktop-chip-editor/useDesktopFloatingPanelLifecycle';
import { useDesktopModifierKeys } from './desktop-chip-editor/useDesktopModifierKeys';
import { DesktopChipList } from './desktop-chip-editor/DesktopChipList';
import { DesktopMultiSelectPanel } from './desktop-chip-editor/DesktopMultiSelectPanel';
import { DesktopSuggestionDropdown } from './desktop-chip-editor/DesktopSuggestionDropdown';
import { DesktopTagQuickPanel } from './desktop-chip-editor/DesktopTagQuickPanel';
import { useDesktopSuggestionSelection } from './desktop-chip-editor/useDesktopSuggestionSelection';
import { useDesktopPanelActions, useDesktopTagActions } from './desktop-chip-editor/useDesktopTagActions';
import { useDesktopTagTranslations } from './desktop-chip-editor/useDesktopTagTranslations';
import { useDesktopWeightPresets } from './desktop-chip-editor/useDesktopWeightPresets';
import { SuggestionWikiPreviewCard } from './prompt-editor/SuggestionWikiPreviewCard';
import { useSuggestionWikiPreview } from './prompt-editor/useSuggestionWikiPreview';
import {
  splitPromptToTags,
  analyzeTagGroups,
} from '../utils/promptTags';

// ========== 提示词工具函数已抽取至 utils/promptTags（与移动端共享） ==========

// collapsible 芯片视觉已抽取至 tag-manager/markerVisual（与移动端共享）

interface DesktopChipEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  type?: 'prompt' | 'undesired';
  onContentHeightChange?: (height: number) => void;
  /** V5 文字渲染:输入落在未闭合引号内时不弹 Danbooru 补全。 */
  suppressAutocompleteInQuotes?: boolean;
}

export const DesktopChipEditor: React.FC<DesktopChipEditorProps> = ({
  value, onChange, placeholder = '输入标签，逗号分隔...', className = '', type = 'prompt', onContentHeightChange,
  suppressAutocompleteInQuotes = false,
}) => {
  const weightPresets = useDesktopWeightPresets();

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

  const [editingTag, setEditingTag] = useState<{ index: number; text: string; width: number; height: number } | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const { ctrlHeld, shiftHeld } = useDesktopModifierKeys();

  const { saveValue, rebuildValue, undoStackRef, isUndoingRef } = useDesktopChipValue({ value, onChange });
  const parsedTags = useMemo(() => splitPromptToTags(value), [value]);
  const tagGroups = useMemo(() => analyzeTagGroups(parsedTags), [parsedTags]);
  const { tagTranslations, translatingTags, setTagTranslations } = useDesktopTagTranslations(parsedTags);

  const {
    selectedTags,
    setSelectedTags,
    multiNumWeight,
    setMultiNumWeight,
    hasSelection,
    handleChipClick,
    handleChipDoubleClick,
    handleContainerClick,
  } = useDesktopChipSelection({
    parsedTags,
    tagTranslations,
    editingTag,
    tagPanel,
    chipRefsMap,
    chipClickTimeRef,
    inputRef,
    editInputRef,
    setEditingTag,
    setTagPanel,
  });

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

  const {
    inputText,
    setInputText,
    commitInput,
    triggerAutocomplete,
    handleInputChange,
    commitEdit,
    cancelEdit,
    handlePaste,
  } = useDesktopChipInput({
    value,
    parsedTags,
    editingTag,
    inputRef,
    editInputRef,
    saveValue,
    rebuildValue,
    setEditingTag,
    setSuggestionPos,
    setShowSuggestions,
    setSuggestions,
    setSelectedSuggIdx,
    suppressAutocompleteInQuotes,
  });

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

  const { handleInputKeyDown, handleContainerKeyDown } = useDesktopChipKeyboard({
    inputText,
    parsedTags,
    selectedTags,
    tagPanel,
    showSuggestions,
    displaySuggs,
    selectedSuggIdx,
    undoStackRef,
    isUndoingRef,
    selectSuggestion,
    commitInput,
    rebuildValue,
    saveValue,
    setSelectedSuggIdx,
    setSelectedTags,
    setShowSuggestions,
    setSuggestions,
    setTagPanel,
  });

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

  useDesktopContentHeight(value, chipContainerRef, onContentHeightChange);

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
      <DesktopChipList
        scrollRef={scrollRef}
        chipContainerRef={chipContainerRef}
        inputRef={inputRef}
        editInputRef={editInputRef}
        chipRefsMap={chipRefsMap}
        parsedTags={parsedTags}
        tagGroups={tagGroups}
        selectedTags={selectedTags}
        tagTranslations={tagTranslations}
        translatingTags={translatingTags}
        inputText={inputText}
        placeholder={placeholder}
        nlTranslating={nlTranslating}
        editingTag={editingTag}
        dragIndex={dragIndex}
        dragOverIndex={dragOverIndex}
        dragGhostInfo={dragGhostInfo}
        showSuggestions={showSuggestions}
        displaySuggs={displaySuggs}
        selectedSuggIdx={selectedSuggIdx}
        handleContainerClick={handleContainerClick}
        handleContainerDragOver={handleContainerDragOver}
        handleDragStart={handleDragStart}
        handleDragEnd={handleDragEnd}
        handleDragOver={handleDragOver}
        handleChipClick={handleChipClick}
        handleChipDoubleClick={handleChipDoubleClick}
        handleInputChange={handleInputChange}
        handleInputKeyDown={handleInputKeyDown}
        handlePaste={handlePaste}
        triggerAutocomplete={triggerAutocomplete}
        commitEdit={commitEdit}
        cancelEdit={cancelEdit}
        selectSuggestion={selectSuggestion}
        rebuildValue={rebuildValue}
        setEditingTag={setEditingTag}
        setSelectedSuggIdx={setSelectedSuggIdx}
        setShowSuggestions={setShowSuggestions}
        setSuggestions={setSuggestions}
      />

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
