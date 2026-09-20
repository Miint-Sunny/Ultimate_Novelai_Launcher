/**
 * 图片元数据解析工具
 * 支持 NovelAI LSB 隐写数据提取、PNG 标准元数据解析和 EXIF 元数据解析（WebP/JPEG）
 */

import pako from 'pako';
import { WATERMARK_LIMITS, applyVisibleWatermark, embedBlindWatermark, hasBlindWatermark, hasVisibleWatermark, isWatermarkActive } from '../services/watermark/index.ts';
import type { RawRgbaImage, WatermarkConfig } from '../services/watermark/index.ts';
import { loadWatermarkImage, rgbaToBlob } from '../services/watermark/browser.ts';
import { resolveWatermarkExportSettings } from '../services/watermark/settings.ts';

// LSB 隐写数据提取器
class LSBExtractor {
  private data: Uint8ClampedArray;
  private width: number;
  private height: number;
  private bits = 0;
  private byte = 0;
  private row = 0;
  private col = 0;

  constructor(imageData: ImageData) {
    this.data = imageData.data;
    this.width = imageData.width;
    this.height = imageData.height;
  }

  private extractNextBit(): void {
    if (this.row < this.height && this.col < this.width) {
      // 获取 alpha 通道的最低位 (RGBA 中的 A 在索引 3)
      const index = (this.row * this.width + this.col) * 4 + 3;
      const bit = this.data[index] & 1;
      this.bits++;
      this.byte <<= 1;
      this.byte |= bit;
      this.row++;
      if (this.row === this.height) {
        this.row = 0;
        this.col++;
      }
    } else {
      throw new Error('Reached end of image data while extracting bits');
    }
  }

  getOneByte(): number {
    while (this.bits < 8) {
      this.extractNextBit();
    }
    const byte = this.byte;
    this.bits = 0;
    this.byte = 0;
    return byte;
  }

  getNextNBytes(n: number): Uint8Array {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      bytes[i] = this.getOneByte();
    }
    return bytes;
  }

  read32BitInteger(): number {
    const bytes = this.getNextNBytes(4);
    return (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  }
}

// Vibe 数据接口
export interface VibeMetadata {
  image?: string;  // vibe 原始图片的 base64（用于匹配本地存储）
  encoding?: string;  // base64 编码的 vibe 特征（如果有）
  strength: number;
  informationExtracted?: number;
  needsLocalMatch?: boolean; // 标记需要通过参数匹配本地 vibe（当没有 image/encoding 时）
}

// 图片来源类型
export type ImageSourceType = 'novelai' | 'stable-diffusion' | 'comfyui' | 'unknown';

// Lora 信息接口
export interface LoraInfo {
  name: string;
  weight: number;
}

// 解析后的元数据接口
export interface ImageMetadata {
  source: string;
  sourceType: ImageSourceType; // 图片来源类型，用于判断可导入的内容
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  seed: string | number;
  steps?: string | number;
  sampler?: string;
  scale?: string | number;
  noiseSchedule?: string;
  cfgRescale?: string | number;
  // 角色提示词
  characterPrompts?: Array<{
    prompt: string;
    uc?: string;
    center?: { x: number; y: number };
  }>;
  /**
   * 发这张图时是不是走的坐标模式。`teXt:` 块的角色顺序按它决定
   * (真值按阅读顺序排,假值按声明顺序),所以剥离时必须用原图的取值,
   * 不能拿「有没有角色」去猜。缺省 = 老元数据没记,由调用方兜底。
   */
  useCoords?: boolean;
  // Vibe 数据
  vibes?: VibeMetadata[];
  // Lora 信息（SD/ComfyUI）
  loras?: LoraInfo[];
  // 原始数据
  raw?: any;
}

/**
 * 从 PNG 图片的 LSB 隐写数据中提取元数据 (NovelAI 格式)
 */
async function extractLSBMetadata(imageData: ImageData): Promise<any | null> {
  try {
    const reader = new LSBExtractor(imageData);
    const magic = 'stealth_pngcomp';

    // 读取魔术字符串
    const magicBytes = reader.getNextNBytes(magic.length);
    const readMagic = new TextDecoder().decode(magicBytes);

    if (readMagic !== magic) {
      return null;
    }

    // 读取数据长度
    const lenBits = reader.read32BitInteger();
    const lenBytes = Math.ceil(lenBits / 8);

    if (lenBytes <= 0 || lenBytes > 50 * 1024 * 1024) {
      return null;
    }

    // 读取压缩数据
    const compressedData = reader.getNextNBytes(lenBytes);

    // 尝试解压
    let decompressed: string;
    try {
      // 尝试 gzip 解压
      decompressed = new TextDecoder().decode(pako.ungzip(compressedData));
    } catch {
      try {
        // 尝试 raw deflate 解压
        decompressed = new TextDecoder().decode(pako.inflateRaw(compressedData));
      } catch {
        return null;
      }
    }

    return JSON.parse(decompressed);
  } catch {
    return null;
  }
}

// PNG 文本元数据结构
interface PNGTextChunks {
  parameters?: string;  // SD WebUI 格式
  comment?: string;     // NovelAI 格式
  source?: string;      // NovelAI 模型来源
  prompt?: string;      // ComfyUI 格式
  workflow?: string;    // ComfyUI 工作流
}

/**
 * 从 PNG 文件的 tEXt/iTXt 块中提取所有文本元数据
 */
