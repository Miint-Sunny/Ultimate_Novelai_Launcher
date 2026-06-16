import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, Eye, EyeOff, Trash2, X } from 'lucide-react';
import { RelatedTagsRow } from '../RelatedTagsRow';
import {
  cleanTagName,
  isCollapsibleMarker,
  isSDWeightFormat,
  stepNumericWeight,
} from '../../utils/promptTags';

interface MultiSelectActions {
  addBrace: () => void;
  addBracket: () => void;
  setNumeric: (weight: number) => void;
  clearWeight: () => void;
  convertSDToNAI: () => void;
  deleteTag: () => void;
  toggleHide: () => void;
  moveToFront: () => void;
}

interface DesktopMultiSelectPanelProps {
  selectedTags: Set<number>;
  chipRefsMap: MutableRefObject<Map<number, HTMLElement>>;
  parsedTags: string[];
  weightPresets: number[];
  multiNumWeight: number;
  tagActions: MultiSelectActions;
  rebuildValue: (tags: string[]) => void;
  setMultiNumWeight: Dispatch<SetStateAction<number>>;
  setSelectedTags: Dispatch<SetStateAction<Set<number>>>;
}

export function DesktopMultiSelectPanel({
  selectedTags,
  chipRefsMap,
  parsedTags,
  weightPresets,
  multiNumWeight,
  tagActions,
  rebuildValue,
  setMultiNumWeight,
  setSelectedTags,
}: DesktopMultiSelectPanelProps) {
  if (selectedTags.size < 2) return null;

  const selectedIndices = Array.from(selectedTags).sort((a, b) => a - b);
  const firstIdx = selectedIndices[0];
  const firstTag = parsedTags[firstIdx];
  const chipEl = chipRefsMap.current.get(firstIdx);
  const rect = chipEl?.getBoundingClientRect();
  const panelX = rect ? rect.left : 100;
  const panelY = rect ? rect.bottom + 4 : 100;
  const sdCount = selectedIndices.filter(index => isSDWeightFormat(parsedTags[index] || '')).length;
  const firstIsHidden = firstTag?.trim().startsWith('~');

  return createPortal(
    <div
      className="fixed z-[99999] chip-tag-quick-panel"
      style={{ top: panelY, left: panelX, minWidth: 300, maxWidth: 420 }}
      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
    >
      <div className="bg-[#0f0f0f] rounded-lg shadow-[0_16px_40px_-10px_rgba(0,0,0,0.85),0_0_0_1px_rgba(252,237,164,0.08)] overflow-hidden">
        <div className="flex items-start gap-2 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="font-tag text-[14px] leading-tight text-[#fceda4] truncate">已选 {selectedTags.size} 个标签</div>
            <div className="text-[11px] leading-tight text-white/50 mt-1">批量操作</div>
          </div>
          <button className="shrink-0 w-6 h-6 flex items-center justify-center text-white/40 hover:text-white/90 rounded-md hover:bg-white/[0.08] transition-colors" onClick={() => setSelectedTags(new Set())} title="关闭">
            <X className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
        </div>

        {sdCount > 0 && (
          <div className="mx-2 mb-1.5 rounded-md bg-amber-500/10 ring-1 ring-amber-500/20 px-2.5 py-1.5 flex items-center gap-2">
            <span className="text-[10px] text-amber-300 font-medium">SD WebUI</span>
            <span className="text-[10px] text-amber-200/60">{sdCount} 个 SD 格式标签</span>
            <div className="flex-1" />
            <button className="px-2 py-0.5 text-[10px] bg-amber-500/25 hover:bg-amber-500/40 text-amber-100 rounded transition-colors cursor-pointer" onClick={() => tagActions.convertSDToNAI()} title="批量转换为 NAI 格式">
              转 NAI
            </button>
          </div>
        )}

        <div className="px-2 pb-1.5">
          <div className="flex items-center gap-1 mb-1.5">
            <button className="px-2 h-6 text-[11px] font-mono bg-[#74270D]/50 hover:bg-[#74270D]/80 text-orange-200 rounded transition-colors" onClick={() => tagActions.addBrace()} title="增加权重 {tags}">{'{+}'}</button>
            <button className="px-2 h-6 text-[11px] font-mono bg-blue-500/20 hover:bg-blue-500/40 text-blue-200 rounded transition-colors" onClick={() => tagActions.addBracket()} title="降低权重 [tags]">{'[−]'}</button>
            <div className="flex-1" />
            <button
              className="w-6 h-6 flex items-center justify-center text-sm bg-blue-500/15 hover:bg-blue-500/35 text-blue-200 rounded transition-colors"
              onClick={() => {
                const value = stepNumericWeight(multiNumWeight, -0.1);
                setMultiNumWeight(value);
                tagActions.setNumeric(value);
              }}
              title="减少 0.1"
            >
              −
            </button>
            <span className={`w-11 text-center text-[12px] font-mono tabular-nums font-medium ${multiNumWeight > 1 ? 'text-orange-200' : multiNumWeight < 1 ? 'text-blue-200' : 'text-white/80'}`}>{multiNumWeight.toFixed(1)}</span>
            <button
              className="w-6 h-6 flex items-center justify-center text-sm bg-[#74270D]/40 hover:bg-[#74270D]/70 text-orange-200 rounded transition-colors"
              onClick={() => {
                const value = stepNumericWeight(multiNumWeight, 0.1);
                setMultiNumWeight(value);
                tagActions.setNumeric(value);
              }}
              title="增加 0.1"
            >
              +
            </button>
          </div>
          <div className="flex items-center gap-1">
            {weightPresets.map(weight => {
              const active = Math.abs(multiNumWeight - weight) < 0.01;
              const isOrange = weight > 1;
              const base = isOrange ? 'bg-[#74270D]/35 hover:bg-[#74270D]/65 text-orange-200' : 'bg-blue-500/15 hover:bg-blue-500/30 text-blue-200';
              return (
                <button
                  key={weight}
                  className={`flex-1 h-6 text-[11px] font-mono tabular-nums rounded transition-colors ${base} ${active ? 'ring-1 ring-inset ring-[#fceda4]/60' : ''}`}
                  onClick={() => {
                    setMultiNumWeight(weight);
                    tagActions.setNumeric(weight);
                  }}
                  title={`${weight}::tags::`}
                >
                  {weight}
                </button>
              );
            })}
            <button className="px-2 h-6 text-[11px] text-white/50 hover:text-white/80 hover:bg-white/[0.08] rounded transition-colors" onClick={() => tagActions.clearWeight()} title="清除所有权重">清除</button>
          </div>
        </div>

        <div className="mx-2 h-px bg-white/[0.08]" />
        <RelatedTagsRow
          anchorTags={selectedIndices
            .map(index => parsedTags[index])
            .filter(tag => tag && !isCollapsibleMarker(tag))
            .map(tag => cleanTagName(tag))}
          existingTagSet={new Set(parsedTags.map(tag => cleanTagName(tag).toLowerCase().replace(/\s+/g, '_')))}
          onAdd={(addedTag, addToEnd) => {
            const newTags = [...parsedTags];
            if (addToEnd) {
              newTags.push(addedTag);
            } else {
              const lastIdx = Math.max(...selectedIndices);
              newTags.splice(lastIdx + 1, 0, addedTag);
            }
            rebuildValue(newTags);
          }}
        />
        <div className="mx-2 h-px bg-white/[0.08]" />

        <div className="px-2 py-1.5 flex items-center gap-0.5">
          <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-white/60 hover:text-white hover:bg-white/[0.08] rounded transition-colors" onClick={() => tagActions.moveToFront()} title="移到最前">
            <ArrowUp className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} /><span>置顶</span>
          </button>
          <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-white/60 hover:text-white hover:bg-white/[0.08] rounded transition-colors" onClick={() => tagActions.toggleHide()} title="禁用/启用">
            {firstIsHidden ? <Eye className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} /> : <EyeOff className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} />}
            <span>{firstIsHidden ? '启用' : '禁用'}</span>
          </button>
          <div className="flex-1" />
          <button className="flex items-center gap-1.5 px-2 h-7 text-[11px] text-red-400/75 hover:text-red-300 hover:bg-red-500/15 rounded transition-colors" onClick={() => tagActions.deleteTag()} title="删除标签">
            <Trash2 className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} /><span>删除</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
