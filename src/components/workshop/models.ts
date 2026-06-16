// 工坊模型定义（仅大GPT 2K / 4K，与 server/config.py BIG_GPT_RATIO_TABLE 对齐）

export interface ModelConfig {
    id: string;
    name: string;
    description: string;
    icon: string;
    resolution: '2k' | '4k';
    maxImages: number;
    speed: number;     // 预估秒数（用于无统计数据时的兜底）
    tag?: string;
    tagColor?: 'green' | 'red';
}

export const MODELS: ModelConfig[] = [
    {
        id: 'gpt-image',
        name: '大GPT',
        description: 'GPT Image 2 · 2K',
        icon: '✨',
        resolution: '2k',
        maxImages: 5,
        speed: 30,
    },
    {
        id: 'gpt-image-4k',
        name: '超大GPT',
        description: 'GPT Image 2 · 4K',
        icon: '✨',
        resolution: '4k',
        maxImages: 5,
        tag: 'x2额度',
        tagColor: 'red',
        speed: 60,
    },
];

export interface AspectRatio {
    label: string;
    value: string;
    w: number;
    h: number;
}

export const ASPECT_RATIOS: AspectRatio[] = [
    { label: '自动', value: 'auto', w: 1, h: 1 },
    { label: '1:1', value: '1:1', w: 1, h: 1 },
    { label: '4:3', value: '4:3', w: 4, h: 3 },
    { label: '3:4', value: '3:4', w: 3, h: 4 },
    { label: '16:9', value: '16:9', w: 16, h: 9 },
    { label: '9:16', value: '9:16', w: 9, h: 16 },
    { label: '3:2', value: '3:2', w: 3, h: 2 },
    { label: '2:3', value: '2:3', w: 2, h: 3 },
    { label: '5:4', value: '5:4', w: 5, h: 4 },
    { label: '4:5', value: '4:5', w: 4, h: 5 },
    { label: '21:9', value: '21:9', w: 21, h: 9 },
];

// 与 server 端 BIG_GPT_RATIO_TABLE 键集一致（用于参考图自动匹配）
const SUPPORTED_RATIOS = [[1, 1], [2, 3], [3, 2], [3, 4], [4, 3], [4, 5], [5, 4], [9, 16], [16, 9], [21, 9], [9, 21]];

export function getClosestRatio(width: number, height: number): string {
    if (width <= 0 || height <= 0) return '1:1';
    const imgRatio = width / height;
    let closest = SUPPORTED_RATIOS[0];
    let minDiff = Infinity;
    for (const r of SUPPORTED_RATIOS) {
        const diff = Math.abs(imgRatio - r[0] / r[1]);
        if (diff < minDiff) {
            minDiff = diff;
            closest = r;
        }
    }
    return `${closest[0]}:${closest[1]}`;
}

export interface UploadedImage {
    id: string;
    file: File;
    previewUrl: string;
    width: number;
    height: number;
}

/** 压缩为 ≤ maxDim 的 JPEG data URI */
export async function compressImageFile(file: File, maxDim = 1536, quality = 0.7): Promise<string> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            let { naturalWidth: w, naturalHeight: h } = img;
            if (w > maxDim || h > maxDim) {
                const scale = maxDim / Math.max(w, h);
                w = Math.round(w * scale);
                h = Math.round(h * scale);
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(img, 0, 0, w, h);
            const dataUri = canvas.toDataURL('image/jpeg', quality);
            URL.revokeObjectURL(img.src);
            resolve(dataUri);
        };
        img.onerror = () => {
            URL.revokeObjectURL(img.src);
            reject(new Error('图片加载失败'));
        };
        img.src = URL.createObjectURL(file);
    });
}

export function extractErrorSummary(error?: string): string {
    if (!error) return '未知错误';
    const lower = error.toLowerCase();
    if (lower.includes('nsfw')) return 'NSFW 内容限制';
    if (lower.includes('timeout') || lower.includes('超时')) return '请求超时';
    if (lower.includes('额度不足') || lower.includes('quota')) return '额度不足';
    if (lower.includes('rate limit') || lower.includes('429')) return '请求过于频繁';
    if (lower.includes('unauthorized') || lower.includes('401') || lower.includes('未登录')) return '未授权';
    if (lower.includes('network') || lower.includes('fetch') || lower.includes('connection')) return '网络错误';
    if (lower.includes('server') || lower.includes('500') || lower.includes('502') || lower.includes('503')) return '服务器错误';
    if (lower.includes('blocked') || lower.includes('safety')) return '安全过滤';
    const short = error.replace(/^(生成错误|生成异常|请求失败|image generation failed)[:\s]*/i, '').trim();
    return short.length > 30 ? short.slice(0, 30) + '…' : short || '生成失败';
}
