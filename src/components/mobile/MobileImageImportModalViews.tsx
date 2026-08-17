import type { Dispatch, SetStateAction } from 'react';
import { ArrowLeft, Copy, Download, Loader2, Sparkles, X } from 'lucide-react';
import { MetadataDetailPanel } from '../ToolsModal';
import { copyToClipboard } from '../../utils/clipboard';
import { getPictureSizeType, type ImageMetadata } from '../../utils/imageMetadata';
import type { WDTaggerResult } from '../../services/wdTagger';
import type { MobileImageImportOptions } from './generate/useMobileImageImport';
import { ImportOption, SettingsImportOption, UseAsButtons } from './MobileImageImportModalParts';

interface UseAsHandlers {
  onUseAsVibe: () => void;
  onUseAsImg2Img: () => void;
  onUseAsCR: () => void;
}

interface TaggerResultViewProps extends UseAsHandlers {
  dataUrl: string;
  taggerResult: WDTaggerResult;
  importOptions: MobileImageImportOptions;
  includeCharacter: boolean;
  setIncludeCharacter: Dispatch<SetStateAction<boolean>>;
  updateImportOption: (key: keyof MobileImageImportOptions) => void;
  onBack: () => void;
  onClose: () => void;
  onImportTaggerPrompt: () => void;
}

