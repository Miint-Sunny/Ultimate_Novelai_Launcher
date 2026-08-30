import { sidecarApi } from '../api/sidecar';
import { getAISettings, getAppSettings } from './localLibrary';
import { generateImageStream, processImg2ImgImage, resolveEnhanceModel } from './novelai';
import { extractImageMetadata } from '../utils/imageMetadata';
import {
  enhanceMaxAvailable,
  enhanceMaxTargetSize,
  enhanceTargetSize,
  type EnhanceScaleId,
} from './naiEnhanceScale';

// 1.5x 图生图放大的总像素上限（与普通生成保持一致：1024 × 3072 = 3,145,728）
export const UPSCALE_15X_MAX_PIXELS = 1024 * 3072;

export interface UpscaleProgress {
  stage: 'loading' | 'processing' | 'done' | 'error';
  progress: number;
  message: string;
}

export type UpscaleMethod = 'local' | 'api';

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function getImageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('无法生成图片'));
      }
    }, 'image/png', 1);
  });
}

/**
 * Sidecar 托管超分入口。
 *
 * 旧 reference 在浏览器里下载 ONNX 模型并运行 Real-ESRGAN；现在前端只负责
 * 收集图片和展示进度，真正的超分请求统一交给 sidecar。
 */
export async function upscaleImageAPI(
  imageBlob: Blob,
  scale = 4,
  onProgress?: (progress: UpscaleProgress) => void
): Promise<Blob> {
  onProgress?.({ stage: 'loading', progress: 10, message: '正在检查图片...' });

  const { width, height } = await getImageSize(imageBlob);
  const allowedResolutions = [
    [832, 1216],
    [1216, 832],
    [1024, 1024],
  ];
  const isValidResolution = allowedResolutions.some(([w, h]) => w === width && h === height);

  if (!isValidResolution) {
    throw new Error(
      `NAI 超分仅支持以下分辨率: 832×1216, 1216×832, 1024×1024\n当前图片: ${width}×${height}`
    );
  }

  const tokenStatus = await sidecarApi.tokenStatus();
  if (!tokenStatus.configured && !tokenStatus.mock_generation) {
    throw new Error('未配置 NovelAI Token，请先在 sidecar 设置中保存 Token');
  }

  onProgress?.({ stage: 'loading', progress: 25, message: '正在转换图片...' });
  const image = await blobToBase64(imageBlob);

  onProgress?.({ stage: 'processing', progress: 45, message: '正在通过 sidecar 超分...' });
  try {
    const resultBlob = await sidecarApi.upscale({ image, width, height, scale });
    onProgress?.({ stage: 'done', progress: 100, message: '超分完成！(Sidecar)' });
    return resultBlob;
  } catch (error) {
    const message = error instanceof Error ? error.message : '超分失败';
    onProgress?.({ stage: 'error', progress: 0, message });
    throw error;
  }
}

export async function upscaleImageLocal(
  imageBlob: Blob,
  scale = 4,
  onProgress?: (progress: UpscaleProgress) => void
): Promise<Blob> {
  onProgress?.({
    stage: 'loading',
    progress: 5,
    message: '浏览器端 Real-ESRGAN 已迁移，正在改用 sidecar 超分...',
  });
  return upscaleImageAPI(imageBlob, scale, onProgress);
}

export async function upscaleImage(
  imageBlob: Blob,
  scale = 4,
  method: UpscaleMethod = 'local',
  onProgress?: (progress: UpscaleProgress) => void
): Promise<Blob> {
  return method === 'api'
    ? upscaleImageAPI(imageBlob, scale, onProgress)
    : upscaleImageLocal(imageBlob, scale, onProgress);
}

export async function upscaleFromCanvas(
  canvas: HTMLCanvasElement,
  scale = 4,
  onProgress?: (progress: UpscaleProgress) => void
): Promise<Blob> {
  const blob = await canvasToBlob(canvas);
  return upscaleImageAPI(blob, scale, onProgress);
}

export function getCurrentBackend(): string {
  return 'Sidecar';
}

export function isModelLoaded(): boolean {
  return true;
}

export function disposeModel(): void {
  // No browser-side model is loaded anymore.
}

/**
 * 通过图生图实现 1.5x 放大。
 * 这条路径保留 reference 的交互能力，但 NovelAI 请求仍走 generateImageStream facade。
 */
