import type { Dispatch, RefObject, SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, ExternalLink, Eye, EyeOff, Trash2, X } from 'lucide-react';
import { RelatedTagsRow } from '../RelatedTagsRow';
import { stepNumericWeight } from './wikiUtils';

export interface TagPanelState {
  tag: string;
  rawTag: string;
  translation: string;
  from: number;
  to: number;
  screenX: number;
  screenY: number;
}

interface TagPanelActions {
  addWeight: () => void;
  reduceWeight: () => void;
  clearWeight: () => void;
  setNumericWeight: (weight: number) => void;
  openDanbooru: () => void;
  moveToFront: () => void;
  toggleHide: () => void;
  deleteTag: () => void;
}

interface TagQuickPanelProps {
  panel: TagPanelState | null;
  panelRef: RefObject<HTMLDivElement | null>;
  weightPresets: number[];
  numWeight: number;
  setNumWeight: Dispatch<SetStateAction<number>>;
  translationLoading: boolean;
  actions: TagPanelActions;
  existingTagSet: Set<string>;
  onAddRelatedTag: (tag: string, addToEnd: boolean) => void;
  onClose: () => void;
}

export function TagQuickPanel({
  panel,
  panelRef,
  weightPresets,
  numWeight,
  setNumWeight,
  translationLoading,
  actions,
  existingTagSet,
  onAddRelatedTag,
  onClose,
}: TagQuickPanelProps) {
  if (!panel) return null;

  const isHidden = panel.rawTag.trim().startsWith('~');

  return createPortal(
    <div
      ref={panelRef}
      className="fixed z-[99999] tag-quick-panel bg-[#0f0f0f] rounded-lg shadow-[0_16px_40px_-10px_rgba(0,0,0,0.85),0_0_0_1px_rgba(252,237,164,0.08)] overflow-hidden"
      style={{ top: panel.screenY, left: panel.screenX, minWidth: 300, maxWidth: 420 }}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="font-tag text-[14px] leading-tight text-[#fceda4] truncate" title={panel.tag}>
            {panel.tag.replace(/ /g, '_')}
          </div>
          <div className="text-[11px] leading-tight text-white/50 mt-1 relative">
            <span className={panel.translation ? '' : 'invisible'}>{panel.translation || '\u00A0'}</span>
            {!panel.translation && translationLoading && (
              <span className="absolute inset-0 flex items-center gap-1">
                <span className="inline-block w-1 h-1 rounded-full bg-white/50 animate-pulse" style={{ animationDelay: '0ms' }} />
                <span className="inline-block w-1 h-1 rounded-full bg-white/50 animate-pulse" style={{ animationDelay: '150ms' }} />
                <span className="inline-block w-1 h-1 rounded-full bg-white/50 animate-pulse" style={{ animationDelay: '300ms' }} />
              </span>
            )}
          </div>
        </div>
        <button className="shrink-0 w-6 h-6 flex items-center justify-center text-white/40 hover:text-white/90 rounded-md hover:bg-white/[0.08] transition-colors" onClick={onClose} title="关闭">
          <X className="w-3.5 h-3.5" strokeWidth={2} />
        </button>
      </div>

      <div className="px-2 pb-1.5">
        <div className="flex items-center gap-1 mb-1.5">
          <button className="px-2 h-6 text-[11px] font-mono bg-[#74270D]/50 hover:bg-[#74270D]/80 text-orange-200 rounded transition-colors" onClick={actions.addWeight} title="增加权重 {tag}">{'{+}'}</button>
          <button className="px-2 h-6 text-[11px] font-mono bg-blue-500/20 hover:bg-blue-500/40 text-blue-200 rounded transition-colors" onClick={actions.reduceWeight} title="降低权重 [tag]">{'[−]'}</button>
          <div className="flex-1" />
          <button className="w-6 h-6 flex items-center justify-center text-sm bg-blue-500/15 hover:bg-blue-500/35 text-blue-200 rounded transition-colors" onClick={() => { const v = stepNumericWeight(numWeight, -0.1); setNumWeight(v); actions.setNumericWeight(v); }} title="减少 0.1">−</button>
          <span className={`w-11 text-center text-[12px] font-mono tabular-nums font-medium ${numWeight > 1 ? 'text-orange-200' : numWeight < 1 ? 'text-blue-200' : 'text-white/80'}`}>{numWeight.toFixed(1)}</span>
          <button className="w-6 h-6 flex items-center justify-center text-sm bg-[#74270D]/40 hover:bg-[#74270D]/70 text-orange-200 rounded transition-colors" onClick={() => { const v = stepNumericWeight(numWeight, 0.1); setNumWeight(v); actions.setNumericWeight(v); }} title="增加 0.1">+</button>
        </div>
        <div className="flex items-center gap-1">
          {weightPresets.map(w => {
            const active = Math.abs(numWeight - w) < 0.01;
            const isOrange = w > 1;
            const base = isOrange ? 'bg-[#74270D]/35 hover:bg-[#74270D]/65 text-orange-200' : 'bg-blue-500/15 hover:bg-blue-500/30 text-blue-200';
            return (
              <button
                key={w}
                className={`flex-1 h-6 text-[11px] font-mono tabular-nums rounded transition-colors ${base} ${active ? 'ring-1 ring-inset ring-[#fceda4]/60' : ''}`}
                onClick={() => { setNumWeight(w); actions.setNumericWeight(w); }}
                title={`${w}::tag::`}
              >
                {w}
              </button>
            );
          })}
          <button className="px-2 h-6 text-[11px] text-white/50 hover:text-white/80 hover:bg-white/[0.08] rounded transition-colors" onClick={actions.clearWeight} title="清除所有权重">清除</button>
        </div>
      </div>

      <div className="mx-2 h-px bg-white/[0.08]" />

      <RelatedTagsRow
        anchorTags={[panel.tag]}
        existingTagSet={existingTagSet}
        onAdd={onAddRelatedTag}
      />

      <div className="mx-2 h-px bg-white/[0.08]" />

      <div className="px-2 py-1.5 flex items-center gap-0.5">
        <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-white/60 hover:text-white hover:bg-white/[0.08] rounded transition-colors" onClick={actions.openDanbooru} title="在 Danbooru 中查看"><ExternalLink className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} /><span>Wiki</span></button>
        <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-white/60 hover:text-white hover:bg-white/[0.08] rounded transition-colors" onClick={actions.moveToFront} title="移到最前"><ArrowUp className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} /><span>置顶</span></button>
        <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-white/60 hover:text-white hover:bg-white/[0.08] rounded transition-colors" onClick={actions.toggleHide} title={isHidden ? '启用此标签' : '禁用此标签'}>
          {isHidden ? <Eye className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} /> : <EyeOff className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />}<span>{isHidden ? '启用' : '禁用'}</span>
        </button>
        <div className="flex-1" />
        <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-red-400/75 hover:text-red-300 hover:bg-red-500/15 rounded transition-colors" onClick={actions.deleteTag} title="删除标签"><Trash2 className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} /><span>删除</span></button>
      </div>
    </div>,
    document.body,
  );
}
