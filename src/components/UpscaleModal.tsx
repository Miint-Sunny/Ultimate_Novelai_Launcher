import { useState, useEffect } from 'react';
import { X, Maximize2, Loader2, Check, AlertCircle, Cpu, Cloud, Sparkles } from 'lucide-react';
import { upscaleImage, upscaleViaImg2Img, type UpscaleProgress, type UpscaleMethod, isModelLoaded, UPSCALE_15X_MAX_PIXELS } from '../services/upscaleService';
import { useAuth } from '../contexts/AuthContext';
import { calculateCostFromUI } from '../services/costCalculator';
import { v5UpscaleCost, v5UpscaleTargetSize } from '../services/naiV5Upscale';
import { getCachedIsOpus, isOpusUsageExhausted, resolveEnhanceModel } from '../services/novelai';
import { getAISettings } from '../services/localLibrary';
import {
  MAGNITUDE_PRESETS,
  enhanceScaleOptions,
  enhanceTargetSize,
  resolveEnhanceScaleChoice,
  type EnhanceMode,
  type EnhanceScaleId,
} from '../services/naiEnhanceScale';

interface UpscaleModalProps {
  isOpen: boolean;
  onClose: () => void;
  imageUrl: string;
  onComplete: (resultBlob: Blob, scale: number) => void;
}

