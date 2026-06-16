import React, { useEffect, useCallback, forwardRef, useRef, useState } from 'react';
import { EditorContent } from '@tiptap/react';
import type { TagSuggestion } from '../services/tagAutocomplete';
import { getAppSettings } from '../services/localLibrary';
import { MultiSelectQuickPanel, type MultiSelectPanelState } from './prompt-editor/MultiSelectQuickPanel';
import { HoverTagTranslationOverlay, NaturalLanguageLoadingPortal, SelectedTagHighlight } from './prompt-editor/PromptEditorOverlays';
import { PromptEditorStyles } from './prompt-editor/PromptEditorStyles';
import { SuggestionDropdown } from './prompt-editor/SuggestionDropdown';
import { SuggestionWikiPreviewCard } from './prompt-editor/SuggestionWikiPreviewCard';
import { TagQuickPanel, type TagPanelState } from './prompt-editor/TagQuickPanel';
import { useMultiSelectActions } from './prompt-editor/useMultiSelectActions';
import { usePromptEditorPanelEvents } from './prompt-editor/usePromptEditorPanelEvents';
import { usePromptEditorLifecycle } from './prompt-editor/usePromptEditorLifecycle';
import { usePromptTipTapEditor } from './prompt-editor/usePromptTipTapEditor';
import { useSuggestionDismissal } from './prompt-editor/useSuggestionDismissal';
import { useSuggestionInputEvents } from './prompt-editor/useSuggestionInputEvents';
import { useSuggestionSelection } from './prompt-editor/useSuggestionSelection';
import { useSuggestionWikiPreview } from './prompt-editor/useSuggestionWikiPreview';
import { useTagPanelActions } from './prompt-editor/useTagPanelActions';
import { useTagHoverTranslation } from './prompt-editor/useTagHoverTranslation';
import { useTagPanelState } from './prompt-editor/useTagPanelState';
import type { CollapsibleTag, PromptEditorRef } from './prompt-editor/types';
export type { CollapsibleTag, CollapsibleTagType, PromptEditorRef } from './prompt-editor/types';

interface PromptEditorProps {
  value?: string;
  onChange?: (value: string) => void;
  onTagsChange?: (tags: CollapsibleTag[]) => void;
  className?: string;
  containerClassName?: string;
  style?: React.CSSProperties;
  placeholder?: string;
  children?: React.ReactNode;
  /** 禁用可折叠标签功能（反向提示词、角色提示词等不需要） */
  disableCollapsibleTags?: boolean;
  /** 移动端模式：禁用 hover tooltip 和 click panel（移动端用独立的标签交互 UI） */
  mobileMode?: boolean;
  /** 内容高度变化回调 */
  onContentHeightChange?: (height: number) => void;
}

