import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, ExternalLink, Eye, EyeOff, Trash2, X } from 'lucide-react';
import { RelatedTagsRow } from '../RelatedTagsRow';
import { getMarkerVisual } from '../tag-manager/markerVisual';
import {
  cleanTagName,
  isSDWeightFormat,
  parseCollapsibleMarker,
  parseSDWeight,
  stepNumericWeight,
} from '../../utils/promptTags';

interface TagPanelState {
  index: number;
  rawTag: string;
  tag: string;
  translation: string;
  screenX: number;
  screenY: number;
}

interface EditingTagState {
  index: number;
  text: string;
  width: number;
  height: number;
}

interface PanelActions {
  addWeight: () => void;
  reduceWeight: () => void;
  clearWeight: () => void;
  setNumericWeight: (weight: number) => void;
  convertSDToNAI: () => void;
  deleteTag: () => void;
  openDanbooru: () => void;
  toggleHide: () => void;
  moveToFront: () => void;
}

interface DesktopTagQuickPanelProps {
  tagPanel: TagPanelState | null;
  tagPanelRef: RefObject<HTMLDivElement | null>;
  chipRefsMap: MutableRefObject<Map<number, HTMLElement>>;
  parsedTags: string[];
  tagPanelPostCount: number | null;
  translationLoading: boolean;
  weightPresets: number[];
  numWeight: number;
  panelActions: PanelActions;
  rebuildValue: (tags: string[]) => void;
  setNumWeight: Dispatch<SetStateAction<number>>;
  setSelectedTags: Dispatch<SetStateAction<Set<number>>>;
  setTagPanel: Dispatch<SetStateAction<TagPanelState | null>>;
  setEditingTag: Dispatch<SetStateAction<EditingTagState | null>>;
}

