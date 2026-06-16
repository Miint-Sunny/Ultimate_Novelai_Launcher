import { AlertTriangle, Check, X } from 'lucide-react';
import type React from 'react';
import type { ToastType } from './types';

interface ToastBannerProps {
  message: string;
  type: ToastType;
}

export const ToastBanner: React.FC<ToastBannerProps> = ({ message, type }) => (
  <div className={`fixed top-6 left-1/2 -translate-x-1/2 z-[300] px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 animate-in slide-in-from-top-2 duration-200 ${type === 'success' ? 'bg-green-600 text-white' : type === 'warning' ? 'bg-nai-accent text-black' : 'bg-red-600 text-white'}`}>
    {type === 'success' ? <Check className="w-4 h-4" /> : type === 'warning' ? <AlertTriangle className="w-4 h-4" /> : <X className="w-4 h-4" />}
    <span className="text-sm font-medium">{message}</span>
  </div>
);
