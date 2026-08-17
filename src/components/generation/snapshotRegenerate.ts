// 图库「重生成」快照复跑:用入库快照(HistoryItem.metadata,即上次投递时经
// stripInvisibleModuleData 剥离后的实际参数)构建新载荷,换种子复跑——seed 留空,
// 由生成链路摇新值(sidecar 规范路径会回显实际 seed)。不读也不写编辑器工作区状态。
// 无元数据的老图(导入图等)返回 null,由调用方回退到按编辑器现状重跑。
// 注意:ucPreset 此处直接透传入库的字符串 key,与正常生成链路同一通道
// (字符串→按模型枚举值的映射在 services/novelai 发送层,勿在此重复映射)。

import type { HistoryItem } from '../../contexts/GenerationContext';
import type { GenerateImageParams } from '../../services/novelai';
import { buildCharacterPromptParams } from './generationPrompts.ts';
import { clampToMaxPixels } from './modelResolutionOptions.ts';

export function buildSnapshotRegenerateParams(item: HistoryItem): GenerateImageParams | null {
  const metadata = item.metadata;
  if (!metadata) return null;

  // 防御性 clamp:入库尺寸理应已合规,但快照可能来自像素上限调整前的版本
  const size = clampToMaxPixels(item.width, item.height);

  return {
    positivePrompt: metadata.positivePrompt,
    negativePrompt: metadata.negativePrompt,
    model: metadata.model,
    width: size.width,
    height: size.height,
    steps: metadata.steps,
    scale: metadata.scale,
    seed: undefined,
    sampler: metadata.sampler,
    cfgRescale: metadata.cfgRescale,
    noiseSchedule: metadata.noiseSchedule,
    ucPreset: metadata.ucPreset,
    qualityToggle: metadata.qualityToggle,
    varietyPlus: metadata.varietyPlus,
    // 与编辑器路径同一谓词:滤掉禁用角色与 ~隐藏标签
    characterPrompts: buildCharacterPromptParams(metadata.characterPrompts ?? []),
    resolutionSource: `图库快照复跑(原图 ${item.width}×${item.height},seed ${item.seed})`,
  };
}
