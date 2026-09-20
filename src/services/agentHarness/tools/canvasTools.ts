/**
 * 画布类工具。
 * - `view_canvas_image`:把历史坞里的图给视觉模型看,默认叠角色位置覆盖层。
 * - `view_canvas_region`:只看图里的一块。二期工具的第一条(契约见
 *   docs_and_plan/2026-09-06-agent-harness-gap.md §7),先把**归一化框**的口径跑通,
 *   后面 inpaint_region / edit_image 用同一套坐标:框是 0–1、相对这张图本身,
 *   不是相对屏幕上显示的尺寸 —— 这正是画布摆位那条踩过的坑。
 * - `inpaint_region`:按同一个框重绘一块。**付费**,所以它自己一行发送逻辑都不写:
 *   适配器把开口交给桌面画布(components/MainContent),走与手动重绘完全同一条路径。
 */

import { toolError, type AgentTool } from '../toolRegistry';
import { buildOverlaySpec, freePositioningForModel } from './canvasOverlay';
import type { ToolDeps } from './deps';
import type { InpaintRegionQuote, NormalizedBox, StudioParams } from '../workbench';

const DEFAULT_MAX_EDGE = 1024;
/** 写进工作台的参数多久必须能读回来;读不回来就不发(计费路径上宁可不做)。 */
const PARAM_SETTLE_TIMEOUT_MS = 3000;

type BoxRead = { ok: true; box: NormalizedBox } | { ok: false; reason: string };

/** 归一化框的统一读法:三条二期工具共用,口径一处定义。 */
function readNormalizedBox(raw: unknown): BoxRead {
  const src = raw as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | undefined;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const x = num(src?.x); const y = num(src?.y); const w = num(src?.w); const h = num(src?.h);
  if (x === null || y === null || w === null || h === null) {
    return { ok: false, reason: 'box 需要四个数字 {x, y, w, h},都是 0–1 的归一化坐标。' };
  }
  if (w <= 0 || h <= 0) {
    return { ok: false, reason: `框的宽高必须大于 0(收到 w=${w}, h=${h})。` };
  }
  return { ok: true, box: { x, y, w, h } };
}

const BOX_SCHEMA = {
  type: 'object',
  description: '归一化的框(0–1,相对图片本身):x/y 是左上角,w/h 是宽高。',
  properties: {
    x: { type: 'number', description: '左上角 x,0–1' },
    y: { type: 'number', description: '左上角 y,0–1' },
    w: { type: 'number', description: '宽,0–1' },
    h: { type: 'number', description: '高,0–1' },
  },
  required: ['x', 'y', 'w', 'h'],
};

