/** novelai_generate / novelai_upscale / novelai_account_info。P 类的估价给闸看。 */

import { toolError, type AgentTool } from '../toolRegistry';
import { blobToBase64, type ToolDeps } from './deps';

export function createNovelaiTools(deps: ToolDeps): AgentTool[] {
  const generate: AgentTool = {
    name: 'novelai_generate',
    label: '图像生成',
    description: '以工作台当前的参数配置(提示词、尺寸、步数、CFG、模型等)直接触发 NovelAI 官方绘图。在调用此工具前,如需构思或调整生图提示词与尺寸,必须先通过 update_studio_parameters 工具修改工作台参数。若预计消耗非零(超出 Opus 免费区间、非 Opus 订阅或 V5 体力透支),将自动向用户发出点数消耗申请。',
    parameters: { type: 'object', properties: {} },
    permissionClass: 'P',
    countsAsGeneration: true,
    estimateCost: async () => deps.estimateGenerationCost(),
    describeChange: async () => {
      const p = deps.adapter.getParams();
      const cost = deps.estimateGenerationCost();
      return `按当前参数出图:${p.model} ${p.width}x${p.height} ${p.steps} 步;${cost.free ? '免费' : `约 ${cost.anlas} Anlas`}${cost.note ? `(${cost.note})` : ''}`;
    },
    execute: async (toolCallId) => {
      const outcome = await deps.adapter.generate();
      if (!outcome.ok) return toolError(toolCallId, generate.name, `生成失败:${outcome.message}`);
      return { toolCallId, toolName: generate.name, content: `生成完成:${outcome.width}x${outcome.height},种子 ${outcome.seed}。可用 view_canvas_image 查看结果。` };
    },
  };

  const upscale: AgentTool = {
    name: 'novelai_upscale',
    label: 'NovelAI 图像超分放大',
    description: '调用 NovelAI 官方超分算法 (V5 换代新模型,固定 2× 输出) 将指定图片无损放大。按输入面积分档计费(1–4 Anlas),预计消耗非零时会先向用户确认。',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '要放大的历史图片索引(从新到旧,0 = 最新;默认 0)' },
      },
    },
    permissionClass: 'P',
    estimateCost: async (args) => {
      const image = pickImage(deps, args);
      if (!image) return { anlas: 0, free: true, note: '没有可放大的图片' };
      const quote = deps.upscaleQuote(image.width, image.height);
      if (quote.cost === null) return { anlas: 0, free: true, note: '源图超过上限,不可用' };
      return { anlas: quote.cost, free: false, note: `${image.width}x${image.height} → ${quote.target.width}x${quote.target.height}` };
    },
    describeChange: async (args) => {
      const image = pickImage(deps, args);
      if (!image) return '没有可放大的图片';
      const quote = deps.upscaleQuote(image.width, image.height);
      return quote.cost === null ? `源图 ${image.width}x${image.height} 超过上限` : `放大 ${image.width}x${image.height} → ${quote.target.width}x${quote.target.height},消耗 ${quote.cost} Anlas`;
    },
    execute: async (toolCallId, args) => {
      const image = pickImage(deps, args);
      if (!image) return toolError(toolCallId, upscale.name, '历史坞里没有可放大的图片。');
      const quote = deps.upscaleQuote(image.width, image.height);
      if (quote.cost === null) return toolError(toolCallId, upscale.name, `源图 ${image.width}x${image.height} 超过 V5 超分的源图上限,请先缩小。`);
      const blob = await image.blob();
      const result = await deps.upscaleV5(await blobToBase64(blob));
      const bytes = Uint8Array.from(atob(result.image), (c) => c.charCodeAt(0));
      deps.adapter.addUpscaledImage(new Blob([bytes], { type: 'image/png' }), result.width, result.height, image.seed);
      return { toolCallId, toolName: upscale.name, content: `放大完成:${result.width}x${result.height},已放入历史坞(index 0)。` };
    },
  };

  const account: AgentTool = {
    name: 'novelai_account_info',
    label: 'NovelAI 账号与体力查询',
    description: '查询当前 NovelAI 账号的订阅等级、Anlas 点数余额以及 V5 专属体力池余量。',
    parameters: { type: 'object', properties: {} },
    permissionClass: 'R',
    execute: async (toolCallId) => {
      const info = await deps.adapter.anlas();
      if (!info) return toolError(toolCallId, account.name, '未配置 NovelAI Token 或查询失败。');
      const total = info.fixedTrainingStepsLeft + info.purchasedTrainingSteps;
      const lines = [
        `订阅:${info.isOpus ? 'Opus' : '非 Opus'}`,
        `Anlas 余额:${total}(固定 ${info.fixedTrainingStepsLeft} + 购买 ${info.purchasedTrainingSteps})`,
      ];
      if (info.opusUsage) lines.push(`V5 体力条:${info.opusUsage.percent}%${info.opusUsage.percent <= 0 ? '(已耗尽,V5 生成会扣 Anlas)' : ''}`);
      return { toolCallId, toolName: account.name, content: lines.join('\n') };
    },
  };

  return [generate, upscale, account];
}

function pickImage(deps: ToolDeps, args: Record<string, unknown>) {
  const images = deps.adapter.images();
  const index = typeof args.index === 'number' && Number.isInteger(args.index) && args.index >= 0 ? args.index : 0;
  return images[index] ?? null;
}