function extractAllPNGTextChunks(arrayBuffer: ArrayBuffer): PNGTextChunks {
  const result: PNGTextChunks = {};
  const view = new DataView(arrayBuffer);

  // 检查 PNG 签名
  const pngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  for (let i = 0; i < 8; i++) {
    if (view.getUint8(i) !== pngSignature[i]) {
      return result;
    }
  }

  let offset = 8;

  while (offset < arrayBuffer.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7)
    );

    if (type === 'tEXt' || type === 'iTXt') {
      const data = new Uint8Array(arrayBuffer, offset + 8, length);
      const text = new TextDecoder('utf-8').decode(data);

      // 解析 key\0value 格式
      const nullIndex = text.indexOf('\0');
      if (nullIndex > 0) {
        const key = text.substring(0, nullIndex).toLowerCase();
        const value = text.substring(nullIndex + 1);

        if (key === 'parameters') {
          result.parameters = value;
        } else if (key === 'comment') {
          result.comment = value;
        } else if (key === 'source') {
          result.source = value;
        } else if (key === 'prompt') {
          result.prompt = value;
        } else if (key === 'workflow') {
          result.workflow = value;
        }
      }
    }

    // 移动到下一个块
    offset += 12 + length; // 4 (length) + 4 (type) + length + 4 (CRC)
  }

  return result;
}

/**
 * 解析 ComfyUI 格式的 prompt JSON
 */
function parseComfyUIPrompt(promptJson: string, workflowJson?: string): ImageMetadata | null {
  try {
    const prompt = JSON.parse(promptJson);

    let positivePrompt = '';
    let negativePrompt = '';
    let model = 'ComfyUI';
    let width = 0;
    let height = 0;
    let seed: string | number = '';
    let steps: string | number = '';
    let sampler = '';
    let scale: string | number = '';

    // 辅助函数：解析节点引用，获取实际值
    const resolveValue = (value: any): any => {
      if (Array.isArray(value) && value.length === 2) {
        // 这是一个节点引用 [nodeId, outputIndex]
        const [nodeId] = value;
        const refNode = prompt[nodeId];
        if (refNode) {
          const refInputs = refNode.inputs || {};
          // 尝试获取常见的输出值
          if (refNode.class_type === 'Constant Number' || refNode.class_type?.includes('Number')) {
            // Constant Number 节点使用 'number' 作为输出
            return refInputs.number ?? refInputs.value ?? refInputs.int ?? refInputs.float;
          }
        }
      }
      return value;
    };

    // 遍历所有节点，提取信息
    for (const nodeId in prompt) {
      const node = prompt[nodeId];
      const classType = node.class_type || '';
      const inputs = node.inputs || {};

      // 提取模型名称
      if (classType.includes('CheckpointLoader') || classType.includes('UNETLoader')) {
        if (inputs.ckpt_name) {
          model = inputs.ckpt_name.replace(/\.[^/.]+$/, ''); // 去掉扩展名
        } else if (inputs.unet_name) {
          model = inputs.unet_name.replace(/\.[^/.]+$/, '');
        }
      }

      // 提取正向提示词
      if (classType === 'CLIPTextEncode' || classType.includes('TextEncode')) {
        if (inputs.text && typeof inputs.text === 'string') {
          // 简单判断：如果包含负面词汇，可能是负向提示词
          const text = inputs.text;
          if (text.includes('worst quality') || text.includes('low quality') || text.includes('bad')) {
            if (!negativePrompt) negativePrompt = text;
          } else {
            if (!positivePrompt) positivePrompt = text;
          }
        }
      }

      // 提取 KSampler 参数
      if (classType === 'KSampler' || classType.includes('Sampler')) {
        const resolvedSeed = resolveValue(inputs.seed);
        const resolvedSteps = resolveValue(inputs.steps);
        const resolvedCfg = resolveValue(inputs.cfg);

        if (resolvedSeed !== undefined && typeof resolvedSeed === 'number') seed = resolvedSeed;
        if (resolvedSteps !== undefined && typeof resolvedSteps === 'number') steps = resolvedSteps;
        if (resolvedCfg !== undefined && typeof resolvedCfg === 'number') scale = resolvedCfg;
        if (inputs.sampler_name) sampler = inputs.sampler_name;
      }

      // 提取图片尺寸
      if (classType === 'EmptyLatentImage' || classType.includes('LatentImage')) {
        const resolvedWidth = resolveValue(inputs.width);
        const resolvedHeight = resolveValue(inputs.height);

        if (typeof resolvedWidth === 'number' && resolvedWidth > 0) width = resolvedWidth;
        if (typeof resolvedHeight === 'number' && resolvedHeight > 0) height = resolvedHeight;
      }
    }

    return {
      source: model,
      sourceType: 'comfyui',
      prompt: positivePrompt,
      negativePrompt,
      width,
      height,
      seed,
      steps,
      sampler,
      scale,
      raw: {
        type: 'comfyui',
        prompt,
        workflow: workflowJson ? JSON.parse(workflowJson) : undefined,
      },
    };
  } catch {
    return null;
  }
}

/**
/**
 * 从提示词中提取 Lora 信息
 */
function extractLoras(prompt: string): LoraInfo[] {
  const loras: LoraInfo[] = [];
  // 匹配 <lora:name:weight> 格式
  const loraRegex = /<lora:([^:>]+):([^>]+)>/gi;
  let match;
  while ((match = loraRegex.exec(prompt)) !== null) {
    loras.push({
      name: match[1],
      weight: parseFloat(match[2]) || 1.0,
    });
  }
  // 匹配 <lyco:name:weight> 格式（LyCORIS）
  const lycoRegex = /<lyco:([^:>]+):([^>]+)>/gi;
  while ((match = lycoRegex.exec(prompt)) !== null) {
    loras.push({
      name: match[1] + ' (LyCORIS)',
      weight: parseFloat(match[2]) || 1.0,
    });
  }
  return loras;
}

/**
 * 将 SD 格式的权重提示词转换为 NAI 格式
 * SD: (text:1.2) -> NAI: 1.2::text::
 * SD: (text) -> NAI: {text}
 */
