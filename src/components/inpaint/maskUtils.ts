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

  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 0 || data[i + 1] > 0 || data[i + 2] > 0 || data[i + 3] > 0) {
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
