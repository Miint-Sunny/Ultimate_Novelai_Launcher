import { useCallback, useMemo, useRef } from 'react';
import { agentService, type AssistantCard } from '../../../services/agentService';
import { useGeneration } from '../../../contexts/GenerationContext';
import { useDragDrop } from '../../../contexts/DragDropContext';
import { useAgentDock } from '../../../contexts/AgentDockContext';
import { extractImageMetadata, type ImageMetadata } from '../../../utils/imageMetadata';

/**
 * 固定触发指令（命令总线）。
 *
 * 裸词优先：输入以指令关键词开头即命中，完全不经过 LLM，零延迟零成本；
 * 未命中的输入照常交给 Plana 两阶段管线。`/` 前缀唤起指令面板（见 AgentDock）。
 *
 * 指令与卡片同走 agentService 日志流：会话归档 / 恢复 / 清空免费获得。
 */

export interface CommandSpec {
  id: string;
  /** 触发词（首个命中的用于显示） */
  keywords: string[];
  /** 指令面板里的一行说明 */
  description: string;
  /** 用法提示（面板 hover / info 卡里用） */
  usage: string;
}

export const COMMAND_SPECS: CommandSpec[] = [
  {
    id: 'inspect',
    keywords: ['kkt', '看看tag'],
    description: '看图断 tag：读取图片的原始提示词与元数据',
    usage: 'kkt（读画布当前图）或 附图后输入 kkt',
  },
  {
    id: 'generate-image',
    keywords: ['生成图片'],
    description: '按左栏当前参数生成；跟提示词则先替换正向再生成',
    usage: '生成图片 [可选：正向提示词]',
  },
  {
    id: 'generate-video',
    keywords: ['生成视频'],
    description: '视频生成（等待 ComfyUI/wan 轨道接入）',
    usage: '生成视频（暂未开放）',
  },
];

/** 输入命中哪条指令？返回 [spec, args] 或 null（大小写不敏感；中文关键词允许不加空格） */
export function matchCommand(input: string): [CommandSpec, string] | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  for (const spec of COMMAND_SPECS) {
    for (const keyword of spec.keywords) {
      const k = keyword.toLowerCase();
      if (lower === k) return [spec, ''];
      if (lower.startsWith(k)) {
        const rest = trimmed.slice(keyword.length);
        // 拉丁词必须以空白分隔（防止 "kktabc" 误触发）；中文词允许直接续参数
        if (/^[a-z0-9]/i.test(keyword) && !/^\s/.test(rest)) continue;
        return [spec, rest.trim()];
      }
    }
  }
  return null;
}

/** 导入动作的运行时图源缓存（大图不进 localStorage；会话恢复后按 imageSource 重取） */
const importSourceCache = new Map<string, { file: File; dataUrl: string }>();
let cacheSeq = 0;

async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return new File([blob], name, { type: blob.type || 'image/png' });
}

