// 通用二次确认弹窗 - 替代浏览器原生 window.confirm
// 配合 useConfirm() hook 以 Promise 形式使用:
//   const ok = await confirm({ title: '删除?', message: '...', danger: true });
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** true 时确认按钮显示为红色 (用于删除等破坏性操作) */
  danger?: boolean;
}

interface Props extends ConfirmOptions {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<Props> = ({
  isOpen, onConfirm, onCancel,
  title, message,
  confirmLabel = '确定', cancelLabel = '取消',
  danger = false,
}) => {
  useEffect(() => {
    if (!isOpen) return;
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [isOpen, onConfirm, onCancel]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[140] grid place-items-center bg-black/60 backdrop-blur-md animate-in fade-in duration-150"
      onClick={onCancel}
    >
      <div
        className="bg-nai-panel border border-gray-700 rounded-2xl shadow-2xl w-[min(420px,92vw)] flex flex-col overflow-hidden animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <>
            <header className="px-6 pt-5 pb-4 shrink-0">
              <h2 className="text-[15px] font-bold text-white tracking-wide">{title}</h2>
            </header>
            <div className="h-px bg-white/[0.06] mx-6 shrink-0" />
          </>
        )}
        <div className="px-6 py-5">
          <p className="text-[13.5px] text-gray-200 leading-[1.65] whitespace-pre-line">{message}</p>
        </div>
        <footer className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-white/[0.06] bg-nai-dark/40 shrink-0">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-[13px] font-bold text-gray-300 hover:text-white transition-colors cursor-pointer"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            autoFocus
            className={
              danger
                ? 'px-4 py-2 text-[13px] font-bold bg-red-600/95 text-white border border-red-700 rounded-lg hover:bg-red-500 transition-colors cursor-pointer'
                : 'px-4 py-2 text-[13px] font-bold bg-nai-accent text-[#1a1410] rounded-lg hover:bg-nai-accent-hover transition-colors cursor-pointer'
            }
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
};