function convertSDWeightToNAI(text: string): string {
  const res: string[] = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    if (ch === '(') {
      // 检查括号前是否是逗号或开头（跳过空格）
      let k = i - 1;
      while (k >= 0 && /\s/.test(text[k])) {
        k--;
      }
      if (i === 0 || k < 0 || text[k] === ',' || text[k] === '，') {
        // 找到匹配的右括号
        let depth = 1;
        let j = i + 1;
        while (j < n && depth > 0) {
          if (text[j] === '(') {
            depth++;
          } else if (text[j] === ')') {
            depth--;
          }
          j++;
        }
        if (depth === 0) {
          const inner = text.slice(i + 1, j - 1);
          // 检查是否是 (content:weight) 格式
          const colonCount = (inner.match(/:/g) || []).length;
          if (colonCount === 1) {
            const colonIdx = inner.indexOf(':');
            const left = inner.slice(0, colonIdx);
            const right = inner.slice(colonIdx + 1);
            // 检查 right 是否是数字
            if (/^\d+(?:\.\d+)?$/.test(right)) {
              // 转换为 NAI 格式: weight::content::
              res.push(`${right}::${left}::`);
              i = j;
              continue;
            }
          }
          // 普通括号转换为花括号，递归处理内部
          const processedInner = convertSDWeightToNAI(inner);
          res.push('{' + processedInner + '}');
          i = j;
          continue;
        }
      }
    }
    res.push(ch);
    i++;
  }
  return res.join('');
}

/**
 * 清理 SD 提示词中的特殊标签（如 Lora、Embedding 等）并转换权重格式
 */
function cleanSDPrompt(prompt: string): string {
  // 移除 <lora:xxx:xxx> 格式的标签
  let cleaned = prompt.replace(/<lora:[^>]+>/gi, '');
  // 移除 <hypernet:xxx:xxx> 格式的标签
  cleaned = cleaned.replace(/<hypernet:[^>]+>/gi, '');
  // 移除 <lyco:xxx:xxx> 格式的标签（LyCORIS）
  cleaned = cleaned.replace(/<lyco:[^>]+>/gi, '');
  // 移除多余的逗号和空格
  cleaned = cleaned.replace(/,\s*,/g, ',').replace(/^\s*,|,\s*$/g, '').trim();
  // 移除多余的空格
  cleaned = cleaned.replace(/\s+/g, ' ');
  // 转换 SD 权重格式为 NAI 格式
  cleaned = convertSDWeightToNAI(cleaned);
  return cleaned;
}

/**
 * 解析 Stable Diffusion WebUI 格式的 parameters 字符串
 * 参考 Python 版本的 parse_parameters 函数
 */
function parseSDParameters(parametersStr: string): ImageMetadata | null {
  try {
    let positivePrompt = '';
    let negativePrompt = '';
    let settingsPart = '';

    // 分割正向和负向提示词
    if (parametersStr.includes('Negative prompt:')) {
      const parts = parametersStr.split('Negative prompt:');
      positivePrompt = parts[0].trim();
      const remaining = parts[1];

      // 查找设置部分（通常以 Steps: 开始）
      const settingsMatch = remaining.match(/(Steps:\s*\d+.*)/s);
      if (settingsMatch) {
        settingsPart = settingsMatch[1];
        negativePrompt = remaining.substring(0, settingsMatch.index).trim();
      } else {
        negativePrompt = remaining.trim();
      }
    } else {
      const settingsMatch = parametersStr.match(/(Steps:\s*\d+.*)/s);
      if (settingsMatch) {
        positivePrompt = parametersStr.substring(0, settingsMatch.index).trim();
        settingsPart = settingsMatch[1];
      } else {
        positivePrompt = parametersStr.trim();
      }
    }

    // 提取 Lora 信息（在清理前）
    const loras = extractLoras(positivePrompt);

    // 清理提示词中的 Lora 等标签
    positivePrompt = cleanSDPrompt(positivePrompt);
    negativePrompt = cleanSDPrompt(negativePrompt);

    // 解析设置 - 扩展更多字段
    const settings: Record<string, string> = {};
    const patterns: Record<string, RegExp> = {
      steps: /Steps:\s*(\d+)/i,
      sampler: /Sampler:\s*([^,]+)/i,
      scheduleType: /Schedule type:\s*([^,]+)/i,
      scale: /CFG scale:\s*([\d.]+)/i,
      seed: /Seed:\s*(\d+)/i,
      size: /Size:\s*(\d+x\d+)/i,
      modelHash: /Model hash:\s*([^,]+)/i,
      model: /Model:\s*([^,]+?)(?:,|$)/i,
      denoisingStrength: /Denoising strength:\s*([\d.]+)/i,
      clipSkip: /Clip skip:\s*(\d+)/i,
      hiresUpscale: /Hires upscale:\s*([\d.]+)/i,
      hiresUpscaler: /Hires upscaler:\s*([^,]+)/i,
      version: /Version:\s*([^,]+)/i,
      loraHashes: /Lora hashes:\s*"([^"]+)"/i,
    };

    for (const [key, pattern] of Object.entries(patterns)) {
      const match = settingsPart.match(pattern);
      if (match) {
        settings[key] = match[1].trim();
      }
    }

    // 解析尺寸
    let width = 0, height = 0;
    if (settings.size) {
      const sizeMatch = settings.size.match(/(\d+)x(\d+)/);
      if (sizeMatch) {
        width = parseInt(sizeMatch[1]);
        height = parseInt(sizeMatch[2]);
      }
    }

    // 构建模型名称（优先使用 Model，否则使用 Model hash）
    let source = 'Stable Diffusion';
    if (settings.model) {
      source = settings.model;
    } else if (settings.modelHash) {
      source = `SD (${settings.modelHash})`;
    }

    return {
      source,
      sourceType: 'stable-diffusion',
      prompt: positivePrompt,
      negativePrompt,
      width,
      height,
      seed: settings.seed || '',
      steps: settings.steps,
      sampler: settings.sampler,
      scale: settings.scale,
      noiseSchedule: settings.scheduleType,
      loras: loras.length > 0 ? loras : undefined,
      // 将额外信息存储在 raw 中
      raw: {
        type: 'stable-diffusion',
        settings: {
          denoisingStrength: settings.denoisingStrength,
          clipSkip: settings.clipSkip,
          hiresUpscale: settings.hiresUpscale,
          hiresUpscaler: settings.hiresUpscaler,
          version: settings.version,
          loraHashes: settings.loraHashes,
          modelHash: settings.modelHash,
        },
      },
    };
  } catch {
    return null;
  }
}

