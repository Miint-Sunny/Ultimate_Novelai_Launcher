/**
 * 生成参数「合法值」的单一数据源。
 *
 * UI 选项渲染、导入校验、发送前兜底统一引用这里，避免多处硬编码各自漂移。
 * 历史教训：NovelAI 元数据里 `noise_schedule` 可能是 `native` 这类「官方 UI 已下架、
 * 但 API/旧图里仍合法存在」的历史值；旧版导入逻辑原样写进 state，导致受控 <select>
 * 的 value 落在 options 之外 —— 表面显示停在 karras，实际却把 native 发了出去。
 */
import type { ImageMetadata } from './imageMetadata';

// ===== Noise Schedule（两端统一用 id 字符串）=====
export const NOISE_SCHEDULES = ['karras', 'exponential', 'polyexponential'] as const;
export type NoiseSchedule = (typeof NOISE_SCHEDULES)[number];
export const DEFAULT_NOISE_SCHEDULE: NoiseSchedule = 'karras';

export const isSupportedNoiseSchedule = (v?: string | null): v is NoiseSchedule =>
  !!v && (NOISE_SCHEDULES as readonly string[]).includes(v);

/** 不在白名单内的值（如 native）一律回退默认，保证 state 永远是 UI 能正确显示的值。 */
export const normalizeNoiseSchedule = (v?: string | null): NoiseSchedule =>
  isSupportedNoiseSchedule(v) ? v : DEFAULT_NOISE_SCHEDULE;

// ===== Sampler（桌面 state/UI 用 label，图片元数据/移动端/API 用 id）=====
export const SAMPLER_OPTIONS = [
  { id: 'k_euler_ancestral', label: 'Euler Ancestral' },
  { id: 'k_euler', label: 'Euler' },
  { id: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
  { id: 'k_dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
  { id: 'k_dpmpp_2m', label: 'DPM++ 2M' },
  { id: 'k_dpmpp_sde', label: 'DPM++ SDE' },
] as const;
export const SAMPLER_IDS: readonly string[] = SAMPLER_OPTIONS.map((o) => o.id);
export const SAMPLER_LABELS: readonly string[] = SAMPLER_OPTIONS.map((o) => o.label);

export const isSupportedSamplerId = (id?: string | null): boolean =>
  !!id && SAMPLER_IDS.includes(id);

/** id → 显示名（桌面 state 用显示名；图片元数据存的是 id，导入时需转换）。 */
export const samplerIdToLabel = (id?: string | null): string | undefined =>
  SAMPLER_OPTIONS.find((o) => o.id === id)?.label;

/** 显示名 → id。 */
export const samplerLabelToId = (label?: string | null): string | undefined =>
  SAMPLER_OPTIONS.find((o) => o.label === label)?.id;

/**
 * 把 sampler 统一成 API id（NovelAI 需要 id）。
 * 兼容两种输入：桌面 state 存显示名（Euler Ancestral），移动端 state 存 id（k_euler_ancestral）。
 * 未知值回退默认，避免发送层把无法识别的 sampler 透传或错误回退。
 */
export const normalizeSamplerToId = (v?: string | null): string => {
  if (v && SAMPLER_IDS.includes(v)) return v;
  return samplerLabelToId(v) ?? 'k_euler_ancestral';
};

// ===== 导入校验 =====
export interface UnsupportedSetting {
  field: string;
  value: string;
}

/**
 * 检查一张图的「生成设置」里是否含有当前 UI 不支持的值。
 * 返回不支持项清单（空数组 = 全部可安全导入）。
 * 注意：只对 NovelAI 来源的图有意义——SD/ComfyUI 的生成设置本就不允许导入。
 */
export function getUnsupportedImportSettings(meta: ImageMetadata): UnsupportedSetting[] {
  const issues: UnsupportedSetting[] = [];
  if (meta.noiseSchedule && !isSupportedNoiseSchedule(meta.noiseSchedule)) {
    issues.push({ field: 'noise schedule', value: String(meta.noiseSchedule) });
  }
  // NovelAI 元数据里的 sampler 是 id；不在受支持 id 列表内则视为不支持。
  if (meta.sampler && !isSupportedSamplerId(meta.sampler)) {
    issues.push({ field: 'sampler', value: String(meta.sampler) });
  }
  return issues;
}

/** 把不支持项格式化成一行可读原因，用于 UI 提示。 */
export const formatUnsupportedSettings = (issues: UnsupportedSetting[]): string =>
  issues.map((i) => `${i.field}: ${i.value}`).join('、');
