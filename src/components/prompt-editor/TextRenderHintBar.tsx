// V5 文字渲染提示条 —— 桌面/移动编辑器共用。
// 纯提示,不改写输入;样式对齐芯片编辑器的异常权重告警(琥珀色警示 + ⚠️ 前缀),
// 不引入第二套视觉。
import type { TextRenderHint } from '../../utils/textRenderHints';

export function TextRenderHintBar({ hints }: { hints: TextRenderHint[] }) {
  if (hints.length === 0) return null;
  return (
    <div className="px-2 py-1.5 space-y-0.5 border-t border-white/5" title="V5 文字渲染提示">
      {hints.map((hint, index) => (
        <p key={`${hint.kind}-${index}`} className="text-[11px] leading-tight text-amber-300/90">
          <span className="text-amber-300">⚠️</span> {hint.message}
        </p>
      ))}
    </div>
  );
}
