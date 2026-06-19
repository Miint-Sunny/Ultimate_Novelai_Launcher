import type { Dispatch, SetStateAction } from 'react';
import type { ImageMetadata } from '../../utils/imageMetadata';
import type { WDTaggerResult } from '../../services/wdTagger';
import type { MobileImageImportOptions } from './generate/useMobileImageImport';
import {
  FullMetadataView,
  ImageUseChoiceView,
  MetadataImportView,
  TaggerResultView,
} from './MobileImageImportModalViews';

interface MobileImageImportModalProps {
  dataUrl: string | null;
  metadata: ImageMetadata | null;
  isParsingMetadata: boolean;
  isAnalyzingTagger: boolean;
  taggerResult: WDTaggerResult | null;
  showTaggerResult: boolean;
  setShowTaggerResult: Dispatch<SetStateAction<boolean>>;
  showFullMetadata: boolean;
  setShowFullMetadata: Dispatch<SetStateAction<boolean>>;
  importOptions: MobileImageImportOptions;
  setImportOptions: Dispatch<SetStateAction<MobileImageImportOptions>>;
  includeCharacter: boolean;
  setIncludeCharacter: Dispatch<SetStateAction<boolean>>;
  onClose: () => void;
  onAnalyzeWithTagger: () => void;
  onImportTaggerPrompt: () => void;
  onImportMetadata: () => void;
  onUseAsVibe: () => void;
  onUseAsImg2Img: () => void;
  onUseAsCR: () => void;
}

export function MobileImageImportModal({
  dataUrl,
  metadata,
  isParsingMetadata,
  isAnalyzingTagger,
  taggerResult,
  showTaggerResult,
  setShowTaggerResult,
  showFullMetadata,
  setShowFullMetadata,
  importOptions,
  setImportOptions,
  includeCharacter,
  setIncludeCharacter,
  onClose,
  onAnalyzeWithTagger,
  onImportTaggerPrompt,
  onImportMetadata,
  onUseAsVibe,
  onUseAsImg2Img,
  onUseAsCR,
}: MobileImageImportModalProps) {
  if (!dataUrl) return null;

  const updateImportOption = (key: keyof MobileImageImportOptions) => {
    setImportOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const useAsProps = { onUseAsVibe, onUseAsImg2Img, onUseAsCR };
  const content = (() => {
    if (showTaggerResult && taggerResult) {
      return (
        <TaggerResultView
          dataUrl={dataUrl}
          taggerResult={taggerResult}
          importOptions={importOptions}
          includeCharacter={includeCharacter}
          setIncludeCharacter={setIncludeCharacter}
          updateImportOption={updateImportOption}
          onBack={() => setShowTaggerResult(false)}
          onClose={onClose}
          onImportTaggerPrompt={onImportTaggerPrompt}
          {...useAsProps}
        />
      );
    }
    if (showFullMetadata && metadata) {
      return (
        <FullMetadataView
          dataUrl={dataUrl}
          metadata={metadata}
          onBack={() => setShowFullMetadata(false)}
          onClose={onClose}
        />
      );
    }
    if (metadata) {
      return (
        <MetadataImportView
          dataUrl={dataUrl}
          metadata={metadata}
          importOptions={importOptions}
          setImportOptions={setImportOptions}
          updateImportOption={updateImportOption}
          onClose={onClose}
          onShowFullMetadata={() => setShowFullMetadata(true)}
          onImportMetadata={onImportMetadata}
          {...useAsProps}
        />
      );
    }
    return (
      <ImageUseChoiceView
        isParsingMetadata={isParsingMetadata}
        isAnalyzingTagger={isAnalyzingTagger}
        onClose={onClose}
        onAnalyzeWithTagger={onAnalyzeWithTagger}
        {...useAsProps}
      />
    );
  })();

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center animate-fade-in" onClick={onClose}>
      <div className="absolute inset-x-0 bottom-0 h-1/2 bg-nai-panel pointer-events-none" />
      <div
        className="relative w-full bg-nai-panel rounded-t-2xl shadow-2xl max-h-[85vh] flex flex-col animate-slide-in-from-bottom mb-4"
        onClick={(event) => event.stopPropagation()}
      >
        {content}
      </div>
    </div>
  );
}
