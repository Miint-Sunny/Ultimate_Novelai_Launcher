import React from 'react';
import {
  Dices,
  Languages,
  Palette,
  Sparkles,
  Tag,
  User,
  Users,
} from 'lucide-react';
import type { TagSuggestion } from '../../../services/tagAutocomplete';

interface SuggestionStripProps {
  showSuggestions: boolean;
  suggestions: TagSuggestion[];
  selectedSuggIdx: number;
  hasSelection: boolean;
  editingTagText: string | null;
  onCommitInput: (text: string) => void;
  onSelectSuggestion: (suggestion: TagSuggestion) => void;
}

export const SuggestionStrip: React.FC<SuggestionStripProps> = ({
  showSuggestions,
  suggestions,
  selectedSuggIdx,
  hasSelection,
  editingTagText,
  onCommitInput,
  onSelectSuggestion,
}) => {
  if (!showSuggestions || suggestions.length === 0 || (hasSelection && editingTagText === null)) {
    return null;
  }

  const tagSuggestions = suggestions.filter(s => s.source !== 'local' && !s.isArtist && !s.isOC && !s.isAiLoading);
  const aiLoading = suggestions.some(s => s.isAiLoading);
  const charAndOCSuggestions = suggestions.filter(s => (s.source === 'local' && !s.isArtist) || s.isOC);
  const artistSuggestions = suggestions.filter(s => s.isArtist);
  const swipeHandlers = {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      (e.currentTarget as any)._touchStart = { x: t.clientX, y: t.clientY };
      (e.currentTarget as any)._swiped = false;
    },
    onTouchMove: (e: React.TouchEvent) => {
      const start = (e.currentTarget as any)._touchStart;
      if (!start) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - start.x) > 8 || Math.abs(t.clientY - start.y) > 8) {
        (e.currentTarget as any)._swiped = true;
      }
    },
  };

  const renderSuggButton = (suggestion: TagSuggestion, index: number) => {
    const isSel = index === selectedSuggIdx;
    const baseClass = isSel
      ? 'bg-[#fceda4]/20 text-[#fceda4]'
      : 'bg-white/[0.06] text-white/80 active:bg-[#fceda4]/15';

    const renderIcon = () => {
      const iconClass = 'w-3 h-3';
      if (suggestion.isNaturalLanguage) return <Languages className={iconClass} />;
      if (suggestion.isArtist) return <Palette className={iconClass} />;
      if (suggestion.isOC) return <Users className={iconClass} />;
      if (suggestion.isOrigin) return <Dices className={iconClass} />;
      if (suggestion.source === 'local' && !suggestion.isArtist && !suggestion.isOC) return <User className={iconClass} />;
      if (suggestion.verified && !suggestion.postCount) return <Sparkles className={iconClass} />;
      return <Tag className={iconClass} />;
    };

    let subText = '';
    if (suggestion.isNaturalLanguage) subText = '直接翻译为英文';
    else if (suggestion.isArtist) subText = '画师串';
    else if (suggestion.isOC) subText = `${suggestion.chineseName || 'OC'}`;
    else if (suggestion.isOrigin) subText = `${suggestion.chineseName || suggestion.value} · ${suggestion.originCharCount}个角色`;
    else if (suggestion.chineseName) subText = `${suggestion.chineseName}${suggestion.category ? ` · ${suggestion.category}` : ''}`;

    const handleClick = () => {
      if (suggestion.isOrigin) {
        const chars = suggestion.originCharacters || [];
        if (chars.length > 0) {
          const randomChar = chars[Math.floor(Math.random() * chars.length)];
          onCommitInput(randomChar);
        }
      } else {
        onSelectSuggestion(suggestion);
      }
    };

    return (
      <button
        key={`${suggestion.value}-${suggestion.isNaturalLanguage ? 'nl' : suggestion.isArtist ? 'artist' : suggestion.isOC ? 'oc' : suggestion.isOrigin ? 'origin' : suggestion.source}`}
        className={`flex-shrink-0 px-2.5 py-1.5 rounded-lg transition-colors ${baseClass}`}
        style={{ animation: 'mobileSuggItemIn 0.18s ease-out both' }}
        onMouseDown={(e) => e.preventDefault()}
        onTouchEnd={(e) => {
          e.preventDefault();
          const container = e.currentTarget.parentElement;
          if (container && (container as any)._swiped) return;
          handleClick();
        }}
        onClick={handleClick}
      >
        <span className="flex flex-col items-start">
          <span className={`flex items-center gap-1 ${suggestion.isNaturalLanguage ? 'text-[14px]' : 'font-tag text-[14px]'} leading-tight whitespace-nowrap`}>
            {renderIcon()} {suggestion.isNaturalLanguage ? suggestion.label : suggestion.value}
            {suggestion.postCount && !suggestion.isOrigin && !suggestion.isArtist && !suggestion.isOC && (
              <span className="text-[9px] text-white/25 ml-1">
                {suggestion.postCount >= 1000 ? `${(suggestion.postCount / 1000).toFixed(0)}k` : suggestion.postCount}
              </span>
            )}
          </span>
          {subText ? (
            <span className={`text-[11px] leading-tight whitespace-nowrap ${isSel ? 'text-[#fceda4]/50' : 'text-white/35'}`}>
              {subText}
            </span>
          ) : (
            <span className="text-[11px] leading-tight whitespace-nowrap text-white/20 animate-pulse">翻译中…</span>
          )}
        </span>
      </button>
    );
  };

  return (
    <div className="flex-shrink-0 bg-nai-panel border-t border-white/[0.06] px-2 py-1.5 space-y-1">
      {artistSuggestions.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide" {...swipeHandlers}>
          {artistSuggestions.map((s) => renderSuggButton(s, suggestions.indexOf(s)))}
        </div>
      )}
      {charAndOCSuggestions.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide" {...swipeHandlers}>
          {charAndOCSuggestions.map((s) => renderSuggButton(s, suggestions.indexOf(s)))}
        </div>
      )}
      {(tagSuggestions.length > 0 || aiLoading) && (
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide" {...swipeHandlers}>
          {tagSuggestions.map((s) => renderSuggButton(s, suggestions.indexOf(s)))}
          {aiLoading && (
            <div className="flex-shrink-0 px-2.5 py-1.5 rounded-lg bg-white/[0.04] flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 border-2 border-[#fceda4]/20 border-t-[#fceda4]/60 rounded-full animate-spin" />
              <span className="text-[11px] text-white/30 whitespace-nowrap">AI 推荐中…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