/**
 * 解析 NovelAI 格式的元数据
 */
/** 导出仅为校验脚本可直接喂 Comment JSON(check:v5-parity 的导入段)。 */
export function parseNAIMetadata(data: any): ImageMetadata | null {
  try {
    const comment = typeof data.Comment === 'string'
      ? JSON.parse(data.Comment)
      : data.Comment || {};

    // 提取负面提示词
    let negativePrompt = '';
    if (comment.v4_negative_prompt?.caption?.base_caption) {
      negativePrompt = comment.v4_negative_prompt.caption.base_caption;
    } else if (comment.uc) {
      negativePrompt = comment.uc;
    }

    // 提取角色提示词
    const characterPrompts: ImageMetadata['characterPrompts'] = [];
    if (comment.v4_prompt?.caption?.char_captions) {
      const positives = comment.v4_prompt.caption.char_captions;
      const negatives = comment.v4_negative_prompt?.caption?.char_captions;
      // 角色负向在**另一份列表**里(v4_negative_prompt),不在正向条目的 char_uc 上,
      // 所以只读 char_uc 的话,导我们自己出的多角色图会把每个人的负向丢光。
      //
      // 按下标配对的前提是两份等长 —— NAI 本来就要求等长(不等直接 400),我们
      // 2026-09-21 起也总是等长发。但老图与老客户端可能只写了非空的那几条,
      // 那种不等长的按下标配会把负向安到别人头上,宁可留空也不猜。
      const pairable = Array.isArray(negatives) && negatives.length === positives.length;
      positives.forEach((char: { char_caption?: string; char_uc?: string; centers?: Array<{ x: number; y: number }> }, index: number) => {
        characterPrompts.push({
          prompt: char.char_caption || '',
          uc: char.char_uc || (pairable ? negatives[index]?.char_caption || '' : ''),
          center: char.centers?.[0],
        });
      });
    }
    const useCoords =
      typeof comment.use_coords === 'boolean'
        ? comment.use_coords
        : typeof comment.v4_prompt?.use_coords === 'boolean'
          ? comment.v4_prompt.use_coords
          : undefined;

    // 提取 Vibe 数据
    // NovelAI API 返回的图片元数据中可能不包含 reference_image_multiple
    // 但会包含 reference_strength_multiple 和 reference_information_extracted_multiple
    // 我们需要处理三种情况：
    // 1. 有 reference_image_multiple（官方格式）：通过图片 hash 或编码 hash 匹配
    // 2. 只有 strength 和 info_extracted（我们的格式）：标记为需要本地匹配
    // 3. 没有任何 vibe 数据
    const vibes: VibeMetadata[] = [];
    const vibeData = comment.reference_image_multiple || [];
    const strengths = comment.reference_strength_multiple || [];
    const infoExtracted = comment.reference_information_extracted_multiple || [];

    // 确定 vibe 数量：以 strengths 数组长度为准（因为 vibeData 可能为空）
    const vibeCount = Math.max(vibeData.length, strengths.length);

    for (let i = 0; i < vibeCount; i++) {
      const data = vibeData[i];
      const strength = strengths[i] ?? 0.6;
      const info = infoExtracted[i] ?? 1;

      if (data) {
        // 有 vibe 数据，判断是原始图片还是编码
        // 编码数据是纯 base64，图片数据解码后会有 PNG/JPEG 的 magic bytes
        // PNG: 以 iVBORw0KGgo 开头 (base64 of 0x89 PNG)
        // JPEG: 以 /9j/ 开头 (base64 of 0xFF 0xD8 0xFF)
        const isLikelyImage = data.startsWith('iVBORw0KGgo') || data.startsWith('/9j/');

        vibes.push({
          image: isLikelyImage ? data : undefined,
          encoding: isLikelyImage ? undefined : data,
          strength,
          informationExtracted: info,
        });
      } else {
        // 没有 vibe 数据，但有参数，标记为需要本地匹配
        vibes.push({
          strength,
          informationExtracted: info,
          needsLocalMatch: true,
        });
      }
    }

    // 模型名称映射 - 基于 NovelAI 官方前端源码的完整映射
    const modelNameMap: Record<string, string> = {
      // V5 —— Source 串里不写 Full/Curated,只有版本号加权重哈希,只能靠哈希区分。
      // 0ADF9AB7 是实测采到的 V5 Full;Curated 的哈希还没采到。
      // 这里必须有条目:没有的话下面的正则兜底会把它压成 "NovelAI V5",
      // 而 metadataImportActions 那张关键词表是按**这里产出的名字**匹配的,
      // 压扁之后哪条都不中 —— 表现就是导入 V5 图片不切模型,且完全不报错。
      'NovelAI Diffusion V5 0ADF9AB7': 'NovelAI V5 Full',
      // V4.5 Full 系列
      'NovelAI Diffusion V4.5 4BDE2A90': 'NovelAI V4.5 Full',
      'NovelAI Diffusion V4.5 1229B44F': 'NovelAI V4.5 Full Inpaint',
      'NovelAI Diffusion V4.5 B9F340FD': 'NovelAI V4.5 Full',
      'NovelAI Diffusion V4.5 F3D95188': 'NovelAI V4.5 Full',
      // V4.5 Curated 系列
      'NovelAI Diffusion V4.5 C02D4F98': 'NovelAI V4.5 Curated',
      'NovelAI Diffusion V4.5 5BB76870': 'NovelAI V4.5 Curated Inpaint',
      'NovelAI Diffusion V4.5 5AB81C7C': 'NovelAI V4.5 Curated',
      'NovelAI Diffusion V4.5 B5A2A797': 'NovelAI V4.5 Curated',
      // V4 Full
      'NovelAI Diffusion V4 44FD40FE': 'NovelAI V4 Full',
      'NovelAI Diffusion V4 37442FCA': 'NovelAI V4 Full',
      'NovelAI Diffusion V4 4F49EC75': 'NovelAI V4 Full',
      'NovelAI Diffusion V4 CA4B7203': 'NovelAI V4 Full',
      'NovelAI Diffusion V4 79F47848': 'NovelAI V4 Full',
      'NovelAI Diffusion V4 F6302A9D': 'NovelAI V4 Full',
      // V4 Curated
      'NovelAI Diffusion V4 C5E578FD': 'NovelAI V4 Curated',
      'NovelAI Diffusion V4 7ABFFA2A': 'NovelAI V4 Curated',
      'NovelAI Diffusion V4 C1CCBA86': 'NovelAI V4 Curated',
      'NovelAI Diffusion V4 770A9E12': 'NovelAI V4 Curated',
      // V4 → V4.5 Curated (官方归类)
      'NovelAI Diffusion V4 5AB81C7C': 'NovelAI V4.5 Curated',
      'NovelAI Diffusion V4 B5A2A797': 'NovelAI V4.5 Curated',
      // V3
      'NovelAI Diffusion V3 F4D50568': 'NovelAI V3',
      // V3 Furry
      'Stable Diffusion XL 4BE8C60C': 'NovelAI V3 Furry',
      'Stable Diffusion XL C8704949': 'NovelAI V3 Furry',
      'Stable Diffusion XL 37C2B166': 'NovelAI V3 Furry',
      'Stable Diffusion XL F306816B': 'NovelAI V3 Furry',
      'Stable Diffusion XL 9CC2F394': 'NovelAI V3 Furry',
    };

    const rawSource = data.Source || '';
    let source: string;
    if (modelNameMap[rawSource]) {
      source = modelNameMap[rawSource];
    } else if (rawSource && rawSource !== 'NovelAI' && rawSource !== 'Stable Diffusion XL') {
      // 尝试从 Source 字符串中提取版本信息
      const versionMatch = rawSource.match(/V(\d+(?:\.\d+)?)/i);
      if (versionMatch) {
        const ver = versionMatch[1];
        const isCurated = /curated/i.test(rawSource);
        source = `NovelAI V${ver}${isCurated ? ' Curated' : ''}`;
      } else {
        source = rawSource;
      }
    } else {
      // Source 为空或通用名称时，尝试从 Comment 内容推断模型
      if (comment.v4_prompt) {
        // 有 v4_prompt 说明是 V4 系列，但无法区分 V4 和 V4.5
        source = 'NovelAI V4+';
      } else if (comment.sm !== undefined || comment.sm_dyn !== undefined) {
        source = 'NovelAI V3';
      } else {
        source = rawSource || 'NovelAI';
      }
    }

    return {
      source,
      sourceType: 'novelai',
      prompt: comment.prompt || '',
      negativePrompt,
      width: comment.width || 0,
      height: comment.height || 0,
      seed: comment.seed || '',
      steps: comment.steps,
      sampler: comment.sampler,
      scale: comment.scale,
      noiseSchedule: comment.noise_schedule,
      cfgRescale: comment.cfg_rescale,
      characterPrompts: characterPrompts.length > 0 ? characterPrompts : undefined,
      useCoords,
      vibes: vibes.length > 0 ? vibes : undefined,
      raw: data,
    };
  } catch (error) {
    console.error('Failed to parse NAI metadata:', error);
    return null;
  }
}

