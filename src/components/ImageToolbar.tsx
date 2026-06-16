import { Paintbrush, Maximize2, Sparkles } from 'lucide-react';

interface ImageToolbarProps {
  hasImage: boolean;
  imageUrl?: string;
  onInpaint: () => void;
  onSuperResolution: () => void;
}

export const ImageToolbar: React.FC<ImageToolbarProps> = ({
  hasImage,
  imageUrl,
  onInpaint,
  onSuperResolution,
}) => {
  const buttonClass = (enabled: boolean) =>
    `group flex items-center gap-3 px-5 py-2.5 rounded-lg text-sm transition-all ${enabled
      ? 'text-gray-300 hover:text-white hover:bg-white/10'
      : 'text-gray-600 cursor-not-allowed'
    }`;

  const iconClass = (enabled: boolean) =>
    `w-4 h-4 transition-transform ${enabled ? 'group-hover:scale-110' : ''}`;

  const openImageStudio = () => {
    if (!hasImage) return;
    window.dispatchEvent(new CustomEvent('open-image-gen-page', { detail: { imageUrl } }));
  };

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20">
      <div className="bg-gray-900/70 backdrop-blur-xl rounded-xl flex items-center p-1.5 shadow-xl border border-white/5">
        <button
          className={buttonClass(hasImage)}
          onClick={onInpaint}
          disabled={!hasImage}
          title="重绘"
        >
          <Paintbrush className={iconClass(hasImage)} />
          <span className="whitespace-nowrap">重绘</span>
        </button>

        <div className="w-px h-6 bg-white/10 mx-1" />

        <button
          className={buttonClass(hasImage)}
          onClick={onSuperResolution}
          disabled={!hasImage}
          title="放大"
        >
          <Maximize2 className={iconClass(hasImage)} />
          <span className="whitespace-nowrap">放大</span>
        </button>

        <div className="w-px h-6 bg-white/10 mx-1" />

        <button
          className={buttonClass(hasImage)}
          onClick={openImageStudio}
          disabled={!hasImage}
          title="图像编辑"
        >
          <Sparkles className={iconClass(hasImage)} />
          <span className="whitespace-nowrap">编辑</span>
        </button>
      </div>
    </div>
  );
};
