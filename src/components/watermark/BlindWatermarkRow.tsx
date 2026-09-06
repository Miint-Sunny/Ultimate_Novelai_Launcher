import React, { useEffect, useState } from 'react';
import { Fingerprint, Loader2 } from 'lucide-react';
import { extractBlindWatermarkFromUrl } from '../../services/watermark/browser.ts';

/** 元数据弹窗里的「提取盲水印」:未提取 / 提取中 / 无 / 文本三态。 */
export function BlindWatermarkRow({ url }: { url: string }) {
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'loading' } | { kind: 'none' } | { kind: 'text'; text: string } | { kind: 'error'; message: string }>({ kind: 'idle' });

  useEffect(() => { setState({ kind: 'idle' }); }, [url]);

  const extract = async () => {
    if (!url) return;
    setState({ kind: 'loading' });
    try {
      const text = await extractBlindWatermarkFromUrl(url);
      setState(text ? { kind: 'text', text } : { kind: 'none' });
    } catch (error) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="mt-2 flex items-start gap-2 text-xs">
      <button
        onClick={extract}
        disabled={!url || state.kind === 'loading'}
        className="shrink-0 flex items-center gap-1 px-2 py-1 rounded border border-gray-700 bg-gray-800/60 text-gray-300 hover:text-white hover:border-gray-500 disabled:opacity-50 transition-colors"
        title="从图片像素里提取 DCT 盲水印(与 Novelai-harness 互通)"
      >
        {state.kind === 'loading' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Fingerprint className="w-3 h-3" />}
        提取盲水印
      </button>
      <div className="min-w-0 flex-1 pt-1 text-gray-400">
        {state.kind === 'idle' && <span className="text-gray-500">未提取</span>}
        {state.kind === 'loading' && <span>提取中…</span>}
        {state.kind === 'none' && <span>没有检测到盲水印</span>}
        {state.kind === 'error' && <span className="text-red-400">提取失败:{state.message}</span>}
        {state.kind === 'text' && (
          <code className="block break-all select-all font-mono text-[11px] text-emerald-300 bg-black/30 rounded px-1.5 py-1">{state.text}</code>
        )}
      </div>
    </div>
  );
}
