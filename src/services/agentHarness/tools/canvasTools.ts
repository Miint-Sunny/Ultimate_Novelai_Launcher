/** view_canvas_image:把历史坞里的图给视觉模型看。一期不叠角色覆盖层(回执里注明)。 */

import { toolError, type AgentTool } from '../toolRegistry';
import type { ToolDeps } from './deps';

export function createCanvasTools(deps: ToolDeps): AgentTool[] {
  const view: AgentTool = {
    name: 'view_canvas_image',
    label: '查看画板图片',
    description: '获取已生成的历史图片供视觉检查。通过 index 参数从新到旧指定图片(0 表示最新生成的一张,1 表示倒数第二张,以此类推。默认 0)。返回的图片默认压缩到最长边 1024px 以控制视觉 Token;若因分辨率不足看不清细节(小字、纹理、面部瑕疵等),可传 full_resolution=true 获取未压缩的原始尺寸图片。注意:当前对话模型需要具备图像理解能力。',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '要查看的图片索引(从新到旧排序,0 表示最新生成的一张,1 表示倒数第二张,以此类推。默认 0)。' },
        with_overlay: { type: 'boolean', description: '是否叠加角色位置覆盖层 (默认 true)。false 时返回原图。' },
        full_resolution: { type: 'boolean', description: '是否返回未压缩的原始尺寸图片 (默认 false,压缩到最长边 1024px)。仅在压缩版看不清细节时使用,原图会消耗更多视觉 Token。' },
      },
    },
    permissionClass: 'R',
    execute: async (toolCallId, args) => {
      const images = deps.adapter.images();
      const index = typeof args.index === 'number' && Number.isInteger(args.index) && args.index >= 0 ? args.index : 0;
      const image = images[index];
      if (!image) return toolError(toolCallId, view.name, images.length === 0 ? '历史坞里还没有图片。' : `索引 ${index} 超出范围(共 ${images.length} 张)。`);
      const full = args.full_resolution === true;
      const encoded = await deps.downscaleImage(await image.blob(), full ? null : 1024);
      return {
        toolCallId,
        toolName: view.name,
        content: `历史图片 index=${index}(原始 ${image.width}x${image.height},种子 ${image.seed})${full ? ',原始尺寸' : `,已压缩到 ${encoded.width}x${encoded.height}`}。角色位置覆盖层一期未提供。`,
        imageBase64: encoded.base64,
        imageMimeType: encoded.mimeType,
      };
    },
  };
  return [view];
}
