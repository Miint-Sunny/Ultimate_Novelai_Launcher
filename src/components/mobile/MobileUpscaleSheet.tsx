import { useState, useEffect } from 'react';
import { X, Maximize2, Loader2, Check, AlertCircle, Cpu, Cloud, Sparkles } from 'lucide-react';
import {
  upscaleImage,
  upscaleFromCanvas,
  upscaleViaImg2Img,
  type UpscaleProgress,
  type UpscaleMethod,
  isModelLoaded,
  UPSCALE_15X_MAX_PIXELS,
} from '../../services/upscaleService';
import { calculateCostFromUI } from '../../services/costCalculator';
import { getCachedIsOpus } from '../../services/novelai';
import { loadImageToCanvas } from './upscale/loadImageToCanvas';

interface MobileUpscaleSheetProps {
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

export const MobileUpscaleSheet: React.FC<MobileUpscaleSheetProps> = ({
  isOpen,
  onClose,
  imageUrl,
  onComplete,
}) => {
  const [scale, setScale] = useState<number>(4);
  const [method, setMethod] = useState<UpscaleMethod>('local');
  const [magnitude, setMagnitude] = useState<number>(3); // 1.5x 模式的 Magnitude 档位
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<UpscaleProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (isOpen && imageUrl) {
      const img = new Image();
      img.src = imageUrl;
      img.onload = () => setImageSize({ width: img.naturalWidth, height: img.naturalHeight });
    }
  }, [isOpen, imageUrl]);

  useEffect(() => {
    if (!isOpen) {
      setProgress(null);
      setError(null);
    }
  }, [isOpen]);

  const resultWidth = imageSize
    ? (scale === 1.5 ? Math.round((imageSize.width * 1.5) / 64) * 64 : Math.round(imageSize.width * scale))
    : 0;
  const resultHeight = imageSize
    ? (scale === 1.5 ? Math.round((imageSize.height * 1.5) / 64) * 64 : Math.round(imageSize.height * scale))
    : 0;
  const modelLoaded = isModelLoaded();

  // 1.5x 模式像素上限保护
  const isOver15xLimit = scale === 1.5 && imageSize !== null && resultWidth * resultHeight > UPSCALE_15X_MAX_PIXELS;

  const handleUpscale = async () => {
    // 1.5x 模式像素超限直接阻断
    if (isOver15xLimit) {
      setError(`1.5x 目标尺寸 ${resultWidth}×${resultHeight} 超过上限（约 1024×3072），请先缩小原图。`);
      return;
    }

    setIsProcessing(true);
    setError(null);
    setProgress({ stage: 'loading', progress: 0, message: '准备中...' });

    try {
      let resultBlob: Blob;

      // 1.5x 模式：使用图生图
      if (scale === 1.5) {
        setProgress({ stage: 'loading', progress: 5, message: '准备图片...' });

        // 获取图片 Blob
        const imageBlob = await new Promise<Blob>((resolve, reject) => {
          const img = new Image();
          const timeoutId = setTimeout(() => reject(new Error('图片加载超时')), 15000);

          img.onload = () => {
            clearTimeout(timeoutId);
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              reject(new Error('无法创建 Canvas'));
              return;
            }
            ctx.drawImage(img, 0, 0);
            canvas.toBlob(
              (blob) => {
                if (blob) resolve(blob);
                else reject(new Error('无法转换为 Blob'));
              },
              'image/png',
              1.0
            );
          };

          img.onerror = () => {
            clearTimeout(timeoutId);
            reject(new Error('图片加载失败'));
          };

          img.src = imageUrl;
        });

        const preset = MAGNITUDE_PRESETS[magnitude];
        resultBlob = await upscaleViaImg2Img(imageBlob, preset.strength, preset.noise, setProgress);
      } else if (method === 'local') {
        // 本地处理：直接使用 Canvas，避免移动端图片解码问题
        const urlType = imageUrl.startsWith('blob:') ? 'blob' :
          imageUrl.startsWith('data:') ? 'data' :
            imageUrl.startsWith('http') ? 'http' : 'other';
        setProgress({ stage: 'loading', progress: 2, message: `[1] URL: ${urlType}, 长度: ${imageUrl.length}` });

        let canvas: HTMLCanvasElement | null = null;

        // 1. 尝试 Fetch + createImageBitmap (最高效，且支持 CORS 检查)
        if (imageUrl.startsWith('blob:') || imageUrl.startsWith('http')) {
          setProgress({ stage: 'loading', progress: 3, message: '[2] Fetch 图片...' });

          try {
            const response = await fetch(imageUrl, { mode: 'cors' });
            if (!response.ok) {
              throw new Error(`Fetch 失败: ${response.status}`);
            }

            const blob = await response.blob();
            setProgress({ stage: 'loading', progress: 4, message: `[3] Blob: ${(blob.size / 1024).toFixed(0)}KB` });

            // 尝试 createImageBitmap
            if (typeof createImageBitmap === 'function') {
              try {
                setProgress({ stage: 'loading', progress: 5, message: '[4] createImageBitmap...' });
                const bitmap = await createImageBitmap(blob);
                setProgress({ stage: 'loading', progress: 6, message: `[5] Bitmap: ${bitmap.width}x${bitmap.height}` });

                canvas = document.createElement('canvas');
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                const ctx = canvas.getContext('2d');
                if (!ctx) throw new Error('无法创建 Canvas Context');
                ctx.drawImage(bitmap, 0, 0);
                bitmap.close();
              } catch (e) {
                console.warn('createImageBitmap failed:', e);
                // Fallback will be handled below
              }
            }

            // 如果 createImageBitmap 失败但我们有 blob，可以用 loadImageToCanvas 加载 blob
            if (!canvas) {
              canvas = await loadImageToCanvas(blob, setProgress);
            }

          } catch (fetchErr) {
            console.warn('Fetch failed:', fetchErr);
            // fetch 失败，稍后尝试直接加载 URL
          }
        }

        // 2. 如果上面没有成功创建 canvas，使用 Image 对象直接加载 URL
        if (!canvas) {
          setProgress({ stage: 'loading', progress: 4, message: '[3b] 使用 Image 加载 URL...' });
          canvas = await loadImageToCanvas(imageUrl, setProgress);
        }

        setProgress({ stage: 'loading', progress: 10, message: '[7] 开始超分处理...' });
        resultBlob = await upscaleFromCanvas(canvas, scale, setProgress);
      } else {

        // API 处理：需要 Blob
        setProgress({ stage: 'loading', progress: 5, message: '准备图片...' });

        const imageBlob = await new Promise<Blob>((resolve, reject) => {
          const img = new Image();

          const timeoutId = setTimeout(() => {
            reject(new Error('图片加载超时'));
          }, 15000);

          img.onload = () => {
            clearTimeout(timeoutId);
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              reject(new Error('无法创建 Canvas'));
              return;
            }
            ctx.drawImage(img, 0, 0);
            canvas.toBlob(
              (blob) => {
                if (blob) resolve(blob);
                else reject(new Error('无法转换为 Blob'));
              },
              'image/png',
              1.0
            );
          };

          img.onerror = () => {
            clearTimeout(timeoutId);
            reject(new Error('图片加载失败'));
          };

          img.src = imageUrl;
        });

        setProgress({ stage: 'loading', progress: 10, message: '开始超分处理...' });
        resultBlob = await upscaleImage(imageBlob, scale, method, setProgress);
      }

      setProgress({ stage: 'done', progress: 100, message: '超分完成！' });

      setTimeout(() => {
        setIsProcessing(false);
        onComplete(resultBlob, scale);
        onClose();
      }, 500);
    } catch (err) {
      console.error('超分失败:', err);
      setError(err instanceof Error ? err.message : '超分失败');
      setProgress(null);
      setIsProcessing(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full bg-nai-panel rounded-t-2xl shadow-2xl animate-slide-in-from-bottom max-h-[85vh] overflow-y-auto"
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
            <label className="text-xs text-gray-400 block mb-2">放大倍数</label>
            <div className="flex gap-2">
              {[1.5, 2, 4].map((s) => (
                <button
                  key={s}
                  onClick={() => setScale(s)}
                  disabled={isProcessing}
                  className={`flex-1 py-3 rounded-xl text-sm font-bold transition-all ${scale === s
                      ? 'bg-nai-accent text-black'
                      : 'bg-gray-800 text-gray-300 active:bg-gray-700'
                    } disabled:opacity-50`}
                >
                  {s}x
                </button>
              ))}
            </div>
          </div>

          {/* 1.5x 模式：Magnitude 滑块 */}
          {scale === 1.5 && (
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
          {scale !== 1.5 && (
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

          {/* 1.5x 模式说明 */}
          {scale === 1.5 && (
            <div className="bg-gray-800/50 rounded-xl p-3">
              <div className="flex items-center gap-3">
                <Sparkles className="w-5 h-5 text-nai-accent flex-shrink-0" />
                <div>
                  <div className="text-sm text-white font-medium">图生图放大</div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {(() => {
                      if (!imageSize) return '以 1.5 倍分辨率重新生成，消耗 Anlas';
                      const targetW = Math.round((imageSize.width * 1.5) / 64) * 64;
                      const targetH = Math.round((imageSize.height * 1.5) / 64) * 64;
                      const preset = MAGNITUDE_PRESETS[magnitude];
                      const result = calculateCostFromUI({
                        width: targetW,
                        height: targetH,
                        steps: 28,
                        modelId: 'v4.5-curated',
                        sampler: 'Euler Ancestral',
                        isOpus: getCachedIsOpus(),
                        img2imgStrength: preset.strength,
                      });
                      return `以 1.5 倍分辨率重新生成，消耗 ${result.total} Anlas`;
                    })()}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 1.5x 像素超限警告 */}
          {isOver15xLimit && (
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
            disabled={isProcessing || isOver15xLimit}
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