export const UpscaleModal: React.FC<UpscaleModalProps> = ({
  isOpen,
  onClose,
  imageUrl,
  onComplete,
}) => {
  const { isAuthenticated, requireAuth } = useAuth();
  // 「方式」与「倍率」是两件事,分开存。此前挤在一个 scale: number 里,
  // Max 档还得用哨兵 0 表示 —— 因为它的倍率由服务端定,客户端根本没有数可填。
  const [mode, setMode] = useState<EnhanceMode>('upscale');
  const [redrawScale, setRedrawScale] = useState<EnhanceScaleId>('x1.5');
  const [upscaleScale, setUpscaleScale] = useState<2 | 4>(4);
  const [method, setMethod] = useState<UpscaleMethod>('local');
  const [magnitude, setMagnitude] = useState<number>(3); // 重绘的 Magnitude 档位
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<UpscaleProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);

  // 获取图片实际尺寸
  useEffect(() => {
    if (isOpen && imageUrl) {
      const img = new Image();
      img.src = imageUrl;
      img.onload = () => {
        setImageSize({ width: img.naturalWidth, height: img.naturalHeight });
      };
    }
  }, [isOpen, imageUrl]);

  // 重绘实际会用的模型(V5 Curated 顶替成 4.5 Curated),档位表也按它算。
  const enhanceModel = resolveEnhanceModel(getAISettings().model);
  // 档位完全由官方那套筛选规则给出,界面不硬编码列表。
  // ⚠ 它**可能是空的**(源图大到连 1× 都越上限),所以「重绘」这个方式要能禁掉。
  const redrawOptions = imageSize
    ? enhanceScaleOptions(imageSize.width, imageSize.height, enhanceModel)
    : [];
  const redrawUnavailable = imageSize !== null && redrawOptions.length === 0;
  const activeRedrawScale = resolveEnhanceScaleChoice(redrawOptions, redrawScale);
  const isRedraw = mode === 'redraw';

  if (!isOpen) return null;

  // 重绘的目标尺寸与服务层同源(Max 档算的是服务端会产出的尺寸,只用于展示与估价,
  // 不进载荷 —— 载荷发的是原图尺寸)。
  const redrawSize = imageSize
    ? enhanceTargetSize(imageSize.width, imageSize.height, activeRedrawScale)
    : null;
  const resultWidth = imageSize
    ? (isRedraw ? (redrawSize?.width ?? 0) : Math.round(imageSize.width * upscaleScale))
    : 0;
  const resultHeight = imageSize
    ? (isRedraw ? (redrawSize?.height ?? 0) : Math.round(imageSize.height * upscaleScale))
    : 0;

  // 像素上限保护。此前只挡 1.5×,现在所有重绘档都要挡。
  const isOverLimit = isRedraw && imageSize !== null && resultWidth * resultHeight > UPSCALE_15X_MAX_PIXELS;

  const handleUpscale = async () => {
    // 重绘目标尺寸超限直接阻断
    if (isOverLimit) {
      setError(`重绘目标尺寸 ${resultWidth}×${resultHeight} 超过上限（约 1024×3072），请先缩小原图。`);
      return;
    }

    // 检查登录状态（API 模式与两档图生图重绘都要登录）
    if ((method === 'api' || isRedraw) && !isAuthenticated) {
      requireAuth(() => handleUpscale());
      return;
    }

    setIsProcessing(true);
    setError(null);
    setProgress({ stage: 'loading', progress: 0, message: '准备中...' });

    try {
      // 获取图片 Blob
      const response = await fetch(imageUrl);
      const imageBlob = await response.blob();

      let resultBlob: Blob;

      if (isRedraw) {
        // Max ✨ 由服务端定输出尺寸,数值档由客户端算好再发
        const preset = MAGNITUDE_PRESETS[magnitude];
        resultBlob = await upscaleViaImg2Img(
          imageBlob,
          preset.strength,
          preset.noise,
          setProgress,
          activeRedrawScale
        );
      } else {
        resultBlob = await upscaleImage(imageBlob, upscaleScale, method, setProgress);
      }

      // 下游(文件名与历史角标)要的是**实际达成的倍率**。重绘没有现成的倍数可报
      // (Max 档尤其没有),按结果宽 ÷ 原图宽算,兜底 1 —— 不能报 0。
      const achievedScale = isRedraw
        ? (imageSize && redrawSize ? Math.max(1, Math.round(redrawSize.width / imageSize.width)) : 1)
        : upscaleScale;

      setTimeout(() => {
        onComplete(resultBlob, achievedScale);
        onClose();
      }, 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : '超分失败');
      setProgress(null);
    } finally {
      setIsProcessing(false);
    }
  };

  const modelLoaded = isModelLoaded();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-gray-900 rounded-2xl shadow-2xl border border-gray-700/50 w-full max-w-md mx-4">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700/50">
          <div className="flex items-center gap-3">
            <Maximize2 className="w-5 h-5 text-nai-accent" />
            <h2 className="text-lg font-medium text-white">放大</h2>
          </div>
          <button
            onClick={onClose}
            disabled={isProcessing}
            className="p-2 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 内容 */}
        <div className="p-6 space-y-6">
          {/* 方式:这两件事此前混在同一排按钮里 —— 重绘走 generate-image 会重画、
              耗 Anlas;原生超分走 upscale,不重画。分成两级之后「重绘 2×」和
              「原生 2x」也不会再在同一排里撞名。 */}
          <div>
            <label className="block text-sm text-gray-400 mb-3">方式</label>
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
                    title={blocked ? '源图太大,任何重绘倍率都会超过总像素上限' : undefined}
                    className={`flex-1 py-3 rounded-xl text-sm font-medium transition-all ${mode === m.key
                        ? 'bg-nai-accent text-black'
                        : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                      } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
            {redrawUnavailable && (
              <p className="text-xs text-gray-500 mt-2">
                源图 {imageSize?.width}×{imageSize?.height} 太大，任何重绘倍率都会超过总像素上限（约 1024×3072）。
                请改用原生超分，或先把原图缩小。
              </p>
            )}
          </div>

          {/* 倍率 */}
          <div>
            <label className="block text-sm text-gray-400 mb-3">倍率</label>
            <div className="flex gap-2">
              {isRedraw
                ? redrawOptions.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => setRedrawScale(option.id)}
                    disabled={isProcessing}
                    className={`flex-1 py-3 rounded-xl text-sm font-medium transition-all ${activeRedrawScale === option.id
                        ? 'bg-nai-accent text-black'
                        : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                      } disabled:opacity-50`}
                  >
                    {option.label}
                  </button>
                ))
                // V5 扩散超分固定 2×:NovelAI 方式下不给 4× 档。
                : ((method === 'api' ? [2] : [2, 4]) as readonly (2 | 4)[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setUpscaleScale(s)}
                    disabled={isProcessing}
                    className={`flex-1 py-3 rounded-xl text-sm font-medium transition-all ${upscaleScale === s
                        ? 'bg-nai-accent text-black'
                        : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                      } disabled:opacity-50`}
                  >
                    {s}x
                  </button>
                ))}
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {isRedraw
                ? (() => {
                  if (!imageSize) return '基于图生图重绘，消耗 Anlas';
                  // Max ✨ 的输出尺寸是服务端定的，params 里留的是原图尺寸 ——
                  // 按原尺寸估价会系统性少记四倍，所以这里必须用算出来的实际尺寸。
                  const target = redrawSize ?? { width: 0, height: 0 };
                  const preset = MAGNITUDE_PRESETS[magnitude];
                  const result = calculateCostFromUI({
    // V5 体力条耗尽后 NAI 静默改扣 Anlas；不带上这个标志，界面会一直显示「免费」
    opusUsageExhausted: isOpusUsageExhausted(),
                    width: target.width,
                    height: target.height,
                    steps: 28,
                    modelId: enhanceModel,
                    sampler: 'Euler Ancestral',
                    isOpus: getCachedIsOpus(),
                    img2imgStrength: preset.strength,
                  });
                  const size = `${target.width}×${target.height}`;
                  if (activeRedrawScale === 'max') return `Max ✨ 由服务端放大至约 ${size}，消耗 ${result.total} Anlas`;
                  if (activeRedrawScale === 'x1') return `同尺寸精修（${size}），消耗 ${result.total} Anlas`;
                  return `基于图生图重绘至 ${size}，消耗 ${result.total} Anlas`;
                })()
                : method === 'api'
                  ? 'V5 扩散超分固定 2×，按源图像素计费'
                  : '模型原生 4x 放大，2x 会额外缩放'}
            </p>
          </div>

          {/* Magnitude 滑块只属于重绘,各档共用 */}
          {isRedraw && (
            <div>
              <label className="block text-sm text-gray-400 mb-3">
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
              <div className="flex justify-between text-xs text-gray-500 mt-2">
                <span>保守</span>
                <span>激进</span>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Strength: {MAGNITUDE_PRESETS[magnitude].strength} / Noise: {MAGNITUDE_PRESETS[magnitude].noise}
              </p>
            </div>
          )}

          {/* 处理方式选择 - 仅在原生超分(2x/4x)显示 */}
          {!isRedraw && (
            <div>
              <label className="block text-sm text-gray-400 mb-3">处理方式</label>
              <div className="space-y-2">
                <button
                  onClick={() => setMethod('local')}
                  disabled={isProcessing}
                  className={`w-full p-4 rounded-xl text-left transition-all ${method === 'local'
                      ? 'bg-nai-accent/20 border-2 border-nai-accent'
                      : 'bg-gray-800 border-2 border-transparent hover:border-gray-600'
                    } disabled:opacity-50`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Cpu className="w-5 h-5 text-nai-accent" />
                      <div>
                        <div className="text-white font-medium">Sidecar</div>
                        <div className="text-xs text-gray-400 mt-1">
                          {modelLoaded ? '本地 sidecar 已接管超分' : '通过本地 sidecar 处理'}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          前端不再下载或运行 ONNX 模型
                        </div>
                      </div>
                    </div>
                    {method === 'local' && <Check className="w-5 h-5 text-nai-accent" />}
                  </div>
                </button>

                <button
                  onClick={() => { setMethod('api'); setUpscaleScale(2); }}
                  disabled={isProcessing}
                  className={`w-full p-4 rounded-xl text-left transition-all ${method === 'api'
                      ? 'bg-nai-accent/20 border-2 border-nai-accent'
                      : 'bg-gray-800 border-2 border-transparent hover:border-gray-600'
                    } disabled:opacity-50`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Cloud className="w-5 h-5 text-blue-400" />
                      <div>
                        <div className="text-white font-medium">NovelAI</div>
                        <div className="text-xs text-gray-400 mt-1">
                          NovelAI V5 扩散超分，固定 2×，按源图像素计 1–4 Anlas
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {(() => {
                            if (!imageSize) return '源图最大约 1024×3072（3.15M 像素）';
                            const cost = v5UpscaleCost(imageSize.width, imageSize.height);
                            if (cost === null) return `源图 ${imageSize.width}×${imageSize.height} 超过上限（约 1024×3072），请先缩小`;
                            const target = v5UpscaleTargetSize(imageSize.width, imageSize.height);
                            return `${imageSize.width}×${imageSize.height} → ${target.width}×${target.height}，消耗 ${cost} Anlas`;
                          })()}
                        </div>
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
            <div className="bg-gray-800/50 rounded-xl p-4">
              <div className="flex items-center gap-3">
                <Sparkles className="w-5 h-5 text-nai-accent flex-shrink-0" />
                <div>
                  <div className="text-sm text-white font-medium">
                    {activeRedrawScale === 'max' ? 'Max ✨ 放大重绘'
                      : activeRedrawScale === 'x1' ? '同尺寸精修'
                        : '图生图重绘'}
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    {activeRedrawScale === 'max'
                      ? `由 ${enhanceModel} 重新生成，输出尺寸由服务端决定（约 ${resultWidth}×${resultHeight}）`
                      : activeRedrawScale === 'x1'
                        ? `同尺寸精修（${resultWidth}×${resultHeight}），只重绘不放大`
                        : `将图片以 ${redrawOptions.find((o) => o.id === activeRedrawScale)?.label ?? ''} 分辨率重新生成至 ${resultWidth}×${resultHeight}，保持画面内容的同时提升细节`}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 重绘像素超限警告 */}
          {isOverLimit && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                <div className="text-xs text-red-300 leading-relaxed">
                  <div className="text-sm font-medium text-red-400 mb-1">尺寸超出上限</div>
                  目标尺寸 {resultWidth}×{resultHeight}（{(resultWidth * resultHeight / 1_000_000).toFixed(2)}M 像素）
                  超过 NAI 上限（约 1024×3072 = 3.15M 像素）。请先缩小原图，或改用原生超分。
                </div>
              </div>
            </div>
          )}

          {/* 进度显示 */}
          {progress && (
            <div className="bg-gray-800/50 rounded-xl p-4">
              <div className="flex items-center gap-3">
                {progress.stage === 'done' ? (
                  <Check className="w-5 h-5 text-green-400 flex-shrink-0" />
                ) : progress.stage === 'error' ? (
                  <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
                ) : (
                  <Loader2 className="w-5 h-5 text-nai-accent animate-spin flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white whitespace-pre-line">{progress.message}</div>
                  {progress.stage !== 'done' && progress.stage !== 'error' && (
                    <div className="mt-2 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-nai-accent rounded-full transition-all duration-300"
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
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
              <div className="flex items-center gap-3">
                <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
                <div className="text-sm text-red-400">{error}</div>
              </div>
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="px-6 py-4 border-t border-gray-700/50 flex gap-3">
          <button
            onClick={onClose}
            disabled={isProcessing}
            className="flex-1 py-3 rounded-xl text-sm font-medium text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={handleUpscale}
            disabled={isProcessing || isOverLimit}
            className="flex-1 py-3 rounded-xl font-medium bg-nai-accent text-black hover:bg-nai-accent/80 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isProcessing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">处理中...</span>
              </>
            ) : (
              <>
                <Maximize2 className="w-4 h-4" />
                <span className="text-sm">开始</span>
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
