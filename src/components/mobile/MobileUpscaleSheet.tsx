import { X, Maximize2, Loader2, Check, AlertCircle, Cpu, Cloud, Sparkles } from 'lucide-react';
import { useMobileUpscaleWorkflow } from './upscale/useMobileUpscaleWorkflow';
import { MAGNITUDE_PRESETS } from '../../services/naiEnhanceScale';

interface MobileUpscaleSheetProps {
  isOpen: boolean;
  onClose: () => void;
  imageUrl: string;
  onComplete: (resultBlob: Blob, scale: number) => void;
}

export const MobileUpscaleSheet: React.FC<MobileUpscaleSheetProps> = ({
  isOpen,
  onClose,
  imageUrl,
  onComplete,
}) => {
  const {
    mode,
    setMode,
    setRedrawScale,
    upscaleScale,
    setUpscaleScale,
    redrawOptions,
    activeRedrawScale,
    redrawUnavailable,
    method,
    setMethod,
    magnitude,
    setMagnitude,
    isProcessing,
    progress,
    error,
    imageSize,
    resultWidth,
    resultHeight,
    modelLoaded,
    isOverLimit,
    estimatedRedrawCost,
    handleUpscale,
    isRedraw,
    enhanceModel,
  } = useMobileUpscaleWorkflow({
    isOpen,
    imageUrl,
    onComplete,
    onClose,
  });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60" onClick={onClose}>
      <div
        className="wide-touch-sheet w-full bg-nai-panel rounded-t-2xl shadow-2xl animate-slide-in-from-bottom max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 sticky top-0 bg-nai-panel z-10">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <Maximize2 className="w-5 h-5 text-nai-accent" />
            放大
          </h3>
          <button
            onClick={onClose}
            disabled={isProcessing}
            className="p-1.5 hover:bg-gray-700 rounded-lg text-gray-400 hover:text-white disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* 放大倍数 */}
          <div>
            <label className="text-xs text-gray-400 block mb-2">方式</label>
            <div className="flex gap-2">
              {([
                { key: 'redraw' as const, label: '图生图重绘' },
                { key: 'upscale' as const, label: '原生超分' },
              ]).map((m) => {
                const blocked = m.key === 'redraw' && redrawUnavailable;
                return (
                  <button
                    key={m.key}
                    onClick={() => setMode(m.key)}
                    disabled={isProcessing || blocked}
                    className={`flex-1 py-3 rounded-xl text-sm font-bold transition-all ${mode === m.key
                        ? 'bg-nai-accent text-black'
                        : 'bg-gray-800 text-gray-300 active:bg-gray-700'
                      } disabled:opacity-50`}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
            {redrawUnavailable && (
              <p className="text-[11px] leading-4 text-gray-500 mt-2">
                源图 {imageSize?.width}×{imageSize?.height} 太大，任何重绘倍率都会超上限，请改用原生超分。
              </p>
            )}
          </div>

          <div>
            <label className="text-xs text-gray-400 block mb-2">倍率</label>
            <div className="flex gap-2">
              {isRedraw
                ? redrawOptions.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => setRedrawScale(option.id)}
                    disabled={isProcessing}
                    className={`flex-1 py-3 rounded-xl text-sm font-bold transition-all ${activeRedrawScale === option.id
                        ? 'bg-nai-accent text-black'
                        : 'bg-gray-800 text-gray-300 active:bg-gray-700'
                      } disabled:opacity-50`}
                  >
                    {option.label}
                  </button>
                ))
                : ([2, 4] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setUpscaleScale(s)}
                    disabled={isProcessing}
                    className={`flex-1 py-3 rounded-xl text-sm font-bold transition-all ${upscaleScale === s
                        ? 'bg-nai-accent text-black'
                        : 'bg-gray-800 text-gray-300 active:bg-gray-700'
                      } disabled:opacity-50`}
                  >
                    {s}x
                  </button>
                ))}
            </div>
          </div>

          {/* 图生图重绘：Magnitude 滑块(Max ✨ 与 1.5x 共用) */}
          {isRedraw && (
            <div>
              <label className="text-xs text-gray-400 block mb-2">
                Magnitude <span className="text-nai-accent font-mono">{magnitude}</span>
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="1"
                  max="5"
                  step="1"
                  value={magnitude}
                  onChange={(e) => setMagnitude(parseInt(e.target.value))}
                  disabled={isProcessing}
                  className="flex-1 h-2 accent-nai-accent"
                />
              </div>
              <div className="flex justify-between text-xs text-gray-500 mt-1">
                <span>保守</span>
                <span>激进</span>
              </div>
              <p className="text-xs text-gray-500 mt-2 text-center">
                Strength: {MAGNITUDE_PRESETS[magnitude].strength} / Noise: {MAGNITUDE_PRESETS[magnitude].noise}
              </p>
            </div>
          )}

          {/* 处理方式 - 仅在 2x/4x 模式显示 */}
          {!isRedraw && (
            <div>
              <label className="text-xs text-gray-400 block mb-2">处理方式</label>
              <div className="space-y-2">
                <button
                  onClick={() => setMethod('local')}
                  disabled={isProcessing}
                  className={`w-full p-3 rounded-xl text-left transition-all ${method === 'local'
                      ? 'bg-nai-accent/20 border-2 border-nai-accent'
                      : 'bg-gray-800 border-2 border-transparent active:border-gray-600'
                    } disabled:opacity-50`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Cpu className="w-5 h-5 text-nai-accent" />
                      <div>
                        <div className="text-white font-medium text-sm">Sidecar</div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          {modelLoaded ? '本地 sidecar 处理' : '不在前端下载模型'}
                        </div>
                      </div>
                    </div>
                    {method === 'local' && <Check className="w-5 h-5 text-nai-accent" />}
                  </div>
                </button>

                <button
                  onClick={() => setMethod('api')}
                  disabled={isProcessing}
                  className={`w-full p-3 rounded-xl text-left transition-all ${method === 'api'
                      ? 'bg-nai-accent/20 border-2 border-nai-accent'
                      : 'bg-gray-800 border-2 border-transparent active:border-gray-600'
                    } disabled:opacity-50`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Cloud className="w-5 h-5 text-blue-400" />
                      <div>
                        <div className="text-white font-medium text-sm">NovelAI</div>
                        <div className="text-xs text-gray-400 mt-0.5">消耗 Anlas，限特定尺寸</div>
                      </div>
                    </div>
                    {method === 'api' && <Check className="w-5 h-5 text-nai-accent" />}
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* 图生图重绘说明 */}
          {isRedraw && (
            <div className="bg-gray-800/50 rounded-xl p-3">
              <div className="flex items-center gap-3">
                <Sparkles className="w-5 h-5 text-nai-accent flex-shrink-0" />
                <div>
                  <div className="text-sm text-white font-medium">
                    {activeRedrawScale === 'max' ? 'Max ✨ 放大重绘'
                      : activeRedrawScale === 'x1' ? '同尺寸精修'
                        : '图生图重绘'}
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {(() => {
                      const cost = estimatedRedrawCost === null ? '，消耗 Anlas' : `，消耗 ${estimatedRedrawCost} Anlas`;
                      const size = `${resultWidth}×${resultHeight}`;
                      if (activeRedrawScale === 'max') return `由 ${enhanceModel} 重绘，尺寸由服务端决定（约 ${size}）${cost}`;
                      if (activeRedrawScale === 'x1') return `同尺寸精修（${size}）${cost}`;
                      const label = redrawOptions.find((o) => o.id === activeRedrawScale)?.label ?? '';
                      return `以 ${label} 分辨率重新生成至 ${size}${cost}`;
                    })()}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 重绘像素超限警告 */}
          {isOverLimit && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                <div className="text-xs text-red-300 leading-relaxed">
                  <div className="text-sm font-medium text-red-400 mb-0.5">尺寸超出上限</div>
                  目标 {resultWidth}×{resultHeight}（{(resultWidth * resultHeight / 1_000_000).toFixed(2)}M 像素）
                  超过 NAI 上限（约 1024×3072 = 3.15M）。请先缩小原图，或改用 2x / 4x。
                </div>
              </div>
            </div>
          )}

          {/* 进度显示 */}
          {progress && (
            <div className="bg-gray-800/50 rounded-xl p-3">
              <div className="flex items-center gap-3">
                {progress.stage === 'done' ? (
                  <Check className="w-5 h-5 text-green-400 flex-shrink-0" />
                ) : progress.stage === 'error' ? (
                  <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
                ) : (
                  <Loader2 className="w-5 h-5 text-nai-accent animate-spin flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white">{progress.message}</div>
                  {progress.stage !== 'done' && progress.stage !== 'error' && (
                    <div className="mt-2 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-nai-accent rounded-full transition-all"
                        style={{ width: `${progress.progress}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 错误显示 */}
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                <div className="text-sm text-red-400">{error}</div>
              </div>
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="px-4 pb-6 pt-2">
          <button
            onClick={handleUpscale}
            disabled={isProcessing || isOverLimit}
            className="w-full flex items-center justify-center gap-2 py-3 bg-nai-accent hover:bg-nai-accent/80 text-black font-bold rounded-xl transition-colors disabled:opacity-50"
          >
            {isProcessing ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                处理中...
              </>
            ) : (
              <>
                <Maximize2 className="w-5 h-5" />
                开始放大
                {imageSize && (
                  <span className="text-xs opacity-70 font-mono ml-1">
                    {resultWidth}×{resultHeight}
                  </span>
                )}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
