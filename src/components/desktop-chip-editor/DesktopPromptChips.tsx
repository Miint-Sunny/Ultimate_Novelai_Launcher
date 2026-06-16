import type { CSSProperties, DragEvent, MouseEvent, MutableRefObject } from 'react';
import {
  cleanTagName,
  detectAbnormalWeight,
  getEffectiveWeight,
  getWeightStyle,
  isSDWeightFormat,
  type TagGroupInfo,
} from '../../utils/promptTags';
import { getMarkerVisual } from '../tag-manager/markerVisual';

type DragStartHandler = (event: DragEvent, index: number) => void;
type DragOverHandler = (event: DragEvent, index: number) => void;
type ChipMouseHandler = (event: MouseEvent, index: number) => void;

interface MarkerInfo {
  type: string;
  name: string;
  content: string;
}

interface SharedChipHandlers {
  chipRefsMap: MutableRefObject<Map<number, HTMLElement>>;
  dragIndex: number | null;
  handleDragStart: DragStartHandler;
  handleDragEnd: (event: DragEvent) => void;
  handleDragOver: DragOverHandler;
  handleChipClick: ChipMouseHandler;
  handleChipDoubleClick: ChipMouseHandler;
}

interface DesktopMarkerChipProps extends SharedChipHandlers {
  index: number;
  markerInfo: MarkerInfo;
  isSelected: boolean;
}

export function DesktopMarkerChip({
  index,
  markerInfo,
  isSelected,
  chipRefsMap,
  dragIndex,
  handleDragStart,
  handleDragEnd,
  handleDragOver,
  handleChipClick,
  handleChipDoubleClick,
}: DesktopMarkerChipProps) {
  const tagCount = markerInfo.content.split(/[,，]/).filter(tag => tag.trim()).length;
  const cfg = getMarkerVisual(markerInfo.type);
  const MarkerIcon = cfg.Icon;

  return (
    <button
      draggable
      onDragStart={(event) => handleDragStart(event, index)}
      onDragEnd={handleDragEnd}
      onDragOver={(event) => handleDragOver(event, index)}
      ref={(el) => { if (el) chipRefsMap.current.set(index, el); else chipRefsMap.current.delete(index); }}
      className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded transition-colors cursor-grab active:cursor-grabbing border ${dragIndex === index ? 'opacity-30' : ''} ${isSelected ? 'bg-nai-accent/40 border-nai-accent/70' : 'bg-nai-accent/20 border-nai-accent/50 hover:bg-nai-accent/30'}`}
      onClick={(event) => handleChipClick(event, index)}
      onDoubleClick={(event) => handleChipDoubleClick(event, index)}
    >
      <MarkerIcon className="w-3.5 h-3.5 shrink-0 text-white/90" strokeWidth={2} />
      <span className="flex flex-col items-start">
        <span className="text-xs font-medium leading-tight text-white/90">{markerInfo.name}</span>
        <span className="text-[10px] leading-tight text-white/40">{tagCount} 个标签</span>
      </span>
    </button>
  );
}

interface DesktopTagChipProps extends SharedChipHandlers {
  index: number;
  rawTag: string;
  group: TagGroupInfo;
  parsedTags: string[];
  tagGroups: TagGroupInfo[];
  selectedTags: Set<number>;
  tagTranslations: Map<string, string>;
  translatingTags: Set<string>;
}

export function DesktopTagChip({
  index,
  rawTag,
  group,
  parsedTags,
  tagGroups,
  selectedTags,
  tagTranslations,
  translatingTags,
  chipRefsMap,
  dragIndex,
  handleDragStart,
  handleDragEnd,
  handleDragOver,
  handleChipClick,
  handleChipDoubleClick,
}: DesktopTagChipProps) {
  const clean = cleanTagName(rawTag);
  const translation = tagTranslations.get(clean);
  const needsTranslation = clean && !/[\u4e00-\u9fa5]/.test(clean) && /[a-zA-Z]/.test(clean) && !clean.startsWith('artist:');
  const isTranslating = needsTranslation && !translation && translatingTags.has(clean);
  const isSelected = selectedTags.has(index);
  const isGroupSelected = selectedTags.size > 0 && group.groupId !== -1 && Array.from(selectedTags).some(selectedIndex => tagGroups[selectedIndex]?.groupId === group.groupId);
  const effectiveWeight = getEffectiveWeight(rawTag, group, parsedTags, tagGroups);
  const isSDFormat = isSDWeightFormat(rawTag);
  const abnormalWeight = detectAbnormalWeight(rawTag);
  const isHidden = rawTag.trim().startsWith('~');
  const roundedClass = group.position === 'first' ? 'rounded-l rounded-r-none' : group.position === 'middle' ? 'rounded-none' : group.position === 'last' ? 'rounded-r rounded-l-none' : 'rounded';
  const gapClass = (group.position === 'first' || group.position === 'middle') ? '-mr-[2px]' : '';
  const weightStyle = getWeightStyle(effectiveWeight);
  const chipStyle: CSSProperties = abnormalWeight
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
    <button
      draggable
      onDragStart={(event) => handleDragStart(event, index)}
      onDragEnd={handleDragEnd}
      onDragOver={(event) => handleDragOver(event, index)}
      ref={(el) => { if (el) chipRefsMap.current.set(index, el); else chipRefsMap.current.delete(index); }}
      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 my-[2px] transition-all cursor-grab active:cursor-grabbing border ${roundedClass} ${gapClass} ${dragIndex === index ? 'opacity-30' : ''} ${isSelected ? 'z-[1]' : ''} ${usesDynamicColor ? 'chip-weight-dynamic' : abnormalWeight ? 'hover:brightness-125' : ''}`}
      style={chipStyle}
      onClick={(event) => handleChipClick(event, index)}
      onDoubleClick={(event) => handleChipDoubleClick(event, index)}
      title={abnormalWeight ? `⚠️ ${abnormalWeight}` : isSDFormat ? `SD格式: ${rawTag.trim()} - 点击转换` : rawTag.trim()}
    >
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
  );
}
