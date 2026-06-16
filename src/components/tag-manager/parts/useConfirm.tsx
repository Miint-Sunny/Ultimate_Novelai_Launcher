// 把 ConfirmDialog 包成 Promise hook,调用方式:
//   const { confirm, confirmDialog } = useConfirm();
//   const ok = await confirm({ title: '删除?', message: '...', danger: true });
//   if (!ok) return;
//   ...
//   return <>...{confirmDialog}</>;
import React, { useCallback, useRef, useState } from 'react';
import { ConfirmDialog, type ConfirmOptions } from './ConfirmDialog';

export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((o: ConfirmOptions) =>
    new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setOpts(o);
    }), []);

  const handle = useCallback((ok: boolean) => {
    const r = resolverRef.current;
    resolverRef.current = null;
    setOpts(null);
    r?.(ok);
  }, []);

  const confirmDialog = (
    <ConfirmDialog
      isOpen={!!opts}
      message={opts?.message ?? ''}
      title={opts?.title}
      confirmLabel={opts?.confirmLabel}
      cancelLabel={opts?.cancelLabel}
      danger={opts?.danger}
      onConfirm={() => handle(true)}
      onCancel={() => handle(false)}
    />
  );

  return { confirm, confirmDialog };
}
