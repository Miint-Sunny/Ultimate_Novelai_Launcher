import type { CSSProperties, RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import type { TagPanelState } from './TagQuickPanel';

interface ScreenPosition {
  top: number;
  left: number;
}

interface TextRange {
  from: number;
  to: number;
}

interface TagTooltipState extends TextRange {
  tag: string;
  translation: string;
}

export function NaturalLanguageLoadingPortal({ position }: { position: ScreenPosition | null }) {
  if (!position) return null;

  return createPortal(
    <div className="fixed z-[99999] flex items-center gap-1.5 px-3 py-1.5 bg-[#1a1a1a]/90 backdrop-blur-md rounded-lg shadow-lg border border-cyan-500/20"
      style={{ top: position.top + 4, left: position.left }}>
      <span className="inline-block w-3 h-3 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
      <span className="text-xs text-cyan-200/80">翻译中...</span>
    </div>,
    document.body,
  );
}

interface HoverTagTranslationOverlayProps {
  editor: Editor | null;
  containerRef: RefObject<HTMLDivElement | null>;
  hoverTagRange: TextRange | null;
  tagPanelOpen: boolean;
  tagTooltip: TagTooltipState | null;
  isLoadingTranslation: boolean;
}

export function HoverTagTranslationOverlay({
  editor,
  containerRef,
  hoverTagRange,
  tagPanelOpen,
  tagTooltip,
  isLoadingTranslation,
}: HoverTagTranslationOverlayProps) {
  if (!editor || !hoverTagRange || tagPanelOpen) return null;

  const docSize = editor.state.doc.content.size;
  if (hoverTagRange.from < 0 || hoverTagRange.to > docSize) return null;

  try {
    const startCoords = editor.view.coordsAtPos(hoverTagRange.from);
    const endCoords = editor.view.coordsAtPos(hoverTagRange.to);
    const editorRect = containerRef.current?.getBoundingClientRect();
    if (!editorRect) return null;

    const isMultiLine = Math.abs(startCoords.top - endCoords.top) > 5;
    const underlineStyle: CSSProperties = {
      height: 0,
      borderBottom: '1.5px dashed rgba(252, 237, 164, 0.6)',
      pointerEvents: 'none',
      position: 'absolute',
    };

    const renderTooltip = (anchorLeft: number, anchorBottom: number) => (
      tagTooltip ? (
        <div className="absolute pointer-events-none z-30" style={{ left: anchorLeft, top: anchorBottom + 4 }}>
          <div className="px-2 py-1 bg-[#1a1a2e]/95 text-[#fceda4]/90 text-xs rounded shadow-md whitespace-nowrap border border-[#fceda4]/15">{tagTooltip.translation}</div>
        </div>
      ) : isLoadingTranslation ? (
        <div className="absolute pointer-events-none z-30" style={{ left: anchorLeft, top: anchorBottom + 4 }}>
          <div className="px-2 py-1 bg-[#1a1a2e]/95 text-[#fceda4]/90 text-xs rounded shadow-md whitespace-nowrap flex items-center border border-[#fceda4]/15">
            <span className="inline-block w-3 h-3 border-2 border-[#fceda4]/25 border-t-[#fceda4]/70 rounded-full animate-spin" />
          </div>
        </div>
      ) : null
    );

    if (isMultiLine) {
      const line1Left = startCoords.left - editorRect.left;
      const line1Width = editorRect.width - line1Left - 8;
      const line2Left = 8;
      const line2Width = endCoords.right - editorRect.left - 8;

      return (
        <>
          <div style={{ ...underlineStyle, left: line1Left, top: startCoords.bottom - editorRect.top, width: line1Width }} />
          <div style={{ ...underlineStyle, left: line2Left, top: endCoords.bottom - editorRect.top, width: line2Width }} />
          {renderTooltip(line2Left, endCoords.bottom - editorRect.top)}
        </>
      );
    }

    const left = startCoords.left - editorRect.left;
    const width = endCoords.right - startCoords.left;
    const bottom = startCoords.bottom - editorRect.top;

    return (
      <>
        <div style={{ ...underlineStyle, left, top: bottom, width }} />
        {renderTooltip(left, bottom)}
      </>
    );
  } catch {
    return null;
  }
}

interface SelectedTagHighlightProps {
  editor: Editor | null;
  containerRef: RefObject<HTMLDivElement | null>;
  tagPanel: TagPanelState | null;
}

export function SelectedTagHighlight({
  editor,
  containerRef,
  tagPanel,
}: SelectedTagHighlightProps) {
  if (!editor || !tagPanel) return null;

  try {
    const docSize = editor.state.doc.content.size;
    if (tagPanel.from < 0 || tagPanel.to > docSize) return null;

    const startCoords = editor.view.coordsAtPos(tagPanel.from);
    const endCoords = editor.view.coordsAtPos(tagPanel.to);
    const editorRect = containerRef.current?.getBoundingClientRect();
    if (!editorRect) return null;

    const isMultiLine = Math.abs(startCoords.top - endCoords.top) > 5;
    const selectedBg: CSSProperties = {
      backgroundColor: 'rgba(252, 237, 164, 0.12)',
      borderBottom: '2px solid rgba(252, 237, 164, 0.8)',
      pointerEvents: 'none',
      position: 'absolute',
      borderRadius: '2px 2px 0 0',
    };

    if (isMultiLine) {
      const line1Left = startCoords.left - editorRect.left;
      const line1Width = editorRect.width - line1Left - 8;
      const line2Left = 8;
      const line2Width = endCoords.right - editorRect.left - 8;
      return (
        <>
          <div style={{
            ...selectedBg, left: line1Left, top: startCoords.top - editorRect.top,
            width: line1Width, height: startCoords.bottom - startCoords.top,
          }} />
          <div style={{
            ...selectedBg, left: line2Left, top: endCoords.top - editorRect.top,
            width: line2Width, height: endCoords.bottom - endCoords.top,
          }} />
        </>
      );
    }

    const left = startCoords.left - editorRect.left;
    const width = endCoords.right - startCoords.left;
    const top = startCoords.top - editorRect.top;
    const height = startCoords.bottom - startCoords.top;

    return <div style={{ ...selectedBg, left, top, width, height }} />;
  } catch {
    return null;
  }
}
