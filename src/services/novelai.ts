import { getAppSettings } from './localLibrary';
import { normalizeNoiseSchedule, normalizeSamplerToId } from '../utils/generationOptions';
import { getQueueServerUrl } from '../utils/apiConfig';
import { decode } from '@msgpack/msgpack';
import { queueService } from './queueService';
import { botService } from './botService';
import { generateLegacyImage, sidecarApi, type GenerationParams as SidecarGenerationParams } from '../api/sidecar';
import type { OpusUsage } from '../api/localSidecarApi';
import { appBackendApi } from '../api/appBackendApi';
import { resolveUcPreset } from './naiUcPresets';
import { officialPresetHint, toV5QualityPresetId, toV5UcPresetId, type NaiV5QualityPresetId } from './naiV5Presets';
import { isV5Model, modelCapabilities } from '../components/generation/modelResolutionOptions';
import { applyAutoText } from '../utils/autoText';
import {
  resolveCharacterCenters,
  shouldUseCoords,
  type CharacterCenter,
  quantizeCenterToGrid,
} from './characterPosition';

export interface AnlasInfo {
  fixedTrainingStepsLeft: number;
  purchasedTrainingSteps: number;
  /** 是否为 Opus 订阅（tier === 3 且 active） */
  isOpus: boolean;
  /** Opus「体力条」；仅 Opus 返回，见 localSidecarApi 的 OpusUsage。 */
  opusUsage?: OpusUsage;
}

/**
 * 查询 NovelAI 账户的 anlas 余额
 */
export async function getAnlas(): Promise<AnlasInfo | null> {
  return sidecarApi.getAnlas();
}

// 模块级缓存：上次查询到的 Opus 状态
let _cachedIsOpus = false;
let _cachedOpusUsage: OpusUsage | undefined;

/**
 * 更新 Opus 缓存（在 getAnlas 或 Bot 模式设置时调用）
 */
export function updateCachedIsOpus(isOpus: boolean, opusUsage?: OpusUsage): void {
  _cachedIsOpus = isOpus;
  _cachedOpusUsage = opusUsage;
}

/**
 * 体力条是否已耗尽。供无 anlasInfo 的组件（重绘、放大等浮层）判断 V5 是否
 * 还在免费额度内。
 *
 * 未知时返回 false（按未耗尽算）：这里返回 true 会让界面对着一个其实还有额度
 * 的账号反复弹确认，比偶尔漏提示更烦人；真正的兜底是生成后余额会变。
 */
export function isOpusUsageExhausted(): boolean {
  if (!_cachedOpusUsage) return false;
  return _cachedOpusUsage.isNegative || _cachedOpusUsage.percent <= 0;
}

/**
 * 获取缓存的 Opus 状态（供无 anlasInfo 状态的组件使用）
 * Bot 模式固定返回 true
 */
export function getCachedIsOpus(): boolean {
  const settings = getAppSettings();
  if (settings.loginMode === 'bot') return true;
  return _cachedIsOpus;
}

/**
 * 调用 NovelAI encode-vibe 接口，将图片编码为vibe特征
 * 根据登录模式选择编码渠道：
 * - bot 模式：使用 Bot 后端接口（服务器端 Token）
 * - token 模式：直接调用 NovelAI API（前端 Token）
 */
export async function encodeVibeImage(
  imageBase64: string,
  informationExtracted: number = 0.5,
  model: string = 'nai-diffusion-4-5-full'
): Promise<string | null> {
  try {
    const result = await sidecarApi.encodeVibe(imageBase64, informationExtracted, model);
    return result.encoding;
  } catch (error) {
    console.error('Sidecar encode vibe error:', error);
    return null;
  }
}

const MODEL_MAP: Record<string, string> = {
  'v5-full': 'nai-diffusion-5-full',
  'v5-curated': 'nai-diffusion-5-curated',
  'v4.5-full': 'nai-diffusion-4-5-full',
  'v4.5-curated': 'nai-diffusion-4-5-curated',
  'v4-full': 'nai-diffusion-4-full',
  'v4-curated-preview': 'nai-diffusion-4-curated-preview',
  v3: 'nai-diffusion-3',
};

// V5 Curated 的局部重绘模型「还在训练中」(官方原话),官方客户端在用户对 V5
// Curated 发起重绘时,实际换成 V4.5 Curated 的重绘模型去跑。所以重绘点得下去、
// 也确实出图,但那是 4.5 的模型在往 V5 的画面里补色,风格对不齐——用户看到的
// 「能用但有点怪」就是这么来的。
//
// TODO(nai-v5-curated-inpainting): NAI 上线 nai-diffusion-5-curated-inpainting 后
// 删掉这张顶替表。摘除前它是静默用错模型,grep 这个标记能找到全部两处
// (另一处在 server/app.py 的 convert_web_params_to_stream)。
const INPAINT_MODEL_OVERRIDES: Record<string, string> = {
  'nai-diffusion-5-curated': 'nai-diffusion-4-5-curated-inpainting',
};

/** 放大重绘走 img2img 时的历史默认档。只在非 V5 与认不出的输入上用。 */
const ENHANCE_FALLBACK_MODEL = 'v4.5-curated';

