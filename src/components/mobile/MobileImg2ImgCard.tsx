import { ChevronDown, Edit2, ImagePlus, Plus, X } from 'lucide-react';
import type { useMobileImg2Img } from './generate/useMobileImg2Img';
import type { MobileCardDragHandleProps } from './generate/useMobileCardDragSort';

type MobileImg2ImgState = ReturnType<typeof useMobileImg2Img>;

interface MobileImg2ImgCardProps {
  imageState: MobileImg2ImgState;
  width: number;
  height: number;
  /** 卡头长按拖拽排序手势(P4 注册表);只挂本卡头,不挂输入区 */
  dragHandleProps?: MobileCardDragHandleProps;
}

export function MobileImg2ImgCard({ imageState, width, height, dragHandleProps }: MobileImg2ImgCardProps) {
  const {
    img2imgImage,
    img2imgStrength,
    setImg2imgStrength,
    img2imgNoise,
    setImg2imgNoise,
    isImg2ImgExpanded,
    setIsImg2ImgExpanded,
    savedInpaintRef,
    hasInpaintParams,
    setHasInpaintParams,
    inpaintStrength,
    updateInpaintStrength,
    clearImg2Img,
    setImg2imgWithAutoRes,
  } = imageState;

  const handleStrengthChange = (value: number) => {
    if (hasInpaintParams) {
      updateInpaintStrength(value);
      window.dispatchEvent(new CustomEvent('inpaint-strength-sync', { detail: { strength: value } }));
    } else {
      setImg2imgStrength(value);
    }
  };

  const handleOpenInpaint = () => {
    const base64 = savedInpaintRef.current?.imageBase64 ||
      (img2imgImage?.startsWith('data:') ? img2imgImage.split(',')[1] : null);
    setHasInpaintParams(true);
    window.dispatchEvent(new CustomEvent('open-inpaint-mode', {
      detail: {
        maskBase64: savedInpaintRef.current?.maskBase64 || null,
        imageBase64: base64,
        width,
        height,
      },
    }));
  };

  return (
    <div className="bg-nai-input rounded-xl border border-gray-700/50 overflow-hidden shadow-lg">
      <div
        className="flex items-center justify-between p-3 active:bg-gray-800/50 transition-colors cursor-pointer"
        onClick={() => {
          if (img2imgImage) {
            setIsImg2ImgExpanded(!isImg2ImgExpanded);
          }
        }}
        {...dragHandleProps}
      >
        <div className="flex items-center gap-2">
          {img2imgImage && (
            <ChevronDown
              className={`w-5 h-5 text-gray-400 transition-transform ${isImg2ImgExpanded ? '' : '-rotate-90'}`}
            />
          )}
          <ImagePlus className="w-5 h-5 text-orange-400" />
          <span className="text-sm font-bold text-gray-200">图生图</span>
          {hasInpaintParams && (
            <span className="text-xs text-blue-400 bg-blue-500/20 px-1.5 py-0.5 rounded">重绘</span>
          )}
          {img2imgImage && (
            <span className="text-xs text-orange-400 bg-orange-500/20 px-1.5 py-0.5 rounded">1</span>
          )}
        </div>
        <label
          onClick={(event) => event.stopPropagation()}
          className="px-3 py-2 bg-orange-500/20 text-orange-400 text-sm font-medium rounded-lg active:scale-95 transition-all flex items-center gap-1.5 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          {img2imgImage ? '更换' : '添加'}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onloadend = () => {
                setImg2imgWithAutoRes(reader.result as string);
              };
              reader.readAsDataURL(file);
              event.target.value = '';
            }}
          />
        </label>
      </div>

      {img2imgImage && isImg2ImgExpanded && (
        <div className="border-t border-gray-700/30 p-3">
          <div className="flex items-start gap-3">
            <img src={img2imgImage} alt="Img2Img" className="w-12 h-12 rounded-lg object-cover flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 w-6">强度</span>
                <input
                  type="range"
                  min="0.01"
                  max="0.99"
                  step="0.01"
                  value={hasInpaintParams ? inpaintStrength : img2imgStrength}
                  onChange={(event) => handleStrengthChange(parseFloat(event.target.value))}
                  className="flex-1 h-1 accent-orange-500"
                />
                <span className="text-xs text-gray-400 w-8 text-right">
                  {(hasInpaintParams ? inpaintStrength : img2imgStrength).toFixed(2)}
                </span>
              </div>

              {!hasInpaintParams && (
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-xs text-gray-500 w-6">噪声</span>
                  <input
                    type="range"
                    min="0"
                    max="0.99"
                    step="0.01"
                    value={img2imgNoise}
                    onChange={(event) => setImg2imgNoise(parseFloat(event.target.value))}
                    className="flex-1 h-1 accent-yellow-500"
                  />
                  <span className="text-xs text-gray-400 w-8 text-right">{img2imgNoise.toFixed(2)}</span>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1 flex-shrink-0">
              <button
                onClick={handleOpenInpaint}
                className="w-8 h-8 rounded-lg flex items-center justify-center bg-gray-700/50 text-gray-400 active:scale-95 transition-all"
                title="重绘"
              >
                <Edit2 className="w-4 h-4" />
              </button>
              <button
                onClick={clearImg2Img}
                className="w-8 h-8 rounded-lg flex items-center justify-center bg-gray-700/50 text-gray-500 hover:text-red-400 active:scale-95 transition-all"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