export function TaggerResultView({
  dataUrl,
  taggerResult,
  importOptions,
  includeCharacter,
  setIncludeCharacter,
  updateImportOption,
  onBack,
  onClose,
  onImportTaggerPrompt,
  onUseAsVibe,
  onUseAsImg2Img,
  onUseAsCR,
}: TaggerResultViewProps) {
  return (
    <>
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="p-1.5 text-gray-400 active:text-white">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-nai-accent" />
            反推结果
          </h3>
        </div>
        <button onClick={onClose} className="p-1.5 text-gray-400 active:text-white">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex gap-3 p-4 border-b border-gray-700">
        <div className="w-20 shrink-0">
          <div className="rounded-lg overflow-hidden border border-gray-600 bg-gray-900">
            <img src={dataUrl} alt="" className="w-full h-auto" />
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-gray-500 mb-1">解析模型</div>
          <div className="text-sm text-white">wd-swinv2-tagger-v3</div>
          {taggerResult.confidence && Object.keys(taggerResult.confidence).length > 0 && (
            <div className="mt-2">
              <div className="text-xs text-gray-500 mb-1">识别角色</div>
              <div className="flex flex-wrap gap-1">
                {Object.entries(taggerResult.confidence)
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 3)
                  .map(([name, conf]) => (
                    <span key={name} className="px-2 py-0.5 bg-nai-accent/20 text-nai-accent rounded text-xs">
                      {name} ({(conf * 100).toFixed(0)}%)
                    </span>
                  ))}
              </div>
            </div>
          )}
          {taggerResult.rating && (
            <div className="mt-2">
              <div className="text-xs text-gray-500 mb-1">评级</div>
              <span className={`px-2 py-0.5 rounded text-xs ${taggerResult.rating === 'general' ? 'bg-green-500/20 text-green-400' : taggerResult.rating === 'sensitive' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-red-500/20 text-red-400'}`}>
                {taggerResult.rating}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="p-4 flex-1 overflow-y-auto">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-500">反推标签</span>
          <button onClick={() => taggerResult.tags && copyToClipboard(taggerResult.tags)} className="flex items-center gap-1 text-xs text-gray-400 active:text-white px-2 py-1 rounded">
            <Copy className="w-3 h-3" />
            复制
          </button>
        </div>
        <div className="text-xs text-gray-300 bg-gray-800/50 rounded-lg p-3 leading-relaxed max-h-32 overflow-y-auto">
          {taggerResult.tags}
        </div>
      </div>

      <div className="p-4 border-t border-gray-700 space-y-3 safe-area-bottom">
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
            <input type="checkbox" checked={importOptions.cleanImports} onChange={() => updateImportOption('cleanImports')} className="w-4 h-4 rounded" />
            清空现有提示词
          </label>
          {taggerResult.character && (
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input type="checkbox" checked={includeCharacter} onChange={() => setIncludeCharacter(!includeCharacter)} className="w-4 h-4 rounded" />
              包含识别角色
            </label>
          )}
        </div>

        <button onClick={onImportTaggerPrompt} className="w-full flex items-center justify-center gap-2 py-3 bg-nai-accent text-black font-bold rounded-xl">
          <Download className="w-4 h-4" />
          导入为正向提示词
        </button>

        <div className="text-xs text-gray-500 mb-2">或用作</div>
        <UseAsButtons onUseAsVibe={onUseAsVibe} onUseAsImg2Img={onUseAsImg2Img} onUseAsCR={onUseAsCR} />
      </div>
    </>
  );
}

export function FullMetadataView({
  dataUrl,
  metadata,
  onBack,
  onClose,
}: {
  dataUrl: string;
  metadata: ImageMetadata;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="p-1.5 text-gray-400 active:text-white">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h3 className="text-base font-bold text-white">完整元数据</h3>
        </div>
        <button onClick={onClose} className="p-1.5 text-gray-400 active:text-white">
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <MetadataDetailPanel file={{ name: '历史图片', dataUrl, metadata, isSelected: false, fileSize: 0 }} />
      </div>
    </>
  );
}

interface MetadataImportViewProps extends UseAsHandlers {
  dataUrl: string;
  metadata: ImageMetadata;
  importOptions: MobileImageImportOptions;
  setImportOptions: Dispatch<SetStateAction<MobileImageImportOptions>>;
  updateImportOption: (key: keyof MobileImageImportOptions) => void;
  onClose: () => void;
  onShowFullMetadata: () => void;
  onImportMetadata: () => void;
}

export function MetadataImportView({
  dataUrl,
  metadata,
  importOptions,
  setImportOptions,
  updateImportOption,
  onClose,
  onShowFullMetadata,
  onImportMetadata,
  onUseAsVibe,
  onUseAsImg2Img,
  onUseAsCR,
}: MetadataImportViewProps) {
  return (
    <>
      <div className="flex gap-3 p-4 border-b border-gray-700">
        <div className="w-24 shrink-0">
          <div className="rounded-lg overflow-hidden border border-gray-600 bg-gray-900">
            <img src={dataUrl} alt="" className="w-full h-auto" />
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-sm font-medium text-white truncate">{metadata.source}</div>
              <div className="text-xs text-gray-400 mt-0.5">
                {metadata.width}×{metadata.height} · {getPictureSizeType(metadata.width, metadata.height)}
              </div>
            </div>
            <button onClick={onClose} className="p-1 text-gray-400 active:text-white -mr-1 -mt-1">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5 mt-2">
            {metadata.seed && <span className="px-2 py-1 bg-gray-800 rounded text-xs text-gray-300">Seed: {metadata.seed}</span>}
            {metadata.steps && <span className="px-2 py-1 bg-gray-800 rounded text-xs text-gray-300">Steps: {metadata.steps}</span>}
            {metadata.scale && <span className="px-2 py-1 bg-gray-800 rounded text-xs text-gray-300">CFG: {metadata.scale}</span>}
            {metadata.characterPrompts && metadata.characterPrompts.length > 0 && <span className="px-2 py-1 bg-nai-accent/20 rounded text-xs text-nai-accent">{metadata.characterPrompts.length} 角色</span>}
            {metadata.vibes && metadata.vibes.length > 0 && <span className="px-2 py-1 bg-cyan-500/15 rounded text-xs text-cyan-300">{metadata.vibes.length} Vibe</span>}
          </div>

          {metadata.prompt && (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-500">提示词</span>
                <button onClick={() => copyToClipboard(metadata.prompt || '')} className="p-1 text-gray-500 hover:text-nai-accent active:scale-95 transition-all" title="复制提示词">
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="text-xs text-gray-300 leading-relaxed break-all bg-gray-800/50 rounded-lg p-2 max-h-24 overflow-y-auto">
                {metadata.prompt}
              </div>
            </div>
          )}
          <button onClick={onShowFullMetadata} className="text-xs text-nai-accent active:opacity-70 mt-2">
            查看完整元数据
          </button>
        </div>
      </div>

      <div className="p-4 border-b border-gray-700">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm text-gray-300 font-medium">导入选项</span>
          <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
            <input type="checkbox" checked={importOptions.cleanImports} onChange={() => updateImportOption('cleanImports')} className="w-4 h-4 rounded" />
            清空现有内容
          </label>
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {metadata.prompt && <ImportOption checked={importOptions.prompt} onChange={() => updateImportOption('prompt')} label="正向提示词" />}
          {metadata.negativePrompt && <ImportOption checked={importOptions.negativePrompt} onChange={() => updateImportOption('negativePrompt')} label="负向提示词" />}
          {metadata.sourceType === 'novelai' && metadata.characterPrompts && metadata.characterPrompts.length > 0 && <ImportOption checked={importOptions.characters} onChange={() => updateImportOption('characters')} label="角色提示词" />}
          {metadata.sourceType === 'novelai' && (metadata.steps || metadata.scale) && <SettingsImportOption metadata={metadata} checked={importOptions.settings} setImportOptions={setImportOptions} />}
          {metadata.sourceType === 'novelai' && metadata.seed && <ImportOption checked={importOptions.seed} onChange={() => updateImportOption('seed')} label="种子" />}
          {metadata.sourceType === 'novelai' && metadata.vibes && metadata.vibes.length > 0 && <ImportOption checked={importOptions.vibes} onChange={() => updateImportOption('vibes')} label={`Vibe (${metadata.vibes.length})`} />}
        </div>

        <button onClick={onImportMetadata} className="w-full mt-3 flex items-center justify-center gap-2 py-2.5 bg-nai-accent text-black font-bold rounded-xl">
          <Download className="w-4 h-4" />
          导入元数据
        </button>
      </div>

      <div className="p-4 safe-area-bottom">
        <div className="text-xs text-gray-500 mb-2">或用作</div>
        <UseAsButtons onUseAsVibe={onUseAsVibe} onUseAsImg2Img={onUseAsImg2Img} onUseAsCR={onUseAsCR} />
      </div>
    </>
  );
}

export function ImageUseChoiceView({
  isParsingMetadata,
  isAnalyzingTagger,
  onClose,
  onAnalyzeWithTagger,
  onUseAsVibe,
  onUseAsImg2Img,
  onUseAsCR,
}: UseAsHandlers & {
  isParsingMetadata: boolean;
  isAnalyzingTagger: boolean;
  onClose: () => void;
  onAnalyzeWithTagger: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h3 className="text-base font-bold text-white">选择用途</h3>
        <button onClick={onClose} className="p-1.5 text-gray-400 active:text-white">
          <X className="w-5 h-5" />
        </button>
      </div>

      {isParsingMetadata ? (
        <div className="flex items-center justify-center gap-2 text-gray-400 text-sm py-8">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>解析中...</span>
        </div>
      ) : (
        <div className="p-4 pb-8 space-y-3 safe-area-bottom">
          <div className="p-3 bg-gray-800/50 rounded-xl border border-gray-700">
            <div className="text-xs text-gray-400 mb-2">未检测到元数据</div>
            <button onClick={onAnalyzeWithTagger} disabled={isAnalyzingTagger} className="w-full flex items-center justify-center gap-2 py-2.5 bg-nai-accent/20 text-nai-accent border border-nai-accent/30 rounded-xl text-sm disabled:opacity-50">
              {isAnalyzingTagger ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  反推中...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  AI 反推标签
                </>
              )}
            </button>
            <div className="text-[10px] text-gray-500 mt-1.5 text-center">使用 WD Tagger 模型反推图片标签</div>
          </div>

          <UseAsButtons stacked onUseAsVibe={onUseAsVibe} onUseAsImg2Img={onUseAsImg2Img} onUseAsCR={onUseAsCR} />
        </div>
      )}
    </>
  );
}
