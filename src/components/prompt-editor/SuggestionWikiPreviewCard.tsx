import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink } from 'lucide-react';
import type { SuggestionWikiPreviewState } from './types';
import { clipWikiSummaryText } from './wikiUtils';

interface SuggestionWikiPreviewCardProps {
  preview: SuggestionWikiPreviewState | null;
  height: number | null;
  contentRef: RefObject<HTMLDivElement | null>;
  imageIndex: number;
  onKeepVisible: () => void;
  onHide: () => void;
}

export function SuggestionWikiPreviewCard({
  preview,
  height,
  contentRef,
  imageIndex,
  onKeepVisible,
  onHide,
}: SuggestionWikiPreviewCardProps) {
  if (!preview) return null;

  return createPortal(
    <div
      className={`wiki-preview-floating ${preview.closing ? 'is-closing' : ''} fixed z-[100000] w-[320px] max-w-[calc(100vw-16px)] overflow-x-hidden rounded-lg bg-[#111315] shadow-[0_20px_50px_-14px_rgba(0,0,0,0.9),0_0_0_1px_rgba(252,237,164,0.22)]`}
      style={computePreviewStyle(preview, height)}
      onMouseEnter={onKeepVisible}
      onMouseLeave={onHide}
    >
      {preview.loading ? (
        <div ref={contentRef} key={`loading-${preview.tag}`} className="wiki-preview-content h-28 flex items-center justify-center gap-2 text-[#fceda4]/75">
          <span className="inline-block w-4 h-4 border-2 border-[#fceda4]/20 border-t-[#fceda4] rounded-full animate-spin" />
          <span className="text-xs">加载 Wiki...</span>
        </div>
      ) : preview.data ? (
        <SuggestionWikiPreviewContent
          preview={preview}
          contentRef={contentRef}
          imageIndex={imageIndex}
        />
      ) : (
        <div className="p-3 text-xs text-white/55">Wiki 预览不可用</div>
      )}
    </div>,
    document.body,
  );
}

function computePreviewStyle(preview: SuggestionWikiPreviewState, height: number | null) {
  const GAP = 8;
  const CARD_W = 320;
  const MARGIN = 8;
  const anchor = preview.anchor;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const cardW = Math.min(CARD_W, viewportW - MARGIN * 2);
  const imageCount = preview.data?.examples?.filter(example => example.previewUrl).length
    || (preview.data?.example?.previewUrl ? 1 : 0);
  const estimatedH = preview.loading ? 112 : preview.data ? (imageCount > 0 ? 390 : 230) : 80;
  const cardH = Math.min(height ?? estimatedH, viewportH - MARGIN * 2);
  const placeLeft = anchor.right + GAP + cardW > viewportW - MARGIN;
  const left = placeLeft
    ? Math.max(MARGIN, anchor.left - GAP - cardW)
    : Math.min(viewportW - MARGIN - cardW, anchor.right + GAP);
  const top = Math.max(MARGIN, Math.min(anchor.top - 8, viewportH - MARGIN - cardH));
  return {
    left,
    top,
    height: height ?? undefined,
    maxHeight: `calc(100vh - ${MARGIN * 2}px)`,
    overflowY: (height ?? 0) > viewportH - MARGIN * 2 ? 'auto' : 'hidden',
  } as const;
}

interface SuggestionWikiPreviewContentProps {
  preview: SuggestionWikiPreviewState;
  contentRef: RefObject<HTMLDivElement | null>;
  imageIndex: number;
}

function SuggestionWikiPreviewContent({
  preview,
  contentRef,
  imageIndex,
}: SuggestionWikiPreviewContentProps) {
  const wikiPreviewData = preview.data!;
  const imageExamples = preview.data!.examples?.filter(example => example.previewUrl)
    || (preview.data!.example?.previewUrl ? [preview.data!.example] : []);
  const activeImageIndex = imageExamples.length > 0 ? imageIndex % imageExamples.length : 0;
  const summaryText = wikiPreviewData.summaryZh
    ? clipWikiSummaryText(wikiPreviewData.summaryZh, 140)
    : clipWikiSummaryText(wikiPreviewData.summary, 260);
  const isPendingZhSummary = !wikiPreviewData.summaryZh && preview.summaryZhLoading;

  return (
    <div ref={contentRef} key={`data-${preview.tag}`} className="wiki-preview-content">
      {imageExamples.length > 0 && (
        <div className="relative h-44 overflow-hidden bg-black/40">
          <div
            className="flex h-full transition-transform duration-500 ease-out"
            style={{ transform: `translateX(-${activeImageIndex * 100}%)` }}
          >
            {imageExamples.map((example) => (
              <div key={`${example.type}-${example.id}`} className="flex h-44 w-full shrink-0 items-center justify-center">
                <img
                  src={example.previewUrl}
                  alt={wikiPreviewData.title}
                  className="max-h-44 w-full object-contain"
                  loading="lazy"
                />
              </div>
            ))}
          </div>
          {imageExamples.length > 1 && (
            <div className="absolute bottom-2 left-0 right-0 flex items-center justify-center gap-1">
              {imageExamples.map((example, idx) => (
                <span
                  key={`${example.type}-${example.id}`}
                  className={`h-1.5 rounded-full transition-all duration-200 ${idx === activeImageIndex ? 'w-4 bg-[#fceda4]' : 'w-1.5 bg-white/25'}`}
                />
              ))}
            </div>
          )}
        </div>
      )}
      <div className="p-3">
        <div className="font-tag text-[14px] leading-tight text-[#fceda4] truncate" title={preview.data!.title}>
          {preview.data!.title}
        </div>
        {preview.data!.otherNames.length > 0 && (
          <div className="mt-1 text-[11px] leading-snug text-white/42 line-clamp-1" title={preview.data!.otherNames.join(' / ')}>
            {preview.data!.otherNames.slice(0, 4).join(' / ')}
          </div>
        )}
        {summaryText && (
          <p
            key={wikiPreviewData.summaryZh ? 'zh' : 'raw'}
            className={`mt-2 text-[12px] leading-relaxed text-white/72 line-clamp-4 break-words ${isPendingZhSummary ? 'animate-wiki-summary-pending' : 'animate-wiki-summary-swap'}`}
          >
            {summaryText}
          </p>
        )}
        <a
          href={`https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(preview.data!.title)}`}
          target="_blank"
          rel="noreferrer"
          className="mt-2 flex items-center justify-center gap-1.5 w-full rounded-md px-3 py-2 text-[12px] font-medium text-nai-accent bg-nai-accent/10 hover:bg-nai-accent/20 border border-nai-accent/20 hover:border-nai-accent/40 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nai-accent/40"
          onClick={(e) => e.stopPropagation()}
          title={`打开 ${preview.data!.title} Wiki`}
        >
          <span>在 Danbooru Wiki 查看</span>
          <ExternalLink className="h-3.5 w-3.5" strokeWidth={2} />
        </a>
      </div>
    </div>
  );
}
