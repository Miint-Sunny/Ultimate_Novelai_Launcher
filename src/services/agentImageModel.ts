import { isV5Model, MODEL_MAP } from '../components/generation/modelResolutionOptions';

/**
 * 发给 agent 的图像模型代际(黑板 #10 定下的契约):
 * `nai_v5_full / nai_v5_curated / nai_v45_full / nai_v45_curated / anima`,空串 = 未知。
 *
 * 服务端按它选 planner 的写法(V5 词组+句子,4.5 纯 tag);未知时保持 V5 旧行为。
 * V4 / V3 这里就报未知——服务端目前只分 V5 与 4.5 两档,硬塞成 4.5 反而是撒谎。
 * 传 UI id(`v4.5-full`)或官方 id 都行,内部按 MODEL_MAP 归一。
 */
export function agentImageModelFor(model: string): string {
  const backendId = MODEL_MAP[model] ?? model;
  if (backendId === 'anima') return 'anima';
  const curated = backendId.includes('curated');
  if (isV5Model(backendId)) return curated ? 'nai_v5_curated' : 'nai_v5_full';
  if (backendId.startsWith('nai-diffusion-4-5-')) return curated ? 'nai_v45_curated' : 'nai_v45_full';
  return '';
}
