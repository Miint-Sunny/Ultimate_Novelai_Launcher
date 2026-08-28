import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  NEWLINE_SENTINEL,
  splitPromptToTags,
  parseCollapsibleMarker,
  analyzeTagGroups,
} from '../../utils/promptTags';
import { getAppSettings } from '../../services/localLibrary';
import { EditorToolbar } from './fullscreen-editor/EditorToolbar';
import { FullscreenChipEditorArea } from './fullscreen-editor/FullscreenChipEditorArea';
import { FullscreenRawTextEditor } from './fullscreen-editor/FullscreenRawTextEditor';
import { NaturalLanguageLoadingPill } from './fullscreen-editor/NaturalLanguageLoadingPill';
import { SelectedTagPanel } from './fullscreen-editor/SelectedTagPanel';
import { SuggestionStrip } from './fullscreen-editor/SuggestionStrip';
import { useChipDragSort } from './fullscreen-editor/useChipDragSort';
import { useFullscreenInputWorkflow } from './fullscreen-editor/useFullscreenInputWorkflow';
import { useFullscreenTagActions } from './fullscreen-editor/useFullscreenTagActions';
import { useFullscreenTagTranslations } from './fullscreen-editor/useFullscreenTagTranslations';
import { useFullscreenWiki } from './fullscreen-editor/useFullscreenWiki';
import { useFullscreenOpenLifecycle } from './fullscreen-editor/useFullscreenOpenLifecycle';
import { useFullscreenTagEditing } from './fullscreen-editor/useFullscreenTagEditing';
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
  /** 当前模型的 token 软阈值。 */
  maxTokens: number;
  isOpen: boolean;
  onClose: () => void;
  type: 'prompt' | 'undesired';
  value: string;
  onChange: (value: string) => void;
  presetTokens?: number;
  totalTokens?: number;
}

export const FullscreenEditor: React.FC<FullscreenEditorProps> = ({
  maxTokens,
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
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 布局模式：芯片 vs 纯文本
  const [rawMode, setRawMode] = useState(false);
  const [nlTranslating, setNlTranslating] = useState(false);
  // 补全选中后短暂屏蔽芯片点击
  const suppressChipClickRef = useRef(false);
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

  const {
    inputText,
    setInputText,
    suggestions,
    setSuggestions,
    showSuggestions,
    setShowSuggestions,
    selectedSuggIdx,
    commitInput,
    triggerAutocomplete,
    handleInputChange,
    handlePaste,
    handleInputKeyDown,
  } = useFullscreenInputWorkflow({
    value,
    parsedTags,
    saveValue,
    rebuildValue,
    scrollToBottom,
  });

  const clearSuggestions = useCallback(() => {
    setShowSuggestions(false);
    setSuggestions([]);
  }, [setShowSuggestions, setSuggestions]);

  const {
    commitTagEdit,
    cancelTagEdit,
  } = useFullscreenTagEditing({
    editingTagText,
    setEditingTagText,
    selectedTags,
    parsedTags,
    rebuildValue,
    setSelectedTags,
    clearSuggestions,
  });

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
        <FullscreenRawTextEditor
          type={type}
          value={value}
          textareaRef={textareaRef}
          onSaveValue={saveValue}
          onTriggerAutocomplete={triggerAutocomplete}
        />
      ) : (
        <FullscreenChipEditorArea
          type={type}
          parsedTags={parsedTags}
          tagGroups={tagGroups}
          tagTranslations={tagTranslations}
          translatingTags={translatingTags}
          selectedTags={selectedTags}
          onSelectedTagsChange={setSelectedTags}
          inputRef={inputRef}
          scrollRef={scrollRef}
          inputText={inputText}
          onInputChange={handleInputChange}
          onInputKeyDown={handleInputKeyDown}
          onPaste={handlePaste}
          onInputFocus={scrollToBottom}
          isDragging={isDragging}
          dragState={dragState}
          dragGhost={dragGhost}
          dragOverIndex={dragOverIndex}
          chipRefsMap={chipRefsMap}
          handleChipTouchStart={handleChipTouchStart}
          handleChipTouchMove={handleChipTouchMove}
          handleChipTouchEnd={handleChipTouchEnd}
          suppressChipClickRef={suppressChipClickRef}
        />
      )}

      <NaturalLanguageLoadingPill isVisible={nlTranslating && !showSuggestions} />

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
        maxTokens={maxTokens}
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
