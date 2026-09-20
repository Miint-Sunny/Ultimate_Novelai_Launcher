/**
 * 导演工具的紧凑条:嵌在画布底部,提交后自己关掉 —— 和「图像编辑」那条同一个形态
 * (方案 `docs_and_plan/2026-09-21-shell-rearrange-and-director-tools.md` §5.4)。
 * 它不需要在画布上画东西,所以不做覆盖层。
 *
 * 价钱直接显示算出来的数字,不写「约」:三次真链路实测钉住了公式,见 services/directorTools.ts。
 * 要花钱的那几种走**两段确认**(按钮先变成「确认 N Anlas」),这和左栏「清空所有角色」
 * 是同一套交互,不另开弹窗。免费的那几种不拦。
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Wand2, X } from 'lucide-react';
import { sidecarV1Api } from '../../api/localSidecarApi';
import { getCachedIsOpus } from '../../services/novelai';
import {
  DIRECTOR_TOOLS,
  clampDefry,
  describeDirectorCost,
  directorCost,
  directorInputProblem,
  directorTool,
  type DirectorToolId,
} from '../../services/directorTools';

interface DirectorBarProps {
  isOpen: boolean;
  onClose: () => void;
  imageUrl?: string;
  width: number;
  height: number;
  seed: number;
  onResult: (url: string, width: number, height: number, seed: number) => void;
}

const PROBLEM_TEXT: Record<string, string> = {
  'no-image': '先出一张图',
  'too-large': '图太大了,官方上限 1536×2048',
  'missing-prompt': '这个工具要写一句要求',
};

/** 画布上的图(可能是 blob: / data:)转成官方要的 base64 PNG。 */
async function toPngBase64(url: string): Promise<string> {
  const blob = await fetch(url).then((r) => r.blob());
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器没给出画布上下文');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const dataUrl = canvas.toDataURL('image/png');
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

export function DirectorBar({ isOpen, onClose, imageUrl, width, height, seed, onResult }: DirectorBarProps) {
  const [tool, setTool] = useState<DirectorToolId>('lineart');
  const [prompt, setPrompt] = useState('');
  const [defry, setDefry] = useState(0);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spec = directorTool(tool);
  const isOpus = getCachedIsOpus();
  const cost = useMemo(() => directorCost(tool, width, height, isOpus), [tool, width, height, isOpus]);
  const problem = directorInputProblem(tool, imageUrl ? { width, height } : null, prompt);

  // 换工具、换图、关掉都要解除「已举起」的确认态,免得上一次的确认落到这一次头上。
  useEffect(() => { setArmed(false); setError(null); }, [tool, imageUrl, isOpen]);

  if (!isOpen) return null;

  const run = async () => {
    if (problem || busy || !imageUrl) return;
    if (cost.confirm && !armed) { setArmed(true); return; }
    setBusy(true);
    setError(null);
    try {
      const image = await toPngBase64(imageUrl);
      const result = await sidecarV1Api.directorAugment({
        image,
        req_type: tool,
        prompt: spec?.needsPrompt ? prompt.trim() : '',
        defry: spec?.needsDefry ? clampDefry(defry) : 0,
      });
      const url = URL.createObjectURL(
        new Blob([Uint8Array.from(atob(result.image), (c) => c.charCodeAt(0))], { type: 'image/png' }),
      );
      // 尺寸以服务端返回的为准(契约里就这么写的),不拿源图的顶。
      onResult(url, result.width, result.height, seed);
      onClose();
    } catch (e) {
      // 计费端点:失败就停下来说清楚,**不自动重发**。要不要再花一次由用户点。
      setError(e instanceof Error ? e.message : '导演工具失败');
      setArmed(false);
    } finally {
      setBusy(false);
    }
  };

  const disabled = !!problem || busy;
  const label = busy ? '处理中' : armed ? `确认 ${describeDirectorCost(cost)}` : '执行';

  return (
    <div
      className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 w-[min(680px,calc(100%-24px))]"
      data-testid="director-bar"
    >
      <div className="bg-gray-900/85 backdrop-blur-xl rounded-xl border border-white/10 shadow-xl p-2.5 space-y-2">
        <div className="flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-nai-accent shrink-0" />
          <div className="flex items-center gap-1 flex-wrap flex-1 min-w-0">
            {DIRECTOR_TOOLS.map((item) => (
              <button
                key={item.id}
                type="button"
                data-director-tool={item.id}
                aria-selected={item.id === tool}
                onClick={() => setTool(item.id)}
                title={item.hint}
                className={`h-7 px-2.5 rounded-full text-[12px] font-bold transition-colors ${
                  item.id === tool ? 'bg-nai-accent text-black' : 'text-gray-400 hover:text-white bg-black/30'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button type="button" onClick={onClose} title="关闭" className="text-gray-500 hover:text-white shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        {spec?.needsPrompt && (
          <div className="flex items-center gap-2">
            <input
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); setArmed(false); }}
              placeholder={tool === 'colorize' ? '想要的颜色 / 风格' : '想要的情绪'}
              className="flex-1 min-w-0 h-8 px-2 rounded-md bg-black/40 border border-gray-700 text-[13px] text-white placeholder:text-gray-600"
            />
            <label className="flex items-center gap-1 text-[11px] text-gray-400 shrink-0" title="defry:官方的「去油」强度,0–5">
              defry
              <input
                type="number"
                min={0}
                max={5}
                value={defry}
                onChange={(e) => { setDefry(clampDefry(Number(e.target.value))); setArmed(false); }}
                className="w-12 h-8 px-1 rounded-md bg-black/40 border border-gray-700 text-[13px] text-white text-center"
              />
            </label>
          </div>
        )}

        <div className="flex items-center gap-2">
          <span className="text-[12px] text-gray-400 flex-1 min-w-0 truncate" data-testid="director-cost">
            {problem ? PROBLEM_TEXT[problem] : `${width}×${height} · ${describeDirectorCost(cost)}`}
          </span>
          {error && <span className="text-[11px] text-red-400 truncate max-w-[45%]" title={error}>{error}</span>}
          <button
            type="button"
            data-testid="director-run"
            disabled={disabled}
            onClick={run}
            className={`h-8 px-4 rounded-md text-[13px] font-bold flex items-center gap-1.5 transition-colors ${
              disabled
                ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
                : armed
                  ? 'bg-red-500/90 text-white hover:bg-red-500'
                  : 'bg-nai-accent text-black hover:brightness-110'
            }`}
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {label}
          </button>
        </div>
      </div>
    </div>
  );
}
