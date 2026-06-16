import React from 'react';

type TranslationType = 'positive' | 'negative';

type TranslationCache = Record<TranslationType, Map<string, string>>;

interface TranslationOverlayProps {
  text: string;
  type: TranslationType;
  translationCache: TranslationCache;
  onClose: () => void;
  onTagClick: (startIndex: number, length: number, type: TranslationType) => void;
}

export const TranslationOverlay: React.FC<TranslationOverlayProps> = ({
  text,
  type,
  translationCache,
  onClose,
  onTagClick,
}) => {
  const parts = text.split(/([,，])/);
  let currentOffset = 0;
  const cache = translationCache[type];

  return (
    <div
      className="absolute inset-0 z-50 p-2 pr-6 font-mono text-sm leading-5 overflow-y-auto scrollbar-hide select-none whitespace-pre-wrap break-words"
      onClick={onClose}
    >
      {parts.map((part, i) => {
        const isSeparator = /[,，]/.test(part);
        const offset = currentOffset;
        currentOffset += part.length;

        if (isSeparator) {
          return <span key={i} className="text-gray-500">{part}</span>;
        }

        if (!part.trim()) {
          if (part.includes('\n')) return <br key={i} />;
          return <span key={i} className="whitespace-pre">{part}</span>;
        }

        const cleanPart = part.trim();
        const leadingSpaces = part.length - part.trimStart().length;
        const trailingSpaces = part.length - part.trimEnd().length;
        const actualOffset = offset + leadingSpaces;
        const actualLength = cleanPart.length;

        const translation = cache.get(cleanPart);
        const hasTranslation = translation && translation !== cleanPart;

        const leadingSpaceSpan = leadingSpaces > 0 ? (
          <span key={`${i}-lead`} className="whitespace-pre">{part.slice(0, leadingSpaces)}</span>
        ) : null;

        const trailingSpaceSpan = trailingSpaces > 0 ? (
          <span key={`${i}-trail`} className="whitespace-pre">{part.slice(part.length - trailingSpaces)}</span>
        ) : null;

        return (
          <React.Fragment key={i}>
            {leadingSpaceSpan}
            <span
              className={`cursor-pointer hover:bg-[#fceda4]/15 hover:text-white rounded px-0.5 -mx-0.5 transition-colors ${hasTranslation ? 'text-[#fceda4]/90' : 'text-gray-300'}`}
              onClick={(e) => {
                e.stopPropagation();
                onTagClick(actualOffset, actualLength, type);
              }}
              title={hasTranslation ? `原文: ${cleanPart}` : undefined}
            >
              {hasTranslation ? translation : cleanPart}
            </span>
            {trailingSpaceSpan}
          </React.Fragment>
        );
      })}
    </div>
  );
};
