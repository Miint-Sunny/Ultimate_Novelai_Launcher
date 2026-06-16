import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Dices, Eye, EyeOff, Languages, Palette, Sparkles, Tag, User, Users } from 'lucide-react';
import {
  lookupCharacterChineseName,
  type TagSuggestion,
} from '../../services/tagAutocomplete';
import { getAppSettings } from '../../services/localLibrary';
import { canCheckSuggestionWiki, normalizeWikiTagKey } from './wikiUtils';

interface CursorPosition {
  top: number;
  left: number;
}

interface SuggestionDropdownProps {
  suggestions: TagSuggestion[];
  selectedIndex: number;
  cursorPosition: CursorPosition | null;
  suggestionWikiMap: Record<string, boolean>;
  suggestionsRef: RefObject<HTMLDivElement | null>;
  onSelect: (suggestion: TagSuggestion) => void;
  onHighlight: (index: number) => void;
  onShowWikiPreview: (suggestion: TagSuggestion, anchor: HTMLElement, showLoading: boolean) => void;
  onHideWikiPreview: () => void;
}

const SECTION_MAX_H: Record<string, number> = {
  nl: 47,
  artists: 141,
  ocs: 141,
  characters: 141,
  origins: 141,
  danbooru: 282,
};

function getSectionInfo(suggestion: TagSuggestion) {
  if (suggestion.isAiLoading) return { key: 'danbooru', label: '标签', color: '#fcd34d', Icon: Tag };
  if (suggestion.isNaturalLanguage) return { key: 'nl', label: '翻译', color: '#67e8f9', Icon: Languages };
  if (suggestion.isArtist) return { key: 'artists', label: '画师', color: '#f0abfc', Icon: Palette };
  if (suggestion.isOC) return { key: 'ocs', label: 'OC', color: '#86efac', Icon: Users };
  if (suggestion.isOrigin) return { key: 'origins', label: '作品', color: '#d8b4fe', Icon: Dices };
  if (suggestion.source === 'local') return { key: 'characters', label: '角色', color: '#7dd3fc', Icon: User };
  return { key: 'danbooru', label: '标签', color: '#fcd34d', Icon: Tag };
}

function getTypeInfo(suggestion: TagSuggestion) {
  if (suggestion.isNaturalLanguage) return { color: '#67e8f9', Icon: Languages };
  if (suggestion.isArtist) return { color: '#f0abfc', Icon: Palette };
  if (suggestion.isOC) return { color: '#86efac', Icon: Users };
  if (suggestion.isOrigin) return { color: '#d8b4fe', Icon: Dices };
  if (suggestion.source === 'local') return { color: '#7dd3fc', Icon: User };
  if (suggestion.verified && !suggestion.postCount) return { color: '#fceda4', Icon: Sparkles };
  return { color: '#fcd34d', Icon: Tag };
}

