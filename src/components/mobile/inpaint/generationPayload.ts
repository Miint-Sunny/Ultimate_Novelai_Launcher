import { alignSendRect, calculateCropRect, type CropRect } from '../../../utils/maskCrop';
import type { ExpandPadding } from './expandPayload';
import { getMaskBase64FromCanvas } from './maskUtils';

export interface InpaintGenerationDimensionsParams {
  isExpandMode: boolean;
  hasExpand: boolean;
  expandPadding: ExpandPadding;
  isCropMode: boolean;
  cropPreview: CropRect | null;
  imageWidth: number;
  imageHeight: number;
}

export interface MaskGenerationPayload {
  maskBase64: string;
  cropRect?: CropRect;
  genRect: CropRect | null;
}

export function calculateInpaintGenerationDimensions({
  isExpandMode,
  hasExpand,
  expandPadding,
  isCropMode,
  cropPreview,
  imageWidth,
  imageHeight,
}: InpaintGenerationDimensionsParams) {
  if (isExpandMode && hasExpand) {
    return {
      width: imageWidth + expandPadding.left + expandPadding.right,
      height: imageHeight + expandPadding.top + expandPadding.bottom,
    };
  }

  if (isCropMode && cropPreview) {
    const aligned = alignSendRect(cropPreview, imageWidth, imageHeight);
    return { width: aligned.width, height: aligned.height };
  }

  return { width: imageWidth, height: imageHeight };
}

export function buildMaskGenerationPayload(
  maskCanvas: HTMLCanvasElement | null,
  imageWidth: number,
  imageHeight: number,
  isCropMode: boolean,
): MaskGenerationPayload {
  const maskBase64 = getMaskBase64FromCanvas(maskCanvas, imageWidth, imageHeight);

  let cropRect: CropRect | undefined;
  if (isCropMode && maskCanvas) {
    const maskCtx = maskCanvas.getContext('2d');
    if (maskCtx) {
      const maskData = maskCtx.getImageData(0, 0, imageWidth, imageHeight);
      const rect = calculateCropRect(maskData, imageWidth, imageHeight);
      if (rect) cropRect = rect;
    }
  }

  return {
    maskBase64,
    cropRect,
    genRect: cropRect || null,
  };
}
