import React from 'react';
import {
  ArrowUp,
  Check,
  Copy,
  Eye,
  EyeOff,
  Trash2,
  X,
} from 'lucide-react';
import {
  NEWLINE_SENTINEL,
  cleanTagName,
  extractTagsFromList,
  isCollapsibleMarker,
  isSDWeightFormat,
  parseCollapsibleMarker,
  parseSDWeight,
  stepNumericWeight,
  type analyzeTagGroups,
} from '../../../utils/promptTags';
import { getMarkerVisual } from '../../tag-manager/markerVisual';
import { RelatedTagsRow } from '../../RelatedTagsRow';

type TagGroups = ReturnType<typeof analyzeTagGroups>;

interface TagActions {
  addBrace: () => void;
  addBracket: () => void;
  setNumeric: (w: number) => void;
  clearWeight: () => void;
  convertSDToNAI: () => void;
  deleteTag: () => void;
  toggleHide: () => void;
}

interface SelectedTagPanelProps {
  rawMode: boolean;
  hasSelection: boolean;
  selectedTags: Set<number>;
  parsedTags: string[];
  tagGroups: TagGroups;
  selectedTag: string | null;
  editingTagText: string | null;
  selectedPostCount: number | null;
  singleCleanTag: string | null;
  currentNumericWeight: number | null;
  weightPresets: number[];
  tagTranslations: Map<string, string>;
  tagActions: TagActions;
  editInputRef: React.RefObject<HTMLInputElement | null>;
  onEditingTagTextChange: (value: string | null) => void;
  onTriggerAutocomplete: (text: string) => void;
  onCommitTagEdit: () => void;
  onCancelTagEdit: () => void;
  onOpenWikiPreview: (tag: string) => void;
  onRebuildValue: (tags: string[]) => void;
  onSelectedTagsChange: (tags: Set<number>) => void;
}

