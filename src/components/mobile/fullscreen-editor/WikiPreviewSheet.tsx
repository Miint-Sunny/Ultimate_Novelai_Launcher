import { ExternalLink, X } from 'lucide-react';
import type React from 'react';
import type { TagWikiPreview } from '../../../services/tagAutocomplete';

export interface WikiPreviewState {
  tag: string;
  data: TagWikiPreview | null;
  loading: boolean;
  summaryZhLoading?: boolean;
}

interface WikiPreviewSheetProps {
  preview: WikiPreviewState;
  imageIndex: number;
  onImageIndexChange: (index: number) => void;
  onClose: () => void;
}

export const WikiPreviewSheet: React.FC<WikiPreviewSheetProps> = ({
  preview,
  imageIndex,
  onImageIndexChange,
  onClose,
}) => {
  const data = preview.data;

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/60 animate-fade-in" onClick={onClose} />
      <div className="fixed left-0 right-0 bottom-0 z-[60] bg-nai-panel rounded-t-2xl shadow-[0_-18px_50px_-12px_rgba(0,0,0,0.8)] animate-slide-in-from-bottom safe-area-bottom overflow-hidden flex flex-col max-h-[75vh]">
        <div className="flex-shrink-0 flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
          <span className="font-tag text-[14px] text-nai-accent truncate flex-1">{data?.title || preview.tag}</span>
          <button
            className="shrink-0 w-7 h-7 flex items-center justify-center text-white/40 active:text-white/80 rounded-md active:bg-white/10 transition-colors"
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {preview.loading ? (
            <div className="h-28 flex items-center justify-center gap-2 text-nai-accent/75">
              <span className="inline-block w-4 h-4 border-2 border-nai-accent/20 border-t-nai-accent rounded-full animate-spin" />
              <span className="text-xs">加载 Wiki...</span>
            </div>
          ) : data ? (
            <WikiPreviewContent
              data={data}
              imageIndex={imageIndex}
              summaryZhLoading={preview.summaryZhLoading}
              onImageIndexChange={onImageIndexChange}
            />
          ) : (
            <WikiPreviewUnavailable tag={preview.tag} />
          )}
        </div>
      </div>
    </>
  );
};

interface WikiPreviewContentProps {
  data: TagWikiPreview;
  imageIndex: number;
  summaryZhLoading?: boolean;
  onImageIndexChange: (index: number) => void;
}

const WikiPreviewContent: React.FC<WikiPreviewContentProps> = ({
  data,
  imageIndex,
  summaryZhLoading,
  onImageIndexChange,
}) => {
  const imageExamples = data.examples?.filter(ex => ex.previewUrl) || (data.example?.previewUrl ? [data.example] : []);
  const summaryText = data.summaryZh || data.summary;

  return (
    <>
      {imageExamples.length > 0 && (
        <div className="relative">
          <div
            className="flex h-48 overflow-x-auto snap-x snap-mandatory scrollbar-hide bg-black/40"
            onScroll={(e) => {
              const el = e.currentTarget;
              onImageIndexChange(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
            }}
          >
            {imageExamples.map((ex) => (
              <div key={`${ex.type}-${ex.id}`} className="w-full h-48 shrink-0 snap-center flex items-center justify-center">
                <img src={ex.previewUrl} alt={data.title} className="max-h-48 w-full object-contain" loading="lazy" />
              </div>
            ))}
          </div>
          {imageExamples.length > 1 && (
            <div className="absolute bottom-2 left-0 right-0 flex items-center justify-center gap-1 pointer-events-none">
              {imageExamples.map((ex, idx) => (
                <span
                  key={`${ex.type}-${ex.id}`}
                  className={`h-1.5 rounded-full transition-all duration-200 ${idx === imageIndex ? 'w-4 bg-nai-accent' : 'w-1.5 bg-white/25'}`}
                />
              ))}
            </div>
          )}
        </div>
      )}
      <div className="p-4">
        {data.otherNames.length > 0 && (
          <div className="text-[11px] leading-snug text-white/40 line-clamp-1" title={data.otherNames.join(' / ')}>
            {data.otherNames.slice(0, 4).join(' / ')}
          </div>
        )}
        {summaryText && (
          <p className={`mt-2 text-[12px] leading-relaxed text-white/70 break-words ${summaryZhLoading ? 'animate-pulse' : ''}`}>
            {summaryText}
          </p>
        )}
        <WikiLink tag={data.title} />
      </div>
    </>
  );
};

const WikiPreviewUnavailable: React.FC<{ tag: string }> = ({ tag }) => (
  <div className="p-4">
    <div className="text-xs text-white/55">Wiki 预览不可用</div>
    <WikiLink tag={tag} />
  </div>
);

const WikiLink: React.FC<{ tag: string }> = ({ tag }) => (
  <a
    href={`https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(tag)}`}
    target="_blank"
    rel="noreferrer"
    className="mt-3 flex items-center justify-center gap-1.5 w-full rounded-lg px-3 py-2.5 text-[13px] font-medium text-nai-accent bg-nai-accent/10 active:bg-nai-accent/20 border border-nai-accent/20 transition-colors"
  >
    <span>在 Danbooru Wiki 查看</span>
    <ExternalLink className="h-3.5 w-3.5" strokeWidth={2} />
  </a>
);
