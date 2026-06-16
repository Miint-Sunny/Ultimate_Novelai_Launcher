import React from 'react';
import type {
  Dispatch,
  DragEvent,
  KeyboardEvent,
  MutableRefObject,
  RefObject,
  SetStateAction,
} from 'react';
import { Plus } from 'lucide-react';
import { type TagSuggestion } from '../../services/tagAutocomplete';
import {
  NEWLINE_SENTINEL,
  parseCollapsibleMarker,
  type TagGroupInfo,
} from '../../utils/promptTags';
import { DesktopInlineTagEditor } from './DesktopInlineTagEditor';
import { DesktopMarkerChip, DesktopTagChip } from './DesktopPromptChips';

interface EditingTagState {
  index: number;
  text: string;
  width: number;
  height: number;
}

interface DesktopChipListProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  chipContainerRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  editInputRef: RefObject<HTMLInputElement | null>;
  chipRefsMap: MutableRefObject<Map<number, HTMLElement>>;
  parsedTags: string[];
  tagGroups: TagGroupInfo[];
  selectedTags: Set<number>;
  tagTranslations: Map<string, string>;
  translatingTags: Set<string>;
  inputText: string;
  placeholder: string;
  nlTranslating: boolean;
  editingTag: EditingTagState | null;
  dragIndex: number | null;
  dragOverIndex: number | null;
  dragGhostInfo: { text: string; sub?: string } | null;
  showSuggestions: boolean;
  displaySuggs: TagSuggestion[];
  selectedSuggIdx: number;
  handleContainerClick: () => void;
  handleContainerDragOver: (event: DragEvent<HTMLDivElement>) => void;
  handleDragStart: (event: DragEvent, index: number) => void;
  handleDragEnd: (event: DragEvent) => void;
  handleDragOver: (event: DragEvent, index: number) => void;
  handleChipClick: (event: React.MouseEvent, index: number) => void;
  handleChipDoubleClick: (event: React.MouseEvent, index: number) => void;
  handleInputChange: (text: string) => void;
  handleInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  handlePaste: (event: React.ClipboardEvent<HTMLInputElement>) => void;
  triggerAutocomplete: (text: string) => void;
  commitEdit: (index: number, newText: string) => void;
  cancelEdit: () => void;
  selectSuggestion: (suggestion: TagSuggestion) => void;
  rebuildValue: (tags: string[]) => void;
  setEditingTag: Dispatch<SetStateAction<EditingTagState | null>>;
  setSelectedSuggIdx: Dispatch<SetStateAction<number>>;
  setShowSuggestions: Dispatch<SetStateAction<boolean>>;
  setSuggestions: Dispatch<SetStateAction<TagSuggestion[]>>;
}

