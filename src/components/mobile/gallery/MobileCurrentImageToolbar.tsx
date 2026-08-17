import React, { useEffect, useRef, useState } from 'react';
import { Check, Download, FileDigit, RefreshCw, Settings2 } from 'lucide-react';
import type { HistoryItem } from '../../../contexts/GenerationContext';
import { useLongPress } from './useLongPress';

interface MobileCurrentImageToolbarProps {
  imageUrl: string | null;
  isGenerating: boolean;
  currentSeed: number | null;
  history: HistoryItem[];
  onRegenerate: () => void;
  onDownload: () => void;
  /** 保存按钮长按:打开保存设置 */
  onOpenSaveSettings: () => void;
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
  onRegenerate,
  onDownload,
  onOpenSaveSettings,
}) => {
  // seed chip 已复制反馈:约 1.2s 对勾图标
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  // 保存:点击 = 下载;长按 = 打开保存设置
  const { handlers: saveHandlers } = useLongPress({
    onLongPress: onOpenSaveSettings,
    onClick: onDownload,
  });

  if (!imageUrl || isGenerating) return null;

  // 点击 seed chip = 复制种子(原「使用种子」填编辑器语义已被复制取代)
  const handleCopySeed = () => {
    if (currentSeed === null) return;
    const write = navigator.clipboard?.writeText(String(currentSeed));
    if (!write) return;
    void write
      .then(() => {
        setCopied(true);
        if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };

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
        onClick={handleCopySeed}
        className="flex items-center gap-1.5 px-3 py-2 bg-black/70 rounded-lg text-sm"
        title="复制种子"
      >
        {copied ? (
          <Check className="w-4 h-4 text-green-400" />
        ) : (
          <FileDigit className="w-4 h-4" />
        )}
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
        {...saveHandlers}
        className="p-2.5 bg-black/70 rounded-lg"
        title="下载(长按打开保存设置)"
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
