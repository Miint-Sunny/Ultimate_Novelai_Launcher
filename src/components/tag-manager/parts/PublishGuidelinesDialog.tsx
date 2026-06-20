// 公共发布规范二次确认弹窗 - OC / 画师串 共用
// 通过 Promise resolver 模式跟 panel 层异步交互:
//   const ok = await askPublishConfirm(payload);  // 触发渲染 → 用户点击 → resolve
//   if (!ok) return false;  // 用户取消,modal 不关 + 字段保留
import React from 'react';
import { createPortal } from 'react-dom';
import { Check, Info, X } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** 弹窗标题 - 比如「发布到公共角色库」 */
  title: string;
  /** 副标题 (灰色小字)，说明文案 */
  subtitle?: string;
  /** 规范条目 - 每条独立一行,前面带勾选样式;支持 \n 段内换行 */
  bullets: string[];
  /** 待发布条目的显示名 - 拼到 footer 显示 */
  itemName: string;
  /** 确认按钮文案,默认"我已确认,发布" */
  confirmLabel?: string;
}

export const PublishGuidelinesDialog: React.FC<Props> = ({
  isOpen, onConfirm, onCancel, title, subtitle, bullets, itemName, confirmLabel = '我已确认,发布',
}) => {
  if (!isOpen) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[130] grid place-items-center bg-black/60 backdrop-blur-md animate-in fade-in duration-200"
      onClick={onCancel}
    >
      <div
        className="bg-nai-panel border border-gray-700 rounded-2xl shadow-2xl w-[min(540px,92vw)] max-h-[88vh] overflow-hidden flex flex-col animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="relative flex items-start gap-4 px-6 pt-6 pb-5 shrink-0">
          <span className="inline-flex w-11 h-11 rounded-xl bg-nai-accent/15 text-nai-accent items-center justify-center shrink-0 ring-1 ring-nai-accent/30">
            <Info className="w-[22px] h-[22px]" strokeWidth={2} />
          </span>
          <div className="flex flex-col leading-tight flex-1 min-w-0 pt-0.5">
            <h2 className="text-[17px] font-bold text-white tracking-wide">{title}</h2>
            {subtitle && (
              <p className="text-[12.5px] text-nai-text-dim mt-1.5">{subtitle}</p>
            )}
          </div>
          <button
            onClick={onCancel}
            title="取消 (Esc)"
            className="w-8 h-8 grid place-items-center rounded-lg text-nai-text-dim hover:bg-white/[0.06] hover:text-white transition-colors cursor-pointer shrink-0 -mr-1 -mt-1"
          >
            <X className="w-[18px] h-[18px]" />
          </button>
        </header>

        {/* Divider (内缩,跟 header padding 对齐) */}
        <div className="h-px bg-white/[0.06] mx-6 shrink-0" />

        {/* Body - 规范条目 */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 custom-scrollbar">
          <ul className="flex flex-col gap-3.5">
            {bullets.map((line, i) => (
              <li key={i} className="flex items-start gap-3 text-[13.5px] text-gray-200 leading-[1.65]">
                <span className="inline-flex w-5 h-5 rounded-full bg-nai-accent/15 items-center justify-center shrink-0 mt-[2px] ring-1 ring-nai-accent/30">
                  <Check className="w-3 h-3 text-nai-accent" strokeWidth={3} />
                </span>
                <span className="flex-1 whitespace-pre-line">{line}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Footer */}
        <footer className="flex items-center gap-3 px-6 py-4 border-t border-white/[0.06] bg-nai-dark/40 shrink-0">
          <div className="flex-1 min-w-0">
            <div className="text-[10.5px] text-nai-text-dim uppercase tracking-[0.08em] font-bold">即将发布</div>
            <div className="text-[13.5px] font-bold text-white truncate mt-0.5">{itemName || '—'}</div>
          </div>
          <button
            onClick={onCancel}
            className="px-4 py-2.5 text-[13.5px] font-bold text-gray-300 hover:text-white transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="px-5 py-2.5 text-[13.5px] font-bold bg-nai-accent text-[#1a1410] rounded-lg hover:bg-nai-accent-hover flex items-center gap-2 shadow-[0_4px_14px_-4px_rgba(252,237,164,0.45)] transition-colors cursor-pointer"
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
};
