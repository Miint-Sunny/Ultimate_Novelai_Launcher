import { useState, useEffect } from 'react';
import { X, Maximize2, Loader2, Check, AlertCircle, Cpu, Cloud, Sparkles } from 'lucide-react';
import { upscaleImage, upscaleViaImg2Img, type UpscaleProgress, type UpscaleMethod, isModelLoaded, UPSCALE_15X_MAX_PIXELS } from '../services/upscaleService';
import { useAuth } from '../contexts/AuthContext';
import { calculateCostFromUI } from '../services/costCalculator';
import { getCachedIsOpus, isOpusUsageExhausted, resolveEnhanceModel } from '../services/novelai';
import { getAISettings } from '../services/localLibrary';
import { enhanceMaxAvailable, enhanceMaxTargetSize, enhanceTargetSize } from '../services/naiEnhanceScale';

interface UpscaleModalProps {
  isOpen: boolean;
  onClose: () => void;
  imageUrl: string;
  onComplete: (resultBlob: Blob, scale: number) => void;
}

// Magnitude 档位对应的 Strength 和 Noise 值
const MAGNITUDE_PRESETS: Record<number, { strength: number; noise: number }> = {
  1: { strength: 0.2, noise: 0 },
  2: { strength: 0.4, noise: 0 },
  3: { strength: 0.5, noise: 0 },
  4: { strength: 0.6, noise: 0 },
  5: { strength: 0.7, noise: 0.1 },
};

export const UpscaleModal: React.FC<UpscaleModalProps> = ({
  isOpen,
  onClose,
  imageUrl,
  onComplete,
}) => {
  const { isAuthenticated, requireAuth } = useAuth();
  // scale 的取值:0 = Max ✨(哨兵),1.5 = 图生图重绘,2/4 = 原生超分。
  // 0 而不是别的数,是因为 Max 的倍率由服务端定,客户端事先并没有一个"倍数"可填。
  const [scale, setScale] = useState<number>(4);
  const [method, setMethod] = useState<UpscaleMethod>('local');
  const [magnitude, setMagnitude] = useState<number>(3); // 1.5x 模式的 Magnitude 档位
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

  // 重绘实际会用的模型(V5 Curated 顶替成 4.5 Curated),Max 档能不能选也看它。
  const enhanceModel = resolveEnhanceModel(getAISettings().model);
  const maxAvailable = imageSize
    ? enhanceMaxAvailable(imageSize.width, imageSize.height, enhanceModel)
    : false;
  // 图生图重绘的两档共用 Magnitude 与费用估算。
  const isRedraw = scale === 0 || scale === 1.5;

  if (!isOpen) return null;

  // 计算预计完成后的尺寸（1.5x 对齐到 64 的倍数；Max ✨ 由服务端定，这里算的是
  // 官方那套 RO() 的结果，只用于展示与估价，不进载荷）
  // 重绘两档的尺寸口径与服务层同源,全族都跟官方。
  const redrawSize = imageSize
    ? enhanceTargetSize(imageSize.width, imageSize.height, scale === 0 ? 'max' : 'x1.5')
    : null;
  const resultWidth = imageSize
    ? (isRedraw ? (redrawSize?.width ?? 0) : Math.round(imageSize.width * scale))
    : 0;
  const resultHeight = imageSize
    ? (isRedraw ? (redrawSize?.height ?? 0) : Math.round(imageSize.height * scale))
    : 0;

  // 1.5x 模式像素上限保护
  const isOver15xLimit = scale === 1.5 && imageSize !== null && resultWidth * resultHeight > UPSCALE_15X_MAX_PIXELS;

  const handleUpscale = async () => {
    // 1.5x 模式像素超限直接阻断
    if (isOver15xLimit) {
      setError(`1.5x 目标尺寸 ${resultWidth}×${resultHeight} 超过上限（约 1024×3072），请先缩小原图。`);
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

      if (scale === 0 || scale === 1.5) {
        // 图生图重绘：Max ✨ 由服务端定输出尺寸，1.5x 由客户端算好再发
        const preset = MAGNITUDE_PRESETS[magnitude];
        resultBlob = await upscaleViaImg2Img(
          imageBlob,
          preset.strength,
          preset.noise,
          setProgress,
          scale === 0 ? 'max' : 'x1.5'
        );
      } else {
        // 2x/4x 模式：使用原有超分
        resultBlob = await upscaleImage(imageBlob, scale, method, setProgress);
      }

      // 延迟一下让用户看到完成状态
      // Max ✨ 的 scale 是哨兵 0，往下游(文件名与历史角标)报实际达成的倍率。
      const achievedScale = scale === 0 && imageSize
        ? Math.max(1, Math.round(enhanceMaxTargetSize(imageSize.width, imageSize.height).width / imageSize.width))
        : scale;

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
          {/* 放大倍数选择 */}
          <div>
            <label className="block text-sm text-gray-400 mb-3">放大倍数</label>
            <div className="flex gap-2">
              {(maxAvailable ? [0, 1.5, 2, 4] : [1.5, 2, 4]).map((s) => (
                <button
                  key={s}
                  onClick={() => setScale(s)}
                  disabled={isProcessing}
                  className={`flex-1 py-3 rounded-xl text-sm font-medium transition-all ${scale === s
                      ? 'bg-nai-accent text-black'
                      : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                    } disabled:opacity-50`}
                >
                  {s === 0 ? 'Max ✨' : `${s}x`}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {isRedraw
                ? (() => {
                  if (!imageSize) return '基于图生图放大，消耗 Anlas';
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
                  return scale === 0
                    ? `Max ✨ 由服务端放大至约 ${size}，消耗 ${result.total} Anlas`
                    : `基于图生图放大至 ${size}，消耗 ${result.total} Anlas`;
                })()
                : '模型原生 4x 放大，2x 会额外缩放'}
            </p>
          </div>

          {/* 图生图重绘：Magnitude 滑块(Max ✨ 与 1.5x 共用) */}
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
                  onClick={() => setMethod('api')}
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
                          使用 NovelAI Upscale，消耗 Anlas
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          仅支持 832×1216 / 1216×832 / 1024×1024
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
                    {scale === 0 ? 'Max ✨ 放大重绘' : '图生图放大'}
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    {scale === 0
                      ? `由 ${enhanceModel} 重新生成，输出尺寸由服务端决定（约 ${resultWidth}×${resultHeight}）`
                      : '将图片以 1.5 倍分辨率重新生成，保持画面内容的同时提升细节'}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 1.5x 像素超限警告 */}
          {isOver15xLimit && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                <div className="text-xs text-red-300 leading-relaxed">
                  <div className="text-sm font-medium text-red-400 mb-1">尺寸超出上限</div>
                  目标尺寸 {resultWidth}×{resultHeight}（{(resultWidth * resultHeight / 1_000_000).toFixed(2)}M 像素）
                  超过 NAI 上限（约 1024×3072 = 3.15M 像素）。请先缩小原图，或改用 2x / 4x 放大。
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
            disabled={isProcessing || isOver15xLimit}
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
