interface CropInfo {
  cropRect: { x: number; y: number; width: number; height: number };
  originalImageBase64: string;
  originalWidth: number;
  originalHeight: number;
  isExpand?: boolean;
}

interface InpaintResult {
  imageData?: Blob;
  seed?: number;
}

type AddInpaintedImage = (imageUrl: string, width: number, height: number, seed: number) => void;

const canvasToPngBlob = (canvas: HTMLCanvasElement): Promise<Blob> => (
  new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob!), 'image/png');
  })
);

const loadOriginalImage = (originalImageBase64: string): Promise<HTMLImageElement> => (
  new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.src = `data:image/png;base64,${originalImageBase64}`;
  })
);

export async function pasteBackInpaintResult(
  result: InpaintResult,
  cropInfo: CropInfo,
  addInpaintedImage: AddInpaintedImage
) {
  try {
    if (!result.imageData) return;
    const { cropRect, originalImageBase64, originalWidth, originalHeight, isExpand } = cropInfo;
    const origImg = await loadOriginalImage(originalImageBase64);
    const cropResultBitmap = await createImageBitmap(result.imageData);
    let compositeCanvas: HTMLCanvasElement;

    if (isExpand) {
      const sel = cropRect;
      const minX = Math.min(0, sel.x);
      const minY = Math.min(0, sel.y);
      const maxX = Math.max(originalWidth, sel.x + sel.width);
      const maxY = Math.max(originalHeight, sel.y + sel.height);
      const finalW = maxX - minX;
      const finalH = maxY - minY;

      compositeCanvas = document.createElement('canvas');
      compositeCanvas.width = finalW;
      compositeCanvas.height = finalH;
      const ctx = compositeCanvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, finalW, finalH);
      ctx.drawImage(origImg, -minX, -minY);
      ctx.drawImage(cropResultBitmap, sel.x - minX, sel.y - minY, sel.width, sel.height);

      const compositeBlob = await canvasToPngBlob(compositeCanvas);
      addInpaintedImage(URL.createObjectURL(compositeBlob), finalW, finalH, result.seed || 0);
    } else {
      compositeCanvas = document.createElement('canvas');
      compositeCanvas.width = originalWidth;
      compositeCanvas.height = originalHeight;
      const ctx = compositeCanvas.getContext('2d')!;
      ctx.drawImage(origImg, 0, 0);
      ctx.drawImage(cropResultBitmap, cropRect.x, cropRect.y, cropRect.width, cropRect.height);

      const compositeBlob = await canvasToPngBlob(compositeCanvas);
      addInpaintedImage(URL.createObjectURL(compositeBlob), originalWidth, originalHeight, result.seed || 0);
    }

    window.dispatchEvent(new Event('inpaint-pasteback-done'));
  } catch (error) {
    console.error('裁切/扩图重绘回贴失败:', error);
    window.dispatchEvent(new Event('inpaint-pasteback-done'));
  }
}
