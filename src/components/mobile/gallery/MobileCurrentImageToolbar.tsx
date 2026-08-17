import React from 'react';
import { Download, FileDigit, RefreshCw, Settings2 } from 'lucide-react';
import type { HistoryItem } from '../../../contexts/GenerationContext';

interface MobileCurrentImageToolbarProps {
  imageUrl: string | null;
  isGenerating: boolean;
  currentSeed: number | null;
  history: HistoryItem[];
  onUseSeed: () => void;
  onRegenerate: () => void;
  onDownload: () => void;
}

const buildMetadataImportPayload = (item?: HistoryItem) => {
  if (!item?.metadata) return null;

  const metadata = item.metadata;
  return {
    source: `NovelAI (${metadata.model})`,
    sourceType: 'novelai',
    prompt: metadata.positivePrompt,
    negativePrompt: metadata.negativePrompt,
    width: item.width,
    height: item.height,
    seed: String(item.seed),
    steps: String(metadata.steps),
    scale: String(metadata.scale),
    sampler: metadata.sampler,
    cfgRescale: metadata.cfgRescale,
    noiseSchedule: metadata.noiseSchedule,
    characterPrompts: metadata.characterPrompts?.map((characterPrompt) => ({
      prompt: characterPrompt.positive,
      uc: characterPrompt.negative,
      center: characterPrompt.position ? { x: 0, y: 0 } : undefined,
    })),
  };
};

export const MobileCurrentImageToolbar: React.FC<MobileCurrentImageToolbarProps> = ({
  imageUrl,
  isGenerating,
  currentSeed,
  history,
  onUseSeed,
  onRegenerate,
  onDownload,
}) => {
  if (!imageUrl || isGenerating) return null;

  const handleImportMetadata = () => {
    const currentItem = history.find((item) => item.imageUrl === imageUrl);
    window.dispatchEvent(new CustomEvent('open-image-import', {
      detail: {
        dataUrl: imageUrl,
        metadata: buildMetadataImportPayload(currentItem),
      },
    }));
  };

  return (
    <div className="absolute bottom-3 right-3 flex items-center gap-1.5">
      <button
        onClick={onUseSeed}
        className="flex items-center gap-1.5 px-3 py-2 bg-black/70 rounded-lg text-sm"
      >
        <FileDigit className="w-4 h-4" />
        {currentSeed}
      </button>
      <button
        onClick={onRegenerate}
        className="p-2.5 bg-nai-accent/90 rounded-lg"
        title="重新生成"
      >
        <RefreshCw className="w-5 h-5 text-black" />
      </button>
      <button
        onClick={onDownload}
        className="p-2.5 bg-black/70 rounded-lg"
        title="下载"
      >
        <Download className="w-5 h-5" />
      </button>
      <button
        onClick={handleImportMetadata}
        className="p-2.5 bg-black/70 rounded-lg"
        title="导入元数据"
      >
        <Settings2 className="w-5 h-5" />
      </button>
    </div>
  );
};
