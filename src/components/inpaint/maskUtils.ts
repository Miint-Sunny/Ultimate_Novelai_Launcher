export function expandMaskRegions(imageData: ImageData): ImageData {
  const { width, height, data } = imageData;
  const gridSize = 8;
  const gridWidth = Math.floor(width / gridSize);
  const gridHeight = Math.floor(height / gridSize);

  const whiteGrids: boolean[][] = Array(gridHeight)
    .fill(null)
    .map(() => Array(gridWidth).fill(false));

  for (let gy = 0; gy < gridHeight; gy++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      outer: for (let dy = 0; dy < gridSize; dy++) {
        for (let dx = 0; dx < gridSize; dx++) {
          const px = gx * gridSize + dx;
          const py = gy * gridSize + dy;
          const idx = (py * width + px) * 4;
          if (data[idx] > 128 || data[idx + 1] > 128 || data[idx + 2] > 128) {
            whiteGrids[gy][gx] = true;
            break outer;
          }
        }
      }
    }
  }

  const bufferSize = 0;
  const expanded: boolean[][] = Array(gridHeight)
    .fill(null)
    .map(() => Array(gridWidth).fill(false));

  for (let gy = 0; gy < gridHeight; gy++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      if (!whiteGrids[gy][gx]) continue;
      for (let dy = -bufferSize; dy <= bufferSize; dy++) {
        for (let dx = -bufferSize; dx <= bufferSize; dx++) {
          const ny = gy + dy;
          const nx = gx + dx;
          if (ny >= 0 && ny < gridHeight && nx >= 0 && nx < gridWidth) {
            expanded[ny][nx] = true;
          }
        }
      }
    }
  }

  const result = new Uint8ClampedArray(data.length);
  result.set(data);

  for (let gy = 0; gy < gridHeight; gy++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      if (!expanded[gy][gx]) continue;
      for (let dy = 0; dy < gridSize; dy++) {
        for (let dx = 0; dx < gridSize; dx++) {
          const px = gx * gridSize + dx;
          const py = gy * gridSize + dy;
          if (px < width && py < height) {
            const idx = (py * width + px) * 4;
            result[idx] = 255;
            result[idx + 1] = 255;
            result[idx + 2] = 255;
            result[idx + 3] = 255;
          }
        }
      }
    }
  }

  return new ImageData(result, width, height);
}

export function getMaskBase64FromCanvas(
  maskCanvas: HTMLCanvasElement | null,
  width: number,
  height: number,
): string {
  if (!maskCanvas) return '';
  const maskCtx = maskCanvas.getContext('2d');
  if (!maskCtx) return '';

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = width;
  tempCanvas.height = height;
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) return '';

  tempCtx.fillStyle = '#000000';
  tempCtx.fillRect(0, 0, width, height);

  const maskData = maskCtx.getImageData(0, 0, width, height);
  const data = maskData.data;
  const outputData = tempCtx.getImageData(0, 0, width, height);
  const output = outputData.data;

  // 二值化按官方阈值 alpha > 155:硬笔刷本来就是 255;软圆笔刷的渐变边只有内侧较实的一段算进遮罩。
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 155) {
      output[i] = 255;
      output[i + 1] = 255;
      output[i + 2] = 255;
      output[i + 3] = 255;
    } else {
      output[i] = 0;
      output[i + 1] = 0;
      output[i + 2] = 0;
      output[i + 3] = 255;
    }
  }

  tempCtx.putImageData(outputData, 0, 0);
  const imageData = tempCtx.getImageData(0, 0, width, height);
  const expandedData = expandMaskRegions(imageData);
  tempCtx.putImageData(expandedData, 0, 0);

  return tempCanvas.toDataURL('image/png').split(',')[1];
}

/** 遮罩画布在 rect 范围内有没有画过(任何非透明像素)。 */
export function maskHasPaintInside(
  maskCanvas: HTMLCanvasElement | null,
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  if (!maskCanvas) return false;
  const ctx = maskCanvas.getContext('2d');
  if (!ctx) return false;
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const w = Math.min(maskCanvas.width - x, Math.ceil(rect.width));
  const h = Math.min(maskCanvas.height - y, Math.ceil(rect.height));
  if (w <= 0 || h <= 0) return false;
  const { data } = ctx.getImageData(x, y, w, h);
  // 与导出阈值一致(alpha > 155),软圆笔刷的淡边不算「画过」
  for (let i = 3; i < data.length; i += 4) if (data[i] > 155) return true;
  return false;
}

/**
 * 照官方焦点重绘的「框内没画遮罩就整框重绘」:整框去掉上下文内边距那一圈就是重绘区。
 * 内边距太大把框吃光时退回至少 64px 的中心区,保证还有东西可画。返回 base64 PNG(白 = 重绘)。
 */
export function buildBoxMask(
  box: { x: number; y: number; width: number; height: number },
  contextPadding: number,
  imageWidth: number,
  imageHeight: number,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = imageWidth;
  canvas.height = imageHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, imageWidth, imageHeight);
  const padX = Math.min(Math.max(0, contextPadding), Math.max(0, (box.width - 64) / 2));
  const padY = Math.min(Math.max(0, contextPadding), Math.max(0, (box.height - 64) / 2));
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(Math.round(box.x + padX), Math.round(box.y + padY), Math.round(box.width - padX * 2), Math.round(box.height - padY * 2));
  return canvas.toDataURL('image/png').split(',')[1];
}
