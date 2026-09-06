/** view_canvas_image:把历史坞里的图给视觉模型看,默认叠角色位置覆盖层。 */

import { toolError, type AgentTool } from '../toolRegistry';
import { buildOverlaySpec, freePositioningForModel } from './canvasOverlay';
import type { ToolDeps } from './deps';

const DEFAULT_MAX_EDGE = 1024;

export function createCanvasTools(deps: ToolDeps): AgentTool[] {
  const view: AgentTool = {
    name: 'view_canvas_image',
    label: '查看画板图片',
    description: '获取已生成的历史图片供视觉检查。通过 index 参数从新到旧指定图片(0 表示最新生成的一张,1 表示倒数第二张,以此类推。默认 0)。默认返回叠加了角色位置覆盖层的版本(各启用角色的编号锚点与名称标签,V5 附带中心十字参考线,V4/V4.5 附带 5x5 网格),便于核对多角色构图与布局;传入 with_overlay=false 可获取未处理的原图。返回的图片默认压缩到最长边 1024px 以控制视觉 Token;若因分辨率不足看不清细节(小字、纹理、面部瑕疵等),可传 full_resolution=true 获取未压缩的原始尺寸图片。注意:当前对话模型需要具备图像理解能力。',
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
      if (!image) return toolError(toolCallId, view.name, images.length === 0 ? '画板当前没有已生成的图片历史。请先生成图片后再查看。' : `指定的图片索引 ${index} 超出范围。当前共有 ${images.length} 张历史图片,有效索引范围为 0 到 ${images.length - 1}。`);
      const full = args.full_resolution === true;
      const wantOverlay = args.with_overlay !== false;
      const maxEdge = full ? null : DEFAULT_MAX_EDGE;
      const enabled = (image.characters ?? []).filter((c) => c.enabled);
      const free = freePositioningForModel(image.model);

      let blob: Blob;
      try {
        blob = await image.blob();
      } catch (error) {
        return toolError(toolCallId, view.name, `读不到这张图片的数据(历史坞里的文件可能已失效):${error instanceof Error ? error.message : String(error)}`);
      }
      let encoded: { base64: string; mimeType: string; width: number; height: number } | null = null;
      let overlayApplied = false;
      let note: string | null = null;
      if (wantOverlay && enabled.length === 0) note = '该图片生成时没有启用的角色提示词,已返回原图。';
      else if (wantOverlay && !deps.renderOverlay) note = '当前环境不支持覆盖层渲染,已返回原图。';
      else if (wantOverlay) {
        const spec = buildOverlaySpec(enabled, free);
        if (spec) {
          try {
            encoded = await deps.renderOverlay!(blob, spec, maxEdge);
            overlayApplied = true;
          } catch {
            note = '覆盖层渲染失败,已回退返回原图。';
          }
        }
      }
      if (!encoded) {
        try {
          encoded = await deps.downscaleImage(blob, maxEdge);
        } catch (error) {
          return toolError(toolCallId, view.name, `这张图片解码失败(历史坞里的文件可能已失效):${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const position = index === 0 ? '最新生成' : `从新到旧第 ${index + 1} 张`;
      const lines = [
        `已获取历史图片(索引 ${index},${position},共 ${images.length} 张)${overlayApplied ? '(已叠加角色位置覆盖层)' : ''}:`,
        `• 生成时间: ${image.createdAt ? formatTime(image.createdAt) : '未知'}`,
      ];
      if (image.seed >= 0) lines.push(`• 随机种子: ${image.seed}`);
      lines.push(`• 图片尺寸: ${image.width}x${image.height}`);
      lines.push(`• 绘图模型: ${image.model ?? '未知'}`);
      if (enabled.length > 0) lines.push(`• 位置模式: ${(image.useCoords ?? enabled.some((c) => c.center)) ? '自定义定位 (use_coords)' : 'AI 自动布局'}`);
      if (overlayApplied) {
        lines.push(`• 启用角色: ${enabled.length} 个,锚点编号对应启用顺序`);
        lines.push('• 锚点配色: 粉色=女性角色, 蓝色=男性角色, 紫色=其他;标签为角色名或首个标签');
        lines.push(free ? '• V5 自由定位: 叠加了中心十字参考线' : '• V4/V4.5 网格模式: 锚点吸附到 5x5 网格格心');
      }
      if (note) lines.push(`• ${note}`);
      lines.push(full
        ? '• 本次为原始尺寸图片(未压缩)。'
        : `• 本次附件已压缩到 ${encoded.width}x${encoded.height}。若看不清细节(小字、纹理等),请再次调用本工具并传 full_resolution: true 获取原图。`);
      lines.push('图片已作为附件随本条结果返回,请直接查看图片内容进行检查。');
      return { toolCallId, toolName: view.name, content: lines.join('\n'), imageBase64: encoded.base64, imageMimeType: encoded.mimeType };
    },
  };
  return [view];
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