export function DesktopChipList({
  scrollRef,
  chipContainerRef,
  inputRef,
  editInputRef,
  chipRefsMap,
  parsedTags,
  tagGroups,
  selectedTags,
  tagTranslations,
  translatingTags,
  inputText,
  placeholder,
  nlTranslating,
  editingTag,
  dragIndex,
  dragOverIndex,
  dragGhostInfo,
  showSuggestions,
  displaySuggs,
  selectedSuggIdx,
  handleContainerClick,
  handleContainerDragOver,
  handleDragStart,
  handleDragEnd,
  handleDragOver,
  handleChipClick,
  handleChipDoubleClick,
  handleInputChange,
  handleInputKeyDown,
  handlePaste,
  triggerAutocomplete,
  commitEdit,
  cancelEdit,
  selectSuggestion,
  rebuildValue,
  setEditingTag,
  setSelectedSuggIdx,
  setShowSuggestions,
  setSuggestions,
}: DesktopChipListProps) {
  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-hide p-2" onClick={handleContainerClick} onDragOver={handleContainerDragOver}>
      <div ref={chipContainerRef} className="chip-container flex flex-wrap gap-x-1 gap-y-0 items-center content-start select-none">
        {parsedTags.map((rawTag, index) => {
          if (rawTag === NEWLINE_SENTINEL) {
            const isConsecutive = index > 0 && parsedTags[index - 1] === NEWLINE_SENTINEL;
            if (!isConsecutive) return <div key={`nl-${index}`} className="basis-full h-0" />;
            return <div key={`nl-${index}`} className="basis-full h-2" />;
          }
          const showDropIndicator = dragIndex !== null && dragOverIndex === index && dragIndex !== index && dragOverIndex !== dragIndex + 1;
          const dropPlaceholder = showDropIndicator && dragGhostInfo ? (
            <div className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border-2 border-dashed border-[#fceda4]/40 bg-[#fceda4]/8">
              <span className="flex flex-col items-start">
                <span className="font-tag text-xs leading-tight text-[#fceda4]/40">{dragGhostInfo.text}</span>
                {dragGhostInfo.sub && <span className="text-[10px] leading-tight text-[#fceda4]/20">{dragGhostInfo.sub}</span>}
              </span>
            </div>
          ) : null;
          const canInsert = dragIndex === null && editingTag === null && selectedTags.size === 0;
          const insertBtn = (
            <button
              key={`ins-${index}`}
              className={`chip-insert-btn inline-flex items-center justify-center w-0 h-5 rounded text-[#fceda4]/60${canInsert ? '' : ' !opacity-0 pointer-events-none'}`}
              onClick={canInsert ? (event: React.MouseEvent) => {
                event.stopPropagation();
                const tags = [...parsedTags];
                tags.splice(index, 0, 'new_tag');
                rebuildValue(tags);
                setTimeout(() => {
                  const chipEl = chipRefsMap.current.get(index);
                  const chipWidth = chipEl ? chipEl.getBoundingClientRect().width : 80;
                  const chipHeight = chipEl ? chipEl.getBoundingClientRect().height : 32;
                  setEditingTag({ index, text: '', width: Math.max(80, chipWidth), height: chipHeight });
                }, 0);
              } : undefined}
              title={canInsert ? '在此处插入标签' : undefined}
            >
              <Plus className="w-3 h-3 flex-shrink-0" />
            </button>
          );
          const markerInfo = parseCollapsibleMarker(rawTag);
          if (markerInfo) {
            return (
              <React.Fragment key={index}>
                {insertBtn}
                {dropPlaceholder}
                <DesktopMarkerChip
                  index={index}
                  markerInfo={markerInfo}
                  isSelected={selectedTags.has(index)}
                  chipRefsMap={chipRefsMap}
                  dragIndex={dragIndex}
                  handleDragStart={handleDragStart}
                  handleDragEnd={handleDragEnd}
                  handleDragOver={handleDragOver}
                  handleChipClick={handleChipClick}
                  handleChipDoubleClick={handleChipDoubleClick}
                />
              </React.Fragment>
            );
          }
          if (editingTag && editingTag.index === index) {
            return (
              <React.Fragment key={index}>
                {insertBtn}
                {dropPlaceholder}
                <DesktopInlineTagEditor
                  index={index}
                  editingTag={editingTag}
                  editInputRef={editInputRef}
                  showSuggestions={showSuggestions}
                  displaySuggs={displaySuggs}
                  selectedSuggIdx={selectedSuggIdx}
                  setSelectedSuggIdx={setSelectedSuggIdx}
                  selectSuggestion={selectSuggestion}
                  triggerAutocomplete={triggerAutocomplete}
                  commitEdit={commitEdit}
                  cancelEdit={cancelEdit}
                  setEditingTag={setEditingTag}
                  setShowSuggestions={setShowSuggestions}
                  setSuggestions={setSuggestions}
                />
              </React.Fragment>
            );
          }
          return (
            <React.Fragment key={index}>
              {insertBtn}
              {dropPlaceholder}
              <DesktopTagChip
                index={index}
                rawTag={rawTag}
                group={tagGroups[index]}
                parsedTags={parsedTags}
                tagGroups={tagGroups}
                selectedTags={selectedTags}
                tagTranslations={tagTranslations}
                translatingTags={translatingTags}
                chipRefsMap={chipRefsMap}
                dragIndex={dragIndex}
                handleDragStart={handleDragStart}
                handleDragEnd={handleDragEnd}
                handleDragOver={handleDragOver}
                handleChipClick={handleChipClick}
                handleChipDoubleClick={handleChipDoubleClick}
              />
            </React.Fragment>
          );
        })}
        <div className="relative inline-flex flex-1 min-w-[80px] my-[2px]">
          <input
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={(event) => handleInputChange(event.target.value)}
            onKeyDown={handleInputKeyDown}
            onPaste={handlePaste}
            placeholder={parsedTags.length === 0 ? placeholder : '继续添加...'}
            className="w-full bg-transparent text-white text-sm font-tag outline-none placeholder-gray-500 placeholder:text-sm py-0.5"
            onClick={(event) => event.stopPropagation()}
          />
          {nlTranslating && (
            <div className="absolute left-0 top-full mt-1 flex items-center gap-1.5 px-2.5 py-1 bg-[#1a1a1a]/90 backdrop-blur-md rounded-lg shadow-lg border border-cyan-500/20 z-50">
              <span className="inline-block w-3 h-3 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
              <span className="text-[11px] text-cyan-200/80">翻译中...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
