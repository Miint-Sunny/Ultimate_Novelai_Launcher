import React, { useEffect, useCallback, useImperativeHandle, forwardRef, useRef, useState } from 'react';
import { EditorContent } from '@tiptap/react';
import { fetchWikiChineseNames, translateTagWithGemini, type TagSuggestion, cancelPendingAutocomplete } from '../services/tagAutocomplete';
import { getAppSettings } from '../services/localLibrary';
import { translateToNaturalLanguage } from '../services/translate';
import { docOffsetToTextIndex, parseValueToDocContent, textIndexToDocOffset } from './prompt-editor/documentMapping';
import {
  extractEditorContent,
  getEditorSelection,
  insertCollapsibleTag,
  removeCollapsibleTagsByType,
  replaceEditorSelection,
  setPlainTextSelection,
} from './prompt-editor/promptEditorCommands';
import { MultiSelectQuickPanel, type MultiSelectPanelState } from './prompt-editor/MultiSelectQuickPanel';
import { HoverTagTranslationOverlay, NaturalLanguageLoadingPortal, SelectedTagHighlight } from './prompt-editor/PromptEditorOverlays';
import { PromptEditorStyles } from './prompt-editor/PromptEditorStyles';
import { SuggestionDropdown } from './prompt-editor/SuggestionDropdown';
import { SuggestionWikiPreviewCard } from './prompt-editor/SuggestionWikiPreviewCard';
import { TagQuickPanel, type TagPanelState } from './prompt-editor/TagQuickPanel';
import { useMultiSelectActions } from './prompt-editor/useMultiSelectActions';
import { usePromptTipTapEditor } from './prompt-editor/usePromptTipTapEditor';
import { useSuggestionInputEvents } from './prompt-editor/useSuggestionInputEvents';
import { useSuggestionWikiPreview } from './prompt-editor/useSuggestionWikiPreview';
import { useTagPanelActions } from './prompt-editor/useTagPanelActions';
import { useTagHoverTranslation } from './prompt-editor/useTagHoverTranslation';
import type { CollapsibleTag, CollapsibleTagType } from './prompt-editor/types';
export type { CollapsibleTag, CollapsibleTagType } from './prompt-editor/types';

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

export interface PromptEditorRef {
  // 添加可折叠标签
  addCollapsibleTag: (tag: Omit<CollapsibleTag, 'id'>) => void;
  // 获取纯文本（展开所有标签）
  getPlainText: () => string;
  // 获取所有标签
  getTags: () => CollapsibleTag[];
  // 删除指定类型的所有标签
  removeTagsByType: (type: CollapsibleTagType) => void;
  // 聚焦编辑器
  focus: () => void;
  // 插入文本
  insertText: (text: string) => void;
  // 设置选区
  setSelection: (from: number, to: number) => void;
  // 获取当前选区文本和位置（移动端权重工具栏用）
  getSelection: () => { text: string; from: number; to: number } | null;
  // 替换选区文本（移动端权重工具栏用）
  replaceSelection: (text: string) => void;
  // 获取翻译缓存（移动端标签芯片用）
  getTranslationCache: () => Map<string, string>;
  // 设置翻译缓存
  setTranslationCache: (key: string, value: string) => void;
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
    const [numWeight, setNumWeight] = useState(1.0);
    const [translationLoading, setTranslationLoading] = useState(false);
    const isWeightUpdateRef = useRef(false); // 标记数字权重更新，跳过面板关闭
    const isPanelActionRef = useRef(false); // 标记面板操作引起的编辑，跳过补全触发

    // 多选面板（用户划词选择多个标签时触发）
    const [multiSelectPanel, setMultiSelectPanel] = useState<MultiSelectPanelState | null>(null);
    const multiSelectPanelRef = useRef<HTMLDivElement>(null);
    const [multiNumWeight, setMultiNumWeight] = useState(1.0);

    // 自然语言翻译加载状态
    const [nlTranslating, setNlTranslating] = useState<{ top: number; left: number } | null>(null);

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

