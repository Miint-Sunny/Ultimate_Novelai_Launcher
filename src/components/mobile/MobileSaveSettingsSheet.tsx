import type { Dispatch, SetStateAction } from 'react';
import { Check, Download, FileEdit, FileX, Save, X } from 'lucide-react';
import type { SaveFormat } from '../../utils/imageMetadata';

type SaveMode = 'original' | 'clean' | 'custom';

interface MobileSaveSettingsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  saveMode: SaveMode;
  setSaveMode: Dispatch<SetStateAction<SaveMode>>;
  customPrompt: string;
  setCustomPrompt: Dispatch<SetStateAction<string>>;
  saveFormat: SaveFormat;
  setSaveFormat: Dispatch<SetStateAction<SaveFormat>>;
  saveQuality: number;
  setSaveQuality: Dispatch<SetStateAction<number>>;
  isEstimating: boolean;
  estimatedSize: number | null;
  onApply: () => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function MobileSaveSettingsSheet({
  isOpen,
  onClose,
  saveMode,
  setSaveMode,
  customPrompt,
  setCustomPrompt,
  saveFormat,
  setSaveFormat,
  saveQuality,
  setSaveQuality,
  isEstimating,
  estimatedSize,
  onApply,
}: MobileSaveSettingsSheetProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="wide-touch-sheet w-full bg-nai-panel rounded-t-2xl shadow-2xl animate-slide-in-from-bottom"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Sheet grabber(P7-1):顶部居中小横条 */}
        <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-gray-600" />
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <Save className="w-5 h-5" />
            保存设置
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 active:bg-gray-700 rounded-lg text-gray-400 active:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <label
            className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${saveMode === 'original'
              ? 'border-nai-accent bg-nai-accent/10'
              : 'border-gray-700 active:border-gray-600'
              }`}
          >
            <input
              type="radio"
              name="saveMode"
              checked={saveMode === 'original'}
              onChange={() => setSaveMode('original')}
              className="w-5 h-5"
            />
            <div className="flex-1">
              <div className="flex items-center gap-2 text-sm text-white font-medium">
                <Download className="w-4 h-4 text-nai-accent" />
                保留原始元数据
              </div>
              <div className="text-xs text-gray-400 mt-0.5">
                保留 NovelAI 生成的所有元数据
              </div>
            </div>
          </label>

          <label
            className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${saveMode === 'clean'
              ? 'border-nai-accent bg-nai-accent/10'
              : 'border-gray-700 active:border-gray-600'
              }`}
          >
            <input
              type="radio"
              name="saveMode"
              checked={saveMode === 'clean'}
              onChange={() => setSaveMode('clean')}
              className="w-5 h-5"
            />
            <div className="flex-1">
              <div className="flex items-center gap-2 text-sm text-white font-medium">
                <FileX className="w-4 h-4 text-orange-400" />
                清除元数据
              </div>
              <div className="text-xs text-gray-400 mt-0.5">
                移除所有元数据，保存纯净图片
              </div>
            </div>
          </label>

          <label
            className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${saveMode === 'custom'
              ? 'border-nai-accent bg-nai-accent/10'
              : 'border-gray-700 active:border-gray-600'
              }`}
          >
            <input
              type="radio"
              name="saveMode"
              checked={saveMode === 'custom'}
              onChange={() => setSaveMode('custom')}
              className="w-5 h-5"
            />
            <div className="flex-1">
              <div className="flex items-center gap-2 text-sm text-white font-medium">
                <FileEdit className="w-4 h-4 text-blue-400" />
                自定义提示词
              </div>
              <div className="text-xs text-gray-400 mt-0.5">
                保持 NAI 格式，替换为自定义提示词
              </div>
            </div>
          </label>

          {saveMode === 'custom' && (
            <div className="p-3 bg-gray-800/50 rounded-xl">
              <label className="text-xs text-gray-400 block mb-1.5">正向提示词</label>
              <textarea
                value={customPrompt}
                onChange={(event) => setCustomPrompt(event.target.value)}
                placeholder="输入自定义提示词..."
                rows={3}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:border-nai-accent focus:outline-none resize-none"
              />
            </div>
          )}

          <div className="pt-2">
            <div className="text-xs text-gray-400 mb-2">保存格式</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setSaveFormat('png')}
                className={`flex items-center justify-center gap-2 py-2.5 rounded-xl border text-sm font-medium transition-colors ${
                  saveFormat === 'png'
                    ? 'border-nai-accent bg-nai-accent/10 text-nai-accent'
                    : 'border-gray-700 text-gray-300 active:border-gray-600'
                }`}
              >
                PNG
                <span className="text-[10px] text-gray-500">无损</span>
              </button>
              <button
                onClick={() => setSaveFormat('jpg')}
                className={`flex items-center justify-center gap-2 py-2.5 rounded-xl border text-sm font-medium transition-colors ${
                  saveFormat === 'jpg'
                    ? 'border-nai-accent bg-nai-accent/10 text-nai-accent'
                    : 'border-gray-700 text-gray-300 active:border-gray-600'
                }`}
              >
                JPG
                <span className="text-[10px] text-gray-500">有损</span>
              </button>
            </div>

            {saveFormat === 'jpg' && (
              <div className="mt-3 px-1">
                <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                  <span>压缩质量</span>
                  <span className="text-gray-200 font-mono">{Math.round(saveQuality * 100)}</span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={1}
                  value={Math.round(saveQuality * 100)}
                  onChange={(event) => setSaveQuality(Number(event.target.value) / 100)}
                  className="w-full accent-nai-accent"
                />
                <div className="text-[11px] text-gray-500 mt-1">
                  JPG 不保留元数据，自定义提示词在 JPG 下不会写入。
                </div>
              </div>
            )}

            <div className="mt-3 px-1 text-xs text-gray-400">
              预估大小：
              <span className="text-gray-200 ml-1">
                {isEstimating ? '计算中…' : formatBytes(estimatedSize ?? 0)}
              </span>
            </div>
          </div>
        </div>

        <div className="px-4 pb-6 pt-2">
          <button
            onClick={onApply}
            className="w-full flex items-center justify-center gap-2 py-3 bg-nai-accent hover:bg-nai-accent/80 text-black font-bold rounded-xl transition-colors"
          >
            <Check className="w-5 h-5" />
            应用设置
          </button>
        </div>
      </div>
    </div>
  );
}
