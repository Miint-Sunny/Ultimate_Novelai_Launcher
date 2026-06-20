import React, { useState, useEffect } from 'react';
import {
  Image as ImageIcon,
  Palette,
  User,
  X,
  Download,
  Loader2,
  Sparkles,
  ArrowLeft,
  Copy,
  Check,
} from 'lucide-react';
import {
  extractImageMetadata,
  getPictureSizeType,
  type ImageMetadata,
} from '../utils/imageMetadata';
import { getUnsupportedImportSettings, formatUnsupportedSettings } from '../utils/generationOptions';
import { MetadataDetailPanel, type MetadataFile } from './ToolsModal';
import {
  analyzeImageWithWDTagger,
  extractBase64FromDataUrl,
  type WDTaggerResult,
} from '../services/wdTagger';

export type DropTarget = 'img2img' | 'vibe' | 'cr' | 'import';

interface ImportOptions {
  prompt: boolean;
  negativePrompt: boolean;
  characters: boolean;
  appendCharacters: boolean;
  settings: boolean;
  seed: boolean;
  vibes: boolean;
  cleanImports: boolean;
}

interface DropZoneModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (
    target: DropTarget,
    metadata?: ImageMetadata,
    importOptions?: ImportOptions
  ) => void;
  fileName?: string;
  isVibeFile?: boolean;
  fileDataUrl?: string;
  presetMetadata?: ImageMetadata | null;
}

