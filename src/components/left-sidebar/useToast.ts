import { useCallback, useState } from 'react';
import type { ToastType } from './types';

export function useToast() {
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastType, setToastType] = useState<ToastType>('success');

  const showToast = useCallback((message: string, type: ToastType = 'success') => {
    setToastMessage(message);
    setToastType(type);
    setTimeout(() => setToastMessage(null), type === 'warning' ? 4200 : 2500);
  }, []);

  return {
    toastMessage,
    toastType,
    showToast,
  };
}
