import type { UpscaleProgress } from '../../../services/upscaleService';

// 辅助函数：从 Blob 或 URL 加载图片到 Canvas (增强版)
// - Blob 源会创建临时 objectURL 并在加载后释放
// - 跨域图片尝试 anonymous CORS，失败时给出明确错误
// - 30s 超时保护
export async function loadImageToCanvas(
  source: Blob | string,
  onProgress?: (progress: UpscaleProgress) => void
): Promise<HTMLCanvasElement> {
  const url = source instanceof Blob ? URL.createObjectURL(source) : source;
  const isBlob = source instanceof Blob;

  onProgress?.({ stage: 'loading', progress: 5, message: isBlob ? '[4] 加载 Blob...' : '[2] 加载图片...' });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (isBlob) URL.revokeObjectURL(url);
      reject(new Error('Image 加载超时'));
    }, 30000);

    const img = new Image();
    // 默认尝试跨域加载，以便能读取数据
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      clearTimeout(timeout);
      if (isBlob) URL.revokeObjectURL(url);

      onProgress?.({ stage: 'loading', progress: 7, message: `[5] Image: ${img.naturalWidth}x${img.naturalHeight}` });

      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('无法创建 Canvas'));
        return;
      }

      try {
        ctx.drawImage(img, 0, 0);
        // 尝试读取数据以验证是否被污染
        ctx.getImageData(0, 0, 1, 1);

        onProgress?.({ stage: 'loading', progress: 9, message: '[6] Canvas 已创建' });
        resolve(canvas);
      } catch (e) {
        reject(new Error('无法读取图片数据(CORS)，请检查图片服务器配置'));
      }
    };

    img.onerror = (e) => {
      clearTimeout(timeout);
      if (isBlob) URL.revokeObjectURL(url);
      // 如果是跨域失败，提示更明确
      if (img.crossOrigin && !isBlob) {
        console.warn('Image load failed with CORS');
        reject(new Error('图片加载失败(CORS)，请检查跨域设置'));
        return;
      }
      reject(new Error(`Image 加载失败: ${e}`));
    };

    img.src = url;
  });
}
