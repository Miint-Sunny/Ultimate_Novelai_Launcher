import React, { type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import {
  NEWLINE_SENTINEL,
  analyzeTagGroups,
  cleanTagName,
  detectAbnormalWeight,
  getEffectiveWeight,
  getWeightStyle,
  isSDWeightFormat,
  parseCollapsibleMarker,
} from '../../../utils/promptTags';
import { getMarkerVisual } from '../../tag-manager/markerVisual';
import type { DragGhost, DragState } from './useChipDragSort';

type TagGroups = ReturnType<typeof analyzeTagGroups>;

interface FullscreenChipEditorAreaProps {
  type: 'prompt' | 'undesired';
  parsedTags: string[];
  tagGroups: TagGroups;
  tagTranslations: Map<string, string>;
  translatingTags: Set<string>;
  selectedTags: Set<number>;
  onSelectedTagsChange: Dispatch<SetStateAction<Set<number>>>;
  inputRef: RefObject<HTMLInputElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  inputText: string;
  onInputChange: (text: string) => void;
  onInputKeyDown: (event: React.KeyboardEvent) => void;
  onPaste: (event: React.ClipboardEvent<HTMLInputElement>) => void;
  onInputFocus: () => void;
  isDragging: boolean;
  dragState: MutableRefObject<DragState | null>;
  dragGhost: DragGhost | null;
  dragOverIndex: number | null;
  chipRefsMap: MutableRefObject<Map<number, HTMLElement>>;
  handleChipTouchStart: (event: React.TouchEvent, index: number) => void;
  handleChipTouchMove: (event: React.TouchEvent) => void;
  handleChipTouchEnd: () => void;
  suppressChipClickRef: MutableRefObject<boolean>;
}

const clearPendingDrag = (dragState: MutableRefObject<DragState | null>) => {
  const state = dragState.current;
  if (state?.longPressTimer) clearTimeout(state.longPressTimer);
  dragState.current = null;
};

export const FullscreenChipEditorArea: React.FC<FullscreenChipEditorAreaProps> = ({
  type,
  parsedTags,
  tagGroups,
  tagTranslations,
  translatingTags,
  selectedTags,
  onSelectedTagsChange,
  inputRef,
  scrollRef,
  inputText,
  onInputChange,
  onInputKeyDown,
  onPaste,
  onInputFocus,
  isDragging,
  dragState,
  dragGhost,
  dragOverIndex,
  chipRefsMap,
  handleChipTouchStart,
  handleChipTouchMove,
  handleChipTouchEnd,
  suppressChipClickRef,
}) => {
  const toggleSelection = (index: number, scrollIntoView: boolean) => {
    if (suppressChipClickRef.current) return;
    onSelectedTagsChange((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
    if (scrollIntoView) {
      setTimeout(() => {
        const el = chipRefsMap.current.get(index);
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
    }
  };

  const renderDropIndicator = (index: number) => {
    const srcIdx = dragState.current?.index ?? -1;
    const isNoOp = dragOverIndex === srcIdx || dragOverIndex === srcIdx + 1;
    if (!isDragging || dragOverIndex !== index || isNoOp || !dragGhost) return null;

    return (
      <div key={`drop-${index}`} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border-2 border-dashed border-[#fceda4]/50 bg-[#fceda4]/10">
        <span className="flex flex-col items-start">
          <span className="font-tag text-[13px] leading-tight text-[#fceda4]/50">{dragGhost.text}</span>
          {dragGhost.sub && (
            <span className="text-[10px] leading-tight text-[#fceda4]/25">{dragGhost.sub}</span>
          )}
        </span>
      </div>
    );
  };

  const renderMarkerChip = (rawTag: string, index: number, dropIndicator: React.ReactNode) => {
    const markerInfo = parseCollapsibleMarker(rawTag);
    if (!markerInfo) return null;

    const isSelected = selectedTags.has(index);
    const tagCount = markerInfo.content.split(/[,，]/).filter((tag) => tag.trim()).length;
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
          onTouchStart={(event) => handleChipTouchStart(event, index)}
          onTouchMove={handleChipTouchMove}
          onTouchEnd={(event) => {
            const state = dragState.current;
            if (state?.activated) { event.preventDefault(); handleChipTouchEnd(); return; }
            clearPendingDrag(dragState);
          }}
          onClick={(event) => {
            event.stopPropagation();
            toggleSelection(index, false);
          }}
        >
          <MarkerIcon className="w-3.5 h-3.5 shrink-0 text-white/90" strokeWidth={2} />
          <span className="flex flex-col items-start">
            <span className="text-[12px] font-medium leading-tight text-white/90">{markerInfo.name}</span>
            <span className="text-[10px] leading-tight text-white/40">{tagCount} 个标签</span>
          </span>
        </button>
      </React.Fragment>
    );
  };

  const renderTagChip = (rawTag: string, index: number, dropIndicator: React.ReactNode) => {
    const clean = cleanTagName(rawTag);
    const translation = tagTranslations.get(clean);
    const needsTranslation = clean && !/[\u4e00-\u9fa5]/.test(clean) && /[a-zA-Z]/.test(clean) && !clean.startsWith('artist:');
    const isTranslating = needsTranslation && !translation && translatingTags.has(clean);
    const group = tagGroups[index];
    const isSelected = selectedTags.has(index);
    const isGroupSelected = selectedTags.size > 0 && group.groupId !== -1 && Array.from(selectedTags).some((selectedIndex) => tagGroups[selectedIndex]?.groupId === group.groupId);
    const effectiveWeight = getEffectiveWeight(rawTag, group, parsedTags, tagGroups);
    const isSDFormat = isSDWeightFormat(rawTag);
    const abnormalWeight = detectAbnormalWeight(rawTag);
    const isHidden = rawTag.trim().startsWith('~');

    const roundedClass = group.position === 'first' ? 'rounded-l-lg rounded-r-none'
      : group.position === 'middle' ? 'rounded-none'
        : group.position === 'last' ? 'rounded-r-lg rounded-l-none'
          : 'rounded-lg';
    const gapClass = (group.position === 'first' || group.position === 'middle') ? '-mr-[3px]' : '';
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
          onTouchStart={(event) => handleChipTouchStart(event, index)}
          onTouchMove={handleChipTouchMove}
          onTouchEnd={(event) => {
            const state = dragState.current;
            if (state?.activated) { event.preventDefault(); handleChipTouchEnd(); return; }
            clearPendingDrag(dragState);
          }}
          onClick={(event) => {
            event.stopPropagation();
            toggleSelection(index, true);
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
              <span className={`text-[10px] leading-tight ${isSelected ? 'text-[#fceda4]/50' : 'text-white/35'}`}>{translation}</span>
            ) : isTranslating ? (
              <span className="text-[10px] leading-tight text-white/20 animate-pulse">翻译中…</span>
            ) : needsTranslation ? (
              <span className="text-[10px] leading-tight text-white/15">…</span>
            ) : <span className="text-[10px] leading-tight">&nbsp;</span>}
          </span>
        </button>
      </React.Fragment>
    );
  };

  return (
    <>
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 pt-3 pb-2"
        style={isDragging ? { touchAction: 'none' } : undefined}
        onClick={() => { onSelectedTagsChange(new Set()); inputRef.current?.focus(); }}
      >
        <div className="flex flex-wrap gap-1.5 items-center content-start select-none chip-no-select" onContextMenu={(event) => event.preventDefault()}>
          {parsedTags.map((rawTag, index) => {
            if (rawTag === NEWLINE_SENTINEL) {
              const isConsecutive = index > 0 && parsedTags[index - 1] === NEWLINE_SENTINEL;
              if (!isConsecutive) return <div key={`nl-${index}`} className="basis-full h-0" />;
              return <div key={`nl-${index}`} className="basis-full h-2" />;
            }
            const dropIndicator = renderDropIndicator(index);
            return renderMarkerChip(rawTag, index, dropIndicator) || renderTagChip(rawTag, index, dropIndicator);
          })}
          <input
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={onInputKeyDown}
            onPaste={onPaste}
            onFocus={onInputFocus}
            placeholder={parsedTags.length === 0 ? (type === 'prompt' ? '输入标签，逗号分隔...' : '输入排除标签...') : '继续添加...'}
            className="flex-1 min-w-[100px] bg-transparent text-white text-[14px] font-tag outline-none placeholder-gray-600 py-1"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      </div>

      {isDragging && dragGhost && (
        <div
          className="fixed z-[100] pointer-events-none"
          style={{ left: dragGhost.x, top: dragGhost.y, width: dragGhost.w }}
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
    </>
  );
};
