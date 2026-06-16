import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { fetchWikiChineseNames, translateTagWithGemini } from '../../services/tagAutocomplete';
import { docOffsetToTextIndex, textIndexToDocOffset } from './documentMapping';

interface TextRange {
  from: number;
  to: number;
}

interface TagTooltipState extends TextRange {
  tag: string;
  translation: string;
}

interface UseTagHoverTranslationParams {
  editor: Editor | null;
  mobileMode: boolean;
}

export function useTagHoverTranslation({ editor, mobileMode }: UseTagHoverTranslationParams) {
  const [tagTooltip, setTagTooltip] = useState<TagTooltipState | null>(null);
  const [hoverTagRange, setHoverTagRange] = useState<TextRange | null>(null);
  const [isLoadingTranslation, setIsLoadingTranslation] = useState(false);
  const translationCacheRef = useRef<Map<string, string>>(new Map());
  const tooltipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentTagRef = useRef('');

  const clearHoverTranslation = useCallback(() => {
    if (tooltipTimeoutRef.current) {
      clearTimeout(tooltipTimeoutRef.current);
      tooltipTimeoutRef.current = null;
    }
    currentTagRef.current = '';
    setTagTooltip(null);
    setHoverTagRange(null);
    setIsLoadingTranslation(false);
  }, []);

  useEffect(() => {
    if (!editor || mobileMode) return;

    const editorDom = editor.view.dom;

    const handleMouseMove = (e: MouseEvent) => {
      const pos = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (!pos) {
        clearHoverTranslation();
        return;
      }

      const $pos = editor.state.doc.resolve(pos.pos);
      const node = $pos.parent;

      if (!node.isTextblock) {
        clearHoverTranslation();
        return;
      }

      const text = node.textContent;
      const offset = docOffsetToTextIndex(node, $pos.parentOffset);
      const nodeStart = $pos.start();

      let start = offset;
      let end = offset;
      while (start > 0 && text[start - 1] !== ',') {
        start--;
      }
      while (end < text.length && text[end] !== ',') {
        end++;
      }

      const tag = text.slice(start, end).trim();
      const tagText = text.slice(start, end);
      const tagStartInText = start + (tagText.length - tagText.trimStart().length);
      const tagEndInText = end - (tagText.length - tagText.trimEnd().length);
      const absoluteFrom = nodeStart + textIndexToDocOffset(node, tagStartInText);
      const absoluteTo = nodeStart + textIndexToDocOffset(node, tagEndInText);

      if (!tag || tag.length < 2 || tag.length > 50 || /[\u4e00-\u9fa5]/.test(tag)) {
        clearHoverTranslation();
        return;
      }

      const cleanTag = tag.replace(/^\{+|\}+$|\[+|\]+$/g, '').replace(/_/g, ' ').trim();
      if (!cleanTag) {
        clearHoverTranslation();
        return;
      }

      if (cleanTag === currentTagRef.current) {
        return;
      }

      if (tooltipTimeoutRef.current) {
        clearTimeout(tooltipTimeoutRef.current);
        tooltipTimeoutRef.current = null;
      }
      currentTagRef.current = cleanTag;

      setHoverTagRange({ from: absoluteFrom, to: absoluteTo });

      const cached = translationCacheRef.current.get(cleanTag);
      if (cached) {
        setTagTooltip({ tag: cleanTag, translation: cached, from: absoluteFrom, to: absoluteTo });
        setIsLoadingTranslation(false);
        return;
      }

      setTagTooltip(null);
      setIsLoadingTranslation(true);

      const tagToFetch = cleanTag;
      const rangeFrom = absoluteFrom;
      const rangeTo = absoluteTo;

      tooltipTimeoutRef.current = setTimeout(async () => {
        if (currentTagRef.current !== tagToFetch) return;

        try {
          const queryTag = tagToFetch.replace(/ /g, '_');
          const result = await fetchWikiChineseNames([queryTag]);

          if (currentTagRef.current !== tagToFetch) return;

          const translation = result[queryTag]?.[0];
          if (translation) {
            translationCacheRef.current.set(tagToFetch, translation);
            setTagTooltip({ tag: tagToFetch, translation, from: rangeFrom, to: rangeTo });
            setIsLoadingTranslation(false);
            return;
          }

          const geminiTranslation = await translateTagWithGemini(tagToFetch);
          if (currentTagRef.current !== tagToFetch) return;

          if (geminiTranslation) {
            translationCacheRef.current.set(tagToFetch, geminiTranslation);
            setTagTooltip({ tag: tagToFetch, translation: geminiTranslation, from: rangeFrom, to: rangeTo });
          }
          setIsLoadingTranslation(false);
        } catch {
          setIsLoadingTranslation(false);
        }
      }, 100);
    };

    editorDom.addEventListener('mousemove', handleMouseMove);
    editorDom.addEventListener('mouseleave', clearHoverTranslation);

    return () => {
      editorDom.removeEventListener('mousemove', handleMouseMove);
      editorDom.removeEventListener('mouseleave', clearHoverTranslation);
      if (tooltipTimeoutRef.current) {
        clearTimeout(tooltipTimeoutRef.current);
      }
    };
  }, [clearHoverTranslation, editor, mobileMode]);

  return {
    tagTooltip,
    hoverTagRange,
    isLoadingTranslation,
    translationCacheRef,
    clearHoverTranslation,
  };
}