/**
 * 检测图片格式并返回 MIME 类型
 */
function detectImageMimeType(arrayBuffer: ArrayBuffer): string {
  const bytes = new Uint8Array(arrayBuffer, 0, Math.min(16, arrayBuffer.byteLength));

  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return 'image/jpeg';
  }
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return 'image/png'; // 默认
}

/**
 * 从 EXIF UserComment 中提取 AI 生成元数据（支持 WebP/JPEG/PNG）
 */
function extractExifMetadata(arrayBuffer: ArrayBuffer): ImageMetadata | null {
  try {
    const bytes = new Uint8Array(arrayBuffer);

    // 查找 EXIF 数据中的 UserComment (tag 0x9286)
    // 首先需要找到 EXIF 块
    let exifOffset = -1;
    let exifLength = 0;

    const mimeType = detectImageMimeType(arrayBuffer);

    if (mimeType === 'image/jpeg') {
      // JPEG: 查找 APP1 (EXIF) 标记 FF E1
      let offset = 2;
      while (offset < bytes.length - 4) {
        if (bytes[offset] === 0xFF && bytes[offset + 1] === 0xE1) {
          const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
          // 检查 "Exif\0\0" 标识
          if (bytes[offset + 4] === 0x45 && bytes[offset + 5] === 0x78 &&
            bytes[offset + 6] === 0x69 && bytes[offset + 7] === 0x66) {
            exifOffset = offset + 10; // 跳过 FF E1 + length(2) + "Exif\0\0"(6)
            exifLength = segLen - 8;
          }
          break;
        }
        if (bytes[offset] === 0xFF) {
          const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
          offset += 2 + segLen;
        } else {
          break;
        }
      }
    } else if (mimeType === 'image/webp') {
      // WebP: 查找 EXIF chunk
      let offset = 12; // 跳过 RIFF + size + WEBP
      while (offset < bytes.length - 8) {
        const chunkId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
        const chunkSize = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);

        if (chunkId === 'EXIF') {
          exifOffset = offset + 8;
          // WebP EXIF 可能以 "Exif\0\0" 开头，需要跳过
          if (bytes[exifOffset] === 0x45 && bytes[exifOffset + 1] === 0x78 &&
            bytes[exifOffset + 2] === 0x69 && bytes[exifOffset + 3] === 0x66) {
            exifOffset += 6;
            exifLength = chunkSize - 6;
          } else {
            exifLength = chunkSize;
          }
          break;
        }

        offset += 8 + chunkSize + (chunkSize % 2); // padding
      }
    }

    if (exifOffset < 0 || exifLength <= 0) return null;

    // 解析 TIFF header 以找到 UserComment
    const tiffStart = exifOffset;
    const isLittleEndian = bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49; // "II"

    const readUint16 = (off: number): number => {
      return isLittleEndian
        ? bytes[off] | (bytes[off + 1] << 8)
        : (bytes[off] << 8) | bytes[off + 1];
    };

    const readUint32 = (off: number): number => {
      return isLittleEndian
        ? bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)
        : (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
    };

    // 查找 IFD0 中的 EXIF IFD 指针 (tag 0x8769)
    const ifd0Offset = tiffStart + readUint32(tiffStart + 4);
    const ifd0Count = readUint16(ifd0Offset);

    let exifIfdOffset = -1;
    for (let i = 0; i < ifd0Count; i++) {
      const entryOffset = ifd0Offset + 2 + i * 12;
      const tag = readUint16(entryOffset);
      if (tag === 0x8769) { // EXIF IFD pointer
        exifIfdOffset = tiffStart + readUint32(entryOffset + 8);
        break;
      }
    }

    if (exifIfdOffset < 0) return null;

    // 在 EXIF IFD 中查找 UserComment (0x9286)
    const exifIfdCount = readUint16(exifIfdOffset);

    for (let i = 0; i < exifIfdCount; i++) {
      const entryOffset = exifIfdOffset + 2 + i * 12;
      const tag = readUint16(entryOffset);

      if (tag === 0x9286) { // UserComment
        const type = readUint16(entryOffset + 2);
        const count = readUint32(entryOffset + 4);
        let dataOffset: number;

        if (count <= 4) {
          dataOffset = entryOffset + 8;
        } else {
          dataOffset = tiffStart + readUint32(entryOffset + 8);
        }

        // 读取 8 字节的字符编码标识
        const charsetBytes = bytes.slice(dataOffset, dataOffset + 8);
        const charsetStr = new TextDecoder('ascii', { fatal: false }).decode(charsetBytes);
        let textStart = dataOffset + 8;
        let textLength = count - 8;

        if (textLength <= 0) return null;

        // 根据编码标识选择解码方式
        const textBytes = bytes.slice(textStart, textStart + textLength);
        let userComment: string;

        if (charsetStr.startsWith('UNICODE')) {
          // UNICODE 前缀 -> UTF-16 BE 编码
          userComment = new TextDecoder('utf-16be', { fatal: false }).decode(textBytes);
        } else {
          // ASCII 或 Undefined -> UTF-8/ASCII
          userComment = new TextDecoder('utf-8', { fatal: false }).decode(textBytes);
        }
        userComment = userComment.replace(/\0+$/g, '').trim();

        if (!userComment) return null;

        // 尝试解析为 JSON (NovelAI 格式)
        try {
          const data = JSON.parse(userComment);
          if (typeof data === 'object' && data !== null) {
            // NovelAI 格式: {Source: ..., Comment: ...}
            if (data.Source || data.Comment) {
              return parseNAIMetadata(data);
            }
          }
        } catch {
          // 不是 JSON
        }

        // 尝试解析为 SD parameters 格式
        if (userComment.includes('Steps:')) {
          return parseSDParameters(userComment);
        }

        break;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 从图片文件中提取元数据
 * @param file 图片文件或 base64 字符串
 * @returns 解析后的元数据，如果无法解析则返回 null
 */
export async function extractImageMetadata(
  input: File | string
): Promise<ImageMetadata | null> {
  try {
    let arrayBuffer: ArrayBuffer;
    let imageData: ImageData;

    if (typeof input === 'string') {
      // Base64 字符串
      const base64Data = input.includes(',') ? input.split(',')[1] : input;
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      arrayBuffer = bytes.buffer;
    } else {
      // File 对象
      arrayBuffer = await input.arrayBuffer();
    }

    // 提取所有 PNG 文本块
    const textChunks = extractAllPNGTextChunks(arrayBuffer);

    // 1. 检查是否是 ComfyUI 格式（有 prompt 和/或 workflow JSON）
    if (textChunks.prompt) {
      const comfyResult = parseComfyUIPrompt(textChunks.prompt, textChunks.workflow);
      if (comfyResult) return comfyResult;
    }

    // 2. 检查是否有 comment 字段（可能是 NovelAI 格式）
    if (textChunks.comment) {
      try {
        const jsonData = JSON.parse(textChunks.comment);
        if (jsonData.prompt || jsonData.Comment) {
          return parseNAIMetadata({ Source: textChunks.source, Comment: jsonData });
        }
      } catch {
        // 不是 JSON，忽略
      }
    }

    // 3. 检查是否有 parameters 字段（SD WebUI 格式）
    if (textChunks.parameters) {
      return parseSDParameters(textChunks.parameters);
    }

    // 4. 尝试 EXIF 元数据（WebP/JPEG 等格式）
    const exifResult = extractExifMetadata(arrayBuffer);
    if (exifResult) return exifResult;

    // 5. 尝试 LSB 隐写数据提取 (NovelAI PNG)
    // 创建图片以获取 ImageData
    const mimeType = detectImageMimeType(arrayBuffer);
    const blob = new Blob([arrayBuffer], { type: mimeType });
    const url = URL.createObjectURL(blob);

    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = reject;
        img.src = url;
      });

      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      imageData = ctx.getImageData(0, 0, img.width, img.height);
    } finally {
      URL.revokeObjectURL(url);
    }

    const lsbData = await extractLSBMetadata(imageData);
    if (lsbData) {
      const parsed = parseNAIMetadata(lsbData);
      if (parsed) return parsed;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 判断图片尺寸类型
 */
export function getPictureSizeType(width: number, height: number): string {
  if (width === 832 && height === 1216) return '竖图';
  if (width === 1216 && height === 832) return '横图';
  if (width === 1024 && height === 1024) return '方图';
  if (width === 1984 && height === 832) return '宽图';
  return `${width}×${height}`;
}

// LSB 隐写数据写入器
class LSBWriter {
  private data: Uint8ClampedArray;
  private width: number;
  private height: number;
  private row = 0;
  private col = 0;

  constructor(imageData: ImageData) {
    this.data = imageData.data;
    this.width = imageData.width;
    this.height = imageData.height;
  }

  private writeBit(bit: number): void {
    if (this.row < this.height && this.col < this.width) {
      const index = (this.row * this.width + this.col) * 4 + 3;
      // 清除最低位并设置新值
      this.data[index] = (this.data[index] & 0xfe) | (bit & 1);
      this.row++;
      if (this.row === this.height) {
        this.row = 0;
        this.col++;
      }
    } else {
      throw new Error('Reached end of image data while writing bits');
    }
  }

  writeByte(byte: number): void {
    for (let i = 7; i >= 0; i--) {
      this.writeBit((byte >> i) & 1);
    }
  }

  writeBytes(bytes: Uint8Array): void {
    for (const byte of bytes) {
      this.writeByte(byte);
    }
  }

  write32BitInteger(value: number): void {
    this.writeByte((value >> 24) & 0xff);
    this.writeByte((value >> 16) & 0xff);
    this.writeByte((value >> 8) & 0xff);
    this.writeByte(value & 0xff);
  }
}

/**
 * 将自定义元数据写入图片的 LSB 隐写数据中（NAI 格式）
 * @param imageUrl 原始图片 URL
 * @param customPrompt 自定义正向提示词
 * @returns 带有新元数据的图片 Blob
 */
export async function writeCustomMetadataToImage(
  imageUrl: string,
  customPrompt: string
): Promise<Blob> {
  // 加载图片
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = imageUrl;
  });

  // 创建 canvas 并绘制图片
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  // 获取图片数据
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  writeCustomMetadataIntoImageData(imageData, customPrompt);

  // 将修改后的数据写回 canvas
  ctx.putImageData(imageData, 0, 0);

  // 导出为 Blob
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Failed to create blob'));
        }
      },
      'image/png'
    );
  });
}