export const DropZoneModal: React.FC<DropZoneModalProps> = ({
  isOpen,
  onClose,
  onSelect,
  fileName,
  isVibeFile = false,
  fileDataUrl,
  presetMetadata,
}) => {
  const [metadata, setMetadata] = useState<ImageMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showFullMetadata, setShowFullMetadata] = useState(false);
  const [importOptions, setImportOptions] = useState<ImportOptions>({
    prompt: true,
    negativePrompt: true,
    characters: true,
    appendCharacters: false,
    settings: false,
    seed: false,
    vibes: true,
    cleanImports: true,
  });

  // WD Tagger 反推状态
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [taggerResult, setTaggerResult] = useState<WDTaggerResult | null>(null);
  const [showTaggerResult, setShowTaggerResult] = useState(false);
  const [copiedTags, setCopiedTags] = useState(false);
  const [includeCharacter, setIncludeCharacter] = useState(true);

  useEffect(() => {
    if (!isOpen || isVibeFile) {
      setMetadata(null);
      setShowFullMetadata(false);
      setTaggerResult(null);
      setShowTaggerResult(false);
      return;
    }
    // 如果有预设元数据（如从历史记录触发），直接使用
    if (presetMetadata) {
      setMetadata(presetMetadata);
      return;
    }
    if (!fileDataUrl) {
      setMetadata(null);
      return;
    }
    const parseMetadata = async () => {
      setIsLoading(true);
      try {
        const result = await extractImageMetadata(fileDataUrl);
        setMetadata(result);
      } catch (error) {
        console.error('Failed to parse metadata:', error);
        setMetadata(null);
      } finally {
        setIsLoading(false);
      }
    };
    parseMetadata();
  }, [isOpen, fileDataUrl, isVibeFile, presetMetadata]);

  if (!isOpen) return null;

  const handleImportMetadata = () => {
    if (metadata) {
      // 对于非 NAI 图片，强制禁用除提示词外的其他导入选项
      const filteredOptions = { ...importOptions };
      if (metadata.sourceType !== 'novelai') {
        filteredOptions.characters = false;
        filteredOptions.vibes = false;
        filteredOptions.settings = false;
        filteredOptions.seed = false;
      }
      // 生成设置里含 UI 不支持的值（如 noise schedule=native、未知 sampler）时，
      // 整个「生成设置」禁止导入，避免把无法显示/编辑的值悄悄写进 state。
      if (getUnsupportedImportSettings(metadata).length > 0) {
        filteredOptions.settings = false;
      }
      onSelect('import', metadata, filteredOptions);
    }
  };

  const toggleOption = (key: keyof ImportOptions) => {
    setImportOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // WD Tagger 反推
  const handleAnalyzeWithTagger = async () => {
    if (!fileDataUrl || isAnalyzing) return;

    setIsAnalyzing(true);
    try {
      const base64 = extractBase64FromDataUrl(fileDataUrl);
      const result = await analyzeImageWithWDTagger(base64);
      if (result) {
        setTaggerResult(result);
        setShowTaggerResult(true);
      } else {
        alert('反推失败，请稍后重试');
      }
    } catch (error) {
      console.error('WD Tagger 分析失败:', error);
      alert('反推失败，请稍后重试');
    } finally {
      setIsAnalyzing(false);
    }
  };

  // 复制标签
  const handleCopyTags = () => {
    if (taggerResult?.tags) {
      navigator.clipboard.writeText(taggerResult.tags);
      setCopiedTags(true);
      setTimeout(() => setCopiedTags(false), 2000);
    }
  };

  // 导入反推结果
  const handleImportTaggerResult = () => {
    if (taggerResult?.tags) {
      // 合并角色和标签
      let finalPrompt = taggerResult.tags;
      if (includeCharacter && taggerResult.character) {
        // 将角色名放在最前面
        finalPrompt = `${taggerResult.character}, ${taggerResult.tags}`;
      }

      // 创建一个虚拟的元数据对象用于导入
      const fakeMetadata: ImageMetadata = {
        source: 'WD Tagger (反推)',
        sourceType: 'unknown',
        prompt: finalPrompt,
        negativePrompt: '',
        width: 0,
        height: 0,
        seed: '',
      };
      onSelect('import', fakeMetadata, {
        prompt: true,
        negativePrompt: false,
        characters: false,
        appendCharacters: false,
        settings: false,
        seed: false,
        vibes: false,
        cleanImports: importOptions.cleanImports,
      });
    }
  };

  const hasMetadata = !isVibeFile && metadata;

  // 反推结果面板：有/无元数据都可进入
  if (showTaggerResult && taggerResult) {
    return (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={onClose}
        >
          <div
            className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[480px] mx-4 max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 头部 */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowTaggerResult(false)}
                  className="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-white"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-nai-accent" />
                  反推结果
                </h3>
              </div>
              <button
                onClick={onClose}
                className="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 图片预览 + 基本信息 */}
            <div className="flex gap-4 p-4 border-b border-gray-700">
              {fileDataUrl && (
                <div className="w-24 shrink-0">
                  <div className="rounded-lg overflow-hidden border border-gray-600 bg-gray-900">
                    <img src={fileDataUrl} alt="" className="w-full h-auto" />
                  </div>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-500 mb-1">解析模型</div>
                <div className="text-sm text-white">wd-swinv2-tagger-v3</div>

                {/* 显示所有识别的角色及置信度 */}
                {taggerResult.confidence && Object.keys(taggerResult.confidence).length > 0 && (
                  <div className="mt-2">
                    <div className="text-xs text-gray-500 mb-1">识别角色</div>
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(taggerResult.confidence)
                        .sort(([, a], [, b]) => b - a)
                        .slice(0, 5)
                        .map(([name, conf]) => (
                          <span
                            key={name}
                            className="px-2 py-0.5 bg-nai-accent/20 text-nai-accent rounded text-xs"
                            title={`置信度: ${(conf * 100).toFixed(1)}%`}
                          >
                            {name} ({(conf * 100).toFixed(0)}%)
                          </span>
                        ))}
                    </div>
                  </div>
                )}

                {taggerResult.rating && (
                  <div className="mt-2">
                    <div className="text-xs text-gray-500 mb-1">评级</div>
                    <span className={`px-2 py-0.5 rounded text-xs ${taggerResult.rating === 'general' ? 'bg-green-500/20 text-green-400' :
                        taggerResult.rating === 'sensitive' ? 'bg-yellow-500/20 text-yellow-400' :
                          'bg-red-500/20 text-red-400'
                      }`}>
                      {taggerResult.rating}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* 标签内容 */}
            <div className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500">反推标签</span>
                <button
                  onClick={handleCopyTags}
                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-gray-800"
                >
                  {copiedTags ? (
                    <>
                      <Check className="w-3 h-3 text-green-400" />
                      <span className="text-green-400">已复制</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      复制
                    </>
                  )}
                </button>
              </div>
              <div className="text-xs text-gray-300 bg-gray-800/50 rounded-lg p-3 leading-relaxed max-h-32 overflow-y-auto">
                {taggerResult.tags}
              </div>
            </div>

            {/* 底部操作 */}
            <div className="p-4 border-t border-gray-700 space-y-3">
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer hover:text-white">
                  <input
                    type="checkbox"
                    checked={importOptions.cleanImports}
                    onChange={() => toggleOption('cleanImports')}
                    className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-700 text-nai-accent"
                  />
                  替换对应内容
                </label>
                {taggerResult.character && (
                  <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer hover:text-white">
                    <input
                      type="checkbox"
                      checked={includeCharacter}
                      onChange={() => setIncludeCharacter(!includeCharacter)}
                      className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-700 text-nai-accent"
                    />
                    包含识别角色
                  </label>
                )}
              </div>

              <button
                onClick={handleImportTaggerResult}
                className="w-full flex items-center justify-center gap-2 py-2.5 bg-nai-accent hover:bg-nai-accent/80 text-black font-medium rounded-lg transition-colors text-sm"
              >
                <Download className="w-4 h-4" />
                导入为正向提示词
              </button>

              <div className="text-xs text-gray-500 mb-2">或用作</div>
              <div className="flex gap-2">
                <button
                  onClick={() => onSelect('vibe')}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-gray-800/50 hover:bg-gray-700 border border-gray-700 rounded-lg transition-all"
                >
                  <Palette className="w-4 h-4 text-nai-accent" />
                  <span className="text-xs text-gray-300">风格迁移</span>
                </button>
                <button
                  onClick={() => onSelect('img2img')}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-gray-800/50 hover:bg-gray-700 border border-gray-700 rounded-lg transition-all"
                >
                  <ImageIcon className="w-4 h-4 text-nai-accent" />
                  <span className="text-xs text-gray-300">图生图</span>
                </button>
                <button
                  onClick={() => onSelect('cr')}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-gray-800/50 hover:bg-gray-700 border border-gray-700 rounded-lg transition-all"
                >
                  <User className="w-4 h-4 text-nai-accent" />
                  <span className="text-xs text-gray-300">角色参考</span>
                </button>
              </div>
            </div>
          </div>
        </div>
    );
  }

  // 简单模式：无元数据或vibe文件
  if (!hasMetadata) {
    // 默认简单模式
    return (
      <div
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      >
        <div
          className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[320px] mx-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
            <h3 className="text-sm font-bold text-white">选择用途</h3>
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center gap-2 text-gray-400 text-sm py-8">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>解析中...</span>
            </div>
          ) : (
            <div className="p-3 space-y-2">
              {/* 无元数据提示 + 反推按钮 */}
              {!isVibeFile && (
                <div className="mb-3 p-3 bg-gray-800/50 rounded-lg border border-gray-700">
                  <div className="text-xs text-gray-400 mb-2">未检测到元数据</div>
                  <button
                    onClick={handleAnalyzeWithTagger}
                    disabled={isAnalyzing}
                    className="w-full flex items-center justify-center gap-2 py-2 bg-nai-accent/20 hover:bg-nai-accent/30 text-nai-accent border border-nai-accent/30 rounded-lg transition-colors text-sm disabled:opacity-50"
                  >
                    {isAnalyzing ? (
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
                  <div className="text-[10px] text-gray-500 mt-1.5 text-center">
                    使用 WD Tagger 模型反推图片标签
                  </div>
                </div>
              )}

              <button
                onClick={() => onSelect('vibe')}
                className="w-full flex items-center gap-3 px-3 py-2.5 bg-gray-800/50 hover:bg-gray-700 border border-gray-700 rounded-lg transition-all"
              >
                <Palette className="w-5 h-5 text-nai-accent" />
                <span className="text-sm text-white">风格迁移</span>
              </button>
              {!isVibeFile && (
                <>
                  <button
                    onClick={() => onSelect('img2img')}
                    className="w-full flex items-center gap-3 px-3 py-2.5 bg-gray-800/50 hover:bg-gray-700 border border-gray-700 rounded-lg transition-all"
                  >
                    <ImageIcon className="w-5 h-5 text-nai-accent" />
                    <span className="text-sm text-white">图生图</span>
                  </button>
                  <button
                    onClick={() => onSelect('cr')}
                    className="w-full flex items-center gap-3 px-3 py-2.5 bg-gray-800/50 hover:bg-gray-700 border border-gray-700 rounded-lg transition-all"
                  >
                    <User className="w-5 h-5 text-nai-accent" />
                    <span className="text-sm text-white">角色参考</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // 完整模式：有元数据
  // 二级面板：查看完整元数据
  if (showFullMetadata) {
    return (
      <div
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      >
        <div
          className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[480px] mx-4 max-h-[85vh] flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 头部 */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 shrink-0">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowFullMetadata(false)}
                className="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-white"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <h3 className="text-sm font-bold text-white">完整元数据</h3>
            </div>
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* 详情面板 */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            <MetadataDetailPanel
              file={{
                name: fileName || '未知文件',
                dataUrl: fileDataUrl || '',
                metadata,
                isSelected: false,
                fileSize: 0,
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[480px] mx-4 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部：图片预览 + 基本信息 */}
        <div className="flex gap-4 p-4 border-b border-gray-700">
          {/* 图片 */}
          <div className="w-28 shrink-0">
            {fileDataUrl && (
              <div className="rounded-lg overflow-hidden border border-gray-600 bg-gray-900">
                <img src={fileDataUrl} alt="" className="w-full h-auto" />
              </div>
            )}
          </div>

          {/* 信息 */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-sm font-medium text-white truncate">{metadata.source}</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {metadata.width}×{metadata.height} · {getPictureSizeType(metadata.width, metadata.height)}
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-white -mr-1 -mt-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 参数标签 */}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {metadata.seed && (
                <span className="px-1.5 py-0.5 bg-gray-800 rounded text-[10px] text-gray-300">
                  Seed: {metadata.seed}
                </span>
              )}
              {metadata.steps && (
                <span className="px-1.5 py-0.5 bg-gray-800 rounded text-[10px] text-gray-300">
                  Steps: {metadata.steps}
                </span>
              )}
              {metadata.scale && (
                <span className="px-1.5 py-0.5 bg-gray-800 rounded text-[10px] text-gray-300">
                  CFG: {metadata.scale}
                </span>
              )}
              {metadata.sampler && (
                <span className="px-1.5 py-0.5 bg-gray-800 rounded text-[10px] text-gray-300">
                  {metadata.sampler}
                </span>
              )}
              {metadata.characterPrompts && metadata.characterPrompts.length > 0 && (
                <span className="px-1.5 py-0.5 bg-nai-accent/20 rounded text-[10px] text-nai-accent">
                  {metadata.characterPrompts.length} 角色
                </span>
              )}
              {metadata.vibes && metadata.vibes.length > 0 && (
                <span className="px-1.5 py-0.5 bg-purple-500/20 rounded text-[10px] text-purple-400">
                  {metadata.vibes.length} Vibe
                </span>
              )}
              {metadata.loras && metadata.loras.length > 0 && (
                <span className="px-1.5 py-0.5 bg-orange-500/20 rounded text-[10px] text-orange-400">
                  {metadata.loras.length} Lora
                </span>
              )}
            </div>

            {/* Lora 列表 */}
            {metadata.loras && metadata.loras.length > 0 && (
              <div className="mt-2 p-2 bg-gray-800/50 rounded-lg">
                <div className="text-[10px] text-gray-500 mb-1">Lora</div>
                <div className="flex flex-wrap gap-1">
                  {metadata.loras.map((lora, idx) => (
                    <span
                      key={idx}
                      className="px-1.5 py-0.5 bg-orange-500/10 border border-orange-500/30 rounded text-[10px] text-orange-300"
                    >
                      {lora.name}:{lora.weight}
                    </span>
                  ))}
                </div>
              </div>
            )}            {/* 提示词预览 */}
            {metadata.prompt && (
              <div className="mt-2">
                <div className="text-[11px] text-gray-400 leading-relaxed break-all line-clamp-2">
                  {metadata.prompt}
                </div>
                <button
                  onClick={() => setShowFullMetadata(true)}
                  className="text-[10px] text-nai-accent hover:underline mt-0.5"
                >
                  查看完整元数据
                </button>
              </div>
            )}
            {!metadata.prompt && (
              <button
                onClick={() => setShowFullMetadata(true)}
                className="text-[10px] text-nai-accent hover:underline mt-2"
              >
                查看完整元数据
              </button>
            )}
          </div>
        </div>

        {/* 导入区域 */}
        <div className="p-4 border-b border-gray-700">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-400">导入选项</span>
            <label className="flex items-center gap-1.5 text-[11px] text-gray-400 cursor-pointer hover:text-white">
              <input
                type="checkbox"
                checked={importOptions.cleanImports}
                onChange={() => toggleOption('cleanImports')}
                className="w-3 h-3 rounded border-gray-600 bg-gray-700 text-nai-accent"
              />
              替换对应内容
            </label>
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {[
              { key: 'prompt', label: '正向提示词', show: !!metadata.prompt, disabled: false, reason: '' },
              { key: 'negativePrompt', label: '负向提示词', show: !!metadata.negativePrompt, disabled: false, reason: '' },
              { key: 'characters', label: '角色提示词', show: !!(metadata.sourceType === 'novelai' && metadata.characterPrompts && metadata.characterPrompts.length > 0), disabled: false, reason: '' },
              { key: 'vibes', label: 'Vibe', show: !!(metadata.sourceType === 'novelai' && metadata.vibes && metadata.vibes.length > 0), disabled: false, reason: '' },
              {
                key: 'settings',
                label: '生成设置',
                show: !!(metadata.sourceType === 'novelai' && (metadata.steps || metadata.scale || metadata.sampler)),
                // 含不支持的值（如 native）时禁用，并展示原因，避免静默改值
                disabled: getUnsupportedImportSettings(metadata).length > 0,
                reason: formatUnsupportedSettings(getUnsupportedImportSettings(metadata)),
              },
              { key: 'seed', label: '种子', show: !!(metadata.sourceType === 'novelai' && metadata.seed), disabled: false, reason: '' },
            ]
              .filter((item) => item.show)
              .map(({ key, label, disabled, reason }) => (
                <label
                  key={key}
                  title={disabled && reason ? `该图含当前版本不支持的参数（${reason}），无法导入生成设置` : undefined}
                  className={`flex items-center gap-1.5 text-xs ${disabled ? 'cursor-not-allowed text-gray-500' : 'cursor-pointer text-gray-300 hover:text-white'}`}
                >
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={!disabled && (importOptions[key as keyof ImportOptions] as boolean)}
                    onChange={() => { if (!disabled) toggleOption(key as keyof ImportOptions); }}
                    className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-700 text-nai-accent focus:ring-nai-accent focus:ring-offset-0 disabled:opacity-50"
                  />
                  {label}
                  {disabled && reason ? (
                    <span className="text-[10px] text-amber-500/80">不支持: {reason}</span>
                  ) : null}
                </label>
              ))}
          </div>

          <button
            onClick={handleImportMetadata}
            className="w-full mt-3 flex items-center justify-center gap-2 py-2 bg-nai-accent hover:bg-nai-accent/80 text-black font-medium rounded-lg transition-colors text-sm"
          >
            <Download className="w-4 h-4" />
            导入元数据
          </button>
        </div>

        {/* 其他用途 */}
        <div className="p-4">
          <div className="text-xs text-gray-500 mb-2">或用作</div>
          <div className="flex gap-2">
            <button
              onClick={handleAnalyzeWithTagger}
              disabled={isAnalyzing || !fileDataUrl}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-gray-800/50 hover:bg-gray-700 border border-gray-700 rounded-lg transition-all disabled:opacity-50"
            >
              {isAnalyzing ? (
                <>
                  <Loader2 className="w-4 h-4 text-nai-accent animate-spin" />
                  <span className="text-xs text-gray-300">反推中...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 text-nai-accent" />
                  <span className="text-xs text-gray-300">AI 反推</span>
                </>
              )}
            </button>
            <button
              onClick={() => onSelect('vibe')}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-gray-800/50 hover:bg-gray-700 border border-gray-700 rounded-lg transition-all"
            >
              <Palette className="w-4 h-4 text-nai-accent" />
              <span className="text-xs text-gray-300">风格迁移</span>
            </button>
            <button
              onClick={() => onSelect('img2img')}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-gray-800/50 hover:bg-gray-700 border border-gray-700 rounded-lg transition-all"
            >
              <ImageIcon className="w-4 h-4 text-nai-accent" />
              <span className="text-xs text-gray-300">图生图</span>
            </button>
            <button
              onClick={() => onSelect('cr')}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-gray-800/50 hover:bg-gray-700 border border-gray-700 rounded-lg transition-all"
            >
              <User className="w-4 h-4 text-nai-accent" />
              <span className="text-xs text-gray-300">角色参考</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
