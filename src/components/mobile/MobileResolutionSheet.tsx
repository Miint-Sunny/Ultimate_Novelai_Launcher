import { X } from 'lucide-react';
import type { MobileResolutionTab } from './generate/useMobileResolutionPicker';

interface ResolutionOption {
  label: string;
  width: number;
  height: number;
}

interface MobileResolutionSheetProps {
  isOpen: boolean;
  onClose: () => void;
  resolutionTab: MobileResolutionTab;
  setResolutionTab: (tab: MobileResolutionTab) => void;
  options: ResolutionOption[];
  width: number;
  height: number;
  setWidth: (width: number) => void;
  setHeight: (height: number) => void;
}

const TABS: Array<{ id: MobileResolutionTab; label: string }> = [
  { id: 'small', label: '小图' },
  { id: 'large', label: '大图' },
  { id: 'wallpaper', label: '壁纸' },
];

export function MobileResolutionSheet({
  isOpen,
  onClose,
  resolutionTab,
  setResolutionTab,
  options,
  width,
  height,
  setWidth,
  setHeight,
}: MobileResolutionSheetProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end animate-fade-in">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="wide-touch-sheet relative w-full bg-nai-panel rounded-t-2xl animate-slide-in-from-bottom safe-area-bottom">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h3 className="text-lg font-bold text-white">选择比例</h3>
          <button onClick={onClose} className="p-2 -mr-2 text-gray-400">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex gap-2 p-4 pb-2">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${resolutionTab === tab.id
                ? 'bg-nai-accent text-black'
                : 'bg-gray-800 text-gray-400'
                }`}
              onClick={() => setResolutionTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-3 p-4">
          {options.map((resolution) => {
            const isSelected = width === resolution.width && height === resolution.height;
            const aspectRatio = resolution.width / resolution.height;
            const previewSize = 40;
            const previewWidth = aspectRatio >= 1 ? previewSize : previewSize * aspectRatio;
            const previewHeight = aspectRatio >= 1 ? previewSize / aspectRatio : previewSize;

            return (
              <button
                key={resolution.label}
                onClick={() => {
                  setWidth(resolution.width);
                  setHeight(resolution.height);
                }}
                className={`flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-all active:scale-95 ${isSelected
                  ? 'bg-nai-accent/20 border-nai-accent'
                  : 'bg-gray-800 border-gray-700'
                  }`}
              >
                <div
                  className={`rounded border-2 ${isSelected ? 'border-nai-accent bg-nai-accent/30' : 'border-gray-500 bg-gray-700'}`}
                  style={{ width: previewWidth, height: previewHeight }}
                />
                <span className={`text-sm font-medium ${isSelected ? 'text-nai-accent' : 'text-gray-300'}`}>
                  {resolution.label}
                </span>
                <span className="text-xs text-gray-500">
                  {resolution.width}×{resolution.height}
                </span>
              </button>
            );
          })}
        </div>

        <div className="p-4 pt-0">
          <button
            onClick={onClose}
            className="w-full py-3 bg-nai-accent text-black font-bold rounded-xl active:scale-[0.98] transition-all"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  );
}