export function useAssistantCommands() {
  const { imageUrl } = useGeneration();
  const { setPendingFile } = useDragDrop();
  const { handlersRef } = useAgentDock();
  // imageUrl 随生成变化；命令执行时取当前值
  const imageUrlRef = useRef(imageUrl);
  imageUrlRef.current = imageUrl;

  const pushCard = useCallback((content: string, card: AssistantCard) => {
    agentService.addLog('card', content, { card });
  }, []);

  const runInspect = useCallback(async (attachedImage?: string) => {
    let file: File | null = null;
    let dataUrl = '';
    let source: AssistantCard['imageSource'] = 'canvas';

    try {
      if (attachedImage) {
        source = 'attached';
        dataUrl = attachedImage;
        file = await dataUrlToFile(attachedImage, 'attached.png');
      } else if (imageUrlRef.current) {
        source = 'canvas';
        const response = await fetch(imageUrlRef.current);
        const blob = await response.blob();
        file = new File([blob], 'canvas.png', { type: blob.type || 'image/png' });
        dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
    } catch {
      file = null;
    }

    if (!file) {
      pushCard('看看tag', {
        kind: 'info',
        title: '看看tag',
        body: '没有可读的图片。',
        hint: '附一张图后输入 kkt，或先生成/选中一张历史图片。',
      });
      return;
    }

    let metadata: ImageMetadata | null = null;
    try {
      metadata = await extractImageMetadata(file);
    } catch {
      metadata = null;
    }

    if (!metadata) {
      pushCard('看看tag', {
        kind: 'info',
        title: '看看tag',
        body: '这张图里没有可解析的生成元数据（PNG 文本块 / NAI / SD / ComfyUI / EXIF / LSB 都试过了）。',
        hint: '自定义云模式下可在导入窗口用「AI 反推」猜 tag。',
      });
      return;
    }

    // 卡片只存元数据；原图进运行时缓存供“导入到左栏”用
    const cacheKey = `kkt-${++cacheSeq}`;
    importSourceCache.set(cacheKey, { file, dataUrl });
    pushCard('看看tag', {
      kind: 'metadata',
      title: `看看tag · ${metadata.source}`,
      metadata,
      imageSource: source,
      cacheKey,
    });
  }, [pushCard]);

  const runGenerateImage = useCallback((args: string) => {
    const handlers = handlersRef.current;
    if (!handlers?.triggerGenerate) {
      pushCard('生成图片', {
        kind: 'info',
        title: '生成图片',
        body: '生成入口尚未就绪，请稍后再试。',
      });
      return;
    }
    handlers.triggerGenerate(args || undefined);
    pushCard('生成图片', {
      kind: 'info',
      title: '生成图片',
      body: args ? `已用新提示词提交生成。` : '已按左栏当前参数提交生成。',
      hint: '进度见下方历史条。',
    });
  }, [handlersRef, pushCard]);

  const runGenerateVideo = useCallback(() => {
    pushCard('生成视频', {
      kind: 'info',
      title: '生成视频',
      body: '视频生成还没接入 —— ComfyUI / Wan 轨道就绪后这里会直接可用。',
      hint: '规划见 docs_and_plan/2026-08-16-universal-assistant-plan.md（C2 阶段）。',
    });
  }, [pushCard]);

  /**
   * 尝试把输入按固定指令执行。
   * @returns true = 已作为指令处理（调用方应清空输入），false = 交给 LLM
   */
  const tryRunCommand = useCallback(async (input: string, attachedImage?: string): Promise<boolean> => {
    const matched = matchCommand(input);
    if (!matched) return false;
    const [spec, args] = matched;

    // 指令回显（与用户消息同流）
    agentService.addLog('user', input.trim(), attachedImage ? { imagePreview: attachedImage } : undefined);

    switch (spec.id) {
      case 'inspect':
        await runInspect(attachedImage);
        return true;
      case 'generate-image':
        runGenerateImage(args);
        return true;
      case 'generate-video':
        runGenerateVideo();
        return true;
      default:
        return false;
    }
  }, [runInspect, runGenerateImage, runGenerateVideo]);

  /** “导入到左栏”：优先运行时缓存的原图；缓存失效则按来源重取 */
  const importMetadataFromCard = useCallback(async (card: AssistantCard) => {
    if (!card.metadata) return;
    let cached = card.cacheKey ? importSourceCache.get(card.cacheKey) : undefined;
    if (!cached && card.imageSource === 'canvas' && imageUrlRef.current) {
      try {
        const response = await fetch(imageUrlRef.current);
        const blob = await response.blob();
        const file = new File([blob], 'canvas.png', { type: blob.type || 'image/png' });
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        cached = { file, dataUrl };
      } catch {
        cached = undefined;
      }
    }
    if (!cached) {
      pushCard('看看tag', {
        kind: 'info',
        title: '导入失败',
        body: '原图已不在（会话恢复后运行时图源失效）。',
        hint: '重新附图或选中图片后再跑一次 kkt。',
      });
      return;
    }
    // 走既有 DropZoneModal 导入流（带选择项 / 校验 / 角色与 vibe 支持）
    setPendingFile({
      file: cached.file,
      dataUrl: cached.dataUrl,
      isVibeFile: false,
      presetMetadata: card.metadata,
    });
  }, [pushCard, setPendingFile]);

  const specs = useMemo(() => COMMAND_SPECS, []);

  return { tryRunCommand, importMetadataFromCard, specs };
}