    // 选择自动补全建议
    const selectSuggestion = useCallback((suggestion: TagSuggestion) => {
      if (!editor) return;

      // 标记刚刚选择了补全
      justSelectedRef.current = true;

      if (suggestion.isNaturalLanguage) {
        // 自然语言翻译：删除中文文本，显示浮层加载提示，翻译完成后插入
        const chineseText = currentWord;
        const insertPos = wordStart;
        editor.chain()
          .focus()
          .command(({ tr }) => {
            tr.delete(wordStart, wordStart + currentWord.length);
            return true;
          })
          .run();
        setShowSuggestions(false);
        setSuggestions([]);
        cancelPendingAutocomplete(); // 取消待执行的防抖回调
        // 在光标位置显示翻译中浮层
        setNlTranslating(cursorPosition);
        translateToNaturalLanguage(chineseText).then((translated) => {
          setNlTranslating(null);
          if (!editor) return;
          const result = translated && translated !== chineseText ? translated : chineseText;
          editor.chain()
            .focus()
            .command(({ tr }) => {
              tr.insertText(result, insertPos);
              return true;
            })
            .run();
        });
        return;
      }

      // 画师串：插入 <<artist:名称:内容>> 格式的标记
      if (suggestion.isArtist && suggestion.artistContent) {
        const artistMarker = `<<artist:${suggestion.label}:${suggestion.artistContent}>>`;
        editor.chain()
          .focus()
          .command(({ tr }) => {
            tr.delete(wordStart, wordStart + currentWord.length);
            tr.insertText(artistMarker, wordStart);
            return true;
          })
          .run();
        setShowSuggestions(false);
        setSuggestions([]);
        return;
      }

      // OC：以标签块形式插入
      if (suggestion.isOC && suggestion.ocContent) {
        const ocMarker = `<<oc:${suggestion.label}:${suggestion.ocContent}>>`;
        editor.chain()
          .focus()
          .command(({ tr }) => {
            tr.delete(wordStart, wordStart + currentWord.length);
            tr.insertText(ocMarker, wordStart);
            return true;
          })
          .run();
        setShowSuggestions(false);
        setSuggestions([]);
        return;
      }

      // 替换当前单词为选中的标签
      editor.chain()
        .focus()
        .command(({ tr }) => {
          tr.delete(wordStart, wordStart + currentWord.length);
          tr.insertText(suggestion.value, wordStart);
          return true;
        })
        .run();

      setShowSuggestions(false);
      setSuggestions([]);
    }, [editor, wordStart, currentWord]);

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

