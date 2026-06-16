import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';
import { lookupCharacterChineseName, type TagSuggestion } from '../../services/tagAutocomplete';

interface EditingTagState {
  index: number;
  text: string;
  width: number;
  height: number;
}

interface DesktopInlineTagEditorProps {
  index: number;
  editingTag: EditingTagState;
  editInputRef: RefObject<HTMLInputElement | null>;
  showSuggestions: boolean;
  displaySuggs: TagSuggestion[];
  selectedSuggIdx: number;
  setSelectedSuggIdx: Dispatch<SetStateAction<number>>;
  selectSuggestion: (suggestion: TagSuggestion) => void;
  triggerAutocomplete: (text: string) => void;
  commitEdit: (index: number, newText: string) => void;
  cancelEdit: () => void;
  setEditingTag: Dispatch<SetStateAction<EditingTagState | null>>;
  setShowSuggestions: Dispatch<SetStateAction<boolean>>;
  setSuggestions: Dispatch<SetStateAction<TagSuggestion[]>>;
}

export function DesktopInlineTagEditor({
  index,
  editingTag,
  editInputRef,
  showSuggestions,
  displaySuggs,
  selectedSuggIdx,
  setSelectedSuggIdx,
  selectSuggestion,
  triggerAutocomplete,
  commitEdit,
  cancelEdit,
  setEditingTag,
  setShowSuggestions,
  setSuggestions,
}: DesktopInlineTagEditorProps) {
  const handleSuggestionKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions || displaySuggs.length === 0) return false;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedSuggIdx(prev => {
        let next = (prev + 1) % displaySuggs.length;
        if (displaySuggs[next]?.isAiLoading) next = (next + 1) % displaySuggs.length;
        return next;
      });
      return true;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedSuggIdx(prev => {
        let next = (prev - 1 + displaySuggs.length) % displaySuggs.length;
        if (displaySuggs[next]?.isAiLoading) next = (next - 1 + displaySuggs.length) % displaySuggs.length;
        return next;
      });
      return true;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const suggestion = displaySuggs[selectedSuggIdx];
      if (suggestion && !suggestion.isAiLoading) {
        if (suggestion.isOrigin) {
          const chars = suggestion.originCharacters || [];
          if (chars.length > 0) {
            const randomCharacter = chars[Math.floor(Math.random() * chars.length)];
            selectSuggestion({
              ...suggestion,
              value: randomCharacter,
              chineseName: lookupCharacterChineseName(randomCharacter),
              isOrigin: false,
            });
          }
        } else {
          selectSuggestion(suggestion);
        }
      }
      event.stopPropagation();
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setShowSuggestions(false);
      setSuggestions([]);
      event.stopPropagation();
      return true;
    }
    return false;
  };

  return (
    <div className="inline-flex items-center rounded border border-[#fceda4]/50 bg-[#fceda4]/10" style={{ width: editingTag.width, height: editingTag.height }}>
      <input
        ref={editInputRef}
        type="text"
        value={editingTag.text}
        onChange={(event) => {
          const newText = event.target.value;
          setEditingTag(prev => prev ? { ...prev, text: newText } : null);
          triggerAutocomplete(newText);
        }}
        onKeyDown={(event) => {
          if (handleSuggestionKeyDown(event)) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            commitEdit(index, editingTag.text);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            cancelEdit();
          }
          event.stopPropagation();
        }}
        onBlur={(event) => {
          const related = event.relatedTarget as HTMLElement | null;
          if (related?.closest('.chip-suggestion-dropdown')) return;
          setTimeout(() => {
            if (!showSuggestions) commitEdit(index, editingTag.text);
            else commitEdit(index, editingTag.text);
          }, 150);
        }}
        onClick={(event) => event.stopPropagation()}
        className="bg-transparent text-[#fceda4] text-sm font-tag outline-none px-1.5 py-0.5 w-full"
        autoFocus
      />
    </div>
  );
}