/**
 * 放大重绘(img2img)该用哪个模型。传入与返回都是 **UI 模型 id**(MODEL_MAP 的键)。
 *
 * 上面那张顶替表**只管 infill**:V5 Curated 缺的是「重绘模型」(`-inpainting`),
 * 而 img2img 压根不需要那种模型,直接用基座跑。官方就是这么分的,参考实现里
 * 写得很直白:`sendModel = inpaint != null ? inpaintModelId(model) : model`
 * (Plana-App lib/features/generate/nai_request.dart:185)。
 * 所以 V5 Full 与 V5 Curated 的放大重绘**都用它们自己,不顶替**。
 *
 * 非 V5 暂时仍退回历史默认档,免得动到老用户的花费与画风;
 * 「让 4.5 / v3 也跟随所选模型」是单独一条待定项。
 *
 * 这里曾经填 API id('nai-diffusion-4-5-curated'),而 MODEL_MAP 是按 UI id 建的,
 * 查不到就静默落到默认的 4.5 Full —— 于是「4.5 Curated 重绘」一直在用 4.5 Full
 * 出图。返回值必须留在 UI id 这个空间里。
 */
export function resolveEnhanceModel(uiModelId: string): string {
  const apiModel = MODEL_MAP[uiModelId];
  return apiModel && isV5Model(apiModel) ? uiModelId : ENHANCE_FALLBACK_MODEL;
}

export interface CharacterPrompt {
  positive: string;
  negative: string;
  enabled: boolean;
  /** 旧的 A1–E5 网格。只为读旧存档保留,新数据写 `center`。 */
  position?: string;
  /** 画布上的连续坐标(0–1)。见 services/characterPosition。 */
  center?: CharacterCenter | null;
}

// Precise Reference 模式类型
export type PreciseReferenceMode = 'character&style' | 'character' | 'style';

// 单个 Precise Reference 图片配置
export interface PreciseReferenceItem {
  imageBase64: string;  // 图片的base64编码（不含data:前缀）
  mode: PreciseReferenceMode;  // 模式：character&style, character, style
  informationExtracted: number;  // 信息提取程度 0-1
  strength: number;  // 强度值 0-1
}

// 兼容旧接口（已废弃，保留向后兼容）
export interface CRReference {
  imageBase64: string;
  fidelity: number;
  styleAware: boolean;
}

export interface VibeReference {
  encodedVibe: string;  // 编码后的vibe base64
  originalImage?: string; // 原始vibe图片的base64（用于保存到元数据）
  strength: number;     // 强度值 0-1
  informationExtracted: number; // 信息提取程度 0-1
}

export interface Img2ImgParams {
  imageBase64: string;  // 图生图基础图片的base64编码（不含data:前缀）
  strength: number;     // 强度值 0-1
  noise: number;        // 噪声值 0-1
  /**
   * Max✨ Enhance 档。只有它为 true 时才发 `upscaled_enhance`,
   * 其余档位整个键省掉——发 `false` 会被官方当成普通 img2img。
   * 能不能发看 modelCapabilities(model).maxEnhance。
   */
  upscaledEnhance?: boolean;
}

export interface InpaintParams {
  imageBase64: string;  // 原图的base64编码（不含data:前缀）
  maskBase64: string;   // 遮罩图的base64编码（白色=重绘区域，黑色=保留区域）
  strength: number;     // 重绘强度 0-1
  noise?: number;       // 噪声值 0-1，默认 0.2
}

export interface GenerateImageParams {
  positivePrompt: string;
  negativePrompt: string;
  model: string;
  width: number;
  height: number;
  steps: number;
  scale: number;
  seed?: number;
  sampler: string;
  cfgRescale: number;
  noiseSchedule: string;
  ucPreset: string;
  qualityToggle: boolean;
  /**
   * V5 的质量档 id。缺省时由布尔 qualityToggle 退化推导(standard / none),
   * 保留给还没走预设目录层的老调用方(放大重绘、OC 管理器等)。
   */
  qualityPresetId?: NaiV5QualityPresetId;
  varietyPlus: boolean;
  /** 透明背景（V5 专有；勾选后发 tag_hint_transparent_background） */
  transparentBackground?: boolean;
  normalizeVibeStrength?: boolean;
  characterPrompts: CharacterPrompt[];
  /**
   * 官方位置区块上的全局二选一(AI's Choice / Custom = `v4_prompt.use_coords`)。
   * 桌面端如实传;没传(移动端)时退回「有人摆过就开」的推断。
   */
  useCoords?: boolean;
  preciseReferences?: PreciseReferenceItem[];  // Precise Reference 参数（多图）
  crReference?: CRReference;  // 旧版 CR 参数（向后兼容）
  vibeReferences?: VibeReference[];  // Vibe参数
  img2img?: Img2ImgParams;  // 图生图参数
  inpaint?: InpaintParams;  // 局部重绘参数
  skipHistory?: boolean;    // 跳过历史记录（裁切/扩图回贴时使用，避免中间结果入历史）
  resolutionSource?: string; // 分辨率来源，用于排查异常尺寸
}

/**
 * 清除前端特有的聚合标签格式 (例: <<artist:名称:内容>> -> 内容)
 * type 通用匹配 (artist/codex/oc/scene/other/自定义 subtype),避免新类型标记残留进出图 prompt
 */
export function cleanPromptMarkers(prompt: string): string {
  if (!prompt) return prompt;
  return prompt.replace(/<<[\w-]+:[^:]+:((?:.|\n)*?)>>/g, '$1');
}

function generateSeed(): number {
  return Math.floor(Math.random() * 4294967295);
}

function generateCorrelationId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 6 }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

// CR图片处理缓存
const crImageCache = new Map<string, string>();