export async function upscaleViaImg2Img(
  imageBlob: Blob,
  strength: number,
  noise: number,
  onProgress?: (progress: UpscaleProgress) => void,
  scaleId: EnhanceScaleId = 'x1.5'
): Promise<Blob> {
  const settings = getAppSettings();
  const tokenStatus = await sidecarApi.tokenStatus();
  if (!tokenStatus.configured && !tokenStatus.mock_generation && settings.loginMode !== 'bot') {
    throw new Error('未配置 NovelAI Token，请先在 sidecar 设置中保存 Token');
  }

  // 重绘用哪个模型:V5 Curated 顶替成 4.5 Curated,V5 Full 用它自己。
  const enhanceModel = resolveEnhanceModel(getAISettings().model);
  const isMax = scaleId === 'max';

  onProgress?.({ stage: 'loading', progress: 10, message: '正在读取图片信息...' });
  const { width: originalWidth, height: originalHeight } = await getImageSize(imageBlob);

  if (isMax && !enhanceMaxAvailable(originalWidth, originalHeight, enhanceModel)) {
    throw new Error(
      `Max ✨ 档对 ${originalWidth}×${originalHeight} / ${enhanceModel} 不可用：` +
      '只有 V5 且源图像素低于上限的 0.8 时才提供这一档。'
    );
  }

  // Max ✨ 发的是**原图尺寸**,由服务端放大;数值档才由客户端把宽高改好再发。
  // 数值档全族都跟官方(832×1216 / 1216×832 有特判,出 1248×1824)。
  const { width: targetWidth, height: targetHeight } = isMax
    ? { width: originalWidth, height: originalHeight }
    : enhanceTargetSize(originalWidth, originalHeight, scaleId);

  if (!isMax && targetWidth * targetHeight > UPSCALE_15X_MAX_PIXELS) {
    throw new Error(
      `1.5x 放大目标尺寸 ${targetWidth}×${targetHeight}（${(targetWidth * targetHeight / 1_000_000).toFixed(2)}M 像素）` +
      `超过上限 ${UPSCALE_15X_MAX_PIXELS.toLocaleString()} 像素（约 1024×3072）。` +
      '请先缩小原图后再使用 1.5x 放大。'
    );
  }

  const imageBase64 = await blobToBase64(imageBlob);
  let positivePrompt = '';
  let negativePrompt = '';
  let seed: number | undefined;
  let characterPrompts: Array<{ positive: string; negative: string; enabled: boolean }> = [];

  try {
    const desktopPositive = localStorage.getItem('desktop_positive_prompt');
    const desktopNegative = localStorage.getItem('desktop_negative_prompt');
    const desktopChars = localStorage.getItem('desktop_character_prompts');
    const mobileState = localStorage.getItem('mobile_generate_state');
    const mobileParsed = mobileState ? JSON.parse(mobileState) : null;

    positivePrompt = desktopPositive || mobileParsed?.positivePrompt || '';
    negativePrompt = desktopNegative || mobileParsed?.negativePrompt || '';

    if (desktopChars) {
      const parsed = JSON.parse(desktopChars);
      if (Array.isArray(parsed)) {
        characterPrompts = parsed
          .filter((char: { enabled?: boolean }) => char.enabled !== false)
          .map((char: { positive?: string; negative?: string }) => ({
            positive: char.positive || '',
            negative: char.negative || '',
            enabled: true,
          }));
      }
    }
  } catch {
    // Ignore legacy localStorage state parse errors.
  }

  if (!positivePrompt) {
    try {
      const file = new File([imageBlob], 'image.png', { type: imageBlob.type });
      const metadata = await extractImageMetadata(file);
      if (metadata) {
        positivePrompt = metadata.prompt || '';
        negativePrompt = negativePrompt || metadata.negativePrompt || '';
        seed = typeof metadata.seed === 'number'
          ? metadata.seed
          : parseInt(String(metadata.seed), 10) || undefined;
      }
    } catch {
      // Ignore metadata extraction errors.
    }
  }

  if (!positivePrompt) positivePrompt = 'masterpiece, best quality';
  if (!negativePrompt) {
    negativePrompt = 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry';
  }

  const billedSize = isMax ? enhanceMaxTargetSize(originalWidth, originalHeight) : { width: targetWidth, height: targetHeight };
  onProgress?.({ stage: 'processing', progress: 30, message: `放大至 ${billedSize.width}×${billedSize.height}...` });

  const processedBase64 = await processImg2ImgImage(
    `data:image/png;base64,${imageBase64}`,
    targetWidth,
    targetHeight
  );

  onProgress?.({ stage: 'processing', progress: 40, message: '正在生成...' });

  const result = await generateImageStream({
    positivePrompt,
    negativePrompt,
    model: enhanceModel,
    width: targetWidth,
    height: targetHeight,
    steps: 28,
    scale: 5,
    seed,
    sampler: 'k_euler_ancestral',
    cfgRescale: 0,
    noiseSchedule: 'native',
    ucPreset: 'Heavy',
    qualityToggle: true,
    varietyPlus: false,
    characterPrompts,
    img2img: {
      imageBase64: processedBase64,
      strength,
      noise,
      // 非 Max 档整个键省掉——发 false 会被官方当成普通重绘。
      ...(isMax ? { upscaledEnhance: true } : {}),
    },
  }, (streamProgress) => {
    const progress = 40 + Math.round((streamProgress.step / streamProgress.totalSteps) * 50);
    onProgress?.({
      stage: 'processing',
      progress,
      message: `生成中 ${streamProgress.step}/${streamProgress.totalSteps}...`,
    });
  });

  if (!result.success || !result.imageData) {
    throw new Error(result.error || '图生图生成失败，未返回图片');
  }

  onProgress?.({ stage: 'done', progress: 100, message: isMax ? 'Max ✨ 放大完成！' : '1.5x 放大完成！' });
  return result.imageData;
}