const PromptEditor = forwardRef<PromptEditorRef, PromptEditorProps>(
  ({ value = '', onChange, onTagsChange, className = '', containerClassName = '', style, placeholder, children, disableCollapsibleTags = false, mobileMode = false, onContentHeightChange }, ref) => {

    // 权重预设
    const [weightPresets, setWeightPresets] = useState(() => getAppSettings().weightPresets || [-1, 0.5, 0.8, 1.5, 2.0]);
    useEffect(() => {
      const sync = () => setWeightPresets(getAppSettings().weightPresets || [-1, 0.5, 0.8, 1.5, 2.0]);
      window.addEventListener('storage', sync);
      window.addEventListener('app-settings-changed', sync);
      return () => { window.removeEventListener('storage', sync); window.removeEventListener('app-settings-changed', sync); };
    }, []);

    // 自动补全状态
    const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [currentWord, setCurrentWord] = useState('');
    const [wordStart, setWordStart] = useState(0);
    const [cursorPosition, setCursorPosition] = useState<{ top: number; left: number } | null>(null);
    const suggestionsRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const justSelectedRef = useRef(false); // 标记刚刚选择了补全，跳过下一次检测
    const isComposingRef = useRef(false); // 标记输入法是否正在组合中
    const isProgrammaticUpdateRef = useRef(false); // 标记是否是程序设置值（非用户输入）
    const suggestionScrollLockRef = useRef(false); // 鼠标 hover 改变 selectedIndex 时不触发 scrollIntoView

    // 标签快捷面板（点击触发）
    const [tagPanel, setTagPanel] = useState<TagPanelState | null>(null);
    const tagPanelRef = useRef<HTMLDivElement>(null);
    const isWeightUpdateRef = useRef(false); // 标记数字权重更新，跳过面板关闭
    const isPanelActionRef = useRef(false); // 标记面板操作引起的编辑，跳过补全触发

    // 多选面板（用户划词选择多个标签时触发）
    const [multiSelectPanel, setMultiSelectPanel] = useState<MultiSelectPanelState | null>(null);
    const multiSelectPanelRef = useRef<HTMLDivElement>(null);
    const [multiNumWeight, setMultiNumWeight] = useState(1.0);

    const editor = usePromptTipTapEditor({
      className,
      placeholder,
      disableCollapsibleTags,
      onChange,
      onTagsChange,
      isProgrammaticUpdateRef,
      justSelectedRef,
      isWeightUpdateRef,
      isPanelActionRef,
      isComposingRef,
      setSuggestions,
      setShowSuggestions,
      setSelectedIndex,
      setCurrentWord,
      setWordStart,
      setCursorPosition,
      setTagPanel,
      setMultiSelectPanel,
    });
    const {
      tagTooltip,
      hoverTagRange,
      isLoadingTranslation,
      translationCacheRef,
      clearHoverTranslation,
    } = useTagHoverTranslation({ editor, mobileMode });

    // tagAutocomplete.reorderByConfig 已在服务层按设置里的源顺序/数量排好，这里直接透传
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

    // displaySuggs 变化时约束 selectedIndex
    useEffect(() => {
      if (displaySuggs.length > 0) {
        setSelectedIndex(prev => Math.min(prev, displaySuggs.length - 1));
      }
    }, [displaySuggs]);

    const { nlTranslating, selectSuggestion } = useSuggestionSelection({
      editor,
      currentWord,
      wordStart,
      cursorPosition,
      justSelectedRef,
      setSuggestions,
      setShowSuggestions,
    });

    useSuggestionInputEvents({
      editor,
      suggestions: displaySuggs,
      showSuggestions,
      selectedIndex,
      suggestionsRef,
      suggestionScrollLockRef,
      isComposingRef,
      onSelectSuggestion: selectSuggestion,
      setSuggestions,
      setShowSuggestions,
      setSelectedIndex,
      setCurrentWord,
      setWordStart,
      setCursorPosition,
    });

    useSuggestionDismissal({
      showSuggestions,
      suggestionsRef,
      setShowSuggestions,
    });

    usePromptEditorPanelEvents({
      editor,
      mobileMode,
      tagPanel,
      setTagPanel,
      tagPanelRef,
      multiSelectPanel,
      setMultiSelectPanel,
      multiSelectPanelRef,
      setMultiNumWeight,
      translationCacheRef,
      clearHoverTranslation,
    });
    const {
      numWeight,
      setNumWeight,
      translationLoading,
    } = useTagPanelState({
      panel: tagPanel,
      setPanel: setTagPanel,
      translationCacheRef,
    });

    const {
      actions: panelActions,
      existingTagSet: tagPanelExistingTagSet,
      addRelatedTag: handleAddRelatedTag,
      markPanelAction,
    } = useTagPanelActions({
      editor,
      panel: tagPanel,
      setPanel: setTagPanel,
      isPanelActionRef,
      isWeightUpdateRef,
    });

    const multiSelectActions = useMultiSelectActions({
      editor,
      panel: multiSelectPanel,
      setPanel: setMultiSelectPanel,
      markPanelAction,
    });
    usePromptEditorLifecycle({
      ref,
      editor,
      value,
      containerRef,
      isProgrammaticUpdateRef,
      translationCacheRef,
      onContentHeightChange,
    });

    return (
      <div ref={containerRef} className={`relative prompt-editor-wrapper ${containerClassName}`} style={style}>
        <PromptEditorStyles />

        <EditorContent
          editor={editor}
          className="h-full scrollbar-hide"
        />

        {showSuggestions && (
          <SuggestionDropdown
            suggestions={displaySuggs}
            selectedIndex={selectedIndex}
            cursorPosition={cursorPosition}
            suggestionWikiMap={suggestionWikiMap}
            suggestionsRef={suggestionsRef}
            onSelect={selectSuggestion}
            onHighlight={(index) => {
              suggestionScrollLockRef.current = true;
              setSelectedIndex(prev => prev === index ? prev : index);
            }}
            onShowWikiPreview={(suggestion, anchor, showLoading) => {
              showSuggestionWikiPreview(suggestion, anchor, 100, showLoading);
            }}
            onHideWikiPreview={() => hideSuggestionWikiPreview()}
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

        <NaturalLanguageLoadingPortal position={nlTranslating} />

        <HoverTagTranslationOverlay
          editor={editor}
          containerRef={containerRef}
          hoverTagRange={hoverTagRange}
          tagPanelOpen={Boolean(tagPanel)}
          tagTooltip={tagTooltip}
          isLoadingTranslation={isLoadingTranslation}
        />

        <SelectedTagHighlight
          editor={editor}
          containerRef={containerRef}
          tagPanel={tagPanel}
        />

        <TagQuickPanel
          panel={tagPanel}
          panelRef={tagPanelRef}
          weightPresets={weightPresets}
          numWeight={numWeight}
          setNumWeight={setNumWeight}
          translationLoading={translationLoading}
          actions={panelActions}
          existingTagSet={tagPanelExistingTagSet}
          onAddRelatedTag={handleAddRelatedTag}
          onClose={() => setTagPanel(null)}
        />

        <MultiSelectQuickPanel
          panel={multiSelectPanel}
          panelRef={multiSelectPanelRef}
          weightPresets={weightPresets}
          numWeight={multiNumWeight}
          setNumWeight={setMultiNumWeight}
          actions={multiSelectActions}
          onClose={() => setMultiSelectPanel(null)}
        />

        {children && (
          <div className="absolute inset-0 z-20 pointer-events-none [&>*]:pointer-events-auto">
            {children}
          </div>
        )}
      </div>
    );
  }
);

PromptEditor.displayName = 'PromptEditor';

export default PromptEditor;


// ============================================
// SimplePromptEditor - 基于 TipTap 的简化版编辑器
// 不支持可折叠标签，保持导出兼容性
// ============================================

interface SimplePromptEditorProps {
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onValueChange?: (newValue: string) => void;
  className?: string;
  containerClassName?: string;
  style?: React.CSSProperties;
  placeholder?: string;
  children?: React.ReactNode;
  enableHoverTranslate?: boolean;
  enableAutocomplete?: boolean;
  disabled?: boolean;
}

/**
 * @deprecated 请直接使用 PromptEditor + disableCollapsibleTags 代替
 */
export const SimplePromptEditor = forwardRef<PromptEditorRef, SimplePromptEditorProps>(
  ({ value, onValueChange, className, containerClassName, style, placeholder, children }, ref) => {
    const handleChange = useCallback((text: string) => {
      onValueChange?.(text);
    }, [onValueChange]);

    return (
      <PromptEditor
        ref={ref}
        disableCollapsibleTags
        value={String(value || '')}
        onChange={handleChange}
        className={className}
        containerClassName={containerClassName}
        style={style}
        placeholder={placeholder}
      >
        {children}
      </PromptEditor>
    );
  }
);

SimplePromptEditor.displayName = 'SimplePromptEditor';