/**
 * 处理图生图的输入图片，调整尺寸以匹配目标输出尺寸
 * @param base64Data 图片的 base64 数据（可以包含或不包含 data: 前缀）
 * @param targetWidth 目标宽度
 * @param targetHeight 目标高度
 * @returns 处理后的 base64 数据（不含前缀）
 */
export async function processImg2ImgImage(
  base64Data: string,
  targetWidth: number,
  targetHeight: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // 创建画布，尺寸为目标尺寸
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('无法创建canvas上下文'));
        return;
      }

      // 计算缩放比例（cover 模式，填满整个画布）
      const scaleX = targetWidth / img.width;
      const scaleY = targetHeight / img.height;
      const scale = Math.max(scaleX, scaleY);

      const scaledWidth = Math.round(img.width * scale);
      const scaledHeight = Math.round(img.height * scale);

      // 居中裁剪
      const xOffset = Math.round((targetWidth - scaledWidth) / 2);
      const yOffset = Math.round((targetHeight - scaledHeight) / 2);

      // 填充黑色背景
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, targetWidth, targetHeight);

      // 绘制图片
      ctx.drawImage(img, xOffset, yOffset, scaledWidth, scaledHeight);

      // 转换为 PNG base64（不含前缀）
      const dataUrl = canvas.toDataURL('image/png');
      const base64Result = dataUrl.split(',')[1];

      resolve(base64Result);
    };
    img.onerror = () => reject(new Error('图片加载失败'));

    // 加载图片
    // 支持: data: URL, http/https URL, 相对路径 (以/开头), 纯base64字符串
    if (base64Data.startsWith('data:') || base64Data.startsWith('http://') || base64Data.startsWith('https://') || base64Data.startsWith('/')) {
      img.src = base64Data;
    } else {
      img.src = `data:image/png;base64,${base64Data}`;
    }
  });
}

/**
 * 获取CR图片的缓存key（使用图片数据的哈希，避免不同图片前缀相同导致的缓存碰撞）
 */
function getCRCacheKey(preview: string): string {
  // 使用简单的 djb2 哈希，覆盖整个字符串而非仅前100字符
  let hash = 5381;
  const len = preview.length;
  // 对于很长的字符串，采样计算避免性能问题
  const step = len > 10000 ? Math.floor(len / 5000) : 1;
  for (let i = 0; i < len; i += step) {
    hash = ((hash << 5) + hash + preview.charCodeAt(i)) | 0;
  }
  // 同时包含长度信息，进一步降低碰撞概率
  return `cr_${len}_${hash >>> 0}`;
}

/**
 * 获取缓存的CR处理结果
 */
export function getCachedCRImage(preview: string): string | undefined {
  return crImageCache.get(getCRCacheKey(preview));
}

/**
 * 处理CR参考图片，调整尺寸并转换为PNG base64
 * 模拟后端 process_image_for_reference 的逻辑
 * 结果会被缓存
 */
export async function processCRImage(base64Data: string): Promise<string> {
  const cacheKey = getCRCacheKey(base64Data);

  // 检查缓存
  const cached = crImageCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const width = img.width;
      const height = img.height;
      const aspectRatio = width / height;

      // 根据宽高比选择目标尺寸
      let containerWidth: number, containerHeight: number;
      if (aspectRatio >= 0.8 && aspectRatio <= 1.25) {
        // 接近正方形
        containerWidth = 1472;
        containerHeight = 1472;
      } else if (width > height) {
        // 横图
        containerWidth = 1536;
        containerHeight = 1024;
      } else {
        // 竖图
        containerWidth = 1024;
        containerHeight = 1536;
      }

      // 计算contain模式下的缩放比例
      const scaleX = containerWidth / width;
      const scaleY = containerHeight / height;
      const scale = Math.min(scaleX, scaleY);

      const scaledWidth = Math.round(width * scale);
      const scaledHeight = Math.round(height * scale);

      // 创建画布
      const canvas = document.createElement('canvas');
      canvas.width = containerWidth;
      canvas.height = containerHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('无法创建canvas上下文'));
        return;
      }

      // 填充黑色背景
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, containerWidth, containerHeight);

      // 居中绘制图片
      const xOffset = Math.round((containerWidth - scaledWidth) / 2);
      const yOffset = Math.round((containerHeight - scaledHeight) / 2);
      ctx.drawImage(img, xOffset, yOffset, scaledWidth, scaledHeight);

      // 转换为PNG base64（不含前缀）- 使用较低质量减小体积
      const dataUrl = canvas.toDataURL('image/png');
      const base64Result = dataUrl.split(',')[1];

      console.log(`CR image processed: ${containerWidth}x${containerHeight}, base64 length: ${base64Result.length}`);

      // 缓存结果
      crImageCache.set(cacheKey, base64Result);

      resolve(base64Result);
    };
    img.onerror = () => reject(new Error('图片加载失败'));

    // 加载图片
    // 支持: data: URL, http/https URL, 相对路径 (以/开头), 纯base64字符串
    if (base64Data.startsWith('data:') || base64Data.startsWith('http://') || base64Data.startsWith('https://') || base64Data.startsWith('/')) {
      img.src = base64Data;
    } else {
      img.src = `data:image/png;base64,${base64Data}`;
    }
  });
}

