import type { ChangeEvent, HTMLAttributes, RefObject } from 'react';
import { Edit2, Image as ImageIcon, Trash2, Upload } from 'lucide-react';
import { HelpTip } from './HelpTip';

interface Image2ImageSectionProps {
  sectionRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  dropZoneHandlers: HTMLAttributes<HTMLDivElement>;
  img2imgFlash: boolean;
  img2imgDropActive: boolean;
  img2imgImage: string | null;
  hasInpaintParams: boolean;
  isInpaintPanelOpen: boolean;
  strength: number;
  noise: number;
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onOpenInpaint: () => void;
  onClear: () => void;
  onStrengthChange: (value: number) => void;
  onNoiseChange: (value: number) => void;
}

export function Image2ImageSection({
  sectionRef,
  inputRef,
  dropZoneHandlers,
  img2imgFlash,
  img2imgDropActive,
  img2imgImage,
  hasInpaintParams,
  isInpaintPanelOpen,
  strength,
  noise,
  onUpload,
  onOpenInpaint,
  onClear,
  onStrengthChange,
  onNoiseChange,
}: Image2ImageSectionProps) {
  return (
    <div
      ref={sectionRef}
      id="drop-zone-img2img"
      className={`bg-nai-input/50 rounded p-2.5 border transition-all relative ${img2imgFlash ? 'animate-img2img-flash' : ''} ${img2imgDropActive
        ? 'border-nai-accent bg-nai-accent/20 ring-2 ring-nai-accent/50 scale-[1.02]'
        : 'border-gray-800/50'
      }`}
      {...dropZoneHandlers}
    >
      {img2imgDropActive && (
        <div className="absolute inset-0 flex items-center justify-center bg-nai-accent/10 rounded pointer-events-none z-10">
          <div className="text-nai-accent text-xs font-medium px-2 py-1 bg-nai-accent/20 rounded">
            松开以添加图片
          </div>
        </div>
      )}
      <input
        type="file"
        ref={inputRef}
        className="hidden"
        onChange={onUpload}
        accept="image/*"
      />

      {!img2imgImage ? (
        <div className={`flex items-center justify-between ${img2imgDropActive ? 'pointer-events-none' : ''}`}>
          <div className="flex items-center gap-2.5">
            <div className={`w-8 h-8 flex items-center justify-center transition-colors ${img2imgDropActive ? 'text-nai-accent' : 'text-gray-300'}`}>
              <ImageIcon className="w-5 h-5" />
            </div>
            <div>
              <div className="text-sm font-bold text-white">Image2Image</div>
              <div className="text-xs text-gray-400">
                图生图，添加基础图像
              </div>
            </div>
          </div>
          <button
            className="p-1.5 hover:bg-gray-700 rounded border border-gray-600"
            onClick={() => inputRef.current?.click()}
            title="Import Image"
          >
            <Upload className="w-3.5 h-3.5 text-gray-300" />
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2">
              <div>
                <div className="text-sm font-bold text-white flex items-center gap-2">
                  Image2Image
                  {hasInpaintParams && (
                    <span className="text-xs text-blue-400 bg-blue-500/20 px-1.5 py-0.5 rounded">重绘</span>
                  )}
                </div>
                <div className="text-xs text-gray-400">调整你的图像参数</div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {!isInpaintPanelOpen && (
                <button
                  className="p-1.5 bg-nai-dark/50 hover:bg-gray-600/50 text-gray-400 hover:text-gray-200 rounded border border-gray-700 hover:border-gray-500 transition-colors"
                  onClick={onOpenInpaint}
                  title="重绘"
                >
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                className="p-1.5 bg-nai-dark/50 hover:bg-red-500/20 text-gray-400 hover:text-red-400 rounded border border-gray-700 hover:border-red-500/50 transition-colors"
                onClick={onClear}
                title="Remove Image"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="relative group">
            <div className="w-full h-32 rounded-lg overflow-hidden border border-gray-700 relative select-none">
              <img src={img2imgImage} alt="Img2Img Base" className="w-full h-full object-cover opacity-50" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
            </div>

            <div className="absolute inset-0 p-3 flex flex-col justify-end gap-3">
              <div>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-bold text-white drop-shadow-md flex items-center">
                    Strength: {strength}
                    <HelpTip bright title="图生图强度 (Strength)" body={"控制原图对最终画面的影响程度。\n· 值越低 → 越接近原图，改动越少\n· 值越高 → 越自由发挥，重绘越多\n💡 0.01 时几乎不重绘；与 Noise 同时调到最低 → 完美复制原图\n💡 AI 过度忽略提示词时，可尝试提高 Prompt Guidance"} />
                  </span>
                </div>
                <input
                  type="range"
                  min="0.01"
                  max="0.99"
                  step="0.01"
                  value={strength}
                  onChange={(event) => onStrengthChange(Number(event.target.value))}
                  className="w-full h-1.5 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-nai-accent hover:accent-[#ebd576]"
                />
              </div>

              {!hasInpaintParams && (
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-bold text-white drop-shadow-md flex items-center">
                      Noise: {noise}
                      <HelpTip bright title="噪声 (Noise)" body={"在原图基础上额外注入随机扰动。\n· 0 → 完全基于原图，结果更稳定\n· 值越高 → 增加创作自由度，更多新元素\n💡 原图大面积空白时，调高可让 AI 主动补充细节\n💡 高 Noise 反复重生成可能产生视觉瑕疵"} />
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="0.99"
                    step="0.01"
                    value={noise}
                    onChange={(event) => onNoiseChange(Number(event.target.value))}
                    className="w-full h-1.5 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-nai-accent hover:accent-[#ebd576]"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