/**
 * 把自定义 NAI 元数据以 LSB 隐写写进一块 ImageData(先清掉旧的 alpha 最低位)。
 * 只动 alpha 通道;水印管道里可见水印合成之后、盲水印之前调它。
 */
export function writeCustomMetadataIntoImageData(imageData: ImageData, customPrompt: string): void {
  // 先清除所有 alpha 通道（设为 255），彻底移除旧的 LSB 隐写数据（包括 vibe 图片数据）
  const pixelData = imageData.data;
  for (let i = 3; i < pixelData.length; i += 4) {
    pixelData[i] = 255;
  }

  // 构建完整的 NAI 格式 Comment 对象
  const comment = {
    prompt: customPrompt,
    steps: 28,
    height: imageData.height,
    width: imageData.width,
    scale: 5.0,
    uncond_scale: 0.0,
    cfg_rescale: 0.0,
    seed: 0,
    n_samples: 1,
    noise_schedule: 'karras',
    legacy_v3_extend: false,
    reference_information_extracted_multiple: [],
    reference_strength_multiple: [],
    v4_prompt: {
      caption: {
        base_caption: customPrompt,
        char_captions: [],
      },
      use_coords: true,
      use_order: true,
      legacy_uc: false,
    },
    v4_negative_prompt: {
      caption: {
        base_caption: '',
        char_captions: [],
      },
      use_coords: false,
      use_order: false,
      legacy_uc: false,
    },
    sampler: 'k_euler_ancestral',
    controlnet_strength: 1.0,
    controlnet_model: null,
    dynamic_thresholding: false,
    dynamic_thresholding_percentile: 0.999,
    dynamic_thresholding_mimic_scale: 10.0,
    sm: false,
    sm_dyn: false,
    skip_cfg_above_sigma: null,
    skip_cfg_below_sigma: 0.0,
    lora_unet_weights: null,
    lora_clip_weights: null,
    deliberate_euler_ancestral_bug: false,
    prefer_brownian: true,
    cfg_sched_eligibility: 'enable_for_post_summer_samplers',
    explike_fine_detail: false,
    minimize_sigma_inf: false,
    uncond_per_vibe: true,
    wonky_vibe_correlation: true,
    stream: 'none',
    version: 1,
    uc: '',
    request_type: 'PromptGenerateRequest',
  };

  // 构建 NAI 格式的元数据
  const metadata = {
    Description: customPrompt,
    Software: 'NovelAI',
    Source: 'NovelAI',
    'Generation time': '0.0',
    Comment: JSON.stringify(comment),
  };

  // 压缩元数据
  const jsonStr = JSON.stringify(metadata);
  const compressed = pako.gzip(new TextEncoder().encode(jsonStr));

  // 写入 LSB 隐写数据
  const writer = new LSBWriter(imageData);
  const magic = 'stealth_pngcomp';
  const magicBytes = new TextEncoder().encode(magic);

  // 写入魔术字符串
  writer.writeBytes(magicBytes);

  // 写入数据长度（以 bits 为单位）
  writer.write32BitInteger(compressed.length * 8);

  // 写入压缩数据
  writer.writeBytes(compressed);
}

