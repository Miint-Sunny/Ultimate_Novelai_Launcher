import React, { useState, useEffect, useRef } from 'react';
import { X, Save, FileX, FileEdit, Download, Check, FileImage, FileType2 } from 'lucide-react';
import { estimateSavedSize, type SaveFormat } from '../utils/imageMetadata';

interface SaveModalProps {
  isOpen: boolean;
  onClose: () => void;
  imageUrl: string;
  seed: number | null;
  onSave: (options: SaveOptions) => void;
  onApplyDefault: (options: SaveOptions) => void;
  defaultMode: 'original' | 'clean' | 'custom';
  defaultCustomPrompt: string;
  defaultFormat: SaveFormat;
  defaultQuality: number;
}

export interface SaveOptions {
  mode: 'original' | 'clean' | 'custom';
  customPrompt?: string;
  format: SaveFormat;
  quality: number; // jpg 0~1
}

const STORAGE_KEY_CUSTOM_PROMPT = 'nai_save_custom_prompt';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export const SaveModal: React.FC<SaveModalProps> = ({
  isOpen,
  onClose,
  imageUrl,
  seed,
  onSave,
  onApplyDefault,
  defaultMode,
  defaultCustomPrompt,
  defaultFormat,
  defaultQuality,
}) => {
  const [mode, setMode] = useState<'original' | 'clean' | 'custom'>(defaultMode);
  const [customPrompt, setCustomPrompt] = useState(defaultCustomPrompt);
  const [format, setFormat] = useState<SaveFormat>(defaultFormat);
  const [quality, setQuality] = useState<number>(defaultQuality);

  const [estimatedSize, setEstimatedSize] = useState<number | null>(null);
  const [isEstimating, setIsEstimating] = useState(false);
  const estimateSeqRef = useRef(0);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY_CUSTOM_PROMPT);
    if (saved) setCustomPrompt(saved);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setMode(defaultMode);
      setFormat(defaultFormat);
      setQuality(defaultQuality);
      if (defaultCustomPrompt) setCustomPrompt(defaultCustomPrompt);
    }
  }, [isOpen, defaultMode, defaultCustomPrompt, defaultFormat, defaultQuality]);

  const saveCustomPrompt = (prompt: string) => {
    setCustomPrompt(prompt);
    localStorage.setItem(STORAGE_KEY_CUSTOM_PROMPT, prompt);
  };

  // 估算大小（jpg 滑动质量时节流）
  useEffect(() => {
    if (!isOpen || !imageUrl) {
      setEstimatedSize(null);
      return;
    }
    const seq = ++estimateSeqRef.current;
    setIsEstimating(true);
    const timer = window.setTimeout(async () => {
      try {
        const size = await estimateSavedSize(imageUrl, {
          mode,
          customPrompt,
          format,
          quality,
        });
        if (seq === estimateSeqRef.current) setEstimatedSize(size);
      } catch {
        if (seq === estimateSeqRef.current) setEstimatedSize(null);
      } finally {
        if (seq === estimateSeqRef.current) setIsEstimating(false);
      }
    }, format === 'jpg' ? 220 : 60);
    return () => window.clearTimeout(timer);
  }, [isOpen, imageUrl, mode, customPrompt, format, quality]);

  if (!isOpen) return null;

  const ext = format === 'jpg' ? 'jpg' : 'png';
  const fileNameSample = `novelai_YYYYMMDD_HHmmss.${ext}`;
  const metaDisabled = format === 'jpg';

  const buildOptions = (): SaveOptions => {
    const opts: SaveOptions = { mode, format, quality };
    if (mode === 'custom') opts.customPrompt = customPrompt;
    return opts;
  };

  const handleSaveOnce = () => {
    onSave(buildOptions());
    onClose();
  };

  const handleApplyDefault = () => {
    onApplyDefault(buildOptions());
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 rounded-2xl shadow-2xl border border-gray-700/50 w-full max-w-md mx-4 max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700/50 shrink-0">
          <div className="flex items-center gap-2.5">
            <Save className="w-4 h-4 text-nai-accent" />
            <h2 className="text-base font-medium text-white">保存设置</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 可滚动主体 */}
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {/* 预览 */}
          <div className="px-5 py-3 border-b border-gray-700/50">
            <div className="flex gap-3">
              <div className="w-14 h-14 rounded-lg overflow-hidden border border-gray-700/50 bg-gray-800 shrink-0">
                <img src={imageUrl} alt="Preview" className="w-full h-full object-cover" />
              </div>
              <div className="flex-1 min-w-0 self-center">
                <div className="text-sm text-white truncate">{fileNameSample}</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  预估大小：
                  <span className="text-gray-200 ml-1 font-mono">
                    {isEstimating ? '计算中…' : formatBytes(estimatedSize ?? 0)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* 格式 + 压缩率 */}
          <div className="px-5 py-3 border-b border-gray-700/50">
            <label className="block text-xs text-gray-400 mb-2">保存格式</label>
            <div className="flex gap-2">
              <button
                onClick={() => setFormat('png')}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-1.5 ${
                  format === 'png'
                    ? 'bg-nai-accent text-black'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}
              >
                <FileImage className="w-3.5 h-3.5" />
                PNG
                <span className={`text-[10px] ${format === 'png' ? 'text-black/60' : 'text-gray-500'}`}>无损</span>
              </button>
              <button
                onClick={() => setFormat('jpg')}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-1.5 ${
                  format === 'jpg'
                    ? 'bg-nai-accent text-black'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}
              >
                <FileType2 className="w-3.5 h-3.5" />
                JPG
                <span className={`text-[10px] ${format === 'jpg' ? 'text-black/60' : 'text-gray-500'}`}>有损</span>
              </button>
            </div>

            {format === 'jpg' && (
              <div className="mt-2.5">
                <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                  <span>压缩质量</span>
                  <span className="text-nai-accent font-mono">{Math.round(quality * 100)}</span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={1}
                  value={Math.round(quality * 100)}
                  onChange={(e) => setQuality(Number(e.target.value) / 100)}
                  className="w-full h-1.5 accent-nai-accent"
                />
                <p className="text-[11px] text-gray-500 mt-1.5">
                  JPG 不保留元数据，自定义提示词在 JPG 下不会写入
                </p>
              </div>
            )}
          </div>

          {/* 保存选项 */}
          <div
            className={`px-5 py-3 space-y-1.5 transition-opacity ${
              metaDisabled ? 'opacity-40 pointer-events-none select-none' : ''
            }`}
            aria-disabled={metaDisabled}
          >
            {/* 原始保存 */}
            <label
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border transition-all ${
                metaDisabled ? 'cursor-not-allowed' : 'cursor-pointer'
              } ${
                mode === 'original'
                  ? 'bg-nai-accent/20 border-nai-accent'
                  : 'bg-gray-800 border-transparent hover:border-gray-600'
              }`}
            >
              <input
                type="radio"
                name="saveMode"
                checked={mode === 'original'}
                onChange={() => setMode('original')}
                disabled={metaDisabled}
                className="accent-nai-accent shrink-0"
              />
              <Download className="w-4 h-4 text-nai-accent shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white font-medium leading-tight">保留原始元数据</div>
                <div className="text-[11px] text-gray-400 mt-0.5">保留 NovelAI 全部元数据</div>
              </div>
            </label>

            {/* 清除元数据 */}
            <label
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border transition-all ${
                metaDisabled ? 'cursor-not-allowed' : 'cursor-pointer'
              } ${
                mode === 'clean'
                  ? 'bg-nai-accent/20 border-nai-accent'
                  : 'bg-gray-800 border-transparent hover:border-gray-600'
              }`}
            >
              <input
                type="radio"
                name="saveMode"
                checked={mode === 'clean'}
                onChange={() => setMode('clean')}
                disabled={metaDisabled}
                className="accent-nai-accent shrink-0"
              />
              <FileX className="w-4 h-4 text-orange-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white font-medium leading-tight">清除元数据</div>
                <div className="text-[11px] text-gray-400 mt-0.5">移除所有元数据，保存纯净图片</div>
              </div>
            </label>

            {/* 自定义元数据 */}
            <label
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border transition-all ${
                metaDisabled ? 'cursor-not-allowed' : 'cursor-pointer'
              } ${
                mode === 'custom'
                  ? 'bg-nai-accent/20 border-nai-accent'
                  : 'bg-gray-800 border-transparent hover:border-gray-600'
              }`}
            >
              <input
                type="radio"
                name="saveMode"
                checked={mode === 'custom'}
                onChange={() => setMode('custom')}
                disabled={metaDisabled}
                className="accent-nai-accent shrink-0"
              />
              <FileEdit className="w-4 h-4 text-blue-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white font-medium leading-tight">自定义提示词</div>
                <div className="text-[11px] text-gray-400 mt-0.5">保持 NAI 格式，替换为自定义提示词</div>
              </div>
            </label>

            {/* 自定义提示词输入 */}
            {mode === 'custom' && (
              <div className="mt-2 bg-gray-800/50 rounded-lg p-2.5">
                <label className="text-[11px] text-gray-400 block mb-1">正向提示词</label>
                <textarea
                  value={customPrompt}
                  onChange={(e) => saveCustomPrompt(e.target.value)}
                  placeholder="输入自定义提示词..."
                  rows={3}
                  disabled={metaDisabled}
                  className="w-full px-2.5 py-1.5 bg-gray-900 border border-gray-700 rounded text-sm text-white placeholder-gray-500 focus:border-nai-accent focus:outline-none resize-none disabled:cursor-not-allowed"
                />
                <div className="text-[11px] text-gray-500 mt-1">
                  其他参数将被清除，提示词会自动保存
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="px-5 py-3 border-t border-gray-700/50 flex gap-2 shrink-0">
          <button
            onClick={handleSaveOnce}
            className="flex-1 py-2.5 rounded-lg text-sm font-medium text-gray-300 hover:text-white bg-gray-800 hover:bg-gray-700 transition-colors flex items-center justify-center gap-1.5"
          >
            <Save className="w-3.5 h-3.5" />
            单次保存
          </button>
          <button
            onClick={handleApplyDefault}
            className="flex-1 py-2.5 rounded-lg text-sm font-medium bg-nai-accent text-black hover:bg-nai-accent/80 transition-colors flex items-center justify-center gap-1.5"
          >
            <Check className="w-3.5 h-3.5" />
            应用默认
          </button>
        </div>
      </div>
    </div>
  );
};