export function SuggestionDropdown({
  suggestions,
  selectedIndex,
  cursorPosition,
  suggestionWikiMap,
  suggestionsRef,
  onSelect,
  onHighlight,
  onShowWikiPreview,
  onHideWikiPreview,
}: SuggestionDropdownProps) {
  if (suggestions.length === 0 || !cursorPosition) return null;

  const sectionsMap = new Map<string, { label: string; color: string; Icon: typeof Tag; items: { s: TagSuggestion; index: number }[] }>();
  const orderKeys: string[] = [];
  suggestions.forEach((s, index) => {
    const info = getSectionInfo(s);
    if (!sectionsMap.has(info.key)) {
      sectionsMap.set(info.key, { label: info.label, color: info.color, Icon: info.Icon, items: [] });
      orderKeys.push(info.key);
    }
    sectionsMap.get(info.key)!.items.push({ s, index });
  });
  const sections = orderKeys.map(k => ({ key: k, ...sectionsMap.get(k)! }));
  const isMulti = sections.length > 1;

  return createPortal(
    <div
      ref={suggestionsRef}
      className="suggestion-dropdown fixed z-[99999] bg-[#0f0f0f] rounded-md shadow-[0_16px_40px_-10px_rgba(0,0,0,0.85),0_0_0_1px_rgba(252,237,164,0.08)] overflow-hidden flex flex-col"
      style={computeDropdownStyle(cursorPosition, suggestions.length, sections, isMulti)}
    >
      {sections.map((sec) => (
        <div key={sec.key} className="flex flex-col min-h-0">
          <div className="overflow-y-auto scrollbar-hide" style={{ maxHeight: isMulti ? (SECTION_MAX_H[sec.key] ?? 168) : 360 }}>
            {sec.items.map(({ s: suggestion, index }) => (
              <SuggestionRow
                key={`${suggestion.value}-${suggestion.isNaturalLanguage ? 'nl' : suggestion.isArtist ? 'artist' : suggestion.isOC ? 'oc' : suggestion.isOrigin ? 'origin' : suggestion.source}`}
                suggestion={suggestion}
                index={index}
                isSelected={index === selectedIndex}
                wikiState={suggestionWikiMap[normalizeWikiTagKey(suggestion.value)]}
                onSelect={onSelect}
                onHighlight={onHighlight}
                onShowWikiPreview={onShowWikiPreview}
                onHideWikiPreview={onHideWikiPreview}
              />
            ))}
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}

function computeDropdownStyle(
  cursorPosition: CursorPosition,
  suggestionCount: number,
  sections: Array<{ key: string; items: { s: TagSuggestion; index: number }[] }>,
  isMulti: boolean,
) {
  const MAX_H = 600;
  const GAP = 4;
  const MARGIN = 8;
  const MIN_H = 120;
  const ITEM_H = 47;
  const vh = window.innerHeight;
  const cursorBottomVp = cursorPosition.top - window.scrollY;
  const cursorTopVp = cursorBottomVp - 18;
  const spaceBelow = vh - cursorBottomVp - MARGIN - GAP;
  const spaceAbove = cursorTopVp - MARGIN - GAP;
  const desiredH = Math.min(
    MAX_H,
    isMulti
      ? sections.reduce((acc, s) => acc + Math.min(SECTION_MAX_H[s.key] ?? 168, s.items.length * ITEM_H), 0)
      : Math.min(360, suggestionCount * ITEM_H),
  );
  const placeAbove = desiredH > spaceBelow && spaceAbove > spaceBelow;
  const maxH = Math.max(MIN_H, Math.min(desiredH, placeAbove ? spaceAbove : spaceBelow));
  const top = placeAbove ? cursorTopVp - GAP - maxH : cursorBottomVp + GAP;
  const left = cursorPosition.left - window.scrollX;
  return { top, left, minWidth: 240, maxWidth: 380, maxHeight: maxH };
}

interface SuggestionRowProps {
  suggestion: TagSuggestion;
  index: number;
  isSelected: boolean;
  wikiState: boolean | undefined;
  onSelect: (suggestion: TagSuggestion) => void;
  onHighlight: (index: number) => void;
  onShowWikiPreview: (suggestion: TagSuggestion, anchor: HTMLElement, showLoading: boolean) => void;
  onHideWikiPreview: () => void;
}

function SuggestionRow({
  suggestion,
  index,
  isSelected,
  wikiState,
  onSelect,
  onHighlight,
  onShowWikiPreview,
  onHideWikiPreview,
}: SuggestionRowProps) {
  if (suggestion.isAiLoading) {
    return (
      <div key="__ai_loading__" data-sugg-idx={index} className="px-3 py-2 flex items-center gap-2 text-[#8b949e] border-l-2 border-transparent">
        <span className="shrink-0 inline-block w-3.5 h-3.5 border-[1.5px] border-[#fceda4]/20 border-t-[#fceda4]/60 rounded-full animate-spin" />
        <span className="text-[11px]">AI 推荐加载中…</span>
      </div>
    );
  }

  const typeInfo = getTypeInfo(suggestion);
  const { Icon } = typeInfo;
  const mainText = suggestion.isNaturalLanguage ? suggestion.label : suggestion.value;
  const subtitle = suggestion.isNaturalLanguage
    ? suggestion.chineseName
    : suggestion.isArtist
      ? '画师串'
      : suggestion.isOC
        ? (suggestion.chineseName || 'OC')
        : suggestion.isOrigin
          ? `${suggestion.chineseName || ''}${suggestion.chineseName ? ' · ' : ''}${suggestion.originCharCount}个角色`
          : (suggestion.chineseName && getAppSettings().autocompleteShowWiki ? suggestion.chineseName : null);
  const countText = suggestion.postCount && !suggestion.isOrigin && !suggestion.isArtist && !suggestion.isOC
    ? (suggestion.postCount >= 1000 ? `${(suggestion.postCount / 1000).toFixed(0)}k` : String(suggestion.postCount))
    : null;

  return (
    <div
      data-sugg-idx={index}
      className={`sugg-item px-2.5 py-1.5 cursor-pointer flex items-center gap-2 border-l-2 transition-colors duration-150 ${isSelected ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'}`}
      style={{ borderLeftColor: isSelected ? typeInfo.color : `${typeInfo.color}55` }}
      onClick={() => selectSuggestionOrOrigin(suggestion, onSelect)}
      onMouseEnter={() => onHighlight(index)}
    >
      <Icon className="shrink-0 w-3.5 h-3.5 transition-opacity duration-150" style={{ color: typeInfo.color, opacity: isSelected ? 1 : 0.75 }} />
      <div className="flex flex-col min-w-0 flex-1 overflow-hidden leading-tight gap-0.5">
        <span className={`${suggestion.isNaturalLanguage ? 'text-[14px]' : 'font-tag text-[14px]'} truncate transition-colors duration-150 ${isSelected ? 'text-white' : 'text-[#d4d4d4]'}`} title={mainText}>
          {mainText}
        </span>
        {subtitle && (
          <span className={`chinese-name-fade text-[11px] truncate transition-colors duration-150 ${isSelected ? 'text-white/55' : 'text-[#6e7681]'}`} title={subtitle}>
            {subtitle}
          </span>
        )}
      </div>
      {countText && (
        <span className={`shrink-0 ml-auto text-right text-[10px] tabular-nums transition-colors duration-150 ${isSelected ? 'text-white/60' : 'text-[#6e7681]'}`}>
          {countText}
        </span>
      )}
      {canCheckSuggestionWiki(suggestion) && (
        wikiState === false ? (
          <span
            className={`shrink-0 ${countText ? '' : 'ml-auto'} p-2 rounded text-[#6e7681]/35 cursor-default inline-flex items-center justify-center`}
            title="无 Wiki 数据"
            onMouseDown={(e) => e.preventDefault()}
          >
            <EyeOff className="w-4 h-4" />
          </span>
        ) : (
          <button
            type="button"
            className={`shrink-0 ${countText ? '' : 'ml-auto'} p-2 rounded text-[#6e7681] hover:text-[#fceda4] hover:bg-white/[0.08] transition-colors inline-flex items-center justify-center`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={(e) => {
              e.stopPropagation();
              onShowWikiPreview(suggestion, e.currentTarget, wikiState === true);
            }}
            onMouseLeave={onHideWikiPreview}
          >
            <Eye className="w-4 h-4" />
          </button>
        )
      )}
    </div>
  );
}

function selectSuggestionOrOrigin(suggestion: TagSuggestion, onSelect: (suggestion: TagSuggestion) => void) {
  if (!suggestion.isOrigin) {
    onSelect(suggestion);
    return;
  }

  const chars = suggestion.originCharacters || [];
  if (chars.length === 0) return;
  const randomChar = chars[Math.floor(Math.random() * chars.length)];
  onSelect({
    ...suggestion,
    value: randomChar,
    chineseName: lookupCharacterChineseName(randomChar),
    isOrigin: false,
  });
}