// ============ 保存格式 / 压缩率 公共工具 ============

export type SaveFormat = 'png' | 'jpg';

export interface ProcessImageForSaveOptions {
  mode: 'original' | 'clean' | 'custom';
  customPrompt?: string;
  format?: SaveFormat;        // 默认 png
  quality?: number;           // jpg 压缩质量 0~1，默认 0.92
  /**
   * 导出水印。省略 = 读设置里的 `watermark`;传 null = 这次强制不加(复制原图之类)。
   * 任一种水印生效时保存 / 复制都会重新编码,PNG + original 也不例外。
   */
  watermark?: WatermarkConfig | null;
}

/**
 * 这次导出会不会经过水印管道(调用方用它决定还能不能走 PNG 直链)。
 * `override` 与 `ProcessImageForSaveOptions.watermark` 同义:省略 = 读设置,null = 强制不加。
 */
export function isWatermarkExportActive(override?: WatermarkConfig | null): boolean {
  const config = override === undefined ? resolveWatermarkExportSettings() : override;
  return Boolean(config && isWatermarkActive(config));
}

async function loadImageElement(imageUrl: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = imageUrl;
  });
  return img;
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Failed to encode image'))),
      mime,
      quality,
    );
  });
}

/**
 * 把图片重新编码到指定格式（jpg 用白色背景填充透明像素，png 保留 alpha）
 */
