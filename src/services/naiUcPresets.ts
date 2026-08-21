/**
 * NAI ucPreset 数字枚举的权威映射。
 *
 * ucPreset 是按模型族区分的枚举，且一律从 0 = Heavy 起编：
 *   nai-diffusion-4-5-full         Heavy=0 Light=1 FurryFocus=2 HumanFocus=3 None=4
 *   nai-diffusion-4-5-curated      Heavy=0 Light=1 HumanFocus=2 None=3
 *   nai-diffusion-4-full           Heavy=0 Light=1 None=2
 *   nai-diffusion-4-curated-preview Heavy=0 Light=1 None=2
 *   nai-diffusion-3                Heavy=0 Light=1 HumanFocus=2 None=3
 *
 * 数据来源：NAI 官方 WebUI 抓取
 * reference_repos/Aaalice_NAI_Launcher/scripts/nai_presets_captured.json（2025-01-29）。
 * 历史教训：曾存在 heavy=0 与 heavy=4 两套互斥映射并存，其中 heavy=4 的一套
 * 是把枚举表倒读的结果（web/bot 链路选 Heavy 实际发出 None）。任何新调用方
 * 一律通过 resolveUcPreset 取值，不得再内联数字表。
 * 后端对应实现：server/app.py 的 _NAI_UC_PRESETS_BY_MODEL，两处需同步修改。
 */

export type NaiUcPresetName = 'heavy' | 'light' | 'furryFocus' | 'humanFocus' | 'none';

// 各模型支持的预设集不同（仅 v4.5-full 有 furryFocus），因此值为 Partial，
// 缺失的预设名在 resolveUcPreset 中兜底到 heavy。
const UC_PRESETS_BY_MODEL: Record<string, Partial<Record<NaiUcPresetName, number>>> = {
  'nai-diffusion-4-5-full': { heavy: 0, light: 1, furryFocus: 2, humanFocus: 3, none: 4 },
  'nai-diffusion-4-5-curated': { heavy: 0, light: 1, humanFocus: 2, none: 3 },
  'nai-diffusion-4-full': { heavy: 0, light: 1, none: 2 },
  'nai-diffusion-4-curated-preview': { heavy: 0, light: 1, none: 2 },
  'nai-diffusion-3': { heavy: 0, light: 1, humanFocus: 2, none: 3 },
};

// furry-3 等未出现在抓取样本中的模型按 v3 同代处理；heavy 在所有已知
// 模型上都是 0，作为兜底最安全。
const UC_PRESETS_FALLBACK: Record<NaiUcPresetName, number> = {
  heavy: 0,
  light: 1,
  furryFocus: 2,
  humanFocus: 2,
  none: 3,
};

export function resolveUcPreset(model: string, preset: string): number {
  const base = model.replace(/-inpainting$/, '');
  const table = UC_PRESETS_BY_MODEL[base] ?? UC_PRESETS_FALLBACK;
  const value = table[preset as NaiUcPresetName];
  // heavy 在所有已知模型上都是 0；最后的 0 只为满足类型，实际不会触达
  return value ?? table.heavy ?? 0;
}
