import { expandMaskRegions } from './maskUtils';
import type { ExpandPadding, ExpandPayload, ExpandSelection } from './types';

interface BuildExpandPayloadParams {
  image: HTMLImageElement;
  imageWidth: number;
  imageHeight: number;
  expandPadding: ExpandPadding;
}

interface BuildExpandPayloadResult {
  selection: ExpandSelection;
  maskBase64: string;
  payload: ExpandPayload;
}

export function buildExpandPayload({
  image,
  imageWidth,
  imageHeight,
  expandPadding,
}: BuildExpandPayloadParams): BuildExpandPayloadResult | null {
  const expandedWidth = imageWidth + expandPadding.left + expandPadding.right;
  const expandedHeight = imageHeight + expandPadding.top + expandPadding.bottom;
  const selection: ExpandSelection = {
    x: -expandPadding.left,
    y: -expandPadding.top,
    width: expandedWidth,
    height: expandedHeight,
  };

  const imageCanvas = document.createElement('canvas');
  imageCanvas.width = selection.width;
  imageCanvas.height = selection.height;
  const imageCtx = imageCanvas.getContext('2d');
  if (!imageCtx) return null;

  imageCtx.fillStyle = '#ffffff';
  imageCtx.fillRect(0, 0, selection.width, selection.height);
  imageCtx.drawImage(image, expandPadding.left, expandPadding.top, imageWidth, imageHeight);
  const imageBase64 = imageCanvas.toDataURL('image/png').split(',')[1];

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = selection.width;
  maskCanvas.height = selection.height;
  const maskCtx = maskCanvas.getContext('2d');
  if (!maskCtx) return null;

  maskCtx.fillStyle = '#ffffff';
  maskCtx.fillRect(0, 0, selection.width, selection.height);
  maskCtx.fillStyle = '#000000';
  maskCtx.fillRect(expandPadding.left, expandPadding.top, imageWidth, imageHeight);
  const maskData = maskCtx.getImageData(0, 0, selection.width, selection.height);
  const expandedMask = expandMaskRegions(maskData);
  maskCtx.putImageData(expandedMask, 0, 0);
  const maskBase64 = maskCanvas.toDataURL('image/png').split(',')[1];

  const originalCanvas = document.createElement('canvas');
  originalCanvas.width = imageWidth;
  originalCanvas.height = imageHeight;
  const originalCtx = originalCanvas.getContext('2d');
  if (!originalCtx) return null;

  originalCtx.drawImage(image, 0, 0);
  const originalImageBase64 = originalCanvas.toDataURL('image/png').split(',')[1];

  return {
    selection,
    maskBase64,
    payload: {
      imageBase64,
      maskBase64,
      width: selection.width,
      height: selection.height,
      selection,
      originalImageBase64,
      originalWidth: imageWidth,
      originalHeight: imageHeight,
    },
  };
}