/** 等一个写进工作台的参数真的读得回来(界面是 React 状态,写完不是立刻生效)。 */
async function waitForParam(deps: ToolDeps, done: (params: StudioParams) => boolean): Promise<boolean> {
  const started = Date.now();
  while (!done(deps.adapter.getParams())) {
    if (Date.now() - started > PARAM_SETTLE_TIMEOUT_MS) return false;
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  return true;
}

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
      // 与发给 NAI 的筛选口径一致(novelai.ts:启用且提示词非空);空提示词的槽位模型根本没见过,不该画锚点。
      const enabled = (image.characters ?? []).filter((c) => c.enabled && c.prompt.trim());
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
  const region: AgentTool = {
    name: 'view_canvas_region',
    label: '查看画板局部',
    description: '放大查看已生成图片中的**某一块**,用于核对细节(手部、文字、面部、纹理等)。box 用归一化坐标 {x, y, w, h},取值 0–1,相对图片本身的左上角;例如右下角四分之一是 {x:0.5, y:0.5, w:0.5, h:0.5}。越界会自动贴边。index 与 view_canvas_image 同义(0 = 最新)。不叠角色覆盖层。注意:当前对话模型需要具备图像理解能力。',
    parameters: {
      type: 'object',
      properties: {
        box: BOX_SCHEMA,
        index: { type: 'integer', description: '要看的图片索引(0 = 最新,默认 0)。' },
        full_resolution: { type: 'boolean', description: '是否不压缩返回(默认 false,压到最长边 1024px)。裁出来本来就小,通常不用开。' },
      },
      required: ['box'],
    },
    permissionClass: 'R',
    execute: async (toolCallId, args) => {
      const read = readNormalizedBox(args.box);
      if (!read.ok) return toolError(toolCallId, region.name, `${read.reason}要看整张图请用 view_canvas_image。`);
      const { x, y, w, h } = read.box;
      if (!deps.cropImage) {
        return toolError(toolCallId, region.name, '当前环境不支持裁剪,请改用 view_canvas_image 查看整张图。');
      }
      const images = deps.adapter.images();
      const index = typeof args.index === 'number' && Number.isInteger(args.index) && args.index >= 0 ? args.index : 0;
      const image = images[index];
      if (!image) {
        return toolError(toolCallId, region.name, images.length === 0 ? '画板当前没有已生成的图片历史。' : `图片索引 ${index} 超出范围(共 ${images.length} 张)。`);
      }
      let blob: Blob;
      try {
        blob = await image.blob();
      } catch (error) {
        return toolError(toolCallId, region.name, `读不到这张图片的数据:${error instanceof Error ? error.message : String(error)}`);
      }
      let encoded;
      try {
        encoded = await deps.cropImage(blob, { x, y, w, h }, args.full_resolution === true ? null : DEFAULT_MAX_EDGE);
      } catch (error) {
        return toolError(toolCallId, region.name, `裁剪失败:${error instanceof Error ? error.message : String(error)}`);
      }
      const px = {
        x: Math.round(x * image.width), y: Math.round(y * image.height),
        w: Math.round(w * image.width), h: Math.round(h * image.height),
      };
      const lines = [
        `已裁出图片(索引 ${index},共 ${images.length} 张)的局部:`,
        `• 原图尺寸: ${image.width}x${image.height}`,
        `• 框(归一化): x=${x.toFixed(3)} y=${y.toFixed(3)} w=${w.toFixed(3)} h=${h.toFixed(3)}`,
        `• 框(像素): 左上 (${px.x}, ${px.y}),约 ${px.w}x${px.h}`,
        `• 附件尺寸: ${encoded.width}x${encoded.height}`,
        '图片已作为附件随本条结果返回。框超出图片时会自动贴边,所以附件尺寸可能小于你要的框。',
      ];
      return { toolCallId, toolName: region.name, content: lines.join('\n'), imageBase64: encoded.base64, imageMimeType: encoded.mimeType };
    },
  };

  /** 估价与确认卡共用:先把框换算好、问出实际发送尺寸,问不出就说清楚为什么。 */
  const quoteFor = (args: Record<string, unknown>): InpaintRegionQuote | null => {
    if (!deps.adapter.inpaintQuote) return null;
    const read = readNormalizedBox(args.box);
    if (!read.ok) return { ok: false, reason: read.reason };
    return deps.adapter.inpaintQuote(read.box);
  };

  const inpaint: AgentTool = {
    name: 'inpaint_region',
    label: '局部重绘',
    description: '对画布上**当前这张图**的某一块做局部重绘(官方的焦点重绘):框内除了四周留作上下文的一圈,整块重画,其余部分原样保留。box 用归一化坐标 {x, y, w, h}(0–1,相对图片本身),与 view_canvas_region 同一口径 —— 动手前建议先用 view_canvas_region 把这块放大看清楚。prompt 传了会先写进工作台的正面提示词(用户在左栏看得见)再重绘;不传就沿用工作台现有的提示词。模型、步数、CFG、负面词等一律取工作台当前值,要改先用 update_studio_parameters。这是**付费**操作,按实际发送的分辨率计费(框会先 64 对齐,再放大到约 100 万像素送去重绘),预计消耗非零时会先向用户确认;失败不会自动重试。',
    parameters: {
      type: 'object',
      properties: {
        box: BOX_SCHEMA,
        prompt: { type: 'string', description: '这一块要画成什么。会写进工作台的正面提示词再重绘;不传则沿用当前提示词。' },
        strength: { type: 'number', description: '重绘强度,0–1,默认 0.7。越大越不像原图。' },
        context_padding: { type: 'integer', description: '框内四周保留多少像素的原图当上下文,默认 128。' },
      },
      required: ['box'],
    },
    permissionClass: 'P',
    countsAsGeneration: true,
    // 用户锁了正面提示词就不许借这条工具绕过去(闸在任何模式下都拒)。
    writesFields: (args) => (typeof args.prompt === 'string' && args.prompt.trim() ? ['prompt'] : []),
    estimateCost: async (args) => {
      const quote = quoteFor(args);
      // 估不出来 = 这次根本发不出去,如实报 0;理由写在 note 里,执行时再原样拦一次。
      if (!quote) return { anlas: 0, free: true, note: '当前环境没有接局部重绘' };
      if (!quote.ok) return { anlas: 0, free: true, note: quote.reason };
      return { ...deps.estimateGenerationCost(quote.send), note: `实际发送 ${quote.send.width}x${quote.send.height}` };
    },
    describeChange: async (args) => {
      const quote = quoteFor(args);
      if (!quote) return '当前环境没有接局部重绘。';
      if (!quote.ok) return quote.reason;
      const cost = deps.estimateGenerationCost(quote.send);
      const wanted = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      return `重绘 ${quote.source.width}x${quote.source.height} 上 (${quote.box.x}, ${quote.box.y}) 起 ${quote.box.width}x${quote.box.height} 这一块,实际发送 ${quote.send.width}x${quote.send.height};${cost.free ? '免费' : `约 ${cost.anlas} Anlas`}${wanted ? `;正面提示词改成「${wanted}」` : ''}`;
    },
    execute: async (toolCallId, args) => {
      const { inpaintQuote, inpaintRegion } = deps.adapter;
      if (!inpaintQuote || !inpaintRegion) {
        return toolError(toolCallId, inpaint.name, '当前环境没有接局部重绘(只有桌面画布支持)。');
      }
      const read = readNormalizedBox(args.box);
      if (!read.ok) return toolError(toolCallId, inpaint.name, read.reason);
      const quote = inpaintQuote(read.box);
      if (!quote.ok) return toolError(toolCallId, inpaint.name, quote.reason);

      let strength: number | undefined;
      if (args.strength !== undefined) {
        const value = typeof args.strength === 'number' && Number.isFinite(args.strength) ? args.strength : null;
        if (value === null || value <= 0 || value > 1) {
          return toolError(toolCallId, inpaint.name, `strength 要是 0–1 之间的数(不含 0),收到 ${JSON.stringify(args.strength)}。`);
        }
        strength = value;
      }
      let contextPadding: number | undefined;
      if (args.context_padding !== undefined) {
        const value = typeof args.context_padding === 'number' && Number.isFinite(args.context_padding) ? Math.round(args.context_padding) : null;
        if (value === null || value < 0) {
          return toolError(toolCallId, inpaint.name, `context_padding 要是不小于 0 的整数,收到 ${JSON.stringify(args.context_padding)}。`);
        }
        contextPadding = value;
      }

      // 提示词先落进工作台,**并等它真的读得回来**再发:界面是 React 状态,写完不是立刻生效,
      // 抢在生效之前发出去就等于花钱重绘了上一版提示词。等不到就不发。
      const wanted = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (wanted && deps.adapter.getParams().prompt !== wanted) {
        deps.adapter.applyParams({ prompt: wanted });
        if (!(await waitForParam(deps, (params) => params.prompt === wanted))) {
          return toolError(toolCallId, inpaint.name, '提示词没能写进工作台(界面没跟上),本次未发送,请重试。');
        }
      }

      const outcome = await inpaintRegion(read.box, { strength, contextPadding });
      // 计费端点:失败就停下来说清楚,不自动重发。要不要再花一次由用户定。
      if (!outcome.ok) return toolError(toolCallId, inpaint.name, `局部重绘失败:${outcome.message}`);
      const lines = [
        `局部重绘完成:重绘了 ${quote.source.width}x${quote.source.height} 上 (${quote.box.x}, ${quote.box.y}) 起 ${quote.box.width}x${quote.box.height} 这一块(实际发送 ${quote.send.width}x${quote.send.height})。`,
        `• 结果尺寸: ${outcome.width}x${outcome.height}(重绘结果已贴回原图,所以还是整张图的尺寸)`,
      ];
      if (typeof outcome.seed === 'number') lines.push(`• 随机种子: ${outcome.seed}`);
      lines.push('已放进历史坞(index 0)并显示在画布上。要核对这一块请用 view_canvas_region 传同一个 box。');
      return { toolCallId, toolName: inpaint.name, content: lines.join('\n') };
    },
  };

  return [view, region, inpaint];
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