export function buildRequestPayload(params: GenerateImageParams) {
  const positivePrompt = cleanPromptMarkers(params.positivePrompt);
  const negativePrompt = cleanPromptMarkers(params.negativePrompt);
  const seed = params.seed ?? generateSeed();
  const isInpaint = !!params.inpaint;
  // 滑杆值收窄到 (0, 1];不是数就当 1(整区重画),别把 NaN 发出去
  const clampInpaintStrength = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0.01, v)) : 1);
  const baseModel = MODEL_MAP[params.model] || 'nai-diffusion-4-5-full';

  // 如果是 inpaint 模式，使用对应的 inpainting 模型
  // v3 使用 nai-diffusion-3-inpainting，v4/v4.5/v5 使用 {model}-inpainting
  // 例外见 INPAINT_MODEL_OVERRIDES（V5 Curated 暂借 4.5 Curated 的重绘模型）
  let model = baseModel;
  if (isInpaint) {
    if (INPAINT_MODEL_OVERRIDES[baseModel]) {
      model = INPAINT_MODEL_OVERRIDES[baseModel];
    } else if (baseModel === 'nai-diffusion-3') {
      model = 'nai-diffusion-3-inpainting';
    } else {
      model = `${baseModel}-inpainting`;
    }
  }

  const isV5 = isV5Model(baseModel);
  const sampler = normalizeSamplerToId(params.sampler);
  // ucPreset 枚举按模型族区分（0=Heavy 起），必须用 baseModel 解析（inpainting 变体共享基座枚举）
  // V5 不走这套数字枚举，改发字符串 ucPresetId（见下方 V5 分支与 naiV5Presets.ts）
  const ucPreset = resolveUcPreset(baseModel, params.ucPreset);

  const charCaptions: Array<{ char_caption: string; centers: Array<{ x: number; y: number }> }> = [];
  const negativeCharCaptions: Array<{ char_caption: string; centers: Array<{ x: number; y: number }> }> = [];
  const characterPromptsForApi: Array<{ prompt: string; uc: string; center: { x: number; y: number }; enabled: boolean }> = [];

  // 同框上限按模型走(V4 系 6,V5 32):界面只在「添加」处拦,切模型不会自动收口,
  // 所以发送层也截一刀,超出的尾巴不进载荷。
  const activeCharacters = params.characterPrompts
    .filter((cp) => cp.enabled && cp.positive.trim())
    .slice(0, modelCapabilities(baseModel).maxCharacters);
  // 官方对不支持自由定位的模型(V4 / V4.5)在发送前把坐标吸到 5×5 格心,存着的坐标不改。
  const freeformPositioning = modelCapabilities(baseModel).freeformCharacterPosition;
  const characterCenters = resolveCharacterCenters(activeCharacters)
    .map((center) => (freeformPositioning ? center : quantizeCenterToGrid(center)));
  // use_coords 是位置区块上的**全局**二选一(AI's Choice / Custom),官方默认 false,
  // 坐标照发、模型不理会。桌面端把开关如实传过来;没传的调用方(移动端)退回老推断:
  // 有人手动摆过才开,全员自动时交回给模型。
  const useCoords = params.useCoords ?? shouldUseCoords(activeCharacters);

  activeCharacters.forEach((cp, index) => {
    const center = characterCenters[index];
    charCaptions.push({ char_caption: cp.positive, centers: [center] });
    if (cp.negative) negativeCharCaptions.push({ char_caption: cp.negative, centers: [center] });
    characterPromptsForApi.push({ prompt: cp.positive, uc: cp.negative || '', center, enabled: true });
  });

  // 引号内容 → `teXt:` 块。放在这里而不是提示词组装层,是因为它要按**阅读顺序**
  // 收集各角色里的引号,而中心坐标正是在上面这段才算出来的;同时这也让所有发包
  // 路径(桌面/移动/放大重绘/OC)走同一条变换,与官方在发送时才转是一致的。
  // 质量尾此时已经拼好,块追加在它之后——正是官方的位置。
  const inputPrompt = modelCapabilities(baseModel).textRendering
    ? applyAutoText(positivePrompt, {
        characters: characterPromptsForApi,
        useCoords,
      })
    : positivePrompt;

  return {
    input: inputPrompt,
    model,
    action: params.inpaint ? 'infill' : (params.img2img ? 'img2img' : 'generate'),
    parameters: {
      // V5 需要 params_version 4：传 3 时它照样出图，但角色的自由定位坐标会被
      // 静默丢弃——图是对的、人站错地方，最难查的那种。
      params_version: isV5 ? 4 : 3,
      width: params.width,
      height: params.height,
      scale: params.scale,
      sampler,
      steps: params.steps,
      n_samples: 1,
      // 数字 ucPreset + 布尔 qualityToggle 是 V4 系的口径；V5 换成字符串 id。
      // 只发官方形状的那一套。服务端今天两种都收（已上线的第三方客户端在 V5 上
      // 发数字口径也能跑），但那是宽容不是契约，不赌它一直收。
      ...(isV5
        ? (() => {
          const ucPresetId = toV5UcPresetId(params.ucPreset);
          const qualityPresetId = params.qualityPresetId ?? toV5QualityPresetId(params.qualityToggle);
          // 官方每个 V5 请求都带这两个数字档位提示,导入图片时靠它决定先拿哪个档
          // 去剥预设文本。映射不到的自定义档要**省掉键**而不是发 0 ——
          // 官方客户端删 undefined,发 0 等于谎报成 none。
          const qtHint = officialPresetHint(qualityPresetId);
          const ucHint = officialPresetHint(ucPresetId);
          return {
            ucPresetId,
            qualityPresetId,
            ...(qtHint === null ? {} : { tag_hint_qt: qtHint }),
            ...(ucHint === null ? {} : { tag_hint_uc_preset: ucHint }),
            // 32 通道 VAE 真正吐出 alpha 通道靠的是这个字段；官方对所有支持
            // 透明的模型常发，与用户有没有要透明背景无关。
            straight_alpha: true,
            ...(params.transparentBackground ? { tag_hint_transparent_background: true } : {}),
          };
        })()
        : {
            ucPreset,
            qualityToggle: params.qualityToggle,
          }),
      autoSmea: false,
      dynamic_thresholding: false,
      controlnet_strength: 1,
      legacy: false,
      add_original_image: true,
      cfg_rescale: params.cfgRescale,
      // V5 隐藏了噪声调度选择器并强制写死 karras（官方客户端的 sanitizer 就是
      // 这么做的），所以这里不透传用户的选择。
      noise_schedule: isV5 ? 'karras' : normalizeNoiseSchedule(params.noiseSchedule),
      legacy_v3_extend: false,
      // V5 没有 Variety+，skip_cfg_above_sigma 无处可延迟。
      skip_cfg_above_sigma: !isV5 && params.varietyPlus ? 58 : null,
      use_coords: useCoords,
      normalize_reference_strength_multiple: params.normalizeVibeStrength ?? true,
      // 重绘强度:服务端不看平铺的 strength(2026-09-20 真链路实测 0.2 与 0.95 逐像素相同),
      // 生效的是下面 inpaint 分支里嵌套的 img2img.strength;这个键照官方客户端跟着滑杆走。
      inpaintImg2ImgStrength: params.inpaint ? clampInpaintStrength(params.inpaint.strength) : 1,
      v4_prompt: {
        caption: { base_caption: inputPrompt, char_captions: charCaptions },
        use_coords: useCoords,
        use_order: true,
      },
      v4_negative_prompt: {
        caption: { base_caption: negativePrompt, char_captions: negativeCharCaptions },
        legacy_uc: false,
      },
      seed,
      legacy_uc: false,
      characterPrompts: characterPromptsForApi,
      negative_prompt: negativePrompt,
      deliberate_euler_ancestral_bug: false,
      prefer_brownian: true,
      image_format: 'png',
      stream: 'msgpack',
      // 图生图参数 - 如果提供了img2img则添加
      ...(params.img2img && {
        image: params.img2img.imageBase64,
        strength: params.img2img.strength,
        noise: params.img2img.noise,
        extra_noise_seed: seed,
        // 只在 Max 档且模型支持时出现。省掉 ≠ 发 false:官方把 false 当普通重绘。
        ...(params.img2img.upscaledEnhance && modelCapabilities(baseModel).maxEnhance
          ? { upscaled_enhance: true }
          : {}),
      }),
      // 局部重绘参数 - 如果提供了inpaint则添加
      ...(params.inpaint && {
        image: params.inpaint.imageBase64,
        mask: params.inpaint.maskBase64,
        strength: params.inpaint.strength,
        noise: params.inpaint.noise ?? 0,
        extra_noise_seed: seed,
        add_original_image: true,  // 保持原图质量
        // 官方「Inpainting Strength」真正生效的位置:强度 < 1 时官方客户端额外发这个嵌套对象
        // (官方 Swagger 里标注 "used by inpaint");等于 1 就不发,与官方一致。
        ...(clampInpaintStrength(params.inpaint.strength) < 1 && {
          img2img: { strength: clampInpaintStrength(params.inpaint.strength), color_correct: true },
        }),
      }),
      // Precise Reference 参数 - 支持多图
      // 不发的两种情况：V4 基座从来不支持；V5 是「暂时」不支持——官方说还在训练，
      // 上线后把能力表里那一位翻成 true 即可，功能代码保持原样不要删。
      // 判据交给能力位（与上面的 vibe 一样）：界面、计价、载荷读同一个答案。散写型号名
      // 的老写法把 V5 漏在了界面与估价两处，2026-09-21 真链路实测才发现。
      ...(params.preciseReferences && params.preciseReferences.length > 0 && modelCapabilities(baseModel).preciseReference && (() => {
        console.log('[API] 构建 Precise Reference 参数:', params.preciseReferences.length, '张图片');
        params.preciseReferences.forEach((pr, i) => {
          console.log(`[API] PR ${i}: mode=${pr.mode}, ie=${pr.informationExtracted}, str=${pr.strength}, base64长度=${pr.imageBase64.length}`);
        });
        return {
          director_reference_images: params.preciseReferences.map(pr => pr.imageBase64),
          director_reference_descriptions: params.preciseReferences.map(pr => ({
            caption: {
              base_caption: pr.mode,
              char_captions: [],
            },
            legacy_uc: false,
          })),
          // information_extracted 固定为 1
          director_reference_information_extracted: params.preciseReferences.map(() => 1),
          // strength_values = Strength
          director_reference_strength_values: params.preciseReferences.map(pr => pr.strength),
          // secondary_strength_values = 1 - Fidelity (UI 上的 informationExtracted 实际是 Fidelity)
          director_reference_secondary_strength_values: params.preciseReferences.map(pr => 1 - pr.informationExtracted),
        };
      })()),
      // 旧版 CR 参数（向后兼容）- 如果没有 preciseReferences 则使用 crReference
      ...(!params.preciseReferences?.length && params.crReference && !isV5 && {
        director_reference_images: [params.crReference.imageBase64],
        director_reference_descriptions: [
          {
            caption: {
              base_caption: params.crReference.styleAware ? 'character&style' : 'character',
              char_captions: [],
            },
            legacy_uc: false,
          },
        ],
        director_reference_information_extracted: [1],
        director_reference_strength_values: [1],
        director_reference_secondary_strength_values: [1 - params.crReference.fidelity],
      }),
      // Vibe参数 - 如果提供了vibeReferences则添加
      // NovelAI API 的 normalize_reference_strength_multiple 仅对缓存模式生效，
      // 直接传编码数据时需要前端自行归一化 strength
      // V5 同样是「暂时」不支持（连 encode-vibe 都不能为它编码），故整段不发。
      ...(params.vibeReferences && params.vibeReferences.length > 0 && modelCapabilities(baseModel).vibeTransfer && (() => {
        let strengths = params.vibeReferences!.map(v => v.strength);
        // 前端归一化：开启时将所有 strength 按比例缩放，使总和 ≤ 1
        if ((params.normalizeVibeStrength ?? true) && strengths.length > 1) {
          const total = strengths.reduce((a, b) => a + b, 0);
          if (total > 1) {
            strengths = strengths.map(s => s / total);
          }
        }
        return {
          reference_image_multiple: params.vibeReferences!.map(v => v.encodedVibe),
          reference_strength_multiple: strengths,
        };
      })()),
    },
    use_new_shared_trial: true,
  };
}

