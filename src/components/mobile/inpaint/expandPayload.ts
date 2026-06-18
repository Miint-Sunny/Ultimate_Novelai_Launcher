import { expandMaskRegions } from './maskUtils';

// 扩图框选区域（图片坐标系，x/y 可为负表示超出图片左/上边界）
// 真相源在此；../MobileInpaintOverlay re-export 以保持对外 API 稳定。
export interface ExpandSelection {
  x: number;
  y: number;
  width: number;
  height: number;
}

// 扩图预备载荷（MobileInpaintOverlay 内部构建好的完整图+遮罩）
export interface ExpandPayload {
  imageBase64: string;
  maskBase64: string;
  width: number;
  height: number;
  // 回贴信息
  selection: ExpandSelection;
  originalImageBase64: string;
  originalWidth: number;
  originalHeight: number;
}

export interface ExpandPadding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

// expand 生成区域矩形（与 activeGenRectRef 形状一致）
export interface ExpandGenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BuildExpandResult {
  payload: ExpandPayload;
  maskBase64: string;
  genRect: ExpandGenRect;
}

// 构建扩图 payload：白底 + 原图对应部分的完整图，外部=白=生成的遮罩（8x8 对齐），
// 以及原图 base64 用于回贴。纯函数，无副作用。img 缺失时返回 null。
export function buildExpandPayload(
  img: HTMLImageElement | null,
  imageWidth: number,
  imageHeight: number,
  expandPadding: ExpandPadding,
): BuildExpandResult | null {
  if (!img) return null;

  const sel: ExpandSelection = {
    x: -expandPadding.left,
    y: -expandPadding.top,
    width: imageWidth + expandPadding.left + expandPadding.right,
    height: imageHeight + expandPadding.top + expandPadding.bottom,
  };

  // 构建选区大小的图片（白底 + 原图对应部分）
  const imgCanvas = document.createElement('canvas');
  imgCanvas.width = sel.width;
  imgCanvas.height = sel.height;
  const imgCtx = imgCanvas.getContext('2d')!;
  imgCtx.fillStyle = '#ffffff';
  imgCtx.fillRect(0, 0, sel.width, sel.height);
  imgCtx.drawImage(img, expandPadding.left, expandPadding.top, imageWidth, imageHeight);
  const imageBase64 = imgCanvas.toDataURL('image/png').split(',')[1];

  // 构建选区大小的遮罩（图片覆盖区域=黑=保留，外部=白=生成）
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = sel.width;
  maskCanvas.height = sel.height;
  const maskCtx = maskCanvas.getContext('2d')!;
  maskCtx.fillStyle = '#ffffff';
  maskCtx.fillRect(0, 0, sel.width, sel.height);
  // 原图区域设为黑色（保留）
  maskCtx.fillStyle = '#000000';
  maskCtx.fillRect(expandPadding.left, expandPadding.top, imageWidth, imageHeight);
  // 8x8 网格对齐
  const maskData = maskCtx.getImageData(0, 0, sel.width, sel.height);
  const expandedMask = expandMaskRegions(maskData);
  maskCtx.putImageData(expandedMask, 0, 0);
  const selMaskBase64 = maskCanvas.toDataURL('image/png').split(',')[1];

  // 获取原图 base64
  const origCanvas = document.createElement('canvas');
  origCanvas.width = imageWidth;
  origCanvas.height = imageHeight;
  origCanvas.getContext('2d')!.drawImage(img, 0, 0);
  const originalImageBase64 = origCanvas.toDataURL('image/png').split(',')[1];

  const payload: ExpandPayload = {
    imageBase64,
    maskBase64: selMaskBase64,
    width: sel.width,
    height: sel.height,
    selection: sel,
    originalImageBase64,
    originalWidth: imageWidth,
    originalHeight: imageHeight,
  };

  const genRect: ExpandGenRect = { x: 0, y: 0, width: sel.width, height: sel.height };

  return { payload, maskBase64: selMaskBase64, genRect };
}