    // 点击外部关闭自动补全
    useEffect(() => {
      if (!showSuggestions) return;

      const handleClickOutside = (event: MouseEvent) => {
        const target = event.target as globalThis.Node;
        // Wiki 预览卡片是独立 portal，点击其中（如 Wiki 跳转链接）不应关闭补全，
        // 否则会触发清空 suggestionWikiPreview，使卡片在 click 派发前卸载、链接失效
        if (target instanceof Element && target.closest('.wiki-preview-floating')) return;
        if (
          suggestionsRef.current &&
          !suggestionsRef.current.contains(target)
        ) {
          setShowSuggestions(false);
        }
      };

      const handleScroll = (e: Event) => {
        // 忽略补全弹窗自身的滚动
        if (suggestionsRef.current && suggestionsRef.current.contains(e.target as globalThis.Node)) return;
        setShowSuggestions(false);
      };

      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('scroll', handleScroll, true);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
        document.removeEventListener('scroll', handleScroll, true);
      };
    }, [showSuggestions]);

    // 标签快捷面板 - 点击事件处理（移动端禁用）
    useEffect(() => {
      if (!editor || mobileMode) return;

      const editorDom = editor.view.dom;

      const handleClick = (e: MouseEvent) => {
        // 如果点击的是面板本身，不处理
        if (tagPanelRef.current?.contains(e.target as globalThis.Node)) return;
        if (multiSelectPanelRef.current?.contains(e.target as globalThis.Node)) return;

        // 如果有选区（划词），不触发单标签面板
        const { from: selFrom, to: selTo } = editor.state.selection;
        if (selTo - selFrom > 1) return;

        const pos = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
        if (!pos) { setTagPanel(null); return; }

        const $pos = editor.state.doc.resolve(pos.pos);
        const node = $pos.parent;
        if (!node.isTextblock) { setTagPanel(null); return; }

        const text = node.textContent;
        const offset = docOffsetToTextIndex(node, $pos.parentOffset);
        const nodeStart = $pos.start();

        // 找到当前位置所在的标签（以逗号分隔）
        let start = offset;
        let end = offset;
        while (start > 0 && text[start - 1] !== ',') start--;
        while (end < text.length && text[end] !== ',') end++;

        const rawTag = text.slice(start, end).trim();
        if (!rawTag || rawTag.length < 2 || rawTag.length > 80) { setTagPanel(null); return; }

        // 去掉权重符号得到纯标签名
        const cleanTag = rawTag.replace(/^\{+|\}+$|\[+|\]+$/g, '').replace(/_/g, ' ').trim();
        if (!cleanTag) { setTagPanel(null); return; }

        // 计算标签在文档中的绝对位置
        const tagStartInText = start + (text.slice(start, end).length - text.slice(start, end).trimStart().length);
        const tagEndInText = end - (text.slice(start, end).length - text.slice(start, end).trimEnd().length);
        const absoluteFrom = nodeStart + textIndexToDocOffset(node, tagStartInText);
        const absoluteTo = nodeStart + textIndexToDocOffset(node, tagEndInText);

        // Toggle：点击同一个标签时关闭面板
        if (tagPanel && tagPanel.from === absoluteFrom && tagPanel.to === absoluteTo) {
          setTagPanel(null);
          return;
        }

        // 获取翻译（从缓存）
        const cleanForCache = rawTag.replace(/^\{+|\}+$|\[+|\]+$/g, '').replace(/_/g, ' ').trim();
        const translation = translationCacheRef.current.get(cleanForCache) || '';

        // 获取标签底部坐标作为面板位置
        const coords = editor.view.coordsAtPos(absoluteFrom);

        // 清除 hover 状态和多选面板，避免冲突
        clearHoverTranslation();
        setMultiSelectPanel(null);

        setTagPanel({
          tag: cleanTag,
          rawTag,
          translation,
          from: absoluteFrom,
          to: absoluteTo,
          screenX: coords.left,
          screenY: coords.bottom + 4,
        });
      };

      editorDom.addEventListener('click', handleClick);
      return () => { editorDom.removeEventListener('click', handleClick); };
    }, [clearHoverTranslation, editor, tagPanel, mobileMode]);

    // 划词多选检测
    useEffect(() => {
      if (!editor || mobileMode) return;
      const editorDom = editor.view.dom;

      const handleMouseUp = () => {
        const { from, to } = editor.state.selection;
        if (to - from < 2) {
          setMultiSelectPanel(null);
          return;
        }
        // 获取选区文本
        const selectedText = editor.state.doc.textBetween(from, to, '\n', '');
        if (!selectedText.trim()) { setMultiSelectPanel(null); return; }

        // 计算扩展到完整标签边界的范围（向前找逗号/行首，向后找逗号/行尾）
        // 但不强制修改用户选区，仅在面板操作时使用扩展范围
        const $from = editor.state.doc.resolve(from);
        const $to = editor.state.doc.resolve(to);
        const fromText = $from.parent.textContent;
        const toText = $to.parent.textContent;
        const fromNodeStart = $from.start();
        const toNodeStart = $to.start();
        const fromLocal = docOffsetToTextIndex($from.parent, $from.parentOffset);
        const toLocal = docOffsetToTextIndex($to.parent, $to.parentOffset);

        // 向前扩展到标签开始
        let expandedFromLocal = fromLocal;
        while (expandedFromLocal > 0 && fromText[expandedFromLocal - 1] !== ',' && fromText[expandedFromLocal - 1] !== '，') expandedFromLocal--;
        const expandedFrom = fromNodeStart + textIndexToDocOffset($from.parent, expandedFromLocal);

        // 向后扩展到标签结束
        let expandedToLocal = toLocal;
        while (expandedToLocal < toText.length && toText[expandedToLocal] !== ',' && toText[expandedToLocal] !== '，') expandedToLocal++;
        const expandedTo = toNodeStart + textIndexToDocOffset($to.parent, expandedToLocal);

        const fullText = editor.state.doc.textBetween(expandedFrom, expandedTo, '\n', '');
        const tags = fullText.split(/[,，]/).filter(t => t.trim());
        if (tags.length < 2) { setMultiSelectPanel(null); return; }

        // 不强制扩选用户选区，面板操作时使用扩展范围
        const coords = editor.view.coordsAtPos(from);
        setTagPanel(null);
        setMultiSelectPanel({
          from: expandedFrom,
          to: expandedTo,
          text: fullText,
          tagCount: tags.length,
          screenX: coords.left,
          screenY: coords.bottom + 4,
        });
        setMultiNumWeight(1.0);
      };

      editorDom.addEventListener('mouseup', handleMouseUp);
      return () => { editorDom.removeEventListener('mouseup', handleMouseUp); };
    }, [editor, mobileMode]);

    // 点击外部关闭多选面板
    useEffect(() => {
      if (!multiSelectPanel || !editor) return;
      const handleClickOutside = (e: MouseEvent) => {
        if (multiSelectPanelRef.current?.contains(e.target as globalThis.Node)) return;
        if (editor.view.dom.contains(e.target as globalThis.Node)) return;
        setMultiSelectPanel(null);
      };
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [multiSelectPanel, editor]);

    // 面板打开时解析当前数字权重
    useEffect(() => {
      if (!tagPanel) return;
      const m = tagPanel.rawTag.match(/^(-?\d+(?:\.\d+)?)::/);
      setNumWeight(m ? parseFloat(m[1]) : 1.0);
    }, [tagPanel]);

    // 面板打开时异步加载翻译（如果缓存中没有）
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
          if (!translation) {
            translation = await translateTagWithGemini(queryTag) || '';
          }
          if (cancelled) return;
          if (translation) {
            translationCacheRef.current.set(tagPanel.tag, translation);
            setTagPanel(prev => prev && prev.from === tagPanel.from ? { ...prev, translation } : prev);
          }
        } catch { } finally {
          if (!cancelled) setTranslationLoading(false);
        }
      })();
      return () => { cancelled = true; };
    }, [tagPanel?.from, tagPanel?.tag, tagPanel?.translation]);

    // 点击面板外部关闭（排除编辑器内点击，编辑器内由 click handler 处理 toggle）
    useEffect(() => {
      if (!tagPanel || !editor) return;
      const handleClickOutside = (e: MouseEvent) => {
        if (tagPanelRef.current?.contains(e.target as globalThis.Node)) return;
        if (editor.view.dom.contains(e.target as globalThis.Node)) return;
        setTagPanel(null);
      };
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [tagPanel, editor]);

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

    // 同步外部 value 到编辑器
    // 解析 <<artist:...>> 等标记为芯片节点，实现芯片模式 ↔ 文本模式无损切换
    useEffect(() => {
      if (!editor) return;

      const { text: currentText } = extractEditorContent(editor);

      // 如果外部 value 与当前文本相同，不需要更新
      if (currentText === value) return;

      // 标记为程序设置值，跳过自动补全
      isProgrammaticUpdateRef.current = true;

      // 解析值中的标记为文档结构（包含芯片节点）
      const docContent = parseValueToDocContent(value || '');
      editor.commands.setContent(docContent);
    }, [value, editor]);

    // 暴露方法给父组件
    useImperativeHandle(ref, () => ({
      addCollapsibleTag: (tag) => {
        insertCollapsibleTag(editor, tag);
      },

      getPlainText: () => {
        const { text } = extractEditorContent(editor);
        return text;
      },

      getTags: () => {
        const { tags } = extractEditorContent(editor);
        return tags;
      },

      removeTagsByType: (type: CollapsibleTagType) => {
        removeCollapsibleTagsByType(editor, type);
      },

      focus: () => {
        editor?.commands.focus();
      },

      insertText: (text) => {
        editor?.commands.insertContent(text);
      },

      setSelection: (from, to) => {
        setPlainTextSelection(editor, from, to);
      },

      getSelection: () => {
        return getEditorSelection(editor);
      },

      replaceSelection: (text: string) => {
        replaceEditorSelection(editor, text);
      },

      getTranslationCache: () => {
        return translationCacheRef.current;
      },

      setTranslationCache: (key: string, value: string) => {
        translationCacheRef.current.set(key, value);
      },
    }), [editor, translationCacheRef]);

    // 内容高度变化通知：监听编辑器内容更新，测量实际内容高度
    // 不能用 ResizeObserver + scrollHeight，因为 ProseMirror 有 height:100%，
    // 手动拉大容器时 scrollHeight 跟着涨会产生虚假 delta
    useEffect(() => {
      if (!editor || !onContentHeightChange) return;
      const measureContent = () => {
        const el = editor.view.dom;
        const children = el.children;
        if (children.length === 0) return;
        const last = children[children.length - 1] as HTMLElement;
        // 实际内容高度 = 最后一个子元素底部 + padding
        onContentHeightChange(last.offsetTop + last.offsetHeight + 16);
      };
      editor.on('update', measureContent);
      requestAnimationFrame(measureContent);
      return () => { editor.off('update', measureContent); };
    }, [editor, onContentHeightChange]);

    // 原生滚轮处理，解决滚动到底部时外部接力的卡顿问题
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const handleWheel = (e: WheelEvent) => {
        const scrollable = (e.target as HTMLElement).closest('.ProseMirror') as HTMLElement;
        if (!scrollable) return;
        
        // 如果内容不足以出现滚动条（如空状态），交由原生处理，保证原生顺滑的整体滚动体验
        if (scrollable.scrollHeight <= scrollable.clientHeight) {
          return;
        }
        
        const isAtTop = scrollable.scrollTop <= 0;
        const isAtBottom = Math.ceil(scrollable.scrollTop + scrollable.clientHeight) >= scrollable.scrollHeight - 1;

        if ((isAtTop && e.deltaY < 0) || (isAtBottom && e.deltaY > 0)) {
          const outerScroll = scrollable.parentElement?.closest('.overflow-y-auto, .custom-scrollbar') as HTMLElement;
          if (outerScroll) {
            e.preventDefault();
            // 处理不同浏览器的滚动 delta 模式 (0: 像素, 1: 行, 2: 页)
            let delta = e.deltaY;
            if (e.deltaMode === 1) delta *= 40;
            else if (e.deltaMode === 2) delta *= outerScroll.clientHeight || 800;
            
            // 判断是否是来自触摸板或平滑滚轮鼠标的高频事件
            // (通常像素模式下 delta 值较小或为小数)
            const isTouchpad = e.deltaMode === 0 && (Math.abs(e.deltaY) < 50 || e.deltaY % 1 !== 0);
            
            // 使用浏览器的原生 scrollBy API：
            // 触摸板本就依靠高频细碎信号完成平滑物理效果，用 'auto' 性能最好；
            // 传统刻度滚轮给出的是瞬间的 100px 级大数值，必须激活 'smooth' 交由浏览器原生缓动（从而百分百复刻自然滚动速度）。
            outerScroll.scrollBy({ top: delta, behavior: isTouchpad ? 'auto' : 'smooth' });
          }
        }
      };

      // 必须使用 passive: false 才能有效防止默认行为且不产生卡顿和警告
      container.addEventListener('wheel', handleWheel, { passive: false });
      return () => container.removeEventListener('wheel', handleWheel);
    }, []);

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