export interface GenerateResult {
  success: boolean;
  imageData?: Blob;
  seed?: number;
  error?: string;
}

export interface StreamProgress {
  step: number;
  totalSteps: number;
  previewImage?: Blob;
}

export interface QueueProgress {
  isQueuing: boolean;
  position: number;
  queueSize: number;
}

function createImageBlob(data: Uint8Array): Blob {
  const mimeType = data[0] === 0xff && data[1] === 0xd8 ? 'image/jpeg' : 'image/png';
  return new Blob([new Uint8Array(data)], { type: mimeType });
}

// 流式消息解析器
class StreamParser {
  private buffer: Uint8Array = new Uint8Array(0);

  append(chunk: Uint8Array): void {
    const newBuffer = new Uint8Array(this.buffer.length + chunk.length);
    newBuffer.set(this.buffer);
    newBuffer.set(chunk, this.buffer.length);
    this.buffer = newBuffer;
  }

  // 尝试解析一个完整的消息，返回解析结果或 null
  tryParseMessage(): Record<string, unknown> | null {
    if (this.buffer.length < 4) return null;

    // 读取 4 字节长度前缀 (大端序)
    const length =
      (this.buffer[0] << 24) | (this.buffer[1] << 16) | (this.buffer[2] << 8) | this.buffer[3];

    if (this.buffer.length < 4 + length) return null;

    // 提取消息数据
    const messageData = this.buffer.slice(4, 4 + length);

    // 移除已解析的数据
    this.buffer = this.buffer.slice(4 + length);

    try {
      return decode(messageData) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

export async function generateImageStream(
  params: GenerateImageParams,
  onProgress?: (progress: StreamProgress) => void,
  onQueueProgress?: (progress: QueueProgress) => void
): Promise<GenerateResult> {
  const settings = getAppSettings();

  // Bot模式：通过Bot生成
  if (settings.loginMode === 'bot') {
    return generateImageViaBotMode(params, onProgress, onQueueProgress);
  }

  const tokenStatus = await sidecarApi.tokenStatus();
  if (!tokenStatus.configured && !tokenStatus.mock_generation) {
    return { success: false, error: '未配置 NovelAI Token，请先在 sidecar 设置中保存 Token' };
  }

  // 如果启用了排队模式，等待轮到自己
  if (settings.queueEnabled) {
    const queueResult = await waitForQueueTurn(getQueueServerUrl(), onQueueProgress);
    // 排队结束，通知UI
    onQueueProgress?.({ isQueuing: false, position: 0, queueSize: 0 });
    if (!queueResult.success) {
      return { success: false, error: queueResult.error || '排队失败' };
    }
  }

  const payload = buildRequestPayload(params);

  try {
    const result = await generateLegacyImage({
      input: cleanPromptMarkers(params.positivePrompt),
      mode: 'tags',
      tags: cleanPromptMarkers(params.positivePrompt),
      negative: cleanPromptMarkers(params.negativePrompt),
      params: toSidecarGenerationParams(params, payload),
      legacy_payload: payload as unknown as Record<string, unknown>,
    });

    onProgress?.({
      step: params.steps,
      totalSteps: params.steps,
      previewImage: result.imageData,
    });

    if (settings.queueEnabled) {
      queueService.notifyDone();
    }
    return { success: true, imageData: result.imageData, seed: result.seed ?? payload.parameters.seed };
  } catch (error) {
    // 排队模式下通知完成（即使出错）
    if (settings.queueEnabled) {
      queueService.notifyDone();
    }
    return { success: false, error: `请求失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function toSidecarGenerationParams(
  params: GenerateImageParams,
  payload: ReturnType<typeof buildRequestPayload>
): SidecarGenerationParams {
  return {
    model: MODEL_MAP[params.model] || params.model,
    width: params.width,
    height: params.height,
    steps: params.steps,
    scale: params.scale,
    cfg_rescale: params.cfgRescale,
    sampler: normalizeSamplerToId(params.sampler),
    noise_schedule: normalizeNoiseSchedule(params.noiseSchedule),
    seed: params.seed ?? payload.parameters.seed ?? null,
  };
}

/**
 * Bot模式生成图片
 */
async function generateImageViaBotMode(
  params: GenerateImageParams,
  onProgress?: (progress: StreamProgress) => void,
  onQueueProgress?: (progress: QueueProgress) => void
): Promise<GenerateResult> {
  // 先尝试恢复会话（如果内存中没有授权状态）
  let authState = botService.getAuthState();
  if (!authState.isAuthorized) {
    await botService.restoreSession();
    authState = botService.getAuthState();
  }

  if (!authState.isAuthorized) {
    return { success: false, error: '未授权Bot，请先在设置中完成Bot授权' };
  }

  // 立即显示排队状态（在提交任务之前），用 0 表示未知位置
  onQueueProgress?.({
    isQueuing: true,
    position: 0,  // 0 表示位置未知，前端显示为横杠
    queueSize: 0,
  });

  // 构建Web端参数（与buildRequestPayload类似，但格式适配Bot端）
  // Sampler 和 Model 需要转换为 API 内部名
  const modelMap: Record<string, string> = {
    'v5-full': 'nai-diffusion-5-full',
    'v5-curated': 'nai-diffusion-5-curated',
    'v4.5-full': 'nai-diffusion-4-5-full',
    'v4.5-curated': 'nai-diffusion-4-5-curated',
    'v4-full': 'nai-diffusion-4-full',
    'v4-curated-preview': 'nai-diffusion-4-curated-preview',
    'v3': 'nai-diffusion-3',
  };
  const ucPresetModel = modelMap[params.model] || params.model;

  const webParams = {
    positivePrompt: cleanPromptMarkers(params.positivePrompt),
    negativePrompt: cleanPromptMarkers(params.negativePrompt),
    model: ucPresetModel,  // 转换为 API 内部名
    width: params.width,
    height: params.height,
    seed: params.seed ?? Math.floor(Math.random() * 4294967295),
    steps: params.steps,
    scale: params.scale,
    sampler: normalizeSamplerToId(params.sampler),  // 统一转 API id（兼容显示名/id 两种输入）
    cfgRescale: params.cfgRescale,
    noiseSchedule: normalizeNoiseSchedule(params.noiseSchedule),
    ucPreset: resolveUcPreset(ucPresetModel, params.ucPreset),  // 转换为按模型族的数字枚举
    qualityToggle: params.qualityToggle,
    varietyPlus: params.varietyPlus,
    normalizeVibeStrength: params.normalizeVibeStrength,
    characterPrompts: params.characterPrompts,
    // 宿主(黑板 #12 之后)照传客户端的 use_coords;不传它会按角色坐标推断,这里把
    // 与直连路径同一口径的值显式带上,三边(直连 / bot / 官方)才对得齐。
    useCoords: params.useCoords ?? shouldUseCoords(params.characterPrompts.filter((cp) => cp.enabled && cp.positive.trim())),
    vibeReferences: params.vibeReferences,
    preciseReferences: params.preciseReferences,  // 新格式 Precise Reference
    crReference: params.crReference,  // 旧格式，向后兼容
    img2img: params.img2img,
    inpaint: params.inpaint,  // 局部重绘参数
    resolutionSource: params.resolutionSource,
  };

  // 先注册监听器，再提交任务
  // 进度停滞检测：生成中如果 90 秒进度没有变化，判定为卡死
  const STALL_TIMEOUT_MS = 90 * 1000;
  // starting（Plana 的“已出队、正在启动”）单独给更宽的阈值：这一阶段本来就没有 step 更新，
  // 而对端是否会在整段生成里一直报 starting 我们无法验证 —— 用 90 秒会误杀健康任务。
  // 3 分钟仍比 waitForTask 的 5 分钟总超时早，能把“卡在启动”和“生成超时”区分开。
  const STARTING_STALL_TIMEOUT_MS = 180 * 1000;
  let lastProgressTime = Date.now();
  let lastStep = -1;
  let stallTimer: ReturnType<typeof setInterval> | null = null;

  const unsubscribe = botService.addEventListener((_, taskState) => {
    // 排队状态显示：pending / queued / starting 都显示排队中。
    // starting 是 Plana 的“已出队、正在启动”状态，UI 层不认它的话整个阶段没有任何提示。
    if (
      taskState.status === 'pending'
      || taskState.status === 'queued'
      || taskState.status === 'starting'
    ) {
      if (taskState.status !== 'starting') {
        // 排队中刷新时间，避免长队列被误判卡死；
        // starting 不刷新 —— 卡在 starting 正是停滞检测要覆盖的场景。
        lastProgressTime = Date.now();
      }
      onQueueProgress?.({
        isQueuing: true,
        position: taskState.queuePosition,  // 0 表示位置未知，由 UI 显示为 "-"
        queueSize: 0,
      });
    } else if (taskState.status === 'generating') {
      onQueueProgress?.({ isQueuing: false, position: 0, queueSize: 0 });

      // 流式进度更新（只在 generating 状态时显示）
      if (taskState.step > 0 && taskState.totalSteps > 0) {
        // 进度有变化时刷新停滞计时
        if (taskState.step !== lastStep) {
          lastStep = taskState.step;
          lastProgressTime = Date.now();
        }

        // 如果有预览图，转换为Blob
        let previewBlob: Blob | undefined;
        if (taskState.previewImage) {
          try {
            const binaryString = atob(taskState.previewImage);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            previewBlob = new Blob([bytes], { type: 'image/png' });
          } catch {
            // 忽略解析错误
          }
        }

        onProgress?.({
          step: taskState.step,
          totalSteps: taskState.totalSteps,
          previewImage: previewBlob,
        });
      } else {
        // 刚进入 generating 状态，刷新计时
        lastProgressTime = Date.now();
      }
    }
  });

  // 提交任务
  const submitted = await botService.submitTask(webParams);
  if (!submitted) {
    const taskState = botService.getTaskState();
    unsubscribe();
    onQueueProgress?.({ isQueuing: false, position: 0, queueSize: 0 });
    return { success: false, error: taskState.error || '提交Bot任务失败' };
  }

  // 启动停滞检测定时器
  stallTimer = setInterval(() => {
    const taskState = botService.getTaskState();
    // starting 一并纳入停滞检测：任务卡在“正在启动”时不会有任何 step 更新，
    // 只认 generating 的话要一路空转到 5 分钟总超时才报错。
    const isStarting = taskState.status === 'starting';
    if (!isStarting && taskState.status !== 'generating') return;
    const limit = isStarting ? STARTING_STALL_TIMEOUT_MS : STALL_TIMEOUT_MS;
    if (Date.now() - lastProgressTime > limit) {
      if (stallTimer) clearInterval(stallTimer);
      stallTimer = null;
      botService.abortTask(
        isStarting
          ? `任务卡在启动阶段超过 ${limit / 1000} 秒，请重试`
          : `生成卡住: 进度停留在 ${lastStep > 0 ? lastStep + '步' : '开始阶段'} 超过 ${limit / 1000} 秒`
      );
    }
  }, 5000);

  try {
    // 等待任务完成
    const result = await botService.waitForTask();
    if (stallTimer) clearInterval(stallTimer);
    unsubscribe();

    if (!result) {
      const taskState = botService.getTaskState();
      return { success: false, error: taskState.error || 'Bot生成失败' };
    }

    // 处理结果
    // 结果形状归一化：我们后端返回 { type:'base64', imageBase64 }，而 Plana 方言的 result
    // 只有 { imageBase64 } 没有 type 字段。所以 type 缺失时按字段推断，两种方言落到同一分支；
    // type 显式给出时仍以 type 为准，保持 file/data 等既有分支的判定不变。
    const resultType: string | undefined = result.type;
    const base64Image = (!resultType || resultType === 'base64') ? result.imageBase64 : undefined;

    if (base64Image) {
      // 直接是base64图片数据
      const binaryString = atob(base64Image);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return {
        success: true,
        imageData: new Blob([bytes], { type: 'image/png' }),
        seed: webParams.seed,
      };
    } else if (resultType === 'file' && result.path) {
      // 文件路径，需要从服务器获取
      try {
        const response = await appBackendApi.request('/api/bot/image', undefined, { path: result.path });
        if (response.ok) {
          const imageData = await response.blob();
          return { success: true, imageData, seed: webParams.seed };
        }
      } catch {
        // 如果无法获取，返回路径信息
      }
      return { success: false, error: `图片生成完成，但无法获取图片: ${result.path}` };
    }

    return { success: false, error: '未知的结果格式' };
  } catch (error) {
    if (stallTimer) clearInterval(stallTimer);
    unsubscribe();
    return { success: false, error: `Bot生成出错: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 等待排队轮到自己
 */
async function waitForQueueTurn(
  serverUrl: string,
  onQueueProgress?: (progress: QueueProgress) => void
): Promise<{ success: boolean; error?: string }> {
  // 连接到排队服务器
  const connected = await queueService.connect(serverUrl);
  if (!connected) {
    return { success: false, error: '无法连接到排队服务器' };
  }

  // 加入队列
  const joined = await queueService.joinQueue();
  if (!joined) {
    return { success: false, error: '加入队列失败' };
  }

  // 等待轮到自己
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve({ success: false, error: '排队超时' });
    }, 5 * 60 * 1000); // 5分钟超时

    const cleanup = queueService.addEventListener((event, state) => {
      // 更新排队状态
      if (event.type === 'joined' || event.type === 'position_update') {
        onQueueProgress?.({
          isQueuing: true,
          position: state.position,
          queueSize: state.queueSize,
        });
      }

      if (event.type === 'your_turn') {
        clearTimeout(timeout);
        cleanup();
        resolve({ success: true });
      } else if (event.type === 'timeout' || event.type === 'error') {
        clearTimeout(timeout);
        cleanup();
        resolve({ success: false, error: (event.data?.message as string) || '排队出错' });
      } else if (event.type === 'disconnected') {
        clearTimeout(timeout);
        cleanup();
        resolve({ success: false, error: '与排队服务器断开连接' });
      }
    });

    // 初始状态通知
    const initialState = queueService.getState();
    if (initialState.inQueue) {
      onQueueProgress?.({
        isQueuing: true,
        position: initialState.position,
        queueSize: initialState.queueSize,
      });
    }

    // 检查是否已经轮到（可能队列为空）
    if (initialState.isMyTurn) {
      clearTimeout(timeout);
      cleanup();
      resolve({ success: true });
    }
  });
}

export async function generateImage(params: GenerateImageParams): Promise<GenerateResult> {
  return generateImageStream(params);
}
