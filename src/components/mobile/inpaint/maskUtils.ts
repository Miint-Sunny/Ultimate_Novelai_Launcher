// Mobile inpaint mask 处理工具。
// 注意：这里的 expandMaskRegions 采用 BFS 连通域 + 8x8 对齐外扩算法，
// 与桌面端 src/components/inpaint/maskUtils.ts 的简单逐格膨胀不同。
// 该差异是有意为之（mobile 笔刷半径包络行为敏感），合并前需单独的行为对齐任务。

// 8x8 网格区域扩张：对每个白色连通域按 8 格对齐向外扩张，并保留笔刷半径包络。
export function expandMaskRegions(imageData: ImageData): ImageData {
  const { width, height, data } = imageData;
  const gridSize = 8;
  const gridWidth = Math.floor(width / gridSize);
  const gridHeight = Math.floor(height / gridSize);

  const whiteGrids: boolean[][] = Array(gridHeight).fill(null).map(() => Array(gridWidth).fill(false));

  for (let gy = 0; gy < gridHeight; gy++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      outer: for (let dy = 0; dy < gridSize; dy++) {
        for (let dx = 0; dx < gridSize; dx++) {
          const px = gx * gridSize + dx;
          const py = gy * gridSize + dy;
          const idx = (py * width + px) * 4;
          if (data[idx] > 128) {
            whiteGrids[gy][gx] = true;
            break outer;
          }
        }
      }
    }
  }

  const visited: boolean[][] = Array(gridHeight).fill(null).map(() => Array(gridWidth).fill(false));
  const regions: Array<Array<[number, number]>> = [];

  const bfs = (startY: number, startX: number): Array<[number, number]> => {
    const region: Array<[number, number]> = [];
    const queue: Array<[number, number]> = [[startY, startX]];
    visited[startY][startX] = true;
    while (queue.length > 0) {
      const [y, x] = queue.shift()!;
      region.push([y, x]);
      for (const [dy, dx] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
        const ny = y + dy;
        const nx = x + dx;
        if (ny >= 0 && ny < gridHeight && nx >= 0 && nx < gridWidth && whiteGrids[ny][nx] && !visited[ny][nx]) {
          visited[ny][nx] = true;
          queue.push([ny, nx]);
        }
      }
    }
    return region;
  };

  for (let gy = 0; gy < gridHeight; gy++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      if (whiteGrids[gy][gx] && !visited[gy][gx]) {
        regions.push(bfs(gy, gx));
      }
    }
  }

  const result = new Uint8ClampedArray(data.length);
  result.set(data);
  const brushHalf = 2;

  for (const region of regions) {
    const ys = region.map((p) => p[0]);
    const xs = region.map((p) => p[1]);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);

    const topDist = minY;
    const bottomDist = gridHeight - 1 - maxY;
    const leftDist = minX;
    const rightDist = gridWidth - 1 - maxX;

    const targetTop = Math.floor(topDist / 8) * 8;
    const targetBottom = Math.floor(bottomDist / 8) * 8;
    const targetLeft = Math.floor(leftDist / 8) * 8;
    const targetRight = Math.floor(rightDist / 8) * 8;

    const expandedMinY = Math.max(0, minY - (topDist - targetTop));
    const expandedMaxY = Math.min(gridHeight - 1, maxY + (bottomDist - targetBottom));
    const expandedMinX = Math.max(0, minX - (leftDist - targetLeft));
    const expandedMaxX = Math.min(gridWidth - 1, maxX + (rightDist - targetRight));

    for (let cy = expandedMinY; cy <= expandedMaxY; cy++) {
      for (let cx = expandedMinX; cx <= expandedMaxX; cx++) {
        const inRange = region.some(([ry, rx]) => Math.abs(cy - ry) <= brushHalf && Math.abs(cx - rx) <= brushHalf);
        if (inRange) {
          for (let dy = 0; dy < gridSize; dy++) {
            for (let dx = 0; dx < gridSize; dx++) {
              const px = cx * gridSize + dx;
              const py = cy * gridSize + dy;
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
    }
  }
  return new ImageData(result, width, height);
}

// 从遮罩画布读取像素，二值化为黑底白遮罩，并应用 8x8 扩张，返回 base64（不含 data: 前缀）。
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
      output[i] = 255; output[i + 1] = 255; output[i + 2] = 255; output[i + 3] = 255;
    } else {
      output[i] = 0; output[i + 1] = 0; output[i + 2] = 0; output[i + 3] = 255;
    }
  }

  tempCtx.putImageData(outputData, 0, 0);
  const imageData = tempCtx.getImageData(0, 0, width, height);
  const expandedData = expandMaskRegions(imageData);
  tempCtx.putImageData(expandedData, 0, 0);

  return tempCanvas.toDataURL('image/png').split(',')[1];
}
