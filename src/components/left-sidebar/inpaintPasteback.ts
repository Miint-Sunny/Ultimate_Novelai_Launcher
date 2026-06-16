export interface InpaintCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InpaintCropInfo {
  cropRect: InpaintCropRect;
  sendRect?: InpaintCropRect;
  originalImageBase64: string;
  originalWidth: number;
  originalHeight: number;
  isExpand?: boolean;
}

export async function pasteBackInpaintResult({
  cropInfo,
  imageData,
  seed,
  addInpaintedImage,
}: {
  cropInfo: InpaintCropInfo;
  imageData: Blob;
  seed: number;
  addInpaintedImage: (url: string, width: number, height: number, seed: number) => void;
}) {
  try {
    const result = await buildPasteBackImage(cropInfo, imageData);
    const compositeBlob = await canvasToBlob(result.canvas);
    const compositeUrl = URL.createObjectURL(compositeBlob);
    addInpaintedImage(compositeUrl, result.width, result.height, seed);
    window.dispatchEvent(new Event('inpaint-pasteback-done'));
  } catch (error) {
    console.error('裁切/扩图重绘回贴失败:', error);
    window.dispatchEvent(new Event('inpaint-pasteback-done'));
  }
}

async function buildPasteBackImage(cropInfo: InpaintCropInfo, imageData: Blob) {
  const { cropRect, sendRect, originalImageBase64, originalWidth, originalHeight, isExpand } = cropInfo;
  const origImg = new Image();
  await new Promise<void>((resolve) => {
    origImg.onload = () => resolve();
    origImg.src = `data:image/png;base64,${originalImageBase64}`;
  });
  const cropResultBitmap = await createImageBitmap(imageData);

  if (isExpand) {
    return buildExpandedPasteBack({
      cropRect,
      originalWidth,
      originalHeight,
      origImg,
      cropResultBitmap,
    });
  }

  return buildCroppedPasteBack({
    cropRect,
    sendRect,
    originalWidth,
    originalHeight,
    origImg,
    cropResultBitmap,
  });
}

function buildExpandedPasteBack({
  cropRect,
  originalWidth,
  originalHeight,
  origImg,
  cropResultBitmap,
}: {
  cropRect: InpaintCropRect;
  originalWidth: number;
  originalHeight: number;
  origImg: HTMLImageElement;
  cropResultBitmap: ImageBitmap;
}) {
  const minX = Math.min(0, cropRect.x);
  const minY = Math.min(0, cropRect.y);
  const maxX = Math.max(originalWidth, cropRect.x + cropRect.width);
  const maxY = Math.max(originalHeight, cropRect.y + cropRect.height);
  const finalW = maxX - minX;
  const finalH = maxY - minY;

  const canvas = document.createElement('canvas');
  canvas.width = finalW;
  canvas.height = finalH;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, finalW, finalH);
  ctx.drawImage(origImg, -minX, -minY);
  ctx.drawImage(cropResultBitmap, cropRect.x - minX, cropRect.y - minY, cropRect.width, cropRect.height);

  return { canvas, width: finalW, height: finalH };
}

function buildCroppedPasteBack({
  cropRect,
  sendRect,
  originalWidth,
  originalHeight,
  origImg,
  cropResultBitmap,
}: {
  cropRect: InpaintCropRect;
  sendRect?: InpaintCropRect;
  originalWidth: number;
  originalHeight: number;
  origImg: HTMLImageElement;
  cropResultBitmap: ImageBitmap;
}) {
  const canvas = document.createElement('canvas');
  canvas.width = originalWidth;
  canvas.height = originalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(origImg, 0, 0);

  if (sendRect) {
    const srcX = cropRect.x - sendRect.x;
    const srcY = cropRect.y - sendRect.y;
    ctx.drawImage(
      cropResultBitmap,
      srcX, srcY, cropRect.width, cropRect.height,
      cropRect.x, cropRect.y, cropRect.width, cropRect.height,
    );
  } else {
    ctx.drawImage(cropResultBitmap, cropRect.x, cropRect.y, cropRect.width, cropRect.height);
  }

  return { canvas, width: originalWidth, height: originalHeight };
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve) => {
    canvas.toBlob((blob) => resolve(blob!), 'image/png');
  });
}