export const SelectedTagPanel: React.FC<SelectedTagPanelProps> = ({
  rawMode,
  hasSelection,
  selectedTags,
  parsedTags,
  tagGroups,
  selectedTag,
  editingTagText,
  selectedPostCount,
  singleCleanTag,
  currentNumericWeight,
  weightPresets,
  tagTranslations,
  tagActions,
  editInputRef,
  onEditingTagTextChange,
  onTriggerAutocomplete,
  onCommitTagEdit,
  onCancelTagEdit,
  onOpenWikiPreview,
  onRebuildValue,
  onSelectedTagsChange,
}) => {
  if (rawMode || !hasSelection) return null;

  const selectedIdx = Array.from(selectedTags).sort((a, b) => a - b);
  const markerData = selectedIdx.length === 1 ? parseCollapsibleMarker(parsedTags[selectedIdx[0]]) : null;

  if (markerData) {
    const tagCount = markerData.content.split(/[,，]/).filter(t => t.trim()).length;
    const markerCfg = getMarkerVisual(markerData.type);
    const MarkerIcon = markerCfg.Icon;
    return (
      <div className="flex-shrink-0 bg-nai-panel border-t border-white/[0.06] px-4 py-2 space-y-1.5">
        <div className="flex items-center gap-2">
          <MarkerIcon className="w-4 h-4 shrink-0 text-nai-accent" strokeWidth={2} />
          <span className="text-sm font-medium text-white/90 truncate">{markerData.name}</span>
          <span className="text-xs text-white/30">{markerCfg.label} · {tagCount} 个标签</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            className="h-8 flex-1 text-xs bg-nai-accent/15 active:bg-nai-accent/30 text-nai-accent rounded-lg transition-colors"
            onClick={() => {
              const t = [...parsedTags];
              t.splice(selectedIdx[0], 1, ...markerData.content.split(/[,，]/).map(s => s.trim()).filter(s => s));
              onRebuildValue(t);
              onSelectedTagsChange(new Set());
            }}
          >展开为标签</button>
          <button
            className="h-8 flex-1 text-xs bg-red-500/10 active:bg-red-500/25 text-red-400/70 active:text-red-400 rounded-lg transition-colors flex items-center justify-center gap-1"
            onClick={() => tagActions.deleteTag()}
          >
            <Trash2 className="w-3.5 h-3.5" /> 删除
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-shrink-0 bg-nai-panel border-t border-white/[0.06] px-4 py-2 space-y-1.5">
      {(() => {
        const hasSDFormat = selectedIdx.some(i => isSDWeightFormat(parsedTags[i]));
        if (!hasSDFormat) return null;
        const sdInfo = selectedIdx.length === 1 ? parseSDWeight(parsedTags[selectedIdx[0]]) : null;
        return (
          <div className="flex items-center gap-2 px-2 py-1.5 bg-amber-500/10 rounded-lg">
            <span className="text-[10px] text-amber-300">⚠️ SD WebUI 格式</span>
            {sdInfo && <span className="text-[10px] text-amber-200/60">{sdInfo.weight !== null ? `权重: ${sdInfo.weight}` : '无权重 → {}'}</span>}
            <div className="flex-1" />
            <button className="px-2 py-0.5 text-[10px] bg-amber-500/30 active:bg-amber-500/50 text-amber-100 rounded transition-colors"
              onClick={() => tagActions.convertSDToNAI()}>转换为 NAI</button>
          </div>
        );
      })()}
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0 flex flex-col">
          {editingTagText !== null && selectedTags.size === 1 ? (
            <div className="flex items-center gap-1.5">
              <input
                ref={editInputRef}
                type="text"
                value={editingTagText}
                onChange={(e) => { onEditingTagTextChange(e.target.value); onTriggerAutocomplete(e.target.value); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); onCommitTagEdit(); }
                  else if (e.key === 'Escape') { e.preventDefault(); onCancelTagEdit(); }
                }}
                className="flex-1 min-w-0 bg-white/5 text-[#fceda4] text-sm font-tag outline-none px-2 py-1 rounded-lg border border-[#fceda4]/30 focus:border-[#fceda4]/60"
                autoFocus
              />
              <button
                className="h-8 w-8 flex items-center justify-center rounded-lg bg-green-500/20 active:bg-green-500/40 text-green-300 transition-colors"
                onClick={onCommitTagEdit}
              >
                <Check className="w-4 h-4" />
              </button>
              <button
                className="h-8 w-8 flex items-center justify-center rounded-lg bg-white/5 active:bg-white/15 text-white/40 transition-colors"
                onClick={onCancelTagEdit}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : selectedTags.size === 1 && selectedTag ? (
            <button
              className="flex items-center gap-1.5 min-w-0 text-left"
              onClick={() => {
                if (!isCollapsibleMarker(selectedTag)) {
                  onEditingTagTextChange(selectedTag.trim());
                  setTimeout(() => editInputRef.current?.focus(), 50);
                }
              }}
            >
              <div className="flex-1 min-w-0 flex flex-col">
                <span className="flex items-baseline gap-1.5 min-w-0">
                  <span className="font-tag text-sm text-[#fceda4] truncate">{cleanTagName(selectedTag).replace(/ /g, '_')}</span>
                  {selectedPostCount != null && selectedPostCount > 0 && (
                    <span className="shrink-0 text-[11px] tabular-nums text-white/40" title={`Danbooru 引用数：${selectedPostCount}`}>
                      {selectedPostCount >= 1000 ? `${(selectedPostCount / 1000).toFixed(0)}k` : selectedPostCount}
                    </span>
                  )}
                </span>
                {tagTranslations.get(cleanTagName(selectedTag)) && (
                  <span className="text-xs text-white/40 truncate">{tagTranslations.get(cleanTagName(selectedTag))}</span>
                )}
              </div>
            </button>
          ) : (
            <span className="text-sm text-[#fceda4]">已选 {selectedTags.size} 个标签</span>
          )}
        </div>
        {editingTagText === null && (
          <div className="flex-shrink-0 flex items-center gap-1.5">
            {singleCleanTag && (
              <button
                className="h-8 w-8 flex items-center justify-center rounded-lg bg-white/5 active:bg-white/15 text-white/40 active:text-white/80 transition-colors"
                onClick={() => onOpenWikiPreview(singleCleanTag)}
                title="Wiki 预览"
              >
                <Eye className="w-4 h-4" />
              </button>
            )}
            {selectedTags.size >= 1 && (
              <button
                className="h-8 w-8 flex items-center justify-center rounded-lg bg-white/5 active:bg-white/15 text-white/40 active:text-white/80 transition-colors"
                onClick={() => {
                  const { extracted } = extractTagsFromList(parsedTags, selectedTags, tagGroups);
                  navigator.clipboard?.writeText(extracted.join(', '));
                }}
              >
                <Copy className="w-4 h-4" />
              </button>
            )}
            {selectedTags.size >= 1 && (
              <button
                className="h-8 w-8 flex items-center justify-center rounded-lg bg-white/5 active:bg-white/15 text-white/40 active:text-white/80 transition-colors"
                onClick={() => {
                  const { extracted, remaining } = extractTagsFromList(parsedTags, selectedTags, tagGroups);
                  onRebuildValue([...extracted, ...remaining]);
                  onSelectedTagsChange(new Set(extracted.map((_, i) => i)));
                }}
              >
                <ArrowUp className="w-4 h-4" />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <button className="h-8 px-3 text-sm bg-[#74270D]/60 active:bg-[#74270D] text-orange-200 rounded-lg transition-colors" onClick={() => tagActions.addBrace()}>{'{+}'}</button>
        <button className="h-8 px-3 text-sm bg-blue-500/20 active:bg-blue-500/40 text-blue-200 rounded-lg transition-colors" onClick={() => tagActions.addBracket()}>{'[-]'}</button>
        <div className="flex-1" />
        <button className="h-8 w-8 flex items-center justify-center text-sm bg-blue-500/15 active:bg-blue-500/30 text-blue-200 rounded-lg transition-colors"
          onClick={() => tagActions.setNumeric(stepNumericWeight(currentNumericWeight ?? 1, -0.1))}>−</button>
        <span className="h-8 w-10 flex items-center justify-center text-[11px] font-mono tabular-nums text-white/70 bg-white/5 rounded-lg">
          {(currentNumericWeight ?? 1).toFixed(1)}
        </span>
        <button className="h-8 w-8 flex items-center justify-center text-sm bg-[#74270D]/40 active:bg-[#74270D]/70 text-orange-200 rounded-lg transition-colors"
          onClick={() => tagActions.setNumeric(stepNumericWeight(currentNumericWeight ?? 1, 0.1))}>+</button>
      </div>
      <div className="flex items-center gap-1.5">
        {weightPresets.map(w => (
          <button
            key={w}
            className={`h-8 flex-1 text-xs font-mono tabular-nums rounded-lg transition-colors ${currentNumericWeight !== null && Math.abs(currentNumericWeight - w) < 0.01 ? 'ring-1 ring-inset ring-[#fceda4]/50 ' : ''
              }${w > 1 ? 'bg-[#74270D]/40 active:bg-[#74270D]/70 text-orange-200' : 'bg-blue-500/15 active:bg-blue-500/30 text-blue-200'}`}
            onClick={() => tagActions.setNumeric(w)}
          >{w}</button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <button className="h-8 flex-1 text-xs bg-white/5 active:bg-white/15 text-white/50 rounded-lg transition-colors" onClick={() => tagActions.clearWeight()}>清除权重</button>
        <button className="h-8 flex-1 text-xs bg-white/5 active:bg-white/15 text-white/40 active:text-[#fceda4] rounded-lg transition-colors flex items-center justify-center gap-1" onClick={() => tagActions.toggleHide()}>{(() => { const idx = selectedIdx[0]; return parsedTags[idx]?.trim().startsWith('~') ? <><Eye className="w-3.5 h-3.5" /> 启用</> : <><EyeOff className="w-3.5 h-3.5" /> 禁用</>; })()}</button>
        <button className="h-8 flex-1 text-xs bg-red-500/10 active:bg-red-500/25 text-red-400/70 active:text-red-400 rounded-lg transition-colors flex items-center justify-center gap-1" onClick={() => tagActions.deleteTag()}>
          <Trash2 className="w-3.5 h-3.5" /> 删除
        </button>
      </div>
      {editingTagText === null && (
        <RelatedTagsRow
          hideNav
          anchorTags={Array.from(selectedTags)
            .map(i => parsedTags[i])
            .filter(t => t && t !== NEWLINE_SENTINEL && !isCollapsibleMarker(t))
            .map(t => cleanTagName(t))}
          existingTagSet={new Set(parsedTags.map(t => cleanTagName(t).toLowerCase().replace(/\s+/g, '_')))}
          onAdd={(addedTag, addToEnd) => {
            const newTags = [...parsedTags];
            if (addToEnd || selectedTags.size === 0) {
              newTags.push(addedTag);
            } else {
              const lastIdx = Math.max(...Array.from(selectedTags));
              newTags.splice(lastIdx + 1, 0, addedTag);
            }
            onRebuildValue(newTags);
          }}
        />
      )}
    </div>
  );
};