async function reEncodeImage(imageUrl: string, format: SaveFormat, quality: number): Promise<Blob> {
  const img = await loadImageElement(imageUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  if (format === 'jpg') {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0);
  return canvasToBlob(canvas, format === 'jpg' ? 'image/jpeg' : 'image/png', format === 'jpg' ? quality : undefined);
}

/**
 * 根据 mode + format + quality 处理图片，返回最终用于保存的 Blob
 *
 * - PNG + original: 原图直接 fetch
 * - PNG + clean:    清除 LSB 隐写
 * - PNG + custom:   写入自定义 NAI 元数据（LSB）
 * - JPG + *:        重新编码为 jpg；jpg 不支持 LSB/PNG tEXt，因此 clean/custom 等同
 */
export async function processImageForSave(
  imageUrl: string,
  options: ProcessImageForSaveOptions,
): Promise<Blob> {
  const { mode, customPrompt = '', format = 'png', quality = 0.92 } = options;

  const watermark = options.watermark === undefined ? resolveWatermarkExportSettings() : options.watermark;
  if (watermark && isWatermarkActive(watermark)) {
    return processImageWithWatermark(imageUrl, { mode, customPrompt, format, quality }, watermark);
  }

  if (format === 'jpg') {
    return reEncodeImage(imageUrl, 'jpg', quality);
  }

  if (mode === 'original') {
    const response = await fetch(imageUrl);
    return response.blob();
  }

  if (mode === 'custom') {
    return writeCustomMetadataToImage(imageUrl, customPrompt);
  }

  // mode === 'clean' 且 format === 'png'：清除 LSB
  const img = await loadImageElement(imageUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  ctx.putImageData(imageData, 0, 0);
  return canvasToBlob(canvas, 'image/png');
}

/**
 * 水印导出管道(照 Novelai-harness 的顺序):可见水印 → 元数据处理 → 盲水印 → 编码。
 *
 * - 可见水印只改 RGB,底图 alpha ≥ 254 的像素保持原值,original 模式下原图的 LSB 隐写
 *   元数据不会被抹掉;
 * - clean / custom 只在 PNG 下有意义(jpg 没有 alpha 可写);
 * - 盲水印永远最后嵌,而且只动 RGB,不会碰刚写好的 alpha 最低位。
 * logo 解码失败、容量不足等情况都退化为「这一步跳过」,导出本身不失败。
 */
async function processImageWithWatermark(
  imageUrl: string,
  options: { mode: ProcessImageForSaveOptions['mode']; customPrompt: string; format: SaveFormat; quality: number },
  config: WatermarkConfig,
): Promise<Blob> {
  const img = await loadImageElement(imageUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let image: RawRgbaImage = { rgba: imageData.data, width: imageData.width, height: imageData.height };

  if (hasVisibleWatermark(config) && config.imageDataUrl) {
    try {
      const logo = await loadWatermarkImage(config.imageDataUrl);
      image = applyVisibleWatermark(image, logo, config).image;
    } catch (error) {
      console.warn('可见水印跳过:logo 解码失败', error);
    }
  }

  if (options.format === 'png') {
    if (options.mode === 'clean') {
      const data = image.rgba;
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
    } else if (options.mode === 'custom') {
      const carrier = new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height);
      writeCustomMetadataIntoImageData(carrier, options.customPrompt);
      image = { rgba: carrier.data, width: image.width, height: image.height };
    }
  }

  if (hasBlindWatermark(config)) {
    // jpg 是有损的:平坦区按用户强度嵌进去的差值会被量化抹平,在真浏览器里实测
    // 0.92 质量下只有最高强度扛得住,所以 jpg 一律用 5(png 照用户设的)。
    const strength = options.format === 'jpg' ? WATERMARK_LIMITS.blindStrength.max : config.blindStrength;
    embedBlindWatermark(image, config.blindText.trim(), strength);
  }

  return rgbaToBlob(image, options.format, options.quality);
}

/**
 * 估算图片在指定保存配置下的体积。
 *
 * 走真实保存路径取 blob.size，估算 = 实际：
 * - PNG + original：直接 fetch 原图（不重编，得到原始字节数）
 * - 其他组合：调用 processImageForSave，与最终保存完全一致
 */
export async function estimateSavedSize(
  imageUrl: string,
  options: ProcessImageForSaveOptions,
): Promise<number> {
  const format = options.format ?? 'png';
  if (format === 'png' && options.mode === 'original' && !isWatermarkExportActive(options.watermark)) {
    const response = await fetch(imageUrl);
    const blob = await response.blob();
    return blob.size;
  }
  const blob = await processImageForSave(imageUrl, options);
  return blob.size;
}

/**
 * 根据 SaveFormat 取扩展名 + MIME
 */
export function getSaveExt(format: SaveFormat): string {
  return format === 'jpg' ? 'jpg' : 'png';
}