export function DesktopTagQuickPanel({
  tagPanel,
  tagPanelRef,
  chipRefsMap,
  parsedTags,
  tagPanelPostCount,
  translationLoading,
  weightPresets,
  numWeight,
  panelActions,
  rebuildValue,
  setNumWeight,
  setSelectedTags,
  setTagPanel,
  setEditingTag,
}: DesktopTagQuickPanelProps) {
  if (!tagPanel) return null;

  const markerData = parseCollapsibleMarker(tagPanel.rawTag);
  if (markerData) {
    const tagCount = markerData.content.split(/[,，]/).filter(tag => tag.trim()).length;
    const cfg = getMarkerVisual(markerData.type);
    const MarkerIcon = cfg.Icon;

    return createPortal(
      <div
        ref={tagPanelRef}
        className="fixed z-[99999] chip-tag-quick-panel bg-[#0f0f0f] rounded-lg shadow-[0_16px_40px_-10px_rgba(0,0,0,0.85)] border border-[#fceda4]/20 overflow-hidden"
        style={{ top: tagPanel.screenY, left: tagPanel.screenX, minWidth: 220, maxWidth: 340 }}
        onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
      >
        <div className="flex items-start gap-2 px-3 py-2 border-b border-white/10">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <MarkerIcon className="w-3.5 h-3.5 shrink-0 text-nai-accent" strokeWidth={2} />
              <span className="text-xs font-medium text-white/90 truncate">{markerData.name}</span>
            </div>
            <div className="text-[10px] text-white/40 mt-0.5">{cfg.label} · {tagCount} 个标签</div>
          </div>
          <button className="shrink-0 w-6 h-6 flex items-center justify-center text-white/40 hover:text-white/80 rounded hover:bg-white/10 transition-colors" onClick={() => setTagPanel(null)}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-2 py-1.5 flex items-center gap-2">
          <button
            className="flex-1 h-6 text-[10px] bg-nai-accent/15 hover:bg-nai-accent/30 text-nai-accent rounded transition-colors"
            onClick={() => {
              const tags = [...parsedTags];
              tags.splice(tagPanel.index, 1, ...markerData.content.split(/[,，]/).map(tag => tag.trim()).filter(Boolean));
              rebuildValue(tags);
              setSelectedTags(new Set());
              setTagPanel(null);
            }}
          >
            展开为标签
          </button>
          <button
            className="flex-1 h-6 text-[10px] bg-red-500/10 hover:bg-red-500/25 text-red-400/70 rounded transition-colors flex items-center justify-center gap-0.5"
            onClick={() => panelActions.deleteTag()}
          >
            <Trash2 className="w-3 h-3" /> 删除
          </button>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      ref={tagPanelRef}
      className="fixed z-[99999] chip-tag-quick-panel"
      style={{ top: tagPanel.screenY, left: tagPanel.screenX, minWidth: 300, maxWidth: 420 }}
      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
    >
      <div className="bg-[#0f0f0f] rounded-lg shadow-[0_16px_40px_-10px_rgba(0,0,0,0.85),0_0_0_1px_rgba(252,237,164,0.08)] overflow-hidden">
        <div className="flex items-start gap-2 px-3 py-2.5">
          <div
            className="min-w-0 flex-1 cursor-text"
            onClick={() => {
              const chipEl = chipRefsMap.current.get(tagPanel.index);
              const chipWidth = chipEl ? chipEl.getBoundingClientRect().width : 80;
              const chipHeight = chipEl ? chipEl.getBoundingClientRect().height : 32;
              setEditingTag({ index: tagPanel.index, text: tagPanel.rawTag, width: Math.max(80, chipWidth), height: chipHeight });
              setTagPanel(null);
              setSelectedTags(new Set());
            }}
          >
            <div className="flex items-baseline gap-1.5 min-w-0">
              <span className="font-tag text-[14px] leading-tight text-[#fceda4] truncate hover:text-[#fceda4]/85 transition-colors" title={tagPanel.tag}>
                {tagPanel.tag.replace(/ /g, '_')}
              </span>
              {tagPanelPostCount != null && tagPanelPostCount > 0 && (
                <span className="shrink-0 text-[11px] tabular-nums text-white/40" title={`Danbooru 引用数：${tagPanelPostCount}`}>
                  {tagPanelPostCount >= 1000 ? `${(tagPanelPostCount / 1000).toFixed(0)}k` : tagPanelPostCount}
                </span>
              )}
            </div>
            <div className="text-[11px] leading-tight text-white/50 mt-1 relative">
              <span className={tagPanel.translation ? '' : 'invisible'}>{tagPanel.translation || '\u00A0'}</span>
              {!tagPanel.translation && translationLoading && (
                <span className="absolute inset-0 flex items-center gap-1">
                  <span className="inline-block w-1 h-1 rounded-full bg-white/50 animate-pulse" style={{ animationDelay: '0ms' }} />
                  <span className="inline-block w-1 h-1 rounded-full bg-white/50 animate-pulse" style={{ animationDelay: '150ms' }} />
                  <span className="inline-block w-1 h-1 rounded-full bg-white/50 animate-pulse" style={{ animationDelay: '300ms' }} />
                </span>
              )}
            </div>
          </div>
          <button className="shrink-0 w-6 h-6 flex items-center justify-center text-white/40 hover:text-white/90 rounded-md hover:bg-white/[0.08] transition-colors" onClick={() => { setTagPanel(null); setSelectedTags(new Set()); }} title="关闭">
            <X className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
        </div>

        {isSDWeightFormat(tagPanel.rawTag) && (() => {
          const sdInfo = parseSDWeight(tagPanel.rawTag);
          return (
            <div className="mx-2 mb-1.5 rounded-md bg-amber-500/10 ring-1 ring-amber-500/20 px-2.5 py-1.5 flex items-center gap-2">
              <span className="text-[10px] text-amber-300 font-medium">SD WebUI</span>
              <span className="text-[10px] text-amber-200/60">{sdInfo?.weight !== null ? `权重 ${sdInfo?.weight}` : '无权重'}</span>
              <div className="flex-1" />
              <button className="px-2 py-0.5 text-[10px] bg-amber-500/25 hover:bg-amber-500/40 text-amber-100 rounded transition-colors" onClick={panelActions.convertSDToNAI} title="转换为 NAI 格式">
                转 NAI
              </button>
            </div>
          );
        })()}

        <div className="px-2 pb-1.5">
          <div className="flex items-center gap-1 mb-1.5">
            <button className="px-2 h-6 text-[11px] font-mono bg-[#74270D]/50 hover:bg-[#74270D]/80 text-orange-200 rounded transition-colors" onClick={panelActions.addWeight} title="增加权重 {tag}">{'{+}'}</button>
            <button className="px-2 h-6 text-[11px] font-mono bg-blue-500/20 hover:bg-blue-500/40 text-blue-200 rounded transition-colors" onClick={panelActions.reduceWeight} title="降低权重 [tag]">{'[−]'}</button>
            <div className="flex-1" />
            <button className="w-6 h-6 flex items-center justify-center text-sm bg-blue-500/15 hover:bg-blue-500/35 text-blue-200 rounded transition-colors" onClick={() => { const value = stepNumericWeight(numWeight, -0.1); setNumWeight(value); panelActions.setNumericWeight(value); }} title="减少 0.1">−</button>
            <span className={`w-11 text-center text-[12px] font-mono tabular-nums font-medium ${numWeight > 1 ? 'text-orange-200' : numWeight < 1 ? 'text-blue-200' : 'text-white/80'}`}>{numWeight.toFixed(1)}</span>
            <button className="w-6 h-6 flex items-center justify-center text-sm bg-[#74270D]/40 hover:bg-[#74270D]/70 text-orange-200 rounded transition-colors" onClick={() => { const value = stepNumericWeight(numWeight, 0.1); setNumWeight(value); panelActions.setNumericWeight(value); }} title="增加 0.1">+</button>
          </div>
          <div className="flex items-center gap-1">
            {weightPresets.map(weight => {
              const active = Math.abs(numWeight - weight) < 0.01;
              const isOrange = weight > 1;
              const base = isOrange ? 'bg-[#74270D]/35 hover:bg-[#74270D]/65 text-orange-200' : 'bg-blue-500/15 hover:bg-blue-500/30 text-blue-200';
              return (
                <button
                  key={weight}
                  className={`flex-1 h-6 text-[11px] font-mono tabular-nums rounded transition-colors ${base} ${active ? 'ring-1 ring-inset ring-[#fceda4]/60' : ''}`}
                  onClick={() => { setNumWeight(weight); panelActions.setNumericWeight(weight); }}
                  title={`${weight}::tag::`}
                >
                  {weight}
                </button>
              );
            })}
            <button className="px-2 h-6 text-[11px] text-white/50 hover:text-white/80 hover:bg-white/[0.08] rounded transition-colors" onClick={panelActions.clearWeight} title="清除所有权重">清除</button>
          </div>
        </div>

        <div className="mx-2 h-px bg-white/[0.08]" />
        <RelatedTagsRow
          anchorTags={[tagPanel.tag]}
          existingTagSet={new Set(parsedTags.map(tag => cleanTagName(tag).toLowerCase().replace(/\s+/g, '_')))}
          onAdd={(addedTag, addToEnd) => {
            const newTags = [...parsedTags];
            if (addToEnd) {
              newTags.push(addedTag);
            } else {
              newTags.splice(tagPanel.index + 1, 0, addedTag);
            }
            rebuildValue(newTags);
          }}
        />
        <div className="mx-2 h-px bg-white/[0.08]" />

        <div className="px-2 py-1.5 flex items-center gap-0.5">
          <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-white/60 hover:text-white hover:bg-white/[0.08] rounded transition-colors" onClick={panelActions.openDanbooru} title="在 Danbooru 中查看">
            <ExternalLink className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} /><span>Wiki</span>
          </button>
          <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-white/60 hover:text-white hover:bg-white/[0.08] rounded transition-colors" onClick={panelActions.moveToFront} title="移到最前">
            <ArrowUp className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} /><span>置顶</span>
          </button>
          <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-white/60 hover:text-white hover:bg-white/[0.08] rounded transition-colors" onClick={panelActions.toggleHide} title={tagPanel.rawTag.trim().startsWith('~') ? '启用此标签' : '禁用此标签'}>
            {tagPanel.rawTag.trim().startsWith('~') ? <Eye className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} /> : <EyeOff className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />}<span>{tagPanel.rawTag.trim().startsWith('~') ? '启用' : '禁用'}</span>
          </button>
          <div className="flex-1" />
          <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-red-400/75 hover:text-red-300 hover:bg-red-500/15 rounded transition-colors" onClick={panelActions.deleteTag} title="删除标签">
            <Trash2 className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} /><span>删除</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
