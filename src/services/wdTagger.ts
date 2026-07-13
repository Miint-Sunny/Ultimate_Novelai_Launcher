import { appBackendApi } from '../api/appBackendApi';

/**
 * WD Tagger 服务
 * 通过后端代理调用 Hugging Face WD Tagger Space
 */

export interface WDTaggerResult {
  tags: string;
  character: string;
  rating: string;
  confidence: Record<string, number>;
}

/**
 * 调用后端 WD Tagger API 进行图片标签反推
 * @param imageBase64 图片的 base64 数据（不含 data:image/xxx;base64, 前缀）
 * @returns 反推结果
 */
export async function analyzeImageWithWDTagger(
  imageBase64: string
): Promise<WDTaggerResult | null> {
  try {
    const resp = await appBackendApi.request('/api/wd-tagger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageBase64 }),
    });

    if (!resp.ok) {
      console.error('WD Tagger API 调用失败:', resp.status, resp.statusText);
      return null;
    }

    const data = await resp.json();
    if (!data.success) {
      console.error('WD Tagger 返回错误:', data.error);
      return null;
    }

    return {
      tags: data.tags,
      character: data.character,
      rating: data.rating,
      confidence: data.confidence,
    };
  } catch (error) {
    console.error('WD Tagger API 调用失败:', error);
    return null;
  }
}

/**
 * 从 dataUrl 中提取 base64 数据
 */
export function extractBase64FromDataUrl(dataUrl: string): string {
  const match = dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
  return match ? match[1] : dataUrl;
}
